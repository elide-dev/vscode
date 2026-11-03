import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { writeKomodoProject, type ProjectModel } from "@elide/ide-core";
import * as vscode from "vscode";
import { CloseAction, ErrorAction, LanguageClient, State, type LanguageClientOptions, type ServerOptions } from "vscode-languageclient/node";
import type * as lsp from "vscode-languageclient/node";
import { KomodoResolutionError, resolveKomodo, type KomodoResolution } from "./komodoDistribution.js";
import { requireKomodoDebugProtocol } from "./komodoDebug.js";

/**
 * Library declarations the server opens (`komodo-library:/<path>?<origin>`): a `-sources.jar` entry or a stub it renders
 * from the binary, read through its `komodo/libraryContent` request. Only `file` documents are synchronized with the
 * server, so these never enter the client's document selector.
 */
export const KOMODO_LIBRARY_SCHEME = "komodo-library";

/** The code lens command the server's "N references"/"N implementations" lenses carry: `[uri, position, locations]`. */
export const KOMODO_SHOW_REFERENCES = "komodo.showReferences";

/**
 * Compiler plugins Komodo accepts (`CompilationRequest.Plugin.ALLOWED`), by the base name of their jar: Komodo's own
 * distributions ship `kotlin-compose-compiler-plugin.jar`, Maven has `-embeddable` builds, either possibly versioned.
 */
const PLUGIN_JARS = {
  compose: "kotlin-compose-compiler-plugin",
  "kotlinx-serialization": "kotlin-serialization-compiler-plugin",
} as const;

/**
 * `--plugin` arguments for the plugins the project needs from a configured directory of plugin jars built for Komodo's
 * pinned compiler (a project's own plugin jars target its build compiler, whose ABI may differ). Without a directory the
 * server applies the plugins its distribution ships under `plugins/`, so nothing is passed. Plugins without a jar are
 * reported, not guessed.
 */
export function komodoPluginArguments(needed: { compose: boolean; serialization: boolean }, directory: string | undefined,
  list: (dir: string) => string[] = (dir) => (existsSync(dir) ? readdirSync(dir) : [])): { args: string[]; missing: string[] } {
  if (!directory) return { args: [], missing: [] };
  const ids = [...(needed.compose ? ["compose"] as const : []), ...(needed.serialization ? ["kotlinx-serialization"] as const : [])];
  const jars = list(directory).filter((name) => name.endsWith(".jar") && !name.endsWith("-sources.jar")).sort();
  const args: string[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const name = new RegExp(`^${PLUGIN_JARS[id]}(-embeddable)?(-\\d[^/]*)?\\.jar$`);
    const jar = jars.filter((candidate) => name.test(candidate)).at(-1);
    if (jar) args.push("--plugin", `${id}=${path.join(directory, jar)}`);
    else missing.push(id);
  }
  return { args, missing };
}


/**
 * The documents the server analyzes: Kotlin files on disk under the folders that chose it. Each folder is the base of a
 * relative pattern rather than part of a glob, so a folder named like `app[v2]` or `{core}` matches its own files.
 */
export function komodoDocumentSelector(folders: readonly string[]): lsp.DocumentSelector {
  const filters: vscode.DocumentFilter[] = folders.map((folder) => ({ scheme: "file", pattern: new vscode.RelativePattern(vscode.Uri.file(folder), "**/*.kt") }));
  // The client types its selector as LSP's, whose filters take string patterns, but hands each filter to
  // `vscode.languages.match` as it is: VS Code's own relative pattern applies.
  return filters as unknown as lsp.DocumentSelector;
}

/** Launch settings: window-wide, since the window has one server. */
export interface KomodoSettings {
  path?: string | undefined;
  elideHome?: string | undefined;
  pluginDirectory?: string | undefined;
  javaHome?: string | undefined;
  /** Native heap cap (`768m`, `1g`); undefined leaves the image's default. */
  maxHeap?: string | undefined;
  signal?: AbortSignal | undefined;
}

