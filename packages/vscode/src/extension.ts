import { existsSync } from "node:fs";
import path from "node:path";
import { MANIFEST_NAME, WORKSPACE_JSON, isLockfileName, nativeImageBinary, type ElideCommand } from "@elide/ide-core";
import * as vscode from "vscode";
import { ACTIVITY_VIEW_ID, type ElideActivityApi } from "./activity.js";
import {
  createAndroidAvd,
  createAndroidKeystore,
  debugAndroid,
  executeAndroidTask,
  installAndroidSdk,
  isAndroidBuild,
  openAndroidMapping,
  runAndroid,
  runAndroidDeviceTask,
  startAndroidEmulator,
  stopAndroidEmulator,
} from "./android.js";
import { ELIDE_ANDROID_DEBUG_TYPE, ElideAndroidDebugConfigurationProvider } from "./androidDebug.js";
import { AndroidDeploymentController } from "./androidDeployment.js";
import { androidApks, hasAndroidProjects } from "./androidDeploymentState.js";
import { ElideAndroidTestController } from "./androidTesting.js";
import { registerAndroidDatabase } from "./androidDatabase.js";
import { registerAndroidLogcat } from "./androidLogcat.js";
import { registerAndroidReadiness } from "./androidReadiness.js";
import { registerAndroidWireless } from "./androidWireless.js";
import { ElideCodeLensProvider } from "./codelens.js";
import { registerBuildExtensionLinks } from "./buildExtensions.js";
import { registerWorkspaceMemberNavigation } from "./workspaceMembers.js";
import { ComposeAgentPreviews } from "./composeAgent.js";
import { registerComposePreviewMcp, type ElideComposePreviewMcpApi } from "./composeAgentMcp.js";
import { registerComposePreview, type ElideComposePreviewApi } from "./composePreview.js";
import { readConfig, type KotlinLspServer } from "./config.js";
import { ELIDE_DEBUG_TYPE, ElideDebugConfigurationProvider, KOMODO_DEBUG_TYPE } from "./debug.js";
import { ElideProjectsView, PROJECTS_VIEW_ID, type ElideExplorerApi } from "./explorer.js";
import { JETBRAINS_EXTENSION_ID, jetBrainsExtension } from "./jetbrains.js";
import { KomodoDebugAdapterFactory } from "./komodoDebug.js";
import { installKomodo, resolveKomodo } from "./komodoDistribution.js";
import { ELIDE_NATIVE_DEBUG_TYPE, ElideNativeDebugConfigurationProvider } from "./nativeDebug.js";
import { addWorkspaceMember, newProject } from "./newProject.js";
import { ElideUi } from "./output.js";
import { ElideWorkspace, type ElideProject } from "./projects.js";
import { ELIDE_TASK_TYPE, ElideTaskProvider, entrypointArgs, entrypointLabel, executeElideTask, executeProgramTask, taskExitCode } from "./tasks.js";
import { ElideTestController, type ElideTestApi } from "./testing.js";

/** What `activate` resolves to; consumed only by the extension-host integration test. */
export interface ElideExtensionApi {
  tests: ElideTestApi;
  explorer: ElideExplorerApi;
  composePreview: ElideComposePreviewApi;
  composePreviewMcp: ElideComposePreviewMcpApi;
  activity: ElideActivityApi;
}

const DEBOUNCE_MS = 1_000;

