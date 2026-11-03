import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
  buildProjectModels,
  findEnclosingWorkspace,
  formatDuration,
  isNestedUnder,
  isSupportedElideVersion,
  liveStatus,
  lockfileDigest,
  observeCommands,
  outermostManifests,
  parseManifestError,
  resolveElideDistribution,
  timelineBreakdown,
  writeKotlinLspWorkspace,
  type BuildModelOptions,
  type ElideDistribution,
  type ManifestError,
  type ManifestErrorLocation,
  type ProjectModel,
  type ProjectProgress,
  type TimelineNode,
} from "@elide/ide-core";
import * as vscode from "vscode";
import { importsWorkspaceJson, readConfig } from "./config.js";
import { addGitExclude, gitExcludeCandidate } from "./gitExclude.js";
import { KotlinLspEnvironment, KotlinSetupPendingError, awaitKotlinDebuggerAnalysis, jetBrainsComposeCompilerPlugin, jetBrainsServerDirectory, notifyKotlinSetupPending, reloadKotlinLsp } from "./jetbrains.js";
import { KomodoLanguageServer, type KomodoDebugLaunch, type KomodoPreviewSession, type KomodoPreviews, type KomodoSettings } from "./komodoLsp.js";
import { probeSourceRoot } from "./kotlinAnalysis.js";
import { kotlinLspPlugin, withoutKotlinLspPlugin } from "./kotlinLspPlugin.js";
import { moduleReaders, projectModules } from "./manifestModules.js";
import type { ElideUi } from "./output.js";

export interface ElideProject {
  /** Absolute project root (directory containing `elide.pkl`). */
  root: string;
  manifestPath: string;
  folder: vscode.WorkspaceFolder;
  model?: ProjectModel;
  /**
   * Root of the Elide workspace this project is a member of. Members are never discovered on their own: their
   * manifests are nested in the root's directory, and they are tracked once a sync of the root has read its member
   * list. They are synced, installed and invalidated as part of that root.
   */
  workspaceRoot?: string;
  /**
   * Digest of the `.dev/elide.lock*.bin` content this extension has already accounted for; `undefined` until the
   * project's lockfiles have been read once. See {@link ElideWorkspace.lockfileChanged}.
   */
  lockDigest?: string;
  /** Local Pkl modules its manifests read, other than manifests; see {@link ElideWorkspace.refreshModules}. */
  modules?: readonly string[];
}

interface FolderState {
  folder: vscode.WorkspaceFolder;
  projects: Map<string, ElideProject>;
  stale: boolean;
  /** How often the folder was marked stale; a sync clears `stale` only if no mark arrived while it ran. */
  staleMarks: number;
  /** `staleMarks` when the last successful sync started: a sync after a later mark installs dependencies anew. */
  installedMarks: number;
  syncing?: AbortController;
  /** Re-run requested while a sync was in flight. */
  rerun: boolean;
  /** Timestamp until which lockfile events are attributed to the sync itself. */
  quietUntil: number;
  /** Message of the last failed sync; cleared by the next successful one. */
  lastError?: string;
  /** Whether the last failed sync found no usable Elide distribution, which a new `elide.home` may provide. */
  elideMissing: boolean;
}

export type SyncReason = "startup" | "manual" | "manifest-change" | "project-added" | "project-removed";

const DISCOVERY_EXCLUDE = "{**/.dev/**,**/node_modules/**}";
const CHANGE_GRACE_MS = 3_000;
/** How long a sync runs before its progress notification appears; quicker ones only touch the status bar. */
const NOTIFICATION_DELAY_MS = 2_000;
const JDK_SETTING = "jdkForSymbolResolution";
/** Remembers the JDK path this extension wrote to user settings, so a value the user chose is never clobbered. */
const JDK_STATE_KEY = "elide.intellij.jdkForSymbolResolution";
const INSTALL_CLASSIFIERS_KEY = "elide.install.classifiers";
/** Settings a folder's models are resolved with (build flags reach the manifest as `build.flags`); see {@link ElideWorkspace.settingsChanged}. */
const MODEL_SETTINGS = ["elide.flags", "elide.home", "elide.jdk.home", "elide.install.classifiers"];
/** The answer to {@link ElideWorkspace.offerWorkspaceJsonExclude}, per folder. */
const WORKSPACE_JSON_EXCLUDE_KEY = "elide.workspaceJson.gitExclude";
/**
 * Files at a folder root that make the Kotlin LSP's auto-detection import another build instead of `workspace.json`:
 * Maven, Gradle, IntelliJ (JPS) and Bazel. See {@link ElideWorkspace.pinKotlinLspImporter}.
 */
const COMPETING_BUILD_FILES = [
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  ".idea",
  "MODULE.bazel",
  "WORKSPACE",
  "WORKSPACE.bazel",
];
const MIN_VERSION_DISPLAY = `${MIN_ELIDE_VERSION.major}.${MIN_ELIDE_VERSION.minor}.${MIN_ELIDE_VERSION.patch}`;
const INSTALL_DOCS = "https://docs.elide.dev/installation";
/** Distribution homes already reported as too old, so the warning is shown once per window. */
const warnedVersions = new Set<string>();
/** Workspace roots already offered for a folder, so the prompt is shown once per window. */
const offeredRoots = new Set<string>();
/** Folders whose `workspace.json` exclusion was offered in this window; a dismissed offer returns in the next. */
const offeredExcludes = new Set<string>();

/** Tracks Elide projects per workspace folder and runs syncs against the CLI. */
export class ElideWorkspace implements vscode.Disposable {
  private readonly folders = new Map<string, FolderState>();
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires after any sync completes or the project set changes. */
  readonly onDidChange = this.changed.event;
  private readonly modulesChanged = new vscode.EventEmitter<void>();
  /** Fires once {@link refreshModules} has recorded what the projects read. */
  readonly onDidChangeModules = this.modulesChanged.event;
  private modulesGeneration = 0;
  private readonly kotlinLspEnvironment = new KotlinLspEnvironment();
  /** Elide's Kotlin server plugin, once a sync of a Compose project has built it. */
  private kotlinLspPluginPath?: string;
  private kotlinLspReady: Promise<unknown> = Promise.resolve();
  /** Where the manifest errors of failed syncs point; see {@link publishManifestError}. */
  private readonly manifestDiagnostics = vscode.languages.createDiagnosticCollection("elide-manifest");
  /** The file each folder's last failed sync put a manifest error on, keyed by folder URI. */
  private readonly manifestErrorFiles = new Map<string, vscode.Uri>();
  /** Komodo's language server: one for the window, over the folders whose `elide.kotlinLsp.server` is `komodo`. */
  private readonly komodoServer: KomodoLanguageServer;
  /** Manifests {@link writeManifest} writes, by path: the text it left there, or `null` while it is still writing. */
  private readonly manifestWrites = new Map<string, string | null>();

