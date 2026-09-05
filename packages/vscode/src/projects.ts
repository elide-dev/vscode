import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  ElideCli,
  ElideCommandFailedError,
  ElideNotFoundError,
  InvalidElideHomeError,
  MANIFEST_NAME,
  ManifestParseError,
  WORKSPACE_JSON,
  buildProjectModel,
  resolveElideDistribution,
  writeKotlinLspWorkspace,
  type ElideDistribution,
  type ProjectModel,
} from "@elide/ide-core";
import * as vscode from "vscode";
import { readConfig } from "./config.js";
import { reloadKotlinLsp } from "./jetbrains.js";
import type { ElideUi } from "./output.js";

export interface ElideProject {
  /** Absolute project root (directory containing `elide.pkl`). */
  root: string;
  manifestPath: string;
  folder: vscode.WorkspaceFolder;
  model?: ProjectModel;
}

interface FolderState {
  folder: vscode.WorkspaceFolder;
  projects: Map<string, ElideProject>;
  stale: boolean;
  syncing?: AbortController;
  /** Re-run requested while a sync was in flight. */
  rerun: boolean;
  /** Timestamp until which file-change events are attributed to the sync itself. */
  quietUntil: number;
}

export type SyncReason = "startup" | "manual" | "manifest-change" | "project-added" | "project-removed";

const DISCOVERY_EXCLUDE = "{**/.dev/**,**/node_modules/**}";
const CHANGE_GRACE_MS = 3_000;
const JDK_SETTING = "jdkForSymbolResolution";
/** Remembers the JDK path this extension wrote to user settings, so a value the user chose is never clobbered. */
const JDK_STATE_KEY = "elide.intellij.jdkForSymbolResolution";