export async function activate(context: vscode.ExtensionContext): Promise<ElideExtensionApi> {
  const ui = new ElideUi();
  const workspace = new ElideWorkspace(ui, context.globalState, context.asAbsolutePath("media/kotlin-lsp"), context.globalStorageUri.fsPath);
  context.subscriptions.push(ui, workspace);
  const composePreview = registerComposePreview(workspace, ui, context);
  const agentPreviews = new ComposeAgentPreviews(workspace, ui, composePreview.agentHost);
  const composePreviewMcp = registerComposePreviewMcp(context, agentPreviews, ui, String(context.extension.packageJSON.version));
  const deployments = new AndroidDeploymentController(workspace, context.workspaceState);
  context.subscriptions.push(
    composePreview.disposable,
    agentPreviews,
    composePreviewMcp.disposable,
    registerAndroidLogcat(workspace, () => deployments.target),
    registerAndroidDatabase(workspace, context, () => deployments.target),
    registerAndroidReadiness(workspace, ui),
    registerAndroidWireless(workspace, () => deployments.target),
    deployments,
  );

  const debugConfigurations = new ElideDebugConfigurationProvider(workspace, ui, context.subscriptions);
  const nativeDebugConfigurations = new ElideNativeDebugConfigurationProvider(workspace, ui);
  const androidDebugConfigurations = new ElideAndroidDebugConfigurationProvider(workspace, ui, debugConfigurations.sessions, deployments);
  const tests = new ElideTestController(workspace, ui, debugConfigurations.sessions);
  const explorer = new ElideProjectsView(workspace, ui, context.workspaceState);
  // A target run from one of the sidebar's own rows counts towards its Frequently used section.
  const counted = (run: (target: unknown) => unknown) => (target: unknown) => {
    explorer.recordUse(target);
    return run(target);
  };
  const androidTests = new ElideAndroidTestController(workspace, ui, deployments, (target) => explorer.recordUse(target));
  const codeLenses = new ElideCodeLensProvider(workspace);
  context.subscriptions.push(
    codeLenses,
    registerBuildExtensionLinks(workspace),
    registerWorkspaceMemberNavigation(workspace),
    vscode.languages.registerCodeLensProvider(ElideCodeLensProvider.selector, codeLenses),
    vscode.commands.registerCommand("elide.sync", (target: unknown) => syncCommand(workspace, target)),
    vscode.commands.registerCommand("elide.installKomodo", () => installKomodoCommand(workspace, ui)),
    vscode.commands.registerCommand("elide.showOutput", () => ui.output.show(true)),
    vscode.commands.registerCommand("elide.showMenu", () => showMenu(workspace)),
    vscode.commands.registerCommand("elide.openWorkspaceJson", () => openWorkspaceJson(workspace)),
    vscode.commands.registerCommand("elide.runTask", () => runTaskCommand(workspace)),
    vscode.commands.registerCommand("elide.newProject", () => newProject(ui)),
    vscode.commands.registerCommand("elide.addMember", (target: unknown) => addWorkspaceMember(workspace, ui, target)),
    vscode.commands.registerCommand("elide.run", (target: unknown) => runEntrypoint(workspace, ui, target, "run")),
    vscode.commands.registerCommand("elide.build", counted((target) => runEntrypoint(workspace, ui, target, "build"))),
    vscode.commands.registerCommand("elide.runArtifact", counted((target) => runArtifact(workspace, ui, target))),
    vscode.commands.registerCommand("elide.debug", counted((target) => debugEntrypoint(workspace, target))),
    vscode.commands.registerCommand("elide.debugArtifact", counted((target) => debugArtifact(workspace, target))),
    vscode.commands.registerCommand("elide.executeTask", counted((target) => runNamedTask(workspace, ui, target))),
    vscode.commands.registerCommand("elide.openManifest", (target: unknown) => openManifest(workspace, target)),
    vscode.commands.registerCommand("elide.androidSelectTarget", (target: unknown) => deployments.select(target)),
    vscode.commands.registerCommand("elide.androidRun", counted((target) => runAndroid(workspace, ui, deployments, target))),
    vscode.commands.registerCommand("elide.androidDebug", counted((target) => debugAndroid(workspace, deployments, target))),
    vscode.commands.registerCommand("elide.androidRunDeviceTask", counted((target) => runAndroidDeviceTask(workspace, ui, deployments, target))),
    vscode.commands.registerCommand("elide.androidStartEmulator", (target: unknown) => startAndroidEmulator(workspace, target)),
    vscode.commands.registerCommand("elide.androidStopEmulator", (target: unknown) => stopAndroidEmulator(workspace, target)),
    vscode.commands.registerCommand("elide.androidCreateAvd", (target: unknown) => createAndroidAvd(workspace, target)),
    vscode.commands.registerCommand("elide.androidInstallSdk", (target: unknown) => installAndroidSdk(workspace, target)),
    vscode.commands.registerCommand("elide.androidCreateKeystore", (target: unknown) => createAndroidKeystore(workspace, ui, target)),
    vscode.commands.registerCommand("elide.androidOpenMapping", (target: unknown) => openAndroidMapping(workspace, target)),
    vscode.commands.registerCommand("elide.revealLibrary", (target: unknown) => revealLibrary(target)),
    vscode.tasks.registerTaskProvider(ELIDE_TASK_TYPE, new ElideTaskProvider(workspace)),
    vscode.debug.registerDebugConfigurationProvider(ELIDE_DEBUG_TYPE, debugConfigurations),
    vscode.debug.registerDebugConfigurationProvider(ELIDE_NATIVE_DEBUG_TYPE, nativeDebugConfigurations),
    vscode.debug.registerDebugConfigurationProvider(ELIDE_ANDROID_DEBUG_TYPE, androidDebugConfigurations),
    vscode.debug.registerDebugAdapterDescriptorFactory(KOMODO_DEBUG_TYPE, new KomodoDebugAdapterFactory(workspace, (message) => ui.log(message))),
    vscode.window.registerTreeDataProvider(PROJECTS_VIEW_ID, explorer),
    vscode.window.registerTreeDataProvider(ACTIVITY_VIEW_ID, ui.activity),
    explorer,
    tests,
    androidTests,
  );

  registerWatchers(context, workspace, ui);
  const komodoSessions = new Set<vscode.DebugSession>();
  const updateKomodoAvailability = () => {
    void vscode.commands.executeCommand("setContext", "elide.komodoAvailable", workspace.komodoAvailable);
    void vscode.commands.executeCommand("setContext", "elide.komodoPreviewAvailable", workspace.komodoPreviewAvailable);
    void updateContextKeys(workspace);
    if (!workspace.komodoAvailable) {
      for (const session of komodoSessions) void vscode.debug.stopDebugging(session);
    }
  };
  updateKomodoAvailability();
  context.subscriptions.push(
    workspace.onDidChange(() => void updateContextKeys(workspace)),
    workspace.onDidChangeKomodoAvailability(updateKomodoAvailability),
    vscode.debug.onDidStartDebugSession((session) => {
      if (session.type !== KOMODO_DEBUG_TYPE) return;
      komodoSessions.add(session);
      if (!workspace.komodoAvailable) void vscode.debug.stopDebugging(session);
    }),
    vscode.debug.onDidTerminateDebugSession((session) => komodoSessions.delete(session)),
  );

  // Kotlin's own activation events do not cover Java-only Elide projects. Start the companion
  // when an Elide source document of a JetBrains folder needs it, without making CLI features wait for its server.
  // A Komodo folder never starts it; when the JetBrains extension starts itself (it activates on any Kotlin file),
  // both servers analyze the folder, so say so once.
  let kotlinRequested = false;
  let duplicateWarned = false;
  const startKotlinForDocuments = () => {
    const elideDocuments = vscode.workspace.textDocuments.filter((document) =>
      document.uri.scheme === "file" && (document.languageId === "kotlin" || document.languageId === "java")
      && workspace.projectFor(document.uri.fsPath) !== undefined);
    const komodo = (document: vscode.TextDocument) => vscode.workspace.getConfiguration("elide", document.uri).get<KotlinLspServer>("kotlinLsp.server") === "komodo";
    const extension = jetBrainsExtension();
    if (!extension) return;
    if (!duplicateWarned && workspace.komodoAvailable && elideDocuments.some((document) => document.languageId === "kotlin" && komodo(document))) {
      duplicateWarned = true;
      void vscode.window.showWarningMessage(
        `Elide: ${JETBRAINS_EXTENSION_ID} is enabled, and it analyzes Kotlin files beside Komodo's language server (duplicate diagnostics and completions). Disable it for this workspace to use Komodo alone.`,
        "Show Extension",
      ).then((pick) => {
        if (pick) void vscode.commands.executeCommand("extension.open", JETBRAINS_EXTENSION_ID);
      });
    }
    if (kotlinRequested || !elideDocuments.some((document) => !komodo(document))) return;
    kotlinRequested = true;
    void extension.activate().then(undefined, (error: unknown) => {
      ui.log(`Kotlin extension activation failed: ${error instanceof Error ? error.message : String(error)}`);
      void vscode.window.showWarningMessage("Elide: Kotlin/Java analysis could not start. Build and sync remain available; see Elide Output for details.");
    });
  };
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(startKotlinForDocuments),
    workspace.onDidChange(startKotlinForDocuments),
    workspace.onDidChangeKomodoAvailability(startKotlinForDocuments),
  );

  for (const folder of vscode.workspace.workspaceFolders ?? []) await workspace.discover(folder);
  await updateContextKeys(workspace);
  // No project is not a dead end: commands, the welcome view and project creation stay available.
  if (workspace.projects.length === 0) ui.log("No elide.pkl found in the workspace.");
  else void workspace.syncAll("startup", (folder) => readConfig(folder).syncOnStartup);
  return { tests, explorer, composePreview: composePreview.api, composePreviewMcp: composePreviewMcp.api, activity: ui.activity };
}

