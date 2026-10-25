import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { writeKomodoProject, type ProjectModel } from "@elide/ide-core";
import * as vscode from "vscode";
import { LanguageClient, State, type LanguageClientOptions, type ServerOptions } from "vscode-languageclient/node";
import type * as lsp from "vscode-languageclient/node";
import { KOMODO_LSP, elideJdkHome, resolveKomodoLauncher } from "./komodoDistribution.js";

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
  /** The server process the client started last (it restarts a crashed one). */
  process?: ChildProcess;
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
    if ("unavailable" in target) throw new Error(`Komodo's debugger cannot start: ${target.unavailable}.`);
    return target.launch;
  }

  /** Record the folder's models and start or reload the server; returns what the Activity step shows. */
  sync(folder: vscode.WorkspaceFolder, models: readonly ProjectModel[], settings: KomodoSettings): Promise<string> {
    if (this.disposed) return Promise.reject(new Error("Komodo language server disposed."));
    this.folders.set(folder.uri.toString(), { folder, models });
    return this.enqueue(() => this.apply(settings));
  }

  /** Drop a folder that no longer uses Komodo (or left the window); the server stops with the last one. */
  remove(folder: vscode.WorkspaceFolder, settings: KomodoSettings): Promise<unknown> {
    if (!this.folders.delete(folder.uri.toString())) return Promise.resolve();
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
    this.debugTarget = { unavailable: "the last Komodo sync failed (see the Elide output)" };
    // A project open in two folders (nested folders, a member opened on its own) is analyzed once.
    const byRoot = new Map<string, ProjectModel>();
    for (const { models } of this.folders.values()) for (const model of models) if (!byRoot.has(model.root)) byRoot.set(model.root, model);
    const models = [...byRoot.values()];
    if (models.length === 0) {
      this.debugTarget = { unavailable: "no Elide projects" };
      await this.stop();
      return "no Elide projects";
    }
    const launcher = resolveKomodoLauncher(KOMODO_LSP, settings.path, settings.elideHome);
    if (!launcher) {
      // A configured path is used as it is: name it rather than suggest setting it.
      const message = settings.path
        ? `elide.kotlinLsp.komodo.path (${settings.path}) does not exist.`
        : `Komodo was not found: use an Elide distribution that ships it (lib/komodo/bin/${KOMODO_LSP}), or set elide.kotlinLsp.komodo.path to a ${KOMODO_LSP} executable.`;
      this.debugTarget = { unavailable: message.replace(/\.$/, "") };
      await this.stop();
      throw new Error(message);
    }
    // Per window: two windows must not rewrite each other's manifest; a multi-root window keys by its workspace file.
    const windowKey = vscode.workspace.workspaceFile?.toString() ?? [...this.folders.keys()].sort()[0]!;
    const manifest = path.join(this.storage, "komodo-lsp", createHash("sha256").update(windowKey).digest("hex").slice(0, 16), "project.properties");
    const project = await writeKomodoProject(models, manifest);
    if (this.disposed) throw new Error("Komodo language server disposed.");
    if (!project) {
      this.debugTarget = { unavailable: "the projects have no Kotlin sources" };
      await this.stop();
      return "no Kotlin sources";
    }
    for (const skipped of project.skipped) this.log(`Komodo: skipped ${skipped}`);
    const plugins = komodoPluginArguments(project.plugins, settings.pluginDirectory);
    if (plugins.missing.length > 0) this.log(`Komodo: no ${plugins.missing.join(", ")} compiler plugin in ${settings.pluginDirectory}; the server falls back to the plugins its distribution ships`);
    const args = [...(settings.maxHeap ? [`-Xmx${settings.maxHeap}`] : []), "--project", manifest, ...plugins.args];
    const javaHome = settings.javaHome ?? elideJdkHome(launcher, settings.elideHome);
    // Before the server starts: the adapter needs only the manifest and launcher, not a running server.
    this.debugTarget = { launch: { launcher, manifest, javaHome } };
    const folders = [...this.folders.values()].map(({ folder }) => folder.uri.fsPath).sort();
    const launch = JSON.stringify([launcher, args, javaHome ?? null, folders]);
    const summary = `${project.modules.length} modules`;
    const running = this.running;
    if (running && running.launch === launch && running.client.state === State.Running) {
      await running.client.sendRequest("workspace/executeCommand", { command: "komodo.reload", arguments: [] });
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
    };
    const started = new LanguageClient("elide.komodo", "Komodo", server, client);
    this.running = { client: started, launch };
    this.log(`Komodo: starting ${launcher} ${args.join(" ")}${javaHome ? ` (JAVA_HOME=${javaHome})` : ""}`);
    await started.start();
    if (this.disposed) throw new Error("Komodo language server disposed.");
    return `${summary} · started`;
  }

  private async stop(): Promise<void> {
    const running = this.running;
    if (!running) return;
    this.running = undefined;
    // A client restarting its crashed server cannot be stopped until it is up; disposed, it never restarts one again.
    if (running.client.state === State.Starting) await running.client.start().catch(() => undefined);
    await running.client.dispose().catch((error: unknown) => this.log(`Komodo: stop failed: ${String(error)}`));
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
    if (!client) throw new Error(`Komodo is not running: ${uri.toString()} cannot be read`);
    if (client.state !== State.Running) await client.start();
    const content = await client.sendRequest<{ text: string; languageId: string }>("komodo/libraryContent", { uri: uri.toString() });
    return content.text;
  }

  /** The lens command: VS Code's reference peek, from the LSP JSON the server put in the lens. */
  private async showReferences(uri: string, position: lsp.Position, locations: lsp.Location[]): Promise<void> {
    const client = this.running?.client;
    if (!client) return;
    const converter = client.protocol2CodeConverter;
    await vscode.commands.executeCommand("editor.action.showReferences", converter.asUri(uri), converter.asPosition(position),
      locations.map((location) => converter.asLocation(location)));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.stop();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