  constructor(
    private readonly ui: ElideUi,
    private readonly state: vscode.Memento,
    /** `media/kotlin-lsp`: sources of the plugin loaded into the Kotlin LSP. */
    private readonly kotlinLspPluginSources: string,
    /** Machine-local cache (global storage). */
    private readonly cacheRoot: string,
  ) {
    this.komodoServer = new KomodoLanguageServer(cacheRoot, (message) => this.ui.log(message));
  }

  get projects(): ElideProject[] {
    return [...this.folders.values()].flatMap((f) => [...f.projects.values()]);
  }

  /** Effective live state, not the persisted engine preference. */
  get komodoAvailable(): boolean { return this.komodoServer.available; }
  get komodoPreviewAvailable(): boolean { return this.komodoServer.previewAvailable; }
  get onDidChangeKomodoAvailability(): vscode.Event<void> { return this.komodoServer.onDidChangeAvailability; }

  requireKomodoPreview(file: string): Promise<void> { return this.komodoServer.requirePreview(file); }
  rejectKomodoPreview(reason: string): void { this.komodoServer.rejectPreview(reason); }

  /** Only Komodo-dependent debug actions are withdrawn; Java/JetBrains and native-image debugging are unchanged. */
  komodoDebugAvailable(folder: vscode.WorkspaceFolder): boolean {
    return readConfig(folder).debugAdapter !== "komodo" ||
      (readConfig(folder).kotlinLspServer === "komodo" && this.komodoAvailable);
  }

  /** `file`'s Compose previews from Komodo's language server (see {@link KomodoLanguageServer.previews}). */
  komodoPreviews(file: string): Promise<KomodoPreviews> {
    return this.komodoServer.previews(file);
  }

  /** A Compose preview session in Komodo's language server for `file` (see {@link KomodoLanguageServer.previewSession}). */
  komodoPreviewSession(file: string): Promise<KomodoPreviewSession> {
    return this.komodoServer.previewSession(file);
  }

  komodoPreviewSync(files: readonly string[]): Promise<void> {
    return this.komodoServer.syncPreview(files);
  }


  private get hasAndroidProjects(): boolean {
    return this.projects.some((project) => project.model?.android !== undefined);
  }

  /** Launch only after this window's Android transport default has reached a new Kotlin server. */
  async prepareAndroidDebugger(): Promise<void> {
    await this.kotlinLspReady;
    if (this.configureKotlinLspEnvironment()) {
      this.kotlinLspReady = reloadKotlinLsp(true, true);
      await this.kotlinLspReady;
    }
  }

  /**
   * What Komodo's debug adapter runs with for `folder` (`elide.debug.adapter` `komodo`): the launcher, project manifest
   * and JDK of the Komodo language server its sync configured. Throws, saying why, when there is none yet.
   */
  async komodoDebugLaunch(folder: vscode.WorkspaceFolder): Promise<KomodoDebugLaunch> {
    try {
      return await this.komodoServer.debugLaunch(folder);
    } catch (error) {
      if (this.folders.get(folder.uri.toString())?.syncing) {
        throw new Error(`'${folder.name}' is still syncing: Komodo's debugger needs the project manifest the sync writes; debug again once it finishes.`);
      }
      throw error;
    }
  }

  /**
   * Hold a JetBrains debug session of the project at `root` until the Kotlin LSP has imported this window's
   * `workspace.json` and indexed it: the session keeps the analysis it starts with. `false` once the user cancels.
   */
  async kotlinDebuggerReady(root: string, signal: AbortSignal): Promise<boolean> {
    await this.kotlinLspReady.catch(() => undefined);
    // One server per window, rooted at the first folder: only that folder's workspace.json is what it imports.
    const lspFolder = vscode.workspace.workspaceFolders?.[0];
    const project = this.projectAt(root) ?? this.projectFor(root);
    const imported = lspFolder && project?.folder.uri.toString() === lspFolder.uri.toString() && importsWorkspaceJson(readConfig(lspFolder));
    const source = imported ? probeSourceRoot([project.model, ...this.projectsIn(lspFolder).map((p) => p.model)], existsSync) : undefined;
    const server = createHash("sha256").update(lspFolder?.uri.fsPath ?? root).digest("hex").slice(0, 16);
    return awaitKotlinDebuggerAnalysis(
      source && vscode.Uri.file(source).toString(),
      path.join(this.cacheRoot, "kotlin-lsp-readiness", server),
      signal,
      (message) => this.ui.log(message),
    );
  }

  /**
   * Apply this window's Kotlin server launch options ({@link KotlinLspEnvironment}): the Android debugger default
   * while an Android project is open, Elide's plugin while a Compose project is. `true` when they changed, which
   * takes a new server.
   */
  private configureKotlinLspEnvironment(): boolean {
    const compose = this.projects.some((project) => project.model?.kotlin.compose);
    const plugin = compose ? this.kotlinLspPluginPath : undefined;
    return this.kotlinLspEnvironment.configure({ androidDebugger: this.hasAndroidProjects, ...(plugin ? { plugin } : {}) },
      vscode.workspace.getConfiguration("intellij").get<string[]>("additionalJvmArgs") ?? []);
  }

  /**
   * The project owning `fsPath` (deepest root that contains it), if any. Inside an Elide workspace that is the member
   * holding the file rather than the root, whose directory contains it as well.
   */
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