export function deactivate(): void {}

function registerWatchers(context: vscode.ExtensionContext, workspace: ElideWorkspace, ui: ElideUi): void {
  const timers = new Map<string, NodeJS.Timeout>();
  const debounce = (key: string, run: () => unknown) => {
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        void run();
      }, DEBOUNCE_MS),
    );
  };

  /** Mark `folder` as needing a re-import of its projects and apply the configured policy. */
  const onStale = (folder: vscode.WorkspaceFolder, what: string, fsPath: string) => {
    workspace.markStale(folder);
    ui.log(`${what} changed: ${fsPath}`);
    const policy = readConfig(folder).onManifestChange;
    if (policy === "always") debounce(folder.uri.toString(), () => void workspace.syncFolder(folder, "manifest-change"));
    else if (policy === "prompt") void promptReload(folder, workspace, what);
  };

  /**
   * The tracked project a changed file belongs to. `rootOf` maps the file to the directory whose manifest owns it;
   * a path that is not a tracked project root belongs to a nested (ignored) manifest and is not a reason to resync.
   */
  const ownerOf = (uri: vscode.Uri, rootOf: (fsPath: string) => string): ElideProject | undefined => {
    const located = workspace.locate(uri);
    return located ? workspace.projectAt(rootOf(located.fsPath)) : undefined;
  };

  const manifests = vscode.workspace.createFileSystemWatcher(`**/${MANIFEST_NAME}`);
  // A sync never writes a manifest: an edit made while one runs, or right after, still makes the folder stale. Add
  // Workspace Member does, and syncs itself.
  manifests.onDidChange(async (uri) => {
    const project = workspace.manifestOwner(uri);
    if (project && !(await workspace.isOwnManifestWrite(uri))) onStale(project.folder, MANIFEST_NAME, uri.fsPath);
  });
  manifests.onDidCreate(async (uri) => {
    const project = workspace.addProject(uri);
    if (!project) {
      // A manifest nested in an Elide workspace can be a member its root declares — or the one whose absence failed
      // the last sync — and only a sync of the root can tell: the member list is whatever `elide project export` says.
      const owner = workspace.manifestOwner(uri, true);
      if (owner && !(await workspace.isOwnManifestWrite(uri))) onStale(owner.folder, MANIFEST_NAME, uri.fsPath);
      return;
    }
    ui.log(`project added: ${project.root}`);
    debounce(project.folder.uri.toString(), () => void workspace.syncFolder(project.folder, "project-added"));
  });
  manifests.onDidDelete(async (uri) => {
    const project = workspace.removeProject(uri);
    if (!project) return;
    ui.log(`project removed: ${project.root}`);
    // Manifests that were nested inside the deleted project become projects of their own.
    await workspace.discover(project.folder);
    if (workspace.projectsIn(project.folder).length > 0) void workspace.syncFolder(project.folder, "project-removed");
  });

  const lockfiles = vscode.workspace.createFileSystemWatcher("**/.dev/elide.lock*");
  const onLock = (uri: vscode.Uri) => {
    if (!isLockfileName(path.basename(uri.fsPath))) return;
    // `<project root>/.dev/elide.lock*.bin`: two levels up from the lockfile.
    const project = ownerOf(uri, (p) => path.dirname(path.dirname(p)));
    if (!project || workspace.isSelfInflicted(project.folder)) return;
    // Running an entrypoint or the tests rewrites the lockfile with the same content, which is no reason to
    // re-import: let the writes settle, then compare content and keep quiet unless the dependencies moved.
    debounce(`lockfile:${project.root}`, async () => {
      if (workspace.isSelfInflicted(project.folder)) return;
      if (await workspace.lockfileChanged(project)) onStale(project.folder, "lockfile", uri.fsPath);
    });
  };
  lockfiles.onDidChange(onLock);
  lockfiles.onDidCreate(onLock);

  // Local modules the manifests read, e.g. a shared `versions.pkl`: one watcher per file, wherever it lives.
  const moduleWatchers = new Map<string, vscode.FileSystemWatcher>();
  const watchModules = () => {
    const readers = workspace.moduleReaders();
    for (const [module, watcher] of moduleWatchers) {
      if (readers.has(module)) continue;
      watcher.dispose();
      moduleWatchers.delete(module);
    }
    for (const module of readers.keys()) {
      if (moduleWatchers.has(module)) continue;
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(module)), path.basename(module)));
      const onModule = (uri: vscode.Uri) => {
        for (const folder of workspace.moduleReaders().get(module) ?? []) onStale(folder, path.basename(module), uri.fsPath);
      };
      watcher.onDidChange(onModule);
      watcher.onDidCreate(onModule);
      watcher.onDidDelete(onModule);
      moduleWatchers.set(module, watcher);
    }
  };
  watchModules();

  context.subscriptions.push(
    manifests,
    lockfiles,
    workspace.onDidChangeModules(watchModules),
    { dispose: () => moduleWatchers.forEach((w) => w.dispose()) },
    vscode.workspace.onDidChangeConfiguration((e) => {
      workspace.settingsChanged(e);
      if (e.affectsConfiguration("elide.debug.adapter") || e.affectsConfiguration("elide.kotlinLsp.server")) void updateContextKeys(workspace);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const removed of e.removed) {
        clearTimeout(timers.get(removed.uri.toString()));
        timers.delete(removed.uri.toString());
        workspace.removeFolder(removed);
      }
      for (const added of e.added) void workspace.addFolder(added);
    }),
    { dispose: () => timers.forEach((t) => clearTimeout(t)) },
  );
}

