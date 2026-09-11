import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  ElideCli,
  ElideCommandFailedError,
  ElideNotFoundError,
  InvalidElideHomeError,
  MANIFEST_NAME,
  MIN_ELIDE_VERSION,
  ManifestParseError,
  WORKSPACE_JSON,
  buildProjectModel,
  isNestedUnder,
  isSupportedElideVersion,
  outermostManifests,
  resolveElideDistribution,
  writeKotlinLspWorkspace,
  type BuildModelOptions,
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
  /** Message of the last failed sync; cleared by the next successful one. */
  lastError?: string;
}

export type SyncReason = "startup" | "manual" | "manifest-change" | "project-added" | "project-removed";

const DISCOVERY_EXCLUDE = "{**/.dev/**,**/node_modules/**}";
const CHANGE_GRACE_MS = 3_000;
const JDK_SETTING = "jdkForSymbolResolution";
/** Remembers the JDK path this extension wrote to user settings, so a value the user chose is never clobbered. */
const JDK_STATE_KEY = "elide.intellij.jdkForSymbolResolution";
const INSTALL_CLASSIFIERS_KEY = "elide.install.classifiers";
const MIN_VERSION_DISPLAY = `${MIN_ELIDE_VERSION.major}.${MIN_ELIDE_VERSION.minor}.${MIN_ELIDE_VERSION.patch}`;
const INSTALL_DOCS = "https://docs.elide.dev/installation";
/** Distribution homes already reported as too old, so the warning is shown once per window. */
const warnedVersions = new Set<string>();

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

  /** The tracked project rooted exactly at `root`; `undefined` for a directory whose manifest is nested and ignored. */
  projectAt(root: string): ElideProject | undefined {
    const abs = path.resolve(root);
    for (const state of this.folders.values()) {
      const project = state.projects.get(abs);
      if (project) return project;
    }
    return undefined;
  }

  /**
   * Find the projects of `folder`: every `elide.pkl` outside `.dev/` and `node_modules/`, minus the manifests nested
   * inside another project's directory, which are separate builds this one does not include.
   */
  async discover(folder: vscode.WorkspaceFolder): Promise<ElideProject[]> {
    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, `**/${MANIFEST_NAME}`), DISCOVERY_EXCLUDE);
    const manifests = outermostManifests(found.map((uri) => uri.fsPath));
    const state = this.folderState(folder);
    const seen = new Set<string>();
    for (const manifestPath of manifests) {
      const root = path.dirname(manifestPath);
      seen.add(root);
      if (!state.projects.has(root)) state.projects.set(root, { root, manifestPath, folder });
    }
    if (manifests.length < found.length) {
      const kept = new Set(manifests);
      for (const uri of found) if (!kept.has(uri.fsPath)) this.ui.log(`ignoring nested manifest: ${uri.fsPath}`);
    }
    for (const root of [...state.projects.keys()]) if (!seen.has(root)) state.projects.delete(root);
    this.changed.fire();
    this.updateProjectLabel();
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

  /**
   * Track a manifest a watcher just reported. Returns `undefined` when the manifest sits inside an existing project
   * and is therefore not imported; a manifest that encloses tracked projects takes their trees over.
   */
  addProject(manifestUri: vscode.Uri): ElideProject | undefined {
    const located = this.locate(manifestUri);
    if (!located) return undefined;
    const state = this.folderState(located.folder);
    const root = path.dirname(located.fsPath);
    const existing = state.projects.get(root);
    if (existing) return existing;
    const outer = [...state.projects.keys()].find((other) => isNestedUnder(root, other));
    if (outer) {
      this.ui.log(`ignoring nested manifest: ${located.fsPath} (inside ${outer})`);
      return undefined;
    }
    for (const inner of [...state.projects.keys()]) {
      if (!isNestedUnder(inner, root)) continue;
      state.projects.delete(inner);
      this.ui.log(`project dropped: ${inner} is now nested inside ${root}`);
    }
    const project: ElideProject = { root, manifestPath: located.fsPath, folder: located.folder };
    state.projects.set(root, project);
    this.changed.fire();
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

  /** Message of the last failed sync of `folder`, if the latest one failed. */
  lastError(folder: vscode.WorkspaceFolder): string | undefined {
    return this.folders.get(folder.uri.toString())?.lastError;
  }

  /** Name the status bar shows beside "Elide": only meaningful when the window holds exactly one project. */
  private updateProjectLabel(): void {
    const projects = this.projects;
    const only = projects.length === 1 ? projects[0] : undefined;
    this.ui.setProjectLabel(only ? (only.model?.name ?? path.basename(only.root)) : undefined);
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
      state.lastError = undefined;
      this.ui.setStatus("idle");
    } catch (e) {
      if (controller.signal.aborted && !state.rerun) {
        this.ui.log("sync cancelled");
        this.ui.setStatus(state.stale ? "stale" : "idle");
      } else if (!controller.signal.aborted) {
        state.lastError = e instanceof Error ? e.message : String(e);
        this.ui.setStatus("error", state.lastError);
        this.reportError(e);
      }
    } finally {
      state.syncing = undefined;
      state.quietUntil = Date.now() + CHANGE_GRACE_MS;
      this.updateProjectLabel();
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
    const classifiers = [...config.installClassifiers].sort();
    for (const project of state.projects.values()) {
      const rel = path.relative(folderPath, project.root) || ".";
      progress.report({ message: rel });
      const cli = new ElideCli(dist, project.root);
      const manifest = await cli.manifest({ onLine, signal });
      const options: BuildModelOptions = {
        onLine,
        signal,
        onProgress: (step) => {
          progress.report({ message: `${rel}: ${step}` });
          this.ui.log(`  [${rel}] ${step}`);
        },
        jdk: { override: config.jdkHome },
      };
      // The classifier set is applied by `elide install --slim --with …`, which the lockfile check cannot see:
      // force an install whenever it differs from the set this project was last resolved with.
      const key = `${INSTALL_CLASSIFIERS_KEY}:${project.root}`;
      const requested = JSON.stringify(classifiers);
      let model: ProjectModel;
      try {
        model = await buildProjectModel(cli, manifest, {
          ...options,
          installWith: classifiers,
          forceInstall: this.state.get<string>(key) !== requested,
        });
      } catch (e) {
        const rejectedClassifiers =
          e instanceof ElideCommandFailedError && e.args[0] === "install" && e.args.some((a) => a === "--with" || a === "--slim");
        if (!rejectedClassifiers) throw e;
        this.ui.log(`  [${rel}] elide install rejected the classifier flags; retrying with the CLI defaults`);
        model = await buildProjectModel(cli, manifest, { ...options, forceInstall: false });
      }
      await this.state.update(key, requested);
      for (const w of model.warnings) this.ui.log(`  [${rel}] warning: ${w}`);
      project.model = model;
      models.push(model);
    }
    if (signal.aborted) throw signal.reason;
    this.warnOnOldElide(dist, models[0]?.elideVersion);

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
   * Log the Elide release every sync and warn once per distribution when it predates {@link MIN_ELIDE_VERSION}:
   * an older CLI lacks flags this extension relies on (`install --with`, `test --reporter=tap`, `build --inspect`).
   */
  private warnOnOldElide(dist: ElideDistribution, version: string | undefined): void {
    if (!version) return;
    this.ui.log(`elide ${version}`);
    if (isSupportedElideVersion(version) || warnedVersions.has(dist.home)) return;
    warnedVersions.add(dist.home);
    void vscode.window
      .showWarningMessage(
        `Elide ${version} at ${dist.home} is older than ${MIN_VERSION_DISPLAY} required by this extension; some features may not work.`,
        "Installation docs",
      )
      .then((pick) => {
        if (pick) void vscode.env.openExternal(vscode.Uri.parse(INSTALL_DOCS));
      });
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