  /** The members of the workspace rooted at `root`, in declaration order; empty for a standalone project. */
  membersOf(root: string): ElideProject[] {
    const project = this.projectAt(root);
    return (project?.model?.members ?? []).map((member) => this.projectAt(member)).filter((p): p is ElideProject => p !== undefined);
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
   * inside another project's directory. Those are either members of the enclosing project's workspace, which its
   * sync attaches, or separate builds that project does not include. Members already attached are kept along with
   * their root.
   */
  async discover(folder: vscode.WorkspaceFolder): Promise<ElideProject[]> {
    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, `**/${MANIFEST_NAME}`), DISCOVERY_EXCLUDE);
    const manifests = outermostManifests(found.map((uri) => uri.fsPath));
    const state = this.folderState(folder);
    const seen = new Set<string>();
    for (const manifestPath of manifests) {
      const root = path.dirname(manifestPath);
      seen.add(root);
      if (state.projects.has(root)) continue;
      // Seed the lockfile digest right away: the first `elide` invocation after discovery rewrites the lockfile,
      // and without a baseline that rewrite is indistinguishable from a dependency change.
      state.projects.set(root, { root, manifestPath, folder, lockDigest: await lockfileDigest(root) });
    }
    if (manifests.length < found.length) {
      const kept = new Set(manifests);
      for (const uri of found) {
        if (kept.has(uri.fsPath) || state.projects.get(path.dirname(uri.fsPath))?.workspaceRoot) continue;
        this.ui.log(`nested manifest not tracked on its own: ${uri.fsPath}`);
      }
    }
    for (const [root, project] of [...state.projects]) {
      if (!seen.has(root) && !(project.workspaceRoot && seen.has(project.workspaceRoot))) state.projects.delete(root);
    }
    this.notifyChanged();
    this.updateProjectLabel();
    this.refreshStatus();
    const projects = [...state.projects.values()];
    for (const project of projects) if (!project.workspaceRoot) this.offerWorkspaceRoot(project);
    return projects;
  }

  /**
   * Point out the Elide workspace `project` belongs to when its root sits above the opened folder.
   *
   * A member opened on its own resolves without the workspace: the CLI still puts its siblings' JARs on the
   * classpath, but those are build outputs of projects this window does not hold, so their sources resolve to
   * nothing until the root is opened. The prompt offers exactly that, once per root per window.
   */
  private offerWorkspaceRoot(project: ElideProject): void {
    const folderPath = project.folder.uri.fsPath;
    const enclosing = findEnclosingWorkspace(project.root);
    if (!enclosing || isNestedUnder(enclosing.root, folderPath) || enclosing.root === path.resolve(folderPath)) return;
    this.ui.log(`${project.root} is member '${enclosing.member}' of the Elide workspace at ${enclosing.root}`);
    if (offeredRoots.has(enclosing.root)) return;
    offeredRoots.add(enclosing.root);
    const open = "Open Workspace Root";
    void vscode.window
      .showInformationMessage(
        `Elide: ${path.basename(project.root)} is a member of the workspace at ${enclosing.root}. Open the root to resolve its sibling projects.`,
        open,
      )
      .then((pick) => {
        if (pick === open) void vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(enclosing.root));
      });
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
    // Out of date until its first sync, which the watcher schedules.
    const project: ElideProject = { root, manifestPath: located.fsPath, folder: located.folder };
    state.projects.set(root, project);
    state.stale = true;
    this.notifyChanged();
    this.refreshStatus();
    return project;
  }

  /** Drops the project whose manifest `manifestUri` is; dropping a workspace root drops its members with it. */
  removeProject(manifestUri: vscode.Uri): ElideProject | undefined {
    const located = this.locate(manifestUri);
    const state = located ? this.folders.get(located.folder.uri.toString()) : undefined;
    const root = located ? path.dirname(located.fsPath) : "";
    const project = state?.projects.get(root);
    if (state && project) {
      state.projects.delete(root);
      for (const [other, p] of [...state.projects]) if (p.workspaceRoot === root) state.projects.delete(other);
      this.notifyChanged();
      this.refreshStatus();
    }
    return project;
  }

  /**
   * The project whose sync reads the manifest at `uri`, after a watcher saw it change or (`created`) appear: the
   * project it is the manifest of, or the project whose directory it is nested in, when that project's sync reads it.
   * Members are tracked only once a sync of their root succeeds, so the manifest of a member whose error failed that
   * sync is found through the root; a new manifest may also be a member a workspace already declares. Any other nested
   * manifest belongs to a build of its own and is not a reason to sync.
   */
  manifestOwner(uri: vscode.Uri, created = false): ElideProject | undefined {
    const located = this.locate(uri);
    if (!located) return undefined;
    const root = path.dirname(located.fsPath);
    const project = this.projectAt(root);
    if (project) return project;
    const owner = this.projectFor(root);
    if (!owner) return undefined;
    const inWorkspace = owner.workspaceRoot !== undefined || (owner.model?.members.length ?? 0) > 0;
    return (created && inWorkspace) || this.lastError(owner.folder) !== undefined ? owner : undefined;
  }

  /**
   * Run `write`, which writes the manifest at `file` (Add Workspace Member generating a member or declaring it in its
   * root), so that the watcher events it causes are not taken for someone's edit: the writer syncs on its own, and
   * the reload prompt, or the watcher's own sync superseding the writer's, is noise. See {@link isOwnManifestWrite}.
   */
  async writeManifest<T>(file: string, write: () => Promise<T>): Promise<T> {
    const key = path.resolve(file);
    this.manifestWrites.set(key, null);
    try {
      return await write();
    } finally {
      const text = await readFile(key, "utf8").catch(() => undefined);
      if (text === undefined) this.manifestWrites.delete(key);
      else this.manifestWrites.set(key, text);
    }
  }

  /**
   * Whether a watcher event for the manifest at `uri` reports {@link writeManifest}'s write rather than someone's
   * edit: the write is under way, or the file still holds the text it left. Events arrive after the write, so that
   * text is kept until an event finds other text, which is an edit.
   */
  async isOwnManifestWrite(uri: vscode.Uri): Promise<boolean> {
    const key = path.resolve(this.locate(uri)?.fsPath ?? uri.fsPath);
    const written = this.manifestWrites.get(key);
    if (written === undefined) return false;
    if (written === null || (await readFile(key, "utf8").catch(() => undefined)) === written) return true;
    if (this.manifestWrites.get(key) === written) this.manifestWrites.delete(key);
    return false;
  }

  /**
   * Forget a folder that left the window: its sync stops without a rerun and its manifest error goes. A debounced or
   * prompted sync, or a stale mark, that arrives for it later is ignored (see {@link isOpen}).
   */
  removeFolder(folder: vscode.WorkspaceFolder): void {
    const state = this.folders.get(folder.uri.toString());
    if (state) {
      state.rerun = false;
      state.syncing?.abort();
    }
    this.folders.delete(folder.uri.toString());
    this.publishManifestError(folder, undefined);
    void this.komodoServer.remove(folder, komodoSettings());
    if (this.configureKotlinLspEnvironment()) {
      this.kotlinLspReady = this.kotlinLspReady.catch(() => undefined).then(() => reloadKotlinLsp(true, this.hasAndroidProjects));
      void this.kotlinLspReady.catch((error) => this.ui.log(`Kotlin LSP restart failed: ${String(error)}`));
    }
    this.notifyChanged();
    this.refreshStatus();
  }

  /**
   * Re-read the local Pkl modules every project's manifests read: they change with the manifests, which a sync has
   * just read, or with the project set. Only the latest of overlapping refreshes is recorded.
   */
  async refreshModules(): Promise<void> {
    const generation = ++this.modulesGeneration;
    const projects = this.projects;
    const modules = await projectModules(projects);
    if (generation !== this.modulesGeneration) return;
    for (const project of projects) project.modules = modules.get(project.root);
    this.modulesChanged.fire();
  }

  /** Every module {@link refreshModules} found, with the folders whose projects read it. */
  moduleReaders(): Map<string, vscode.WorkspaceFolder[]> {
    return moduleReaders(this.projects);
  }

  private notifyChanged(): void {
    this.changed.fire();
    void this.refreshModules();
  }

  /** Mark `folder` out of date after a change to what its projects resolve from; see {@link FolderState.staleMarks}. */
  markStale(folder: vscode.WorkspaceFolder): void {
    if (!this.isOpen(folder)) return;
    const state = this.folderState(folder);
    state.stale = true;
    state.staleMarks++;
    this.refreshStatus();
  }

  isStale(folder: vscode.WorkspaceFolder): boolean {
    return this.folders.get(folder.uri.toString())?.stale ?? false;
  }

  /** Message of the last failed sync of `folder`, if the latest one failed. */
  lastError(folder: vscode.WorkspaceFolder): string | undefined {
    return this.folders.get(folder.uri.toString())?.lastError;
  }

  /** Whether a sync of `folder` is running; {@link onDidChange} fires when it ends. */
  isSyncing(folder: vscode.WorkspaceFolder): boolean {
    return this.folders.get(folder.uri.toString())?.syncing !== undefined;
  }

  /**
   * Name the status bar shows beside "Elide": only meaningful when the window holds exactly one project, counting a
   * workspace as the one project it builds as.
   */
  private updateProjectLabel(): void {
    const projects = this.projects.filter((p) => !p.workspaceRoot);
    const only = projects.length === 1 ? projects[0] : undefined;
    this.ui.setProjectLabel(only ? (only.model?.name ?? path.basename(only.root)) : undefined);
  }

  /**
   * Show the worst state of the folders with projects in the status bar: a failed sync, then one out of date, then
   * in sync; nothing without projects. Folders sync side by side, so the one that finished last speaks for none of
   * the others.
   */
  private refreshStatus(): void {
    const states = [...this.folders.values()].filter((state) => state.projects.size > 0);
    const failed = states.find((state) => state.lastError !== undefined);
    if (failed) this.ui.setStatus("error", failed.lastError);
    else if (states.some((state) => state.stale)) this.ui.setStatus("stale");
    else this.ui.setStatus(states.length > 0 ? "idle" : "none");
  }

  /**
   * Whether a lockfile event under `folder` is the sync's own doing: the CLI rewrites `.dev/elide.lock*.bin` while
   * resolving, so events during a sync and for a short grace period afterwards must not mark the folder stale. A sync
   * never writes a manifest, so a manifest event is always someone's edit.
   */
  isSelfInflicted(folder: vscode.WorkspaceFolder): boolean {
    const state = this.folders.get(folder.uri.toString());
    return state !== undefined && (state.syncing !== undefined || Date.now() < state.quietUntil);
  }

  /**
   * Whether a `.dev/elide.lock*.bin` event means `project` resolves to different dependencies than the ones its
   * model was built from, recording the observed content either way.
   *
   * Every `elide` invocation rewrites the lockfile: `elide run`, `elide test` and `elide build` all bump its mtime
   * while writing the same bytes back, which the file watcher reports as a change. Comparing content keeps those
   * rewrites — including ones started outside this extension, e.g. from a terminal — from asking for a re-import.
   * A project whose lockfiles have never been read has no baseline to compare against, so the first event only
   * records one.
   */
  async lockfileChanged(project: ElideProject): Promise<boolean> {
    const digest = await lockfileDigest(project.root);
    const previous = project.lockDigest;
    project.lockDigest = digest;
    return previous !== undefined && previous !== digest;
  }

  /**
   * Sync every folder that has at least one project and that `include` accepts; a folder it declines, such as one
   * whose `elide.sync.onStartup` is off, is left out of date until synced.
   */
  async syncAll(reason: SyncReason, include: (folder: vscode.WorkspaceFolder) => boolean = () => true): Promise<void> {
    const targets: vscode.WorkspaceFolder[] = [];
    for (const state of this.folders.values()) {
      if (state.projects.size === 0) continue;
      if (include(state.folder)) targets.push(state.folder);
      else state.stale = true;
    }
    this.refreshStatus();
    await Promise.all(targets.map((f) => this.syncFolder(f, reason)));
  }

  /**
   * Track a folder added to the window and treat its projects as startup does: synced, unless the folder's
   * `elide.sync.onStartup` is off, which leaves them out of date until synced.
   */
  async addFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    if ((await this.discover(folder)).length === 0) return;
    if (readConfig(folder).syncOnStartup) {
      await this.syncFolder(folder, "startup");
      return;
    }
    this.folderState(folder).stale = true;
    this.refreshStatus();
  }

  /** Whether `folder` is still open in the window: a debounced or prompted sync may come after it left. */
  private isOpen(folder: vscode.WorkspaceFolder): boolean {
    return (vscode.workspace.workspaceFolders ?? []).some((open) => open.uri.toString() === folder.uri.toString());
  }

  /**
   * Resolve every project in `folder` through the Elide CLI, write `<folder>/workspace.json`, and hand the result
   * to the Kotlin LSP. A sync already running for the folder is cancelled and restarted.
   *
   * A workspace is resolved from its root, members included, and the members its manifest declares replace the ones
   * tracked before.
   */
  async syncFolder(folder: vscode.WorkspaceFolder, reason: SyncReason): Promise<void> {
    if (!this.isOpen(folder)) return;
    const state = this.folderState(folder);
    if (state.syncing) {
      state.rerun = true;
      state.syncing.abort(new Error("superseded by a newer sync"));
      return;
    }
    const controller = new AbortController();
    state.syncing = controller;
    state.rerun = false;
    const marks = state.staleMarks;
    const cancel = () => controller.abort(new Error("cancelled by user"));
    const sync = this.ui.activity.start(`Sync ${folder.name}`, { detail: reason, cancel });
    this.ui.trackSync(sync);
    this.ui.log(`[${new Date().toISOString()}] sync ${folder.name}: ${reason}`);
    const notification = this.notifyProgress(folder, sync, cancel);

    try {
      await this.runSync(state, sync, controller.signal, state.installedMarks !== marks);
      sync.end("succeeded");
      this.ui.log(`sync ${folder.name} finished in ${formatDuration(sync.durationMs)}`);
      for (const row of timelineBreakdown(sync)) this.ui.log(`  ${row}`);
      // An edit made while the sync ran may have come after the sync read the file: it still needs a sync.
      state.stale = state.staleMarks !== marks;
      state.installedMarks = marks;
      state.lastError = undefined;
      state.elideMissing = false;
      this.publishManifestError(folder, undefined);
      this.refreshStatus();
    } catch (e) {
      if (controller.signal.aborted && !state.rerun) {
        sync.end("cancelled", "cancelled");
        this.ui.log("sync cancelled");
        // A project that never synced has no model to be in sync with.
        if ([...state.projects.values()].some((project) => !project.model)) state.stale = true;
        this.refreshStatus();
      } else if (!controller.signal.aborted) {
        state.lastError = e instanceof Error ? e.message : String(e);
        state.elideMissing = e instanceof ElideNotFoundError || e instanceof InvalidElideHomeError;
        sync.end("failed", state.lastError);
        this.refreshStatus();
        this.reportError(e, sync, folder);
      } else sync.end("cancelled", "superseded by a newer sync");
    } finally {
      notification.dispose();
      state.syncing = undefined;
      state.quietUntil = Date.now() + CHANGE_GRACE_MS;
      this.updateProjectLabel();
      this.notifyChanged();
    }
    if (state.rerun) await this.syncFolder(folder, reason);
  }

  /**
   * A notification naming the step in progress, with Cancel, for a sync still running after a moment: VS Code keeps
   * window progress to a spinner, and a sync that installs dependencies or builds can take minutes.
   */
  private notifyProgress(folder: vscode.WorkspaceFolder, sync: TimelineNode, cancel: () => void): vscode.Disposable {
    if (!readConfig(folder).syncNotification) return new vscode.Disposable(() => {});
    const finished = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      void vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Elide: syncing ${folder.name}`, cancellable: true },
        async (progress, token) => {
          token.onCancellationRequested(cancel);
          const report = () => {
            const now = liveStatus(sync);
            progress.report({ message: `${sync.phase?.label ?? "starting"}${now ? ` — ${now}` : ""} (${formatDuration(sync.durationMs)})` });
          };
          report();
          const subscription = this.ui.activity.onDidChangeOperation((operation) => {
            if (operation === sync) report();
          });
          await finished.promise;
          subscription.dispose();
        },
      );
    }, NOTIFICATION_DELAY_MS);
    return new vscode.Disposable(() => {
      clearTimeout(timer);
      finished.resolve();
    });
  }

  /**
   * Resolve the folder's projects as steps of `sync`: every step the model builder reports, every CLI process it
   * starts, and the build tasks those report, each timed; the Elide output channel gets the same narrative.
   */
  private async runSync(state: FolderState, sync: TimelineNode, signal: AbortSignal, changed: boolean): Promise<void> {
    const folderPath = state.folder.uri.fsPath;
    const config = readConfig(state.folder);
    const dist = resolveElideDistribution({ explicitHome: config.home });
    this.ui.log(`elide: ${dist.bin}`);

    const models: ProjectModel[] = [];
    const classifiers = [...config.installClassifiers].sort();
    const roots = [...state.projects.values()].filter((p) => !p.workspaceRoot);
    for (const project of roots) {
      const rel = path.relative(folderPath, project.root) || ".";
      // Several projects in one folder each get a step of their own; a lone project's steps are the sync's.
      const parent = roots.length > 1 ? sync.start(rel) : sync;
      let step = parent;
      const begin = (label: string) => {
        if (step !== parent) step.end();
        step = parent.start(label);
        this.ui.log(`  [${rel}] ${label}`);
      };
      const onCommand = observeCommands(() => step, (line) => this.ui.log(`    ${line}`));
      // Projects resolve side by side, each a step of the phase that resolves them with its own steps and processes.
      const onProject = (name: string): ProjectProgress => {
        const node = step.start(name);
        let phase = node;
        return {
          onProgress: (label) => {
            if (phase !== node) phase.end();
            phase = node.start(label);
            this.ui.log(`  [${rel}] ${label}`);
          },
          onCommand: observeCommands(() => phase, (line) => this.ui.log(`    [${name}] ${line}`)),
          end: (outcome, error) => {
            if (outcome === "succeeded") node.end();
            else node.end(outcome, outcome === "failed" ? (error instanceof Error ? error.message : String(error)) : undefined);
          },
        };
      };
      try {
        const cli = new ElideCli(dist, project.root, config.flags);
        begin("Reading the project manifest");
        const manifest = await cli.manifest({ onCommand, signal });
        const options: BuildModelOptions = { onCommand, onProject, signal, onProgress: begin, jdk: { override: config.jdkHome } };
        // The classifier set is applied by `elide install --slim --with …`, which the lockfile check cannot see:
        // force an install whenever it differs from the set this project was last resolved with. So is a change since
        // the last sync: any `elide` command run after it, such as a superseded sync's classpath query, rewrites the
        // lockfile, which then looks newer than the edit.
        const key = `${INSTALL_CLASSIFIERS_KEY}:${project.root}`;
        const requested = JSON.stringify(classifiers);
        const forceInstall = changed || this.state.get<string>(key) !== requested;
        let resolved: ProjectModel[];
        try {
          resolved = await buildProjectModels(cli, manifest, { ...options, installWith: classifiers, forceInstall });
        } catch (e) {
          // Only a release without `--slim`/`--with` gets its defaults instead; any other install failure is the sync's.
          if (!(e instanceof ElideCommandFailedError && e.args[0] === "install" && rejectedOption(e, ["--slim", "--with"]))) throw e;
          this.ui.log(`  [${rel}] elide install rejected the classifier flags; retrying with the CLI defaults`);
          step.end("failed", "classifier flags rejected; retrying with the CLI defaults");
          step = parent;
          resolved = await buildProjectModels(cli, manifest, { ...options, forceInstall });
        }
        if (step !== parent) step.end();
        step = parent;
        await this.state.update(key, requested);
        for (const model of resolved) {
          const where = path.relative(folderPath, model.root) || ".";
          for (const w of model.warnings) {
            this.ui.log(`  [${where}] warning: ${w}`);
            parent.log(`[${where}] warning: ${w}`);
          }
        }
        const [model, ...members] = resolved;
        if (parent !== sync) parent.end("succeeded", members.length > 0 ? `${members.length} member${members.length === 1 ? "" : "s"}` : undefined);
        if (!model) continue;
        project.model = model;
        await this.attachMembers(state, project, members);
        // The model was resolved from whatever `elide install` left behind: that content is now the baseline. A
        // workspace records its one lockfile at the root.
        project.lockDigest = await lockfileDigest(project.root);
        models.push(...resolved);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (step !== parent) step.end(signal.aborted ? "cancelled" : "failed", message);
        if (parent !== sync) parent.end(signal.aborted ? "cancelled" : "failed", message);
        throw e;
      }
    }
    if (signal.aborted) throw signal.reason;
    this.warnOnOldElide(dist, models[0]?.elideVersion);

    // With Komodo the folder has no JetBrains import: no workspace.json, no JetBrains server configuration or reload.
    if (importsWorkspaceJson(config) && models.length > 0) {
      await sync.run(`Writing ${WORKSPACE_JSON}`, async (step) => {
        const composeCompilerPlugin = jetBrainsComposeCompilerPlugin();
        if (models.some((model) => model.kotlin.compose) && !composeCompilerPlugin) {
          this.ui.log("Compose analysis needs the bundled Compose IDE plugin from the JetBrains Kotlin extension; update that extension and sync again.");
        }
        const ws = await writeKotlinLspWorkspace(models, folderPath, { composeCompilerPlugin });
        step.setDetail(`${ws.modules.length} modules · ${ws.libraries.length} libraries`);
        this.ui.log(`wrote ${path.join(folderPath, WORKSPACE_JSON)}: ${ws.modules.length} modules, ${ws.libraries.length} libraries`);
      });
      void this.offerWorkspaceJsonExclude(state.folder);
      signal.throwIfAborted();
      await sync.run("Configuring the Kotlin LSP", async () => {
        // The server reads one JDK for the window: the first folder it imports sets it, not whichever syncs last.
        const jdkFolder = (vscode.workspace.workspaceFolders ?? []).find((f) => this.projectsIn(f).length > 0 && importsWorkspaceJson(readConfig(f)));
        if (jdkFolder?.uri.toString() === state.folder.uri.toString()) await this.configureJdkForSymbolResolution(models);
        await this.pinKotlinLspImporter(state.folder);
        await this.forgetKotlinLspPluginSetting();
        if (models.some((model) => model.kotlin.compose)) await this.prepareKotlinLspPlugin(signal);
      });
      // Cancelled here, the server keeps what it has. Past this check the launch options change, and a change must
      // reach the server: the next sync would see none left to apply.
      signal.throwIfAborted();
      const restart = this.configureKotlinLspEnvironment();
      // The JetBrains reload command may block for as long as the server's import runs; never let it hold the sync.
      this.kotlinLspReady = this.kotlinLspReady.catch(() => undefined).then(() => reloadKotlinLsp(restart, this.hasAndroidProjects));
      void this.kotlinLspReady.then(
        (used) => this.ui.log(used ? `Kotlin LSP ${restart ? "restart" : "reload"} requested via ${used}` : "Kotlin LSP not running yet; it will import workspace.json on start"),
        (e) => {
          if (e instanceof KotlinSetupPendingError) {
            this.ui.log(`Kotlin LSP not started: ${e.message}`);
            notifyKotlinSetupPending(e.steps, { once: true });
            return;
          }
          this.ui.log(`Kotlin LSP ${restart ? "restart" : "reload"} failed: ${e instanceof Error ? e.message : String(e)}`);
          void vscode.window.showWarningMessage(`Elide: Kotlin LSP did not ${restart ? "restart" : "reload"}; run 'IntelliJ: Restart Language Server'.`);
        },
      );
    }
    if (config.kotlinLspServer === "komodo" && models.length > 0) {
      signal.throwIfAborted();
      await sync.run("Checking Komodo native services", async (step) => {
        // Native-service failure disables its dependents, not the resolved project model or unrelated build steps.
        step.setDetail(await this.komodoServer.sync(state.folder, models, { ...komodoSettings(), signal }));
      });
    } else {
      await this.komodoServer.remove(state.folder, komodoSettings());
    }
  }

  /**
   * Apply a settings change to the folders it concerns without waiting for the next sync. A change of what a folder's
   * models were resolved with ({@link MODEL_SETTINGS}) leaves it out of date; a new `elide.home` syncs a folder whose
   * last sync found no Elide, since that is what the failure asked the user to set. A folder that switched servers
   * syncs again (the JetBrains server needs its `workspace.json`), and Komodo restarts with the models the folders
   * already have when its launch settings or the distribution it comes from change.
   */
  settingsChanged(event: vscode.ConfigurationChangeEvent): void {
    for (const state of this.folders.values()) {
      if (state.projects.size === 0) continue;
      const folder = state.folder;
      if (event.affectsConfiguration("elide.kotlinLsp.server", folder) || (state.elideMissing && event.affectsConfiguration("elide.home", folder))) {
        if (readConfig(folder).kotlinLspServer === "komodo") this.komodoServer.invalidate("the Kotlin language server configuration changed");
        else void this.komodoServer.remove(folder, komodoSettings());
        void this.syncFolder(folder, "manual");
        continue;
      }
      const changed = MODEL_SETTINGS.filter((key) => event.affectsConfiguration(key, folder));
      if (changed.length > 0) {
        this.ui.log(`${changed.join(", ")} changed: sync ${folder.name} to re-resolve the project model`);
        this.markStale(folder);
      }
      // Komodo's launch settings are read for the window, like the distribution it runs from (see komodoSettings).
      const komodo = event.affectsConfiguration("elide.kotlinLsp.komodo") || event.affectsConfiguration("elide.home");
      if (!komodo || readConfig(folder).kotlinLspServer !== "komodo") continue;
      const models = [...state.projects.values()].flatMap((project) => (project.model ? [project.model] : []));
      if (models.length === 0) continue;
      void this.komodoServer.sync(folder, models, komodoSettings()).then(
        (detail) => this.ui.log(`Komodo: ${detail}`),
        (error: unknown) => this.ui.log(`Komodo language server: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
  }

  /**
   * Track the members a sync of the workspace root `root` resolved, replacing the ones tracked before. A member's
   * manifest is nested in the root's directory, so discovery never tracks it on its own; a project that was tracked
   * on its own and is now declared a member is taken over.
   *
   * Each member gets a lockfile baseline of its own: the workspace resolves into the root's repository, but a
   * member still has a `.dev` the CLI writes to, and an event there must not be read as a dependency change.
   */
  private async attachMembers(state: FolderState, root: ElideProject, models: readonly ProjectModel[]): Promise<void> {
    // Model roots are normalized to forward slashes; projects are keyed by the platform's own spelling.
    const declared = new Map(models.map((m) => [path.resolve(m.root), m]));
    for (const [other, p] of [...state.projects]) {
      if (p.workspaceRoot === root.root && !declared.has(other)) {
        state.projects.delete(other);
        this.ui.log(`workspace member dropped: ${other}`);
      }
    }
    for (const [memberRoot, model] of declared) {
      if (!state.projects.get(memberRoot)?.workspaceRoot) this.ui.log(`workspace member: ${memberRoot} (of ${root.root})`);
      state.projects.set(memberRoot, {
        root: memberRoot,
        manifestPath: path.join(memberRoot, MANIFEST_NAME),
        folder: state.folder,
        model,
        workspaceRoot: root.root,
        lockDigest: await lockfileDigest(memberRoot),
      });
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
   * not a directory". A workspace value that does not resolve here is therefore cleared; one that does is a
   * deliberate project override and wins. A user-settings value the extension did not write is left alone.
   *
   * `intellij.*` settings are window-scoped (a folder's own value only applies as the workspace's, in a window of
   * one folder), so they are read and written without a resource.
   */
  private async configureJdkForSymbolResolution(models: ProjectModel[]): Promise<void> {
    const jdk = models.find((m) => m.jdk)?.jdk;
    if (!jdk) return;
    const intellij = vscode.workspace.getConfiguration("intellij");
    const stale = intellij.inspect<string>(JDK_SETTING)?.workspaceValue;
    if (typeof stale === "string" && stale.length > 0 && !isDirectory(stale)) {
      try {
        await intellij.update(JDK_SETTING, undefined, vscode.ConfigurationTarget.Workspace);
        this.ui.log(`cleared intellij.${JDK_SETTING} = ${stale}: not a directory on this machine`);
      } catch (e) {
        this.ui.log(`could not clear intellij.${JDK_SETTING}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const inspected = vscode.workspace.getConfiguration("intellij").inspect<string>(JDK_SETTING);
    const override = typeof inspected?.workspaceValue === "string" && inspected.workspaceValue.length > 0 ? inspected.workspaceValue : undefined;
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
   * Build Elide's plugin for the installed Kotlin server, for Compose projects. It suppresses the `FunctionName`
   * inspection on `@Composable` functions, which are named like types — the rule Android Studio's Compose plugin
   * applies and the language server lacks. {@link configureKotlinLspEnvironment} lists it in `-Dplugin.path`.
   */
  private async prepareKotlinLspPlugin(signal: AbortSignal): Promise<void> {
    const server = jetBrainsServerDirectory();
    if (!server) {
      this.ui.log("Compose function-name suppression needs the JetBrains Kotlin extension's bundled server");
      return;
    }
    try {
      this.kotlinLspPluginPath = await kotlinLspPlugin(server, this.kotlinLspPluginSources, this.cacheRoot, signal);
    } catch (e) {
      this.ui.log(`could not build the Kotlin LSP plugin: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const own = (vscode.workspace.getConfiguration("intellij").get<string[]>("additionalJvmArgs") ?? []).find((arg) => arg.startsWith("-Dplugin.path="));
    if (own) {
      this.ui.log(`intellij.additionalJvmArgs sets ${own}, which replaces Elide's Compose plugin; add ${this.kotlinLspPluginPath} to it ` +
        `(separated by '${path.delimiter}') to keep @Composable functions exempt from FunctionName`);
    }
  }

  /**
   * Drop the plugin builds earlier releases listed in the user setting `intellij.additionalJvmArgs`: the path is
   * local to this machine and VS Code profile, and Settings Sync carries user settings to others. The setting is
   * removed once nothing else is left in it; the user's own entries stay.
   */
  private async forgetKotlinLspPluginSetting(): Promise<void> {
    const intellij = vscode.workspace.getConfiguration("intellij");
    const next = withoutKotlinLspPlugin(intellij.inspect<string[]>("additionalJvmArgs")?.globalValue ?? [], this.cacheRoot);
    if (!next) return;
    try {
      await intellij.update("additionalJvmArgs", next.length > 0 ? next : undefined, vscode.ConfigurationTarget.Global);
      this.ui.log(`removed Elide's plugin from intellij.additionalJvmArgs (user settings)${next.length > 0 ? `: ${JSON.stringify(next)}` : ""}`);
    } catch (e) {
      this.ui.log(`could not update intellij.additionalJvmArgs: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Force the Kotlin LSP's JSON importer for this window when the folder carries another build's files.
   *
   * The server's auto-detection (`InitializeKt.planAutoImport`, intellij-server 263.x) first filters its importers
   * to the build systems — `maven`, `gradle`, `jps`, `bazel` — and only falls back to `workspace.json` when none of
   * them matches the folder. A checked-in `.idea/modules.xml` therefore wins (JPS), and a Gradle or Maven build
   * beside it makes the server prompt the user to pick a build system; `workspace.json` is never a candidate.
   * `intellij.buildTool` short-circuits detection: the importer is looked up by id over the full importer map.
   *
   * The pin lives in workspace settings, which in a window of one folder is that folder's `.vscode/settings.json`, so
   * it is written only when one of those files is there ({@link COMPETING_BUILD_FILES}); without them detection
   * already lands on `workspace.json`. The setting is window-scoped in JetBrains.kotlin-server, so it cannot be
   * pinned per folder: skip it when the window also holds folders without an Elide project, whose Gradle/Maven
   * import the pin would disable.
   */
  private async pinKotlinLspImporter(folder: vscode.WorkspaceFolder): Promise<void> {
    const intellij = vscode.workspace.getConfiguration("intellij");
    const inspected = intellij.inspect<string>("buildTool");
    if ([inspected?.globalValue, inspected?.workspaceValue].some((v) => typeof v === "string")) return;
    const competing = COMPETING_BUILD_FILES.filter((file) => existsSync(path.join(folder.uri.fsPath, file)));
    if (competing.length === 0) return;
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
      this.ui.log(`intellij.buildTool = "json" (workspace settings): ${competing.join(", ")} would make the Kotlin LSP import another build`);
    } catch (e) {
      this.ui.log(`could not write intellij.buildTool: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Offer, once per folder, to keep the generated `workspace.json` out of Git. It has to sit at the folder root —
   * the Kotlin server imports it from there, and pointing it elsewhere takes a setting in `.vscode/settings.json` —
   * so every clone lists it as untracked. The offer adds it to the clone's own `info/exclude`, which is never
   * committed; nothing is written without consent, and a file the repository tracks or already ignores is left as
   * it is. A dismissed offer returns in the next window.
   */
  private async offerWorkspaceJsonExclude(folder: vscode.WorkspaceFolder): Promise<void> {
    const key = `${WORKSPACE_JSON_EXCLUDE_KEY}:${folder.uri.fsPath}`;
    if (offeredExcludes.has(key) || this.state.get<string>(key) !== undefined) return;
    offeredExcludes.add(key);
    const target = await gitExcludeCandidate(folder.uri.fsPath, WORKSPACE_JSON);
    if (!target) return;
    const exclude = "Exclude from Git";
    const keep = "Keep Untracked";
    const pick = await vscode.window.showInformationMessage(
      `Elide: ${WORKSPACE_JSON} in ${folder.name} is generated for the Kotlin language server, which reads it from the folder root, ` +
        `and Git lists it as untracked. Exclude it in this clone only (${path.relative(folder.uri.fsPath, target.exclude)})?`,
      exclude,
      keep,
    );
    if (pick === undefined) return;
    await this.state.update(key, pick === exclude ? "excluded" : "kept");
    if (pick !== exclude) return;
    try {
      await addGitExclude(target);
      this.ui.log(`added ${target.pattern} to ${target.exclude}`);
    } catch (e) {
      this.ui.log(`could not update ${target.exclude}: ${e instanceof Error ? e.message : String(e)}`);
      void vscode.window.showWarningMessage(`Elide: could not update ${target.exclude}; see Elide Output.`);
    }
  }

  /**
   * Logs and notifies; the notification is not awaited (it settles only when the user dismisses it). It names the
   * step that failed and offers that sync's log, which holds the failing command's output. A manifest error is
   * reported in Elide's own words, with its location, which also becomes a diagnostic.
   */
  private reportError(e: unknown, sync: TimelineNode, folder: vscode.WorkspaceFolder): void {
    const message = e instanceof Error ? e.message : String(e);
    this.ui.log(`sync failed: ${message}`);
    const manifestError = e instanceof ElideCommandFailedError
      ? parseManifestError(e.stderr, path.join(e.cwd ?? folder.uri.fsPath, MANIFEST_NAME))
      : undefined;
    this.publishManifestError(folder, manifestError);
    if (e instanceof ElideNotFoundError || e instanceof InvalidElideHomeError) {
      reportElideMissing(this.ui, e);
      return;
    }
    const actions = ["Show Log", "Show Activity"];
    const location = manifestError?.locations[0];
    if (location) actions.unshift("Go to Error");
    let text: string;
    if (manifestError) {
      const at = location ? `${path.relative(folder.uri.fsPath, this.manifestErrorUri(location.file).fsPath)}:${location.line}:${location.column}: ` : "";
      text = `${at}${manifestError.message.replace(/\s*\n\s*/g, " ")}`;
    } else {
      const summary = e instanceof ElideCommandFailedError ? `elide ${e.args.join(" ")} failed (exit ${e.exitCode ?? "signal"})` : e instanceof ManifestParseError ? e.message : message;
      const failed = sync.children.findLast((step) => step.state === "failed");
      text = `${summary}${failed && failed.label !== summary ? ` while ${failed.label.toLowerCase()}` : ""}`;
    }
    void vscode.window.showErrorMessage(`Elide: ${text}`, ...actions).then((pick) => {
      if (pick === "Go to Error" && location) void vscode.window.showTextDocument(this.manifestErrorUri(location.file), { selection: manifestErrorRange(location) });
      if (pick === "Show Log") void this.ui.activity.openLog(sync);
      if (pick === "Show Activity") void vscode.commands.executeCommand("elide.showActivity");
    });
  }

  /** The file a manifest error points at, spelled inside its workspace folder when Elide printed its real path. */
  private manifestErrorUri(file: string): vscode.Uri {
    const uri = vscode.Uri.file(file);
    const located = this.locate(uri);
    return located ? vscode.Uri.file(located.fsPath) : uri;
  }

  /**
   * Replace the manifest diagnostics of `folder`'s previous failed sync with the ones `error` points at: an Error at
   * its innermost location, with the others as related information. `undefined` (a successful sync, or another
   * failure) only clears them.
   */
  private publishManifestError(folder: vscode.WorkspaceFolder, error: ManifestError | undefined): void {
    const key = folder.uri.toString();
    const previous = this.manifestErrorFiles.get(key);
    if (previous) this.manifestDiagnostics.delete(previous);
    this.manifestErrorFiles.delete(key);
    const [first, ...rest] = error?.locations ?? [];
    if (!error || !first) return;
    const uri = this.manifestErrorUri(first.file);
    const diagnostic = new vscode.Diagnostic(manifestErrorRange(first), error.message, vscode.DiagnosticSeverity.Error);
    diagnostic.source = "elide";
    diagnostic.relatedInformation = rest.map((at) =>
      new vscode.DiagnosticRelatedInformation(new vscode.Location(this.manifestErrorUri(at.file), manifestErrorRange(at)), "referenced from here"));
    this.manifestDiagnostics.set(uri, [diagnostic]);
    this.manifestErrorFiles.set(key, uri);
  }

  private folderState(folder: vscode.WorkspaceFolder): FolderState {
    const key = folder.uri.toString();
    let state = this.folders.get(key);
    if (!state) {
      state = { folder, projects: new Map(), stale: false, staleMarks: 0, installedMarks: 0, rerun: false, quietUntil: 0, elideMissing: false };
      this.folders.set(key, state);
    }
    return state;
  }

  dispose(): void {
    this.kotlinLspEnvironment.dispose();
    this.komodoServer.dispose();
    this.manifestDiagnostics.dispose();
    for (const f of this.folders.values()) f.syncing?.abort();
    this.changed.dispose();
    this.modulesChanged.dispose();
  }
}

/**
 * Notify that no usable Elide distribution was found, offering the two ways out. Shared by sync and the New
 * Project wizard; the caller logs, because only it knows what was being attempted.
 */
export function reportElideMissing(ui: ElideUi, e: ElideNotFoundError | InvalidElideHomeError): void {
  void vscode.window.showErrorMessage(`Elide: ${e.message}`, "Set elide.home", "Install Elide").then((pick) => {
    if (pick === "Set elide.home") void vscode.commands.executeCommand("workbench.action.openSettings", "elide.home");
    else if (pick === "Install Elide") void vscode.env.openExternal(vscode.Uri.parse(INSTALL_DOCS));
  });
}

/** The span carets marked under a manifest error's source line. */
function manifestErrorRange(at: ManifestErrorLocation): vscode.Range {
  return new vscode.Range(at.line - 1, at.column - 1, at.line - 1, at.endColumn - 1);
}

/**
 * Komodo's launch settings are window-wide, like its shared server. Without a developer launcher,
 * the selected Elide CLI resolves the optional component from its managed store.
 */
function komodoSettings(): KomodoSettings {
  const config = readConfig();
  return {
    path: config.komodoLspPath,
    elideHome: config.home,
    pluginDirectory: config.komodoPluginDirectory,
    javaHome: config.komodoLspJavaHome,
    maxHeap: config.komodoLspMaxHeap,
  };
}

/**
 * Whether the CLI refused one of `options` as unknown, as a release that predates them does (picocli's "Unknown option:
 * '--slim'" or "Unmatched argument at index 1: '--slim'"), rather than failing at the command's work.
 */
function rejectedOption(error: ElideCommandFailedError, options: readonly string[]): boolean {
  return error.stderr.split("\n").some((line) =>
    /unknown option|unmatched argument/i.test(line) && options.some((option) => line.includes(`'${option}'`) || line.includes(`'${option}=`)));
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