const prompting = new Set<string>();

async function promptReload(folder: vscode.WorkspaceFolder, workspace: ElideWorkspace, what: string): Promise<void> {
  const key = folder.uri.toString();
  if (prompting.has(key)) return;
  prompting.add(key);
  try {
    const pick = await vscode.window.showInformationMessage(`${what} changed in ${folder.name}. Reload Elide project?`, "Reload", "Ignore");
    if (pick === "Reload") await workspace.syncFolder(folder, "manifest-change");
  } finally {
    prompting.delete(key);
  }
}

/** Installation is an explicit command, never a side effect of activation or sync. */
async function installKomodoCommand(workspace: ElideWorkspace, ui: ElideUi): Promise<void> {
  const config = readConfig();
  if (config.komodoLspPath) {
    void vscode.window.showErrorMessage("Komodo uses elide.kotlinLsp.komodo.path. Fix or clear that developer override before installing a managed component.");
    return;
  }
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Elide: installing Komodo", cancellable: true },
      async (progress, token) => {
        const abort = new AbortController();
        const cancellation = token.onCancellationRequested(() => abort.abort(new Error("Komodo installation cancelled.")));
        try {
          if (token.isCancellationRequested) abort.abort(new Error("Komodo installation cancelled."));
          await installKomodo(config.home, {
            signal: abort.signal,
            onLine: (message) => { progress.report({ message }); ui.log(`Komodo: ${message}`); },
          });
          await resolveKomodo(undefined, config.home, { signal: abort.signal });
        } finally {
          cancellation.dispose();
        }
      },
    );
    await workspace.syncAll("manual", (folder) => readConfig(folder).kotlinLspServer === "komodo");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.log(`Komodo: ${message}`);
    void vscode.window.showErrorMessage(`Komodo: ${message}`);
  }
}

