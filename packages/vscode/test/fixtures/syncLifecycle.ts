import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { mock } from "bun:test";
import * as core from "@elide/ide-core";

const scenario = process.argv[2];
const root = await fs.mkdtemp(path.join(tmpdir(), "elide-sync-test-"));

interface FileUri { scheme: "file"; fsPath: string; path: string; toString(): string }
type Folder = { name: string; index: number; uri: FileUri };
function fileUri(fsPath: string): FileUri {
  return { scheme: "file", fsPath, path: fsPath, toString: () => `file://${fsPath}` };
}
class Emitter<T> {
  private readonly listeners = new Set<(event: T) => void>();
  readonly event = (listener: (event: T) => void) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(event: T): void {
    for (const listener of [...this.listeners]) listener(event);
  }
  dispose(): void {
    this.listeners.clear();
  }
}
class Disposable {
  constructor(private readonly done: () => void) {}
  dispose(): void {
    this.done();
  }
}

const workspaceFolders: Folder[] = [];
/** Every `elide.pkl` findFiles reports. */
const manifests = new Set<string>();
/** Settings by section, then a folder's own values by its path. */
const settings: Record<string, Record<string, unknown>> = { elide: { "sync.showProgressNotification": false }, intellij: {} };
const folderSettings = new Map<string, Record<string, unknown>>();
const diagnostics = new Map<string, unknown>();
const commands = new Map<string, (...args: unknown[]) => unknown>();
const reloads: boolean[] = [];
const komodoSyncs: string[] = [];
let inspected: (key: string) => void = () => {};
let outputClosed = false;
const lines: string[] = [];

