import path from "node:path";
import { MANIFEST_NAME, WORKSPACE_JSON, isLockfileName } from "@elide/ide-core";
import * as vscode from "vscode";
import { ElideCodeLensProvider } from "./codelens.js";
import { readConfig } from "./config.js";
import { ELIDE_DEBUG_TYPE, ElideDebugConfigurationProvider } from "./debug.js";
import { ElideUi } from "./output.js";
import { ElideWorkspace, type ElideProject } from "./projects.js";
import { ELIDE_TASK_TYPE, ElideTaskProvider, entrypointArgs, entrypointLabel, executeElideTask, type ElideTaskCommand } from "./tasks.js";

const DEBOUNCE_MS = 1_000;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const ui = new ElideUi();
  const workspace = new ElideWorkspace(ui, context.globalState);
  context.subscriptions.push(ui, workspace);

  const codeLenses = new ElideCodeLensProvider(workspace);
  context.subscriptions.push(
    codeLenses,
    vscode.languages.registerCodeLensProvider(ElideCodeLensProvider.selector, codeLenses),
    vscode.commands.registerCommand("elide.sync", () => syncCommand(workspace)),
    vscode.commands.registerCommand("elide.showOutput", () => ui.output.show(true)),
    vscode.commands.registerCommand("elide.showMenu", () => showMenu(workspace)),
    vscode.commands.registerCommand("elide.openWorkspaceJson", () => openWorkspaceJson(workspace)),
    vscode.commands.registerCommand("elide.runTask", () => runTaskCommand(workspace)),
    vscode.commands.registerCommand("elide.run", (target: unknown) => runEntrypoint(workspace, target, "run")),
    vscode.commands.registerCommand("elide.build", (target: unknown) => runEntrypoint(workspace, target, "build")),
    vscode.commands.registerCommand("elide.debug", (target: unknown) => debugEntrypoint(workspace, target)),
    vscode.commands.registerCommand("elide.executeTask", (target: unknown) => runNamedTask(workspace, target)),
    vscode.commands.registerCommand("elide.openManifest", (target: unknown) => openManifest(workspace, target)),
    vscode.tasks.registerTaskProvider(ELIDE_TASK_TYPE, new ElideTaskProvider(workspace)),
    vscode.debug.registerDebugConfigurationProvider(ELIDE_DEBUG_TYPE, new ElideDebugConfigurationProvider(workspace, ui, context.subscriptions)),
  );

  registerWatchers(context, workspace, ui);
  context.subscriptions.push(
    workspace.onDidChange(() => void vscode.commands.executeCommand("setContext", "elide.hasProjects", workspace.projects.length > 0)),
  );

  for (const folder of vscode.workspace.workspaceFolders ?? []) await workspace.discover(folder);
  await vscode.commands.executeCommand("setContext", "elide.hasProjects", workspace.projects.length > 0);
  // No project is not a dead end: commands, the welcome view and project creation stay available.
  if (workspace.projects.length === 0) ui.log("No elide.pkl found in the workspace.");
  else {
    ui.setStatus("idle");
    if (readConfig().syncOnStartup) void workspace.syncAll("startup");
    else workspace.markStaleAll();
  }
}

export function deactivate(): void {}

function registerWatchers(context: vscode.ExtensionContext, workspace: ElideWorkspace, ui: ElideUi): void {
  const timers = new Map<string, NodeJS.Timeout>();
  const schedule = (folder: vscode.WorkspaceFolder, reason: "manifest-change" | "project-added") => {
    const key = folder.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        void workspace.syncFolder(folder, reason);
      }, DEBOUNCE_MS),
    );
  };

  /**
   * React to a change under a project root. `rootOf` maps the changed file to the directory whose manifest owns it;
   * a path that is not a tracked project root belongs to a nested (ignored) manifest and is not a reason to resync.
   */
  const onStale = (uri: vscode.Uri, what: string, rootOf: (fsPath: string) => string) => {
    const located = workspace.locate(uri);
    if (!located) return;
    const folder = located.folder;
    if (!workspace.projectAt(rootOf(located.fsPath)) || workspace.isSelfInflicted(folder)) return;
    workspace.markStale(folder);
    ui.log(`${what} changed: ${uri.fsPath}`);
    const policy = readConfig(folder).onManifestChange;
    if (policy === "always") schedule(folder, "manifest-change");
    else if (policy === "prompt") void promptReload(folder, workspace);
  };

  const manifests = vscode.workspace.createFileSystemWatcher(`**/${MANIFEST_NAME}`);
  manifests.onDidChange((uri) => onStale(uri, MANIFEST_NAME, path.dirname));
  manifests.onDidCreate((uri) => {
    const project = workspace.addProject(uri);
    if (!project) return;
    ui.log(`project added: ${project.root}`);
    ui.setStatus("stale");
    schedule(project.folder, "project-added");
  });
  manifests.onDidDelete(async (uri) => {
    const project = workspace.removeProject(uri);
    if (!project) return;
    ui.log(`project removed: ${project.root}`);
    // Manifests that were nested inside the deleted project become projects of their own.
    await workspace.discover(project.folder);
    if (workspace.projectsIn(project.folder).length > 0) void workspace.syncFolder(project.folder, "project-removed");
    else ui.setStatus("none");
  });

  const lockfiles = vscode.workspace.createFileSystemWatcher("**/.dev/elide.lock*");
  const onLock = (uri: vscode.Uri) => {
    // `<project root>/.dev/elide.lock*.bin`: two levels up from the lockfile.
    if (isLockfileName(path.basename(uri.fsPath))) onStale(uri, "lockfile", (p) => path.dirname(path.dirname(p)));
  };
  lockfiles.onDidChange(onLock);
  lockfiles.onDidCreate(onLock);

  context.subscriptions.push(
    manifests,
    lockfiles,
    vscode.workspace.onDidChangeWorkspaceFolders(async (e) => {
      for (const removed of e.removed) workspace.removeFolder(removed);
      for (const added of e.added) {
        const projects = await workspace.discover(added);
        if (projects.length > 0) void workspace.syncFolder(added, "startup");
      }
    }),
    { dispose: () => timers.forEach((t) => clearTimeout(t)) },
  );
}