/** Sync the folder of the project row the command was invoked on, or the only folder with projects, or the one picked. */
async function syncCommand(workspace: ElideWorkspace, value: unknown): Promise<void> {
  const root = toTarget(value)?.root;
  const project = root ? workspace.projectAt(root) : undefined;
  if (project) {
    await workspace.syncFolder(project.folder, "manual");
    return;
  }
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => workspace.projectsIn(f).length > 0);
  if (folders.length === 0) {
    for (const folder of vscode.workspace.workspaceFolders ?? []) await workspace.discover(folder);
    const rediscovered = (vscode.workspace.workspaceFolders ?? []).filter((f) => workspace.projectsIn(f).length > 0);
    if (rediscovered.length === 0) {
      void vscode.window.showInformationMessage("Elide: no elide.pkl found in the open workspace folders.");
      return;
    }
    folders.push(...rediscovered);
  }
  if (folders.length === 1) {
    await workspace.syncFolder(folders[0]!, "manual");
    return;
  }
  const pick = await vscode.window.showQuickPick(
    [{ label: "All", folder: undefined }, ...folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f }))],
    { placeHolder: "Sync which workspace folder?" },
  );
  if (!pick) return;
  if (pick.folder) await workspace.syncFolder(pick.folder, "manual");
  else await workspace.syncAll("manual");
}