/** Tracks Elide projects per workspace folder and runs syncs against the CLI. */
export class ElideWorkspace implements vscode.Disposable {
  private readonly folders = new Map<string, FolderState>();
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires after any sync completes or the project set changes. */
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly ui: ElideUi,
    private readonly state: vscode.Memento,
  ) {}

  get projects(): ElideProject[] {
    return [...this.folders.values()].flatMap((f) => [...f.projects.values()]);
  }

  /** The project owning `fsPath` (deepest root that contains it), if any. */
  projectFor(fsPath: string): ElideProject | undefined {
    const abs = path.resolve(fsPath);
    let best: ElideProject | undefined;
    for (const p of this.projects) {
      if (abs === p.root || abs.startsWith(`${p.root}${path.sep}`)) {
        if (!best || p.root.length > best.root.length) best = p;
      }
    }
    return best;
  }

  projectsIn(folder: vscode.WorkspaceFolder): ElideProject[] {
    return [...(this.folders.get(folder.uri.toString())?.projects.values() ?? [])];
  }

  async discover(folder: vscode.WorkspaceFolder): Promise<ElideProject[]> {
    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, `**/${MANIFEST_NAME}`), DISCOVERY_EXCLUDE);
    const state = this.folderState(folder);
    const seen = new Set<string>();
    for (const uri of found) {
      const root = path.dirname(uri.fsPath);
      seen.add(root);
      if (!state.projects.has(root)) state.projects.set(root, { root, manifestPath: uri.fsPath, folder });
    }
    for (const root of [...state.projects.keys()]) if (!seen.has(root)) state.projects.delete(root);
    this.changed.fire();
    return [...state.projects.values()];
  }

  /**
   * Workspace folder owning `uri`, plus the path spelled inside that folder.
   *
   * File watchers may report real paths (macOS: `/private/var/…` for a workspace opened as `/var/…`), which
   * `workspace.getWorkspaceFolder` does not match; fall back to comparing real paths.
   */
  locate(uri: vscode.Uri): { folder: vscode.WorkspaceFolder; fsPath: string } | undefined {
    const direct = vscode.workspace.getWorkspaceFolder(uri);
    if (direct) return { folder: direct, fsPath: uri.fsPath };
    const real = realpathOrSelf(uri.fsPath);
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const folderReal = realpathOrSelf(folder.uri.fsPath);
      if (real === folderReal || real.startsWith(`${folderReal}${path.sep}`)) {
        return { folder, fsPath: path.join(folder.uri.fsPath, path.relative(folderReal, real)) };
      }
    }
    return undefined;
  }

  addProject(manifestUri: vscode.Uri): ElideProject | undefined {
    const located = this.locate(manifestUri);
    if (!located) return undefined;
    const state = this.folderState(located.folder);
    const root = path.dirname(located.fsPath);
    let project = state.projects.get(root);
    if (!project) {
      project = { root, manifestPath: located.fsPath, folder: located.folder };
      state.projects.set(root, project);
      this.changed.fire();
    }
    return project;
  }

  removeProject(manifestUri: vscode.Uri): ElideProject | undefined {
    const located = this.locate(manifestUri);
    const state = located ? this.folders.get(located.folder.uri.toString()) : undefined;
    const root = located ? path.dirname(located.fsPath) : "";
    const project = state?.projects.get(root);
    if (state && project) {
      state.projects.delete(root);
      this.changed.fire();
    }
    return project;
  }

  removeFolder(folder: vscode.WorkspaceFolder): void {
    const state = this.folders.get(folder.uri.toString());
    state?.syncing?.abort();
    this.folders.delete(folder.uri.toString());
    this.changed.fire();
  }

  markStale(folder: vscode.WorkspaceFolder): void {
    this.folderState(folder).stale = true;
    this.ui.setStatus("stale");
  }

  markStaleAll(): void {
    for (const state of this.folders.values()) if (state.projects.size > 0) state.stale = true;
    this.ui.setStatus("stale");
  }

  isStale(folder: vscode.WorkspaceFolder): boolean {
    return this.folders.get(folder.uri.toString())?.stale ?? false;
  }

  /**
   * Whether file changes under `folder` are the sync's own doing: the CLI rewrites `.dev/elide.lock*.bin` while
   * resolving, so events during a sync and for a short grace period afterwards must not mark the folder stale.
   */
  isSelfInflicted(folder: vscode.WorkspaceFolder): boolean {
    const state = this.folders.get(folder.uri.toString());
    return state !== undefined && (state.syncing !== undefined || Date.now() < state.quietUntil);
  }

  /** Sync every folder that has at least one project. */
  async syncAll(reason: SyncReason): Promise<void> {
    const targets = [...this.folders.values()].filter((f) => f.projects.size > 0).map((f) => f.folder);
    await Promise.all(targets.map((f) => this.syncFolder(f, reason)));
  }

  /**
   * Resolve every project in `folder` through the Elide CLI, write `<folder>/workspace.json`, and hand the result
   * to the Kotlin LSP. A sync already running for the folder is cancelled and restarted.
   */
  async syncFolder(folder: vscode.WorkspaceFolder, reason: SyncReason): Promise<void> {
    const state = this.folderState(folder);
    if (state.syncing) {
      state.rerun = true;
      state.syncing.abort(new Error("superseded by a newer sync"));
      return;
    }
    const controller = new AbortController();
    state.syncing = controller;
    state.rerun = false;
    this.ui.setStatus("syncing", `Syncing Elide projects in ${folder.name} (${reason})`);
    this.ui.log(`[${new Date().toISOString()}] sync ${folder.name}: ${reason}`);

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `Elide: syncing ${folder.name}`, cancellable: true },
        async (progress, token) => {
          token.onCancellationRequested(() => controller.abort(new Error("cancelled by user")));
          await this.runSync(state, progress, controller.signal);
        },
      );
      state.stale = false;
      this.ui.setStatus("idle");
    } catch (e) {
      if (controller.signal.aborted && !state.rerun) {
        this.ui.log("sync cancelled");
        this.ui.setStatus(state.stale ? "stale" : "idle");
      } else if (!controller.signal.aborted) {
        this.ui.setStatus("error", e instanceof Error ? e.message : String(e));
        this.reportError(e);
      }
    } finally {
      state.syncing = undefined;
      state.quietUntil = Date.now() + CHANGE_GRACE_MS;
      this.changed.fire();
    }
    if (state.rerun) await this.syncFolder(folder, reason);
  }

  private async runSync(state: FolderState, progress: vscode.Progress<{ message?: string }>, signal: AbortSignal): Promise<void> {
    const folderPath = state.folder.uri.fsPath;
    const config = readConfig(state.folder);
    const dist = resolveElideDistribution({ explicitHome: config.home });
    this.ui.log(`elide: ${dist.bin}`);

    const models: ProjectModel[] = [];
    const onLine = (line: string) => this.ui.log(`  ${line}`);
    for (const project of state.projects.values()) {
      const rel = path.relative(folderPath, project.root) || ".";
      progress.report({ message: rel });
      const cli = new ElideCli(dist, project.root);
      const manifest = await cli.manifest({ onLine, signal });
      const model = await buildProjectModel(cli, manifest, {
        onLine,
        signal,
        onProgress: (step) => {
          progress.report({ message: `${rel}: ${step}` });
          this.ui.log(`  [${rel}] ${step}`);
        },
        jdk: { override: config.jdkHome },
      });
      for (const w of model.warnings) this.ui.log(`  [${rel}] warning: ${w}`);
      project.model = model;
      models.push(model);
    }
    if (signal.aborted) throw signal.reason;

    if (config.writeWorkspaceJson && models.length > 0) {
      progress.report({ message: `writing ${WORKSPACE_JSON}` });
      const ws = await writeKotlinLspWorkspace(models, folderPath);
      this.ui.log(`wrote ${path.join(folderPath, WORKSPACE_JSON)}: ${ws.modules.length} modules, ${ws.libraries.length} libraries`);
      await this.configureJdkForSymbolResolution(state.folder, models);
      await this.pinKotlinLspImporter(state.folder);
      // The JetBrains reload command may block for as long as the server's import runs; never let it hold the sync.
      void reloadKotlinLsp().then(
        (used) => this.ui.log(used ? `Kotlin LSP reload requested via ${used}` : "Kotlin LSP not running yet; it will import workspace.json on start"),
        (e) => {
          this.ui.log(`Kotlin LSP reload failed: ${e instanceof Error ? e.message : String(e)}`);
          void vscode.window.showWarningMessage("Elide: Kotlin LSP did not reload; run 'IntelliJ: Restart Language Server'.");
        },
      );
    }
  }

  /**
   * Point the Kotlin LSP at the project's JDK.
   *
   * The value is an absolute path to this machine's JDK, so it goes into user settings and never into the folder's
   * `.vscode/settings.json`: committed, it breaks every other checkout — the importer calls `Files.isDirectory` on
   * `initializationOptions.defaultSdk` and fails the whole import with "Configured Java home does not exist or is
   * not a directory". A workspace or folder value that does not resolve here is therefore cleared; one that does is
   * a deliberate project override and wins. A user-settings value the extension did not write is left alone.
   */
  private async configureJdkForSymbolResolution(folder: vscode.WorkspaceFolder, models: ProjectModel[]): Promise<void> {
    const jdk = models.find((m) => m.jdk)?.jdk;
    if (!jdk) return;
    for (const target of [vscode.ConfigurationTarget.WorkspaceFolder, vscode.ConfigurationTarget.Workspace] as const) {
      const stale = vscode.workspace.getConfiguration("intellij", folder).inspect<string>(JDK_SETTING);
      const value = target === vscode.ConfigurationTarget.WorkspaceFolder ? stale?.workspaceFolderValue : stale?.workspaceValue;
      if (typeof value !== "string" || value.length === 0 || isDirectory(value)) continue;
      try {
        await vscode.workspace.getConfiguration("intellij", folder).update(JDK_SETTING, undefined, target);
        this.ui.log(`cleared intellij.${JDK_SETTING} = ${value}: not a directory on this machine`);
      } catch (e) {
        this.ui.log(`could not clear intellij.${JDK_SETTING}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const intellij = vscode.workspace.getConfiguration("intellij", folder);
    const inspected = intellij.inspect<string>(JDK_SETTING);
    const override = [inspected?.workspaceFolderValue, inspected?.workspaceValue].find((v) => typeof v === "string" && v.length > 0);
    if (override) {
      this.ui.log(`intellij.${JDK_SETTING} left at the project's own value ${override}`);
      return;
    }
    const current = inspected?.globalValue;
    if (current === jdk.home) return;
    if (typeof current === "string" && current.length > 0 && current !== this.state.get<string>(JDK_STATE_KEY) && isDirectory(current)) {
      this.ui.log(`intellij.${JDK_SETTING} left at the user's own value ${current} (project JDK: ${jdk.home})`);
      return;
    }
    try {
      await intellij.update(JDK_SETTING, jdk.home, vscode.ConfigurationTarget.Global);
      await this.state.update(JDK_STATE_KEY, jdk.home);
      this.ui.log(`intellij.${JDK_SETTING} = ${jdk.home} (user settings)`);
    } catch (e) {
      this.ui.log(`could not write intellij.${JDK_SETTING}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Force the Kotlin LSP's JSON importer for this window.
   *
   * The server's auto-detection (`InitializeKt.planAutoImport`, intellij-server 263.x) first filters its importers
   * to the build systems — `maven`, `gradle`, `jps`, `bazel` — and only falls back to `workspace.json` when none of
   * them matches the folder. A checked-in `.idea/modules.xml` therefore wins (JPS), and a Gradle or Maven build
   * beside it makes the server prompt the user to pick a build system; `workspace.json` is never a candidate.
   * `intellij.buildTool` short-circuits detection: the importer is looked up by id over the full importer map.
   *
   * The setting is window-scoped in JetBrains.kotlin-server, so it cannot be pinned per folder: skip it when the
   * window also holds folders without an Elide project, whose Gradle/Maven import the pin would disable.
   */
  private async pinKotlinLspImporter(folder: vscode.WorkspaceFolder): Promise<void> {
    const intellij = vscode.workspace.getConfiguration("intellij", folder);
    const inspected = intellij.inspect<string>("buildTool");
    const configured = [inspected?.globalValue, inspected?.workspaceValue, inspected?.workspaceFolderValue].some(
      (v) => typeof v === "string",
    );
    if (configured) return;
    const foreign = (vscode.workspace.workspaceFolders ?? []).filter((f) => this.projectsIn(f).length === 0);
    if (foreign.length > 0) {
      this.ui.log(
        `not pinning intellij.buildTool: ${foreign.map((f) => f.name).join(", ")} ${foreign.length === 1 ? "has" : "have"} no Elide project ` +
          "and the setting is window-scoped; set intellij.buildTool to \"json\" manually if the Kotlin LSP imports the wrong project model",
      );
      return;
    }
    try {
      await intellij.update("buildTool", "json", vscode.ConfigurationTarget.Workspace);
      this.ui.log('intellij.buildTool = "json"');
    } catch (e) {
      this.ui.log(`could not write intellij.buildTool: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Logs and notifies; the notification is not awaited (it settles only when the user dismisses it). */
  private reportError(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    this.ui.log(`sync failed: ${message}`);
    if (e instanceof ElideNotFoundError || e instanceof InvalidElideHomeError) {
      void vscode.window.showErrorMessage(`Elide: ${message}`, "Set elide.home", "Install Elide").then((pick) => {
        if (pick === "Set elide.home") void vscode.commands.executeCommand("workbench.action.openSettings", "elide.home");
        else if (pick === "Install Elide") void vscode.env.openExternal(vscode.Uri.parse("https://docs.elide.dev/installation"));
      });
      return;
    }
    const summary = e instanceof ElideCommandFailedError ? `elide ${e.args.join(" ")} failed (exit ${e.exitCode ?? "signal"})` : e instanceof ManifestParseError ? e.message : message;
    void vscode.window.showErrorMessage(`Elide: ${summary}`, "Show Output").then((pick) => {
      if (pick === "Show Output") this.ui.output.show(true);
    });
  }

  private folderState(folder: vscode.WorkspaceFolder): FolderState {
    const key = folder.uri.toString();
    let state = this.folders.get(key);
    if (!state) {
      state = { folder, projects: new Map(), stale: false, rerun: false, quietUntil: 0 };
      this.folders.set(key, state);
    }
    return state;
  }

  dispose(): void {
    for (const f of this.folders.values()) f.syncing?.abort();
    this.changed.dispose();
  }
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