/** What Komodo's debug adapter (`komodo --dap`) runs with. */
export interface KomodoDebugLaunch {
  launcher: string;
  /** The Komodo project manifest the server analyzes; the adapter maps JDI source paths to its module source roots. */
  manifest: string;
  /** The server's JAVA_HOME; undefined inherits the environment's. */
  javaHome: string | undefined;
}

interface Running {
  client: LanguageClient;
  /** The executable, arguments, JDK inputs and document selector: a sync that changes any restarts the server. */
  launch: string;
  /** The server process owned by this client; incompatible/crashed servers are not restarted implicitly. */
  process?: ChildProcess;
  stateListener?: vscode.Disposable;
  failure?: string;
}

/** Graceful shutdown includes disposing analysis workspaces. */
const EXIT_GRACE_MS = 30_000;

/**
 * Komodo's language server for this window: one process analyzing the Elide projects of every folder whose
 * `elide.kotlinLsp.server` is `komodo`, from one Komodo project manifest the syncs write into extension storage (never
 * into a project). A sync of any folder rewrites the manifest and makes the running server reload it
 * (`komodo.reload`); one that changes how the server is launched restarts it.
 */
export class KomodoLanguageServer implements vscode.Disposable {
  /** Each Komodo folder's models from its last sync, by folder URI. */
  private readonly folders = new Map<string, { folder: vscode.WorkspaceFolder; models: readonly ProjectModel[] }>();
  private running: Running | undefined;
  private disposed = false;
  /** Serializes manifest writes and server starts: folders sync concurrently. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly disposables: vscode.Disposable[] = [];
  /** What the last {@link apply} left for the debug adapter, or why it left nothing. */
  private debugTarget: { launch: KomodoDebugLaunch } | { unavailable: string } = { unavailable: "no folder has synced with Komodo yet" };
  private missingOffered = false;
  private readonly availabilityChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeAvailability = this.availabilityChanged.event;
  private previewFailure: string | undefined;