async function openWorkspaceJson(workspace: ElideWorkspace): Promise<void> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => workspace.projectsIn(f).length > 0);
  const folder =
    folders.length === 1
      ? folders[0]
      : (await vscode.window.showQuickPick(folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })), { placeHolder: "Which folder?" }))?.folder;
  if (!folder) return;
  const file = vscode.Uri.joinPath(folder.uri, WORKSPACE_JSON);
  try {
    await vscode.window.showTextDocument(file);
  } catch {
    void vscode.window.showWarningMessage(`Elide: ${file.fsPath} does not exist yet; run 'Elide: Sync Project(s)'.`);
  }
}

/**
 * `elide.hasProjects`, and the keys that keep Android commands out of non-Android workspaces: `elide.hasAndroidProjects`
 * (a synced project declares `android`) and `elide.hasUnsyncedProjects` (a project has no model yet, so it may).
 */
async function updateContextKeys(workspace: ElideWorkspace): Promise<void> {
  await Promise.all([
    vscode.commands.executeCommand("setContext", "elide.hasProjects", workspace.projects.length > 0),
    vscode.commands.executeCommand("setContext", "elide.hasAndroidProjects", hasAndroidProjects(workspace.projects)),
    vscode.commands.executeCommand("setContext", "elide.hasUnsyncedProjects", workspace.projects.some((project) => !project.model)),
    vscode.commands.executeCommand("setContext", "elide.androidDebugAvailable",
      workspace.projects.some((project) => project.model?.android && workspace.komodoDebugAvailable(project.folder))),
  ]);
}

/** Actions offered by the status-bar menu, in order; entries whose command is not registered are skipped, Android ones without an Android project. */
const MENU_ACTIONS: { label: string; description: string; command: string; android?: true }[] = [
  { label: "$(sync) Sync Project(s)", description: "Re-resolve the project model and refresh the Kotlin LSP", command: "elide.sync" },
  { label: "$(cloud-download) Install Komodo", description: "Explicitly install the managed native Kotlin component", command: "elide.installKomodo" },
  { label: "$(play) Run Elide Command…", description: "Build, test, install, run an entrypoint or an Android app", command: "elide.runTask" },
  { label: "$(device-mobile) Select Android Deployment Target…", description: "Choose the application and device for Run and Debug", command: "elide.androidSelectTarget", android: true },
  { label: "$(radio-tower) Pair Android Device over Wi-Fi…", description: "Pair by QR or pairing code, or reconnect a paired device", command: "elide.androidPairWireless", android: true },
  { label: "$(play) Run Android App…", description: "Build, install and launch on the selected device", command: "elide.androidRun", android: true },
  { label: "$(debug-alt) Debug Android App…", description: "Build, install and attach the debugger", command: "elide.androidDebug", android: true },
  { label: "$(beaker) Run Android Instrumented Tests…", description: "Install a test APK and run its tests on the selected device", command: "elide.androidTest", android: true },
  { label: "$(checklist) Check Android Environment", description: "Diagnose SDK, tools and connected devices", command: "elide.androidDoctor", android: true },
  { label: "$(preview) Open Compose Preview", description: "Render composables locally, without a device", command: "elide.androidComposePreview", android: true },
  { label: "$(output) Show Android Logcat", description: "Application logs and stack traces", command: "elide.androidLogcat", android: true },
  { label: "$(database) Explore Android Databases", description: "The connected app's Room / SQLite data", command: "elide.androidDatabase", android: true },
  { label: "$(beaker) Run All Tests", description: "Run every test in the Testing view", command: "testing.runAll" },
  { label: "$(file-code) Open elide.pkl", description: "Project manifest", command: "elide.openManifest" },
  { label: "$(json) Open Generated Kotlin LSP Workspace", description: WORKSPACE_JSON, command: "elide.openWorkspaceJson" },
  { label: "$(pulse) Show Activity", description: "What syncs and preview builds did, step by step, and where their time went", command: "elide.showActivity" },
  { label: "$(output) Show Output", description: "Elide output channel", command: "elide.showOutput" },
  { label: "$(new-folder) New Project…", description: "Create a project from an Elide template", command: "elide.newProject" },
  { label: "$(add) Add Workspace Member…", description: "Create a project inside this one and declare it a member", command: "elide.addMember" },
];

