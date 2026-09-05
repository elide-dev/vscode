import path from "node:path";
import { MANIFEST_NAME, WORKSPACE_JSON, isLockfileName } from "@elide/ide-core";
import * as vscode from "vscode";
import { readConfig } from "./config.js";
import { ELIDE_DEBUG_TYPE, ElideDebugConfigurationProvider } from "./debug.js";
import { ElideUi } from "./output.js";
import { ElideWorkspace } from "./projects.js";
import { ELIDE_TASK_TYPE, ElideTaskProvider, entrypointArgs, entrypointLabel } from "./tasks.js";

const DEBOUNCE_MS = 1_000;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const ui = new ElideUi();
  const workspace = new ElideWorkspace(ui, context.globalState);
  context.subscriptions.push(ui, workspace);

  context.subscriptions.push(
    vscode.commands.registerCommand("elide.sync", () => syncCommand(workspace)),
    vscode.commands.registerCommand("elide.showOutput", () => ui.output.show(true)),
    vscode.commands.registerCommand("elide.openWorkspaceJson", () => openWorkspaceJson(workspace)),
    vscode.commands.registerCommand("elide.runTask", () => runTaskCommand(workspace)),
    vscode.tasks.registerTaskProvider(ELIDE_TASK_TYPE, new ElideTaskProvider(workspace)),
    vscode.debug.registerDebugConfigurationProvider(ELIDE_DEBUG_TYPE, new ElideDebugConfigurationProvider(workspace, ui, context.subscriptions)),
  );

  registerWatchers(context, workspace, ui);

  for (const folder of vscode.workspace.workspaceFolders ?? []) await workspace.discover(folder);
  if (workspace.projects.length === 0) {
    ui.log("No elide.pkl found in the workspace.");
    return;
  }
  ui.setStatus("idle");
  if (readConfig().syncOnStartup) void workspace.syncAll("startup");
  else workspace.markStaleAll();
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

  const onStale = (uri: vscode.Uri, what: string) => {
    const folder = workspace.locate(uri)?.folder;
    if (!folder || workspace.projectsIn(folder).length === 0 || workspace.isSelfInflicted(folder)) return;
    workspace.markStale(folder);
    ui.log(`${what} changed: ${uri.fsPath}`);
    const policy = readConfig(folder).onManifestChange;
    if (policy === "always") schedule(folder, "manifest-change");
    else if (policy === "prompt") void promptReload(folder, workspace);
  };

  const manifests = vscode.workspace.createFileSystemWatcher(`**/${MANIFEST_NAME}`);
  manifests.onDidChange((uri) => onStale(uri, MANIFEST_NAME));
  manifests.onDidCreate((uri) => {
    const project = workspace.addProject(uri);
    if (!project) return;
    ui.log(`project added: ${project.root}`);
    ui.setStatus("stale");
    schedule(project.folder, "project-added");
  });
  manifests.onDidDelete((uri) => {
    const project = workspace.removeProject(uri);
    if (!project) return;
    ui.log(`project removed: ${project.root}`);
    if (workspace.projectsIn(project.folder).length > 0) void workspace.syncFolder(project.folder, "project-removed");
    else ui.setStatus("none");
  });

  const lockfiles = vscode.workspace.createFileSystemWatcher("**/.dev/elide.lock*");
  const onLock = (uri: vscode.Uri) => {
    if (isLockfileName(path.basename(uri.fsPath))) onStale(uri, "lockfile");
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

async function runTaskCommand(workspace: ElideWorkspace): Promise<void> {
  const items: (vscode.QuickPickItem & { command: string; args: string[]; root: string; folder: vscode.WorkspaceFolder })[] = [];
  for (const project of workspace.projects) {
    const rel = path.relative(project.folder.uri.fsPath, project.root);
    const desc = rel ? rel : project.folder.name;
    const add = (command: string, args: string[] = [], label = [command, ...args].join(" ")) =>
      items.push({ label: `elide ${label}`, description: desc, command, args, root: project.root, folder: project.folder });
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
  const rel = path.relative(pick.folder.uri.fsPath, pick.root);
  const definition = { type: ELIDE_TASK_TYPE, command: pick.command, ...(pick.args.length ? { args: pick.args } : {}), ...(rel ? { project: rel } : {}) };
  const provider = new ElideTaskProvider(workspace);
  const task = provider.resolveTask(new vscode.Task(definition, pick.folder, pick.label, ELIDE_TASK_TYPE));
  if (task) await vscode.tasks.executeTask(task);
}