mock.module("vscode", () => ({
  EventEmitter: Emitter,
  Disposable,
  Uri: { file: fileUri, parse: (text: string) => fileUri(text.replace(/^file:\/\//, "")), from: ({ path: at }: { path: string }) => fileUri(at) },
  RelativePattern: class {
    constructor(readonly base: Folder, readonly pattern: string) {}
  },
  Range: class {},
  Location: class {},
  Diagnostic: class {
    constructor(readonly range: unknown, readonly message: string) {}
  },
  DiagnosticRelatedInformation: class {},
  DiagnosticSeverity: { Error: 0 },
  ThemeColor: class {},
  ThemeIcon: class {},
  MarkdownString: class {
    appendText() { return this; }
    appendMarkdown() { return this; }
    appendCodeblock() { return this; }
  },
  StatusBarAlignment: { Left: 1 },
  ProgressLocation: { Notification: 15 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  languages: {
    createDiagnosticCollection: () => ({
      set: (uri: { fsPath: string }, value: unknown) => diagnostics.set(uri.fsPath, value),
      delete: (uri: { fsPath: string }) => diagnostics.delete(uri.fsPath),
      dispose() {},
    }),
  },
  window: {
    // VS Code's output channel throws once closed.
    createOutputChannel: () => ({
      appendLine: (line: string) => {
        if (outputClosed) throw new Error("Channel has been closed");
        lines.push(line);
      },
      dispose: () => { outputClosed = true; },
    }),
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    showErrorMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
  },
  commands: {
    registerCommand: (id: string, run: (...args: unknown[]) => unknown) => {
      commands.set(id, run);
      return new Disposable(() => commands.delete(id));
    },
    executeCommand: async () => undefined,
  },
  env: { openExternal: async () => true },
  workspace: {
    workspaceFolders,
    textDocuments: [],
    registerTextDocumentContentProvider: () => new Disposable(() => {}),
    getWorkspaceFolder: (uri: { fsPath: string }) =>
      workspaceFolders.find((folder) => uri.fsPath === folder.uri.fsPath || uri.fsPath.startsWith(`${folder.uri.fsPath}${path.sep}`)),
    findFiles: async (pattern: { base: Folder }) =>
      [...manifests].filter((file) => file.startsWith(`${pattern.base.uri.fsPath}${path.sep}`)).map(fileUri),
    getConfiguration: (section: string, scope?: { uri?: { fsPath: string } } | null) => ({
      get: (key: string, fallback?: unknown) => (scope?.uri && folderSettings.get(scope.uri.fsPath)?.[key]) ?? settings[section]?.[key] ?? fallback,
      inspect: (key: string) => {
        inspected(key);
        return { key, globalValue: settings[section]?.[key] };
      },
      update: async (key: string, value: unknown) => {
        settings[section]![key] = value;
      },
    }),
  },
}));

/** What `elide` resolves each project to; the default is a model of the project alone. */
let build: (root: string, options: core.BuildModelOptions) => Promise<unknown[]> = async (projectRoot) => [model(projectRoot)];
const builds: { root: string; options: core.BuildModelOptions }[] = [];
let elideInstalled = true;
mock.module("@elide/ide-core", () => ({
  ...core,
  ElideCli: class {
    constructor(_dist: unknown, readonly root: string) {}
    async manifest() {
      return {};
    }
  },
  buildProjectModels: (cli: { root: string }, _manifest: unknown, options: core.BuildModelOptions) => {
    builds.push({ root: cli.root, options });
    return build(cli.root, options);
  },
  resolveElideDistribution: () => {
    if (!elideInstalled) throw new core.ElideNotFoundError(["/nowhere"]);
    return { bin: "/elide/bin/elide", home: "/elide" };
  },
  lockfileDigest: async () => "lockfile",
  findEnclosingWorkspace: () => undefined,
  writeKotlinLspWorkspace: async () => ({ modules: [], libraries: [] }),
  // A manifest error points at the file the failing command evaluated.
  parseManifestError: (stderr: string, file: string) =>
    stderr.startsWith("manifest:") ? { message: stderr, locations: [{ file, line: 1, column: 1, endColumn: 2 }] } : undefined,
}));
mock.module("../../src/jetbrains.js", () => ({
  KotlinLspEnvironment: class {
    configure() { return false; }
    dispose() {}
  },
  KotlinSetupPendingError: class extends Error {},
  awaitKotlinDebuggerAnalysis: async () => true,
  jetBrainsComposeCompilerPlugin: () => undefined,
  jetBrainsServerDirectory: () => undefined,
  notifyKotlinSetupPending: () => {},
  reloadKotlinLsp: async (restart: boolean) => {
    reloads.push(restart);
    return "test";
  },
}));
mock.module("../../src/komodoLsp.js", () => ({
  KomodoLanguageServer: class {
    async sync(folder: Folder) {
      komodoSyncs.push(folder.name);
      return "started";
    }
    async remove() {}
    dispose() {}
  },
}));
mock.module("../../src/manifestModules.js", () => ({ projectModules: async () => new Map(), moduleReaders: () => new Map() }));
mock.module("../../src/gitExclude.js", () => ({ gitExcludeCandidate: async () => undefined, addGitExclude: async () => {} }));
mock.module("../../src/kotlinAnalysis.js", () => ({ probeSourceRoot: () => undefined }));
mock.module("../../src/kotlinLspPlugin.js", () => ({ kotlinLspPlugin: async () => "/plugin", withoutKotlinLspPlugin: () => undefined }));
// The workspace's dependencies must be replaced before the real modules capture them.
const { ElideUi } = await import("../../src/output.js");
const { ElideWorkspace } = await import("../../src/projects.js");

function model(projectRoot: string, extra: Record<string, unknown> = {}) {
  return { root: projectRoot, name: path.basename(projectRoot), members: [], warnings: [], kotlin: { compose: false }, ...extra };
}

const memento = new Map<string, unknown>();
const ui = new ElideUi();
const statuses: string[] = [];
const setStatus = ui.setStatus.bind(ui);
ui.setStatus = (kind, detail) => {
  statuses.push(kind);
  setStatus(kind, detail);
};
const workspace = new ElideWorkspace(ui, { get: (key: string) => memento.get(key), update: async (key: string, value: unknown) => void memento.set(key, value), keys: () => [...memento.keys()] } as never, "/plugin-sources", root);

/** A workspace folder named `name` holding a project at each of `projects`, discovered as at startup. */
async function openFolder(name: string, projects: string[] = ["."], own: Record<string, unknown> = {}): Promise<Folder> {
  const folder = { name, index: workspaceFolders.length, uri: fileUri(path.join(root, name)) };
  workspaceFolders.push(folder);
  folderSettings.set(folder.uri.fsPath, own);
  for (const project of projects) manifests.add(path.join(folder.uri.fsPath, project, "elide.pkl"));
  await workspace.discover(folder as never);
  return folder;
}

/** Sync operations in the Activity view, oldest first. */
function operations() {
  return ui.activity.getChildren().slice().reverse();
}

/** Cancel the running sync as the Activity view's Cancel action does. */
function cancel(): void {
  const running = operations().find((operation) => operation.running);
  assert.ok(running, "a sync is running");
  commands.get("elide.cancelActivity")!(running);
}

/** A build that waits until its sync is aborted, then fails as the CLI's kill does. */
function untilAborted(_root: string, options: core.BuildModelOptions): Promise<unknown[]> {
  const { promise, reject } = Promise.withResolvers<unknown[]>();
  options.signal!.addEventListener("abort", () => reject(options.signal!.reason));
  return promise;
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (const deadline = Date.now() + 2_000; !condition(); await sleep(5)) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
  }
}

try {
  if (scenario === "install-failure") {
    const app = await openFolder("app");
    const offline = new core.ElideCommandFailedError(["install", "--slim", "--with=sources"], 1, "error: could not resolve com.example:lib:1.0 (network is unreachable)");
    build = async (projectRoot, options) => {
      if (options.installWith) throw offline;
      return [model(projectRoot)];
    };
    await workspace.syncFolder(app as never, "manual");
    assert.equal(builds.length, 1, "an install failure is not retried without the classifier flags");
    assert.equal(workspace.lastError(app as never), offline.message, "the sync reports the install's own failure");
    assert.equal(operations().at(-1)?.state, "failed");

    // A release that predates the flags installs with its defaults, forced as the first attempt was.
    builds.length = 0;
    const unknown = new core.ElideCommandFailedError(["install", "--slim", "--with=sources"], 2, "Unknown options: '--slim', '--with=sources'");
    build = async (projectRoot, options) => {
      if (options.installWith) throw unknown;
      return [model(projectRoot)];
    };
    await workspace.syncFolder(app as never, "manual");
    assert.deepEqual(builds.map(({ options }) => [options.installWith, options.forceInstall]), [[["sources"], true], [undefined, true]]);
    assert.equal(workspace.lastError(app as never), undefined);
  } else if (scenario === "member-manifest") {
    const folder = await openFolder("ws", [".", "app", "lib"]);
    const wsRoot = folder.uri.fsPath;
    const app = fileUri(path.join(wsRoot, "app", "elide.pkl"));
    const lib = fileUri(path.join(wsRoot, "lib", "elide.pkl"));
    assert.equal(workspace.manifestOwner(app as never), undefined, "a nested manifest no sync has read is not the root's");
    // The root's sync fails on its member's manifest before any member is tracked.
    build = async () => {
      throw new core.ElideCommandFailedError(["project", "export"], 1, "manifest: app/elide.pkl: cannot find property", wsRoot);
    };
    await workspace.syncFolder(folder as never, "startup");
    assert.equal(workspace.manifestOwner(app as never)?.root, wsRoot, "fixing the member's manifest makes the root stale");
    // Once synced, the member is tracked; a nested manifest the workspace does not declare is not a reason to sync,
    // unless it just appeared and may be a member the root declares.
    const appRoot = path.join(wsRoot, "app");
    build = async (projectRoot) => [model(projectRoot, { members: [appRoot] }), model(appRoot)];
    await workspace.syncFolder(folder as never, "manual");
    assert.equal(workspace.manifestOwner(app as never)?.root, appRoot);
    assert.equal(workspace.manifestOwner(lib as never), undefined);
    assert.equal(workspace.manifestOwner(lib as never, true)?.root, wsRoot);
  } else if (scenario === "own-writes") {
    const folder = await openFolder("ws");
    const file = path.join(folder.uri.fsPath, "elide.pkl");
    await fs.mkdir(folder.uri.fsPath, { recursive: true });
    await fs.writeFile(file, "members {}\n");
    let during: boolean | undefined;
    await workspace.writeManifest(file, async () => {
      await fs.writeFile(file, "members { \"app\" }\n");
      during = await workspace.isOwnManifestWrite(fileUri(file) as never);
    });
    assert.equal(during, true, "an event while the wizard writes is its own");
    assert.equal(await workspace.isOwnManifestWrite(fileUri(file) as never), true, "so is a late event for the text it wrote");
    await fs.writeFile(file, "members { \"app\"; \"lib\" }\n");
    assert.equal(await workspace.isOwnManifestWrite(fileUri(file) as never), false, "an edit after it is someone's");
    await fs.writeFile(file, "members { \"app\" }\n");
    assert.equal(await workspace.isOwnManifestWrite(fileUri(file) as never), false, "and so is every later one");
    assert.equal(await workspace.isOwnManifestWrite(fileUri(path.join(folder.uri.fsPath, "app", "elide.pkl")) as never), false);
  } else if (scenario === "status") {
    const a = await openFolder("a");
    const b = await openFolder("b");
    assert.equal(statuses.at(-1), "idle");
    const bResolves = Promise.withResolvers<void>();
    build = async (projectRoot) => {
      if (projectRoot === a.uri.fsPath) throw new Error("a does not resolve");
      await bResolves.promise;
      return [model(projectRoot)];
    };
    const syncing = workspace.syncAll("manual");
    await until(() => workspace.lastError(a as never) !== undefined, "a's sync to fail");
    bResolves.resolve();
    await syncing;
    assert.equal(statuses.at(-1), "error", "b finishing last does not hide a's failure");
    workspace.markStale(b as never);
    assert.equal(statuses.at(-1), "error");
    build = async (projectRoot) => [model(projectRoot)];
    await workspace.syncFolder(a as never, "manual");
    assert.equal(statuses.at(-1), "stale", "b is still out of date");
    await workspace.syncFolder(b as never, "manual");
    assert.equal(statuses.at(-1), "idle");

    // Cancelling the first sync of a folder leaves it out of date, not in sync.
    const c = await openFolder("c");
    build = untilAborted;
    const first = workspace.syncFolder(c as never, "startup");
    await until(() => builds.some((started) => started.root === c.uri.fsPath), "c's sync to start");
    cancel();
    await first;
    assert.equal(operations().at(-1)?.state, "cancelled");
    assert.equal(workspace.isStale(c as never), true);
    assert.equal(statuses.at(-1), "stale");
  } else if (scenario === "remove-folder") {
    const app = await openFolder("app");
    build = async () => {
      throw new core.ElideCommandFailedError(["project", "export"], 1, "manifest: cannot find property", app.uri.fsPath);
    };
    await workspace.syncFolder(app as never, "startup");
    assert.equal(diagnostics.size, 1, "the failed sync points at the manifest");
    // A sync superseded by a newer one is still stopping when its folder leaves the window.
    const entered = Promise.withResolvers<void>();
    build = (_root, options) => {
      entered.resolve();
      const { promise, reject } = Promise.withResolvers<unknown[]>();
      options.signal!.addEventListener("abort", () => setTimeout(() => reject(options.signal!.reason), 20));
      return promise;
    };
    const first = workspace.syncFolder(app as never, "manual");
    await entered.promise;
    void workspace.syncFolder(app as never, "manifest-change");
    workspaceFolders.splice(0, 1);
    workspace.removeFolder(app as never);
    await first;
    assert.equal(diagnostics.size, 0, "the removed folder's manifest error leaves Problems");
    // What a debounced lockfile change or a Reload click does later.
    workspace.markStale(app as never);
    await workspace.syncFolder(app as never, "manifest-change");
    assert.deepEqual(operations().map((operation) => operation.state), ["failed", "cancelled"], "no sync reruns for the removed folder");
    assert.equal(workspace.isStale(app as never), false);
    assert.deepEqual(workspace.projectsIn(app as never), []);
    assert.equal(statuses.at(-1), "none");
  } else if (scenario === "added-folder") {
    // Folders added to the window after startup, one of them opted out of syncing on open.
    const add = async (name: string, own: Record<string, unknown>): Promise<Folder> => {
      const folder = { name, index: workspaceFolders.length, uri: fileUri(path.join(root, name)) };
      workspaceFolders.push(folder);
      folderSettings.set(folder.uri.fsPath, own);
      manifests.add(path.join(folder.uri.fsPath, "elide.pkl"));
      await workspace.addFolder(folder as never);
      return folder;
    };
    const manual = await add("manual", { "sync.onStartup": false });
    assert.deepEqual(builds, [], "a folder with sync.onStartup off is not synced when added");
    assert.equal(workspace.isStale(manual as never), true);
    assert.equal(statuses.at(-1), "stale");
    const auto = await add("auto", {});
    assert.deepEqual(builds.map((started) => started.root), [auto.uri.fsPath]);
  } else if (scenario === "late-cancel") {
    const app = await openFolder("app");
    build = async (projectRoot) => [model(projectRoot, { jdk: { home: "/jdk/17" } })];
    // Cancel while the sync configures the Kotlin LSP, after the models resolved.
    inspected = (key) => {
      if (key === "jdkForSymbolResolution" && workspace.isSyncing(app as never)) cancel();
    };
    await workspace.syncFolder(app as never, "manual");
    assert.equal(operations().at(-1)?.state, "cancelled");
    assert.deepEqual(reloads, [], "a cancelled sync does not reload the Kotlin LSP");
  } else if (scenario === "window-jdk") {
    const android = await openFolder("android");
    const service = await openFolder("service");
    const jdks: Record<string, string> = { [android.uri.fsPath]: "/jdk/17", [service.uri.fsPath]: "/jdk/21" };
    build = async (projectRoot) => [model(projectRoot, { jdk: { home: jdks[projectRoot] } })];
    await workspace.syncFolder(service as never, "startup");
    assert.equal(settings.intellij!.jdkForSymbolResolution, undefined, "only the window's first folder sets its JDK");
    await workspace.syncFolder(android as never, "startup");
    assert.equal(settings.intellij!.jdkForSymbolResolution, "/jdk/17");
    await workspace.syncFolder(service as never, "manual");
    assert.equal(settings.intellij!.jdkForSymbolResolution, "/jdk/17", "a later sync of another folder keeps it");
  } else if (scenario === "settings") {
    const changed = (key: string) => ({ affectsConfiguration: (section: string) => section === key });
    elideInstalled = false;
    const app = await openFolder("app");
    await workspace.syncFolder(app as never, "startup");
    assert.match(workspace.lastError(app as never) ?? "", /Elide CLI not found/);
    // The user sets elide.home, as the failure's notification offers.
    elideInstalled = true;
    workspace.settingsChanged(changed("elide.home") as never);
    await until(() => operations().length === 2 && !workspace.isSyncing(app as never), "a sync with the new distribution");
    assert.equal(workspace.lastError(app as never), undefined);
    // Whatever else the model was resolved with leaves it out of date, without syncing on its own.
    for (const key of ["elide.jdk.home", "elide.install.classifiers", "elide.flags", "elide.home"]) {
      await workspace.syncFolder(app as never, "manual");
      workspace.settingsChanged(changed(key) as never);
      assert.equal(workspace.isStale(app as never), true, `${key} leaves the model out of date`);
    }
    assert.equal(operations().length, 6);
    // Komodo runs from the distribution: a new elide.home restarts it with the models the folder has.
    folderSettings.get(app.uri.fsPath)!["kotlinLsp.server"] = "komodo";
    await workspace.syncFolder(app as never, "manual");
    assert.deepEqual(komodoSyncs, ["app"]);
    workspace.settingsChanged(changed("elide.home") as never);
    assert.deepEqual(komodoSyncs, ["app", "app"]);
  } else if (scenario === "dispose") {
    const app = await openFolder("app");
    build = untilAborted;
    const unhandled: unknown[] = [];
    process.on("unhandledRejection", (error) => unhandled.push(error));
    // As at startup: nothing awaits the sync.
    void workspace.syncFolder(app as never, "startup");
    await until(() => builds.length === 1, "the sync to start");
    // A window reload disposes the extension's subscriptions in order, the UI first; that cancels the sync.
    ui.dispose();
    workspace.dispose();
    await sleep(20);
    assert.deepEqual(unhandled, [], "the cancelled sync ends quietly after its output channel closed");
  } else throw new Error(`unknown scenario ${scenario}`);
} finally {
  workspace.dispose();
  ui.dispose();
  await fs.rm(root, { recursive: true, force: true });
}
process.exit(0);