async function showMenu(workspace: ElideWorkspace): Promise<void> {
  const registered = new Set(await vscode.commands.getCommands(true));
  const items: (vscode.QuickPickItem & { command: string })[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const error = workspace.lastError(folder);
    if (!error) continue;
    items.push({
      label: `$(error) Last sync failed: ${error.split("\n")[0]}`,
      description: folder.name,
      command: "elide.showActivity",
    });
    break;
  }
  // The environment check also diagnoses a project that is not synced yet, and may turn out to be an Android one.
  const android = hasAndroidProjects(workspace.projects);
  const unsynced = workspace.projects.some((project) => !project.model);
  items.push(...MENU_ACTIONS.filter((a) => registered.has(a.command)
    && (!a.android || android || (a.command === "elide.androidDoctor" && unsynced))
    && (a.command !== "elide.androidDebug" || workspace.projects.some((project) => project.model?.android && workspace.komodoDebugAvailable(project.folder)))
    && (a.command !== "elide.androidComposePreview" || readConfig().composePreviewEngine !== "komodo" || workspace.komodoPreviewAvailable)));
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "Elide" });
  if (pick) await vscode.commands.executeCommand(pick.command);
}

/**
 * Every command the projects offer: build, test and install each, run each entrypoint, and — on the deployment
 * target — run, debug or test each APK, as far as Elide lists a device target for it.
 */
async function runTaskCommand(workspace: ElideWorkspace): Promise<void> {
  const items: (vscode.QuickPickItem & { run: () => Thenable<unknown> })[] = [];
  for (const project of workspace.projects) {
    const rel = path.relative(project.folder.uri.fsPath, project.root);
    const desc = rel ? rel : project.folder.name;
    const add = (command: ElideCommand, args: string[] = [], label = [command, ...args].join(" ")) =>
      items.push({ label: `elide ${label}`, description: desc, run: () => executeElideTask(workspace, project, command, { args }) });
    add("build");
    add("test");
    add("install");
    for (const ep of project.model?.entrypoints ?? []) add("run", entrypointArgs(ep), entrypointLabel(ep));
    for (const apk of androidApks(project)) {
      const target = { root: project.root, artifact: apk.name };
      const android = (label: string, command: string) =>
        items.push({ label, description: desc, detail: "on the Android deployment target", run: () => vscode.commands.executeCommand(command, target) });
      if (apk.device?.runnable) android(`$(play) Run Android app ${apk.name}`, "elide.androidRun");
      if (apk.device?.debuggable) android(`$(debug-alt) Debug Android app ${apk.name}`, "elide.androidDebug");
      if (apk.device?.instrumented) android(`$(beaker) Run instrumented tests of ${apk.name}`, "elide.androidTest");
    }
  }
  if (items.length === 0) {
    void vscode.window.showInformationMessage("Elide: no Elide projects found; run 'Elide: Sync Project(s)' first.");
    return;
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "Elide command to run" });
  if (pick) await pick.run();
}

/** What an `elide.run`/`elide.debug`/`elide.build`/`elide.runArtifact`/`elide.debugArtifact`/`elide.executeTask` invocation points at. */
interface CommandTarget {
  root: string;
  args: string[];
  command?: ElideCommand;
  /** Output name an artifact declares, which decides the file `elide.runArtifact` runs. */
  outputName?: string;
}

const TASK_COMMANDS: Record<string, ElideCommand> = { build: "build", run: "run", test: "test", install: "install" };

/**
 * Normalize a command argument: code lenses and menu items pass their own objects, but all of them carry the
 * project root and, where it applies, the argument vector and the Elide subcommand.
 */
function toTarget(value: unknown): CommandTarget | undefined {
  if (typeof value !== "object" || value === null || !("root" in value) || typeof value.root !== "string") return undefined;
  const rawArgs = "args" in value ? value.args : undefined;
  const args = Array.isArray(rawArgs) ? rawArgs.filter((a): a is string => typeof a === "string") : [];
  const command = "command" in value && typeof value.command === "string" ? TASK_COMMANDS[value.command] : undefined;
  const outputName = "outputName" in value && typeof value.outputName === "string" ? value.outputName : undefined;
  return { root: value.root, args, ...(command ? { command } : {}), ...(outputName ? { outputName } : {}) };
}

function projectForTarget(workspace: ElideWorkspace, target: CommandTarget): ElideProject | undefined {
  const project = workspace.projectAt(target.root);
  if (!project) void vscode.window.showWarningMessage(`Elide: project ${target.root} is not synced; run 'Elide: Sync Project(s)'.`);
  return project;
}

/** `elide <command> <args>` as a task; an Android build reports its failure in Elide's words (see {@link executeAndroidTask}). */
async function runEntrypoint(workspace: ElideWorkspace, ui: ElideUi, value: unknown, command: ElideCommand): Promise<void> {
  const target = toTarget(value);
  if (!target) return;
  const project = projectForTarget(workspace, target);
  if (!project) return;
  if (command === "build" && isAndroidBuild(project, target.args)) await executeAndroidTask(workspace, ui, project, { args: target.args });
  else await executeElideTask(workspace, project, command, { args: target.args });
}