const prompting = new Set<string>();

async function promptReload(folder: vscode.WorkspaceFolder, workspace: ElideWorkspace): Promise<void> {
  const key = folder.uri.toString();
  if (prompting.has(key)) return;
  prompting.add(key);
  try {
    const pick = await vscode.window.showInformationMessage(`elide.pkl changed in ${folder.name}. Reload Elide project?`, "Reload", "Ignore");
    if (pick === "Reload") await workspace.syncFolder(folder, "manifest-change");
  } finally {
    prompting.delete(key);
  }
}

async function syncCommand(workspace: ElideWorkspace): Promise<void> {
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

/** Actions offered by the status-bar menu, in order; entries whose command is not registered are skipped. */
const MENU_ACTIONS: { label: string; description: string; command: string }[] = [
  { label: "$(sync) Sync Project(s)", description: "Re-resolve the project model and refresh the Kotlin LSP", command: "elide.sync" },
  { label: "$(play) Run Elide Command…", description: "Build, test, install, or run an entrypoint", command: "elide.runTask" },
  { label: "$(beaker) Run All Tests", description: "Run every test in the Testing view", command: "testing.runAll" },
  { label: "$(file-code) Open elide.pkl", description: "Project manifest", command: "elide.openManifest" },
  { label: "$(json) Open generated Kotlin LSP workspace", description: WORKSPACE_JSON, command: "elide.openWorkspaceJson" },
  { label: "$(output) Show Output", description: "Elide output channel", command: "elide.showOutput" },
  { label: "$(new-folder) New Project…", description: "Create a project from an Elide template", command: "elide.newProject" },
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
      command: "elide.showOutput",
    });
    break;
  }
  items.push(...MENU_ACTIONS.filter((a) => registered.has(a.command)));
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "Elide" });
  if (pick) await vscode.commands.executeCommand(pick.command);
}

async function runTaskCommand(workspace: ElideWorkspace): Promise<void> {
  const items: (vscode.QuickPickItem & { command: ElideTaskCommand; args: string[]; project: ElideProject })[] = [];
  for (const project of workspace.projects) {
    const rel = path.relative(project.folder.uri.fsPath, project.root);
    const desc = rel ? rel : project.folder.name;
    const add = (command: ElideTaskCommand, args: string[] = [], label = [command, ...args].join(" ")) =>
      items.push({ label: `elide ${label}`, description: desc, command, args, project });
    add("build");
    add("test");
    add("install");
    for (const ep of project.model?.entrypoints ?? []) add("run", entrypointArgs(ep), entrypointLabel(ep));
  }
  if (items.length === 0) {
    void vscode.window.showInformationMessage("Elide: no Elide projects found; run 'Elide: Sync Project(s)' first.");
    return;
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "Elide command to run" });
  if (!pick) return;
  await executeElideTask(workspace, pick.project, pick.command, pick.args);
}

/** What a `elide.run`/`elide.debug`/`elide.build`/`elide.executeTask` invocation points at. */
interface CommandTarget {
  root: string;
  args: string[];
  command?: ElideTaskCommand;
}

const TASK_COMMANDS: Record<string, ElideTaskCommand> = { build: "build", run: "run", test: "test", install: "install" };

/**
 * Normalize a command argument: code lenses and menu items pass their own objects, but all of them carry the
 * project root and, where it applies, the argument vector and the Elide subcommand.
 */
function toTarget(value: unknown): CommandTarget | undefined {
  if (typeof value !== "object" || value === null || !("root" in value) || typeof value.root !== "string") return undefined;
  const rawArgs = "args" in value ? value.args : undefined;
  const args = Array.isArray(rawArgs) ? rawArgs.filter((a): a is string => typeof a === "string") : [];
  const command = "command" in value && typeof value.command === "string" ? TASK_COMMANDS[value.command] : undefined;
  return { root: value.root, args, ...(command ? { command } : {}) };
}

function projectForTarget(workspace: ElideWorkspace, target: CommandTarget): ElideProject | undefined {
  const project = workspace.projectAt(target.root);
  if (!project) void vscode.window.showWarningMessage(`Elide: project ${target.root} is not synced; run 'Elide: Sync Project(s)'.`);
  return project;
}

async function runEntrypoint(workspace: ElideWorkspace, value: unknown, command: ElideTaskCommand): Promise<void> {
  const target = toTarget(value);
  if (!target) return;
  const project = projectForTarget(workspace, target);
  if (project) await executeElideTask(workspace, project, command, target.args);
}

async function runNamedTask(workspace: ElideWorkspace, value: unknown): Promise<void> {
  const target = toTarget(value);
  if (!target?.command) return;
  const project = projectForTarget(workspace, target);
  if (project) await executeElideTask(workspace, project, target.command, target.args);
}

async function debugEntrypoint(workspace: ElideWorkspace, value: unknown): Promise<void> {
  const target = toTarget(value);
  if (!target) return;
  const project = projectForTarget(workspace, target);
  if (!project) return;
  const rel = path.relative(project.folder.uri.fsPath, project.root);
  await vscode.debug.startDebugging(project.folder, {
    type: ELIDE_DEBUG_TYPE,
    request: "launch",
    name: "Elide: Run (debug)",
    ...(target.args[0] ? { entrypoint: target.args[0] } : {}),
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