  constructor(private readonly storage: string, private readonly log: (message: string) => void) {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(KOMODO_LIBRARY_SCHEME, { provideTextDocumentContent: (uri) => this.libraryContent(uri) }),
      vscode.commands.registerCommand(KOMODO_SHOW_REFERENCES, (uri: string, position: lsp.Position, locations: lsp.Location[]) => this.showReferences(uri, position, locations)),
    );
  }

  /** The running client, for tests and commands. */
  get client(): LanguageClient | undefined {
    return this.running?.client;
  }

  get available(): boolean {
    return !this.disposed && this.running?.client.state === State.Running && "launch" in this.debugTarget;
  }

  get previewAvailable(): boolean {
    return this.available && this.previewFailure === undefined;
  }

  rejectPreview(reason: string): void {
    this.previewFailure = reason;
    this.availabilityChanged.fire();
  }

  async requirePreview(file: string): Promise<void> {
    await this.queue.catch(() => undefined);
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
    if (!folder || !this.folders.has(folder.uri.toString())) {
      throw new Error("Komodo previews need a synced project with elide.kotlinLsp.server set to komodo. Select that server and sync, or select the layoutlib preview engine.");
    }
    if (!this.available) {
      const reason = "unavailable" in this.debugTarget ? this.debugTarget.unavailable : "the language server is not running";
      throw new Error(`Komodo previews are disabled: ${reason}. Install or configure compatible Komodo and sync again.`);
    }
    if (this.previewFailure) throw new Error(`Komodo previews are disabled: ${this.previewFailure}`);
  }

  /** Disable consumers synchronously, before waiting for a process or queued operation to finish. */
  invalidate(reason: string): void {
    const changed = "launch" in this.debugTarget;
    this.debugTarget = { unavailable: reason };
    if (changed) this.availabilityChanged.fire();
  }

  /**
   * The launcher, manifest and JDK Komodo's debug adapter needs for `folder`, once the syncs queued so far have applied.
   * Throws, saying why, when the folder is not (yet) on Komodo or the last sync left no launcher or manifest.
   */
  async debugLaunch(folder: vscode.WorkspaceFolder): Promise<KomodoDebugLaunch> {
    await this.queue.catch(() => undefined);
    if (!this.folders.has(folder.uri.toString())) {
      throw new Error(`Komodo's debugger needs the Komodo project manifest of '${folder.name}', which its sync writes: set elide.kotlinLsp.server to komodo for it and wait for the sync to finish, or choose another elide.debug.adapter.`);
    }
    const target = this.debugTarget;
    if (!this.available && "launch" in target) throw new Error("Komodo's debugger cannot start: the language server is not running. Sync the project again.");
    if ("unavailable" in target) throw new Error(`Komodo's debugger cannot start: ${target.unavailable}. Install or configure compatible Komodo, then run Elide: Sync Project(s); no alternative adapter is selected automatically.`);
    return target.launch;
  }

  /** Record the folder's models and start or reload the server; returns what the Activity step shows. */
  sync(folder: vscode.WorkspaceFolder, models: readonly ProjectModel[], settings: KomodoSettings): Promise<string> {
    if (this.disposed) return Promise.reject(new Error("Komodo language server disposed."));
    this.folders.set(folder.uri.toString(), { folder, models });
    this.invalidate("Komodo compatibility is being checked");
    return this.enqueue(() => this.apply(settings));
  }

  /** Drop a folder that no longer uses Komodo (or left the window); the server stops with the last one. */
  remove(folder: vscode.WorkspaceFolder, settings: KomodoSettings): Promise<unknown> {
    if (!this.folders.delete(folder.uri.toString())) return Promise.resolve();
    this.invalidate("the Komodo project set changed");
    return this.enqueue(() => this.apply(settings)).catch((error: unknown) => this.log(`Komodo: ${String(error)}`));
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(() => {
      if (this.disposed) throw new Error("Komodo language server disposed.");
      return run();
    });
    this.queue = next;
    return next;
  }

  private async apply(settings: KomodoSettings): Promise<string> {
    this.invalidate("Komodo compatibility is being checked");
    try {
      return await this.applyAvailable(settings);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.invalidate(message);
      await this.stop();
      if (this.disposed) throw new Error("Komodo language server disposed.");
      settings.signal?.throwIfAborted();
      this.log(`Komodo disabled: ${message}`);
      if (error instanceof KomodoResolutionError && error.status === "missing" && !this.missingOffered) {
        this.missingOffered = true;
        void vscode.window.showWarningMessage(`Komodo disabled: ${message}`, "Install Komodo").then((choice) => {
          if (choice === "Install Komodo" && !this.disposed) void vscode.commands.executeCommand("elide.installKomodo");
        });
      }
      return `disabled · ${message}`;
    }
  }

  private async applyAvailable(settings: KomodoSettings): Promise<string> {
    // A project open in two folders (nested folders, a member opened on its own) is analyzed once.
    const byRoot = new Map<string, ProjectModel>();
    for (const { models } of this.folders.values()) for (const model of models) if (!byRoot.has(model.root)) byRoot.set(model.root, model);
    const models = [...byRoot.values()];
    if (models.length === 0) {
      this.invalidate("no Elide projects");
      await this.stop();
      return "no Elide projects";
    }
    const resolved = await resolveKomodo(settings.path, settings.elideHome, { signal: settings.signal });
    this.missingOffered = false;
    const launcher = resolved.executable;
    // Per window: two windows must not rewrite each other's manifest; a multi-root window keys by its workspace file.
    const windowKey = vscode.workspace.workspaceFile?.toString() ?? [...this.folders.keys()].sort()[0]!;
    const manifest = path.join(this.storage, "komodo-lsp", createHash("sha256").update(windowKey).digest("hex").slice(0, 16), "project.properties");
    const project = await writeKomodoProject(models, manifest);
    if (this.disposed) throw new Error("Komodo language server disposed.");
    if (!project) {
      this.invalidate("the projects have no Kotlin sources");
      await this.stop();
      return "no Kotlin sources";
    }
    for (const skipped of project.skipped) this.log(`Komodo: skipped ${skipped}`);
    const pluginDirectory = settings.pluginDirectory ?? resolved.pluginDirectory;
    const plugins = komodoPluginArguments(project.plugins, pluginDirectory);
    if (plugins.missing.length > 0) throw new Error(`Komodo: missing ${plugins.missing.join(", ")} compiler plugin in ${pluginDirectory}. Check the configured plugin directory or reinstall the managed component.`);
    const args = [...(settings.maxHeap ? [`-Xmx${settings.maxHeap}`] : []), "--project", manifest, ...plugins.args];
    const javaHome = settings.javaHome ?? resolved.javaHome;
    const target = { launcher, manifest, javaHome };
    const folders = [...this.folders.values()].map(({ folder }) => folder.uri.fsPath).sort();
    const executable = statSync(launcher);
    const launch = JSON.stringify([launcher, executable.mtimeMs, executable.size, args, javaHome ?? null, folders]);
    const summary = `${project.modules.length} modules`;
    const running = this.running;
    if (running && running.launch === launch && running.client.state === State.Running) {
      await this.waitForService(running.client.sendRequest("workspace/executeCommand", { command: "komodo.reload", arguments: [] }), settings.signal);
      if (running.failure) throw new Error(running.failure);
      if (running.client.state !== State.Running) throw new Error("Komodo stopped during project reload.");
      this.enable(target, resolved);
      return `${summary} · reloaded`;
    }
    await this.stop();
    if (this.disposed) throw new Error("Komodo language server disposed.");
    // JAVA_HOME supplies resolution inputs to the image, not a process to launch.
    const env = { ...process.env, ...(javaHome ? { JAVA_HOME: javaHome } : {}) };
    // The owner waits for disposal before a replacement can start.
    const server: ServerOptions = async () => {
      const child = spawn(launcher, args, { cwd: path.dirname(manifest), env });
      if (this.running?.client === started) this.running.process = child;
      return { process: child, detached: true };
    };
    const client: LanguageClientOptions = {
      documentSelector: komodoDocumentSelector(folders),
      outputChannelName: "Elide: Komodo",
      errorHandler: {
        error: () => ({ action: ErrorAction.Shutdown }),
        closed: () => ({ action: CloseAction.DoNotRestart }),
      },
      middleware: {
        handleDiagnostics: (uri, diagnostics, next) => {
          next(uri, diagnostics);
          const failure = diagnostics.find((diagnostic) => (typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code) === "komodo.project");
          if (failure && this.running?.client === started) this.failed(this.running, `Komodo could not load the project: ${failure.message}`);
        },
      },
    };
    const started = new LanguageClient("elide.komodo", "Komodo", server, client);
    const active: Running = { client: started, launch };
    this.running = active;
    active.stateListener = started.onDidChangeState(({ newState }) => {
      if (newState === State.Stopped && this.running === active) this.failed(active, "Komodo stopped. Check Elide: Komodo output and sync again.");
    });
    this.log(`Komodo: starting ${launcher} ${args.join(" ")}${javaHome ? ` (JAVA_HOME=${javaHome})` : ""}`);
    await this.waitForService(started.start(), settings.signal);
    if (this.disposed) throw new Error("Komodo language server disposed.");
    if (active.failure) throw new Error(active.failure);
    const capabilities = started.initializeResult?.capabilities;
    if (!capabilities?.executeCommandProvider?.commands.includes("komodo.reload") ||
      !capabilities.definitionProvider || !capabilities.hoverProvider || !capabilities.completionProvider) {
      throw new KomodoResolutionError("incompatible", "Komodo's initialize response lacks native Kotlin completion, definitions, hover or project reload. Install a compatible component or fix elide.kotlinLsp.komodo.path.");
    }
    // initialize advertises capabilities before the analysis workspace loads. Reload acknowledges a real load
    // (and propagates komodo.project failures) instead of exposing a debugger for a failed analysis session.
    await this.waitForService(started.sendRequest("workspace/executeCommand", { command: "komodo.reload", arguments: [] }), settings.signal);
    if (!resolved.protocol) await requireKomodoDebugProtocol(target, settings.signal);
    if (this.disposed) throw new Error("Komodo language server disposed.");
    settings.signal?.throwIfAborted();
    if (active.failure) throw new Error(active.failure);
    if (this.running !== active || started.state !== State.Running) throw new Error("Komodo stopped before it became ready.");
    this.enable(target, resolved);
    return `${summary} · started`;
  }

  private enable(launch: KomodoDebugLaunch, resolution: KomodoResolution): void {
    this.debugTarget = { launch };
    this.previewFailure = resolution.protocol &&
      (resolution.protocol.preview !== 2 || !resolution.capabilities?.includes("preview"))
      ? "The installed component does not advertise preview protocol 2. Install compatible Komodo and sync again."
      : undefined;
    // Successful sync also clears a preview session's incompatibility latch, even when base availability was unchanged.
    this.availabilityChanged.fire();
  }

  private failed(running: Running, reason: string): void {
    running.failure = reason;
    this.invalidate(reason);
    this.log(`Komodo disabled: ${reason}`);
    void this.enqueue(async () => {
      if (this.running === running) await this.stop();
    }).catch(() => undefined);
  }

  private async waitForService<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    const interrupted = Promise.withResolvers<never>();
    const cancel = () => interrupted.reject(signal?.reason ?? new Error("Komodo operation cancelled."));
    const timer = setTimeout(() => interrupted.reject(new Error("Komodo did not finish its native service handshake or reload within 30 seconds. Check Elide: Komodo output, then sync again.")), 30_000);
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (signal?.aborted) cancel();
      return await Promise.race([operation, interrupted.promise]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }

  private async stop(): Promise<void> {
    const running = this.running;
    if (!running) return;
    this.running = undefined;
    running.stateListener?.dispose();
    // Interrupt an initialize that never replied before waiting for the client's start promise to settle.
    if (running.client.state === State.Starting) {
      running.process?.kill("SIGKILL");
      await this.waitForService(running.client.start()).catch(() => undefined);
    }
    await this.waitForService(running.client.dispose()).catch((error: unknown) => this.log(`Komodo: stop failed: ${String(error)}`));
    // Wait for the old daemon's renderer and workspace to finish disposing.
    const child = running.process;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      exited.resolve();
    }, EXIT_GRACE_MS);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      exited.resolve();
    });
    await exited.promise;
  }

  /** A `komodo-library:` document's text, from the server that produced the location. */
  private async libraryContent(uri: vscode.Uri): Promise<string> {
    await this.queue.catch(() => undefined);
    const client = this.running?.client;
    if (!client || !this.available) throw new Error(`Komodo is disabled: ${uri.toString()} cannot be read. Sync the project again.`);
    const content = await client.sendRequest<{ text: string; languageId: string }>("komodo/libraryContent", { uri: uri.toString() });
    return content.text;
  }

  /** The lens command: VS Code's reference peek, from the LSP JSON the server put in the lens. */
  private async showReferences(uri: string, position: lsp.Position, locations: lsp.Location[]): Promise<void> {
    const client = this.running?.client;
    if (!client || !this.available) return;
    const converter = client.protocol2CodeConverter;
    await vscode.commands.executeCommand("editor.action.showReferences", converter.asUri(uri), converter.asPosition(position),
      locations.map((location) => converter.asLocation(location)));
  }

  dispose(): void {
    if (this.disposed) return;
    this.invalidate("the workspace closed");
    this.disposed = true;
    void this.stop();
    for (const disposable of this.disposables) disposable.dispose();
    this.availabilityChanged.dispose();
  }
}