/**
 * Build a Native Image artifact, then run the binary it produced. `elide run` executes manifest entrypoints, not
 * built images, so the binary is started directly once `elide build <artifact>` has succeeded.
 */
async function runArtifact(workspace: ElideWorkspace, ui: ElideUi, value: unknown): Promise<void> {
  const target = toTarget(value);
  const artifact = target?.args[0];
  if (!target || !artifact) return;
  const project = projectForTarget(workspace, target);
  if (!project) return;

  const execution = await executeElideTask(workspace, project, "build", { args: [artifact] });
  if (!execution) return;
  const code = await taskExitCode(execution);
  // A failed or cancelled build already reports itself in its terminal and in the Problems view.
  if (code !== 0) return;

  const binary = nativeImageBinary(project.root, { outputName: target.outputName, projectName: project.model?.name });
  if (!existsSync(binary)) {
    ui.log(`no binary at ${binary} after building ${artifact}`);
    void vscode.window.showWarningMessage(`Elide: ${artifact} built, but no binary was found at ${binary}.`);
    return;
  }
  ui.log(`running ${binary}`);
  await executeProgramTask(project, `run ${artifact}`, binary);
}

async function runNamedTask(workspace: ElideWorkspace, ui: ElideUi, value: unknown): Promise<void> {
  const target = toTarget(value);
  if (!target?.command) return;
  await runEntrypoint(workspace, ui, target, target.command);
}

/**
 * Start a debug session for a target. `run` (the default) debugs an entrypoint, `build` debugs the named build
 * targets, `test` debugs the whole test run.
 */
async function debugEntrypoint(workspace: ElideWorkspace, value: unknown): Promise<void> {
  const target = toTarget(value);
  if (!target) return;
  const project = projectForTarget(workspace, target);
  if (!project) return;
  const rel = path.relative(project.folder.uri.fsPath, project.root);
  const command = target.command === "build" || target.command === "test" ? target.command : "run";
  // Build targets name themselves in the session, since a project has several; `run` and `test` have one each.
  const label = { run: "Run", test: "Test", build: `Build ${target.args.join(" ")}`.trim() }[command];
  await vscode.debug.startDebugging(project.folder, {
    type: ELIDE_DEBUG_TYPE,
    request: "launch",
    name: `Elide: ${label} (debug)`,
    ...(command === "run" ? {} : { command }),
    ...(command === "build" ? { targets: target.args } : target.args[0] ? { entrypoint: target.args[0] } : {}),
    ...(rel ? { project: rel } : {}),
  });
}

/**
 * Build a Native Image artifact, then debug the binary it produced. An `elide-native` configuration owns the whole
 * sequence, so the command only names the artifact.
 */
async function debugArtifact(workspace: ElideWorkspace, value: unknown): Promise<void> {
  const target = toTarget(value);
  const artifact = target?.args[0];
  if (!target || !artifact) return;
  const project = projectForTarget(workspace, target);
  if (!project) return;
  const rel = path.relative(project.folder.uri.fsPath, project.root);
  await vscode.debug.startDebugging(project.folder, {
    type: ELIDE_NATIVE_DEBUG_TYPE,
    request: "launch",
    name: `Elide: Debug ${artifact}`,
    artifact,
    ...(rel ? { project: rel } : {}),
  });
}

async function openManifest(workspace: ElideWorkspace, value: unknown): Promise<void> {
  let root = toTarget(value)?.root;
  if (!root) {
    const projects = workspace.projects;
    if (projects.length === 0) {
      void vscode.window.showInformationMessage("Elide: no elide.pkl found in the open workspace folders.");
      return;
    }
    root =
      projects.length === 1
        ? projects[0]?.root
        : (await vscode.window.showQuickPick(
            projects.map((p) => ({ label: p.model?.name ?? path.basename(p.root), description: p.root, root: p.root })),
            { placeHolder: "Which project?" },
          ))?.root;
  }
  if (!root) return;
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, MANIFEST_NAME)));
}

/** Show a dependency's jar in the OS file manager; invoked from the `library` rows of the Elide sidebar. */
async function revealLibrary(value: unknown): Promise<void> {
  const classes = typeof value === "object" && value !== null && "classes" in value ? value.classes : undefined;
  if (typeof classes !== "string" || classes.length === 0) return;
  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(classes));
}
