import { existsSync } from "node:fs";
import {
  ANDROID_DATABASE_DEBUGGABLE_HINT, adbExecutable, AndroidDatabaseSession, listAndroidDatabasePackages,
  type AndroidDatabaseObject, type AndroidDatabasePackage, type AndroidDatabaseResult,
} from "@elide/ide-core";
import * as vscode from "vscode";
import { androidSdkFor, attachedDevices, toAndroidTarget } from "./android.js";
import type { AndroidDeploymentTarget } from "./androidDeploymentState.js";
import { NO_ANDROID_PROJECT, preferredAndroidProject } from "./androidDeploymentState.js";
import { databaseHtml } from "./androidDatabaseHtml.js";
import type { ElideProject, ElideWorkspace } from "./projects.js";

type SessionOptions = ConstructorParameters<typeof AndroidDatabaseSession>[0];
const PAGE_SIZE = 100;
const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** One panel pins one app and serial. No device switch can redirect a pending SQL write. */
class DatabasePanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly subscriptions: vscode.Disposable[] = [];
  private session: AndroidDatabaseSession;
  private disposed = false;
  private revision = 0;
  private busy = false;
  private databases: string[] = [];
  private database: string | undefined;
  private objects: AndroidDatabaseObject[] = [];
  private lastRead: { sql: string; offset: number } | undefined;

  constructor(private readonly options: SessionOptions, private readonly valid: () => boolean, onClose: () => void) {
    this.session = new AndroidDatabaseSession(options);
    this.panel = vscode.window.createWebviewPanel("elide.androidDatabase", `Databases: ${options.packageName}`, vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
    this.subscriptions.push(
      this.panel.onDidDispose(() => { this.dispose(); onClose(); }),
      this.panel.webview.onDidReceiveMessage((message: unknown) => { void this.receive(message); }),
    );
    this.panel.webview.html = databaseHtml();
  }

  private post(message: object): void {
    if (!this.disposed) void this.panel.webview.postMessage(message);
  }

  private current(revision: number): boolean {
    return !this.disposed && revision === this.revision && this.valid() && vscode.workspace.isTrusted;
  }

  private async catalog(revision: number, requested?: string): Promise<void> {
    const databases = await this.session.databases();
    if (!this.current(revision)) return;
    this.databases = databases;
    const next = requested && databases.includes(requested) ? requested : databases[0];
    if (next !== this.database) this.lastRead = undefined;
    this.database = next;
    const objects = next ? await this.session.schema(next) : [];
    if (!this.current(revision)) return;
    this.objects = objects;
    this.post({ type: "catalog", databases, database: next, objects });
  }

  private async read(sql: string, offset: number, revision: number, updateEditor = true): Promise<void> {
    if (!this.database) throw new Error("Select a database first. Launch the app and open a screen that creates its Room database, then refresh.");
    let result: AndroidDatabaseResult;
    try {
      result = await this.session.query(this.database, sql, PAGE_SIZE, offset);
    } catch (error) {
      // The webview drops its rows on error; a later refresh must not repaint an older query under this SQL.
      if (this.current(revision)) this.lastRead = undefined;
      throw error;
    }
    if (!this.current(revision)) return;
    this.lastRead = { sql, offset };
    this.post({ type: "result", ...result, sql, offset, updateEditor, pageSize: PAGE_SIZE, at: new Date().toLocaleTimeString() });
  }

  private async receive(value: unknown): Promise<void> {
    if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string" || this.disposed) return;
    const message = value as Record<string, unknown>;
    if (message.type === "cancel") {
      if (!this.busy) return;
      this.revision++;
      // Cancellation drops the displayed rows, including a query whose replacement never completed.
      this.lastRead = undefined;
      // The helper is stopped; the session and its installed DEX stay for the next request.
      this.session.cancel();
      this.busy = false;
      this.post({ type: "error", message: "Request cancelled. If a write was in flight, its outcome is unknown; refresh before retrying." });
      this.post({ type: "busy", busy: false });
      return;
    }
    if (this.busy || !this.current(this.revision)) return;
    if (message.type === "refresh" && message.automatic === true && !this.panel.visible) return;
    if (!["ready", "refresh", "database", "browse", "query", "execute", "page"].includes(message.type as string)) return;
    this.busy = true;
    const revision = ++this.revision;
    this.post({ type: "busy", busy: true });
    try {
      switch (message.type) {
        case "ready":
          this.post({ type: "identity", device: this.options.device, packageName: this.options.packageName });
          await this.catalog(revision);
          break;
        case "refresh":
          await this.catalog(revision, this.database);
          if (this.current(revision) && this.lastRead) await this.read(this.lastRead.sql, this.lastRead.offset, revision, false);
          break;
        case "database":
          if (typeof message.database !== "string" || !this.databases.includes(message.database)) throw new Error("Database is no longer available. Refresh the database list.");
          await this.catalog(revision, message.database);
          break;
        case "browse": {
          const object = this.objects.find((item) => item.name === message.name && (item.type === "table" || item.type === "view"));
          if (!object) throw new Error("Table or view is no longer available. Refresh the schema.");
          await this.read(`SELECT * FROM ${quoteIdentifier(object.name)}`, 0, revision);
          break;
        }
        case "page": {
          if (!this.lastRead || (message.direction !== 1 && message.direction !== -1)) return;
          const offset = Math.max(0, this.lastRead.offset + message.direction * PAGE_SIZE);
          await this.read(this.lastRead.sql, offset, revision, false);
          break;
        }
        case "query":
        case "execute": {
          if (typeof message.sql !== "string" || !message.sql.trim() || Buffer.byteLength(message.sql, "utf8") > 65_536) throw new Error("Enter one SQL statement (at most 64 KiB).");
          if (message.type === "query") {
            await this.read(message.sql, 0, revision);
            break;
          }
          if (!this.database) throw new Error("Select a database first.");
          const database = this.database;
          const answer = await vscode.window.showWarningMessage(
            `Modify ${this.options.packageName} / ${database} on ${this.options.device}?`,
            { modal: true, detail: `This writes directly to the connected app's database. Room observers are not notified. Back up important data first.\n\n${message.sql.slice(0, 2_000)}${message.sql.length > 2_000 ? "\n… (statement continues in editor)" : ""}` },
            "Execute write",
          );
          if (answer !== "Execute write" || !this.current(revision)) {
            if (this.current(revision)) this.post({ type: "notice", message: "Write cancelled; no SQL was sent." });
            break;
          }
          const result = await this.session.execute(database, message.sql);
          if (!this.current(revision)) return;
          // A completed write invalidates both rows and schema, never silently re-executes editor SQL.
          this.lastRead = undefined;
          try {
            await this.catalog(revision, database);
          } catch (error) {
            throw new Error(`Write committed (${result.changes} rows changed), but schema refresh failed: ${errorText(error)}`);
          }
          if (this.current(revision)) this.post({ type: "written", changes: result.changes });
          break;
        }
      }
    } catch (error) {
      if (this.current(revision)) this.post({ type: "error", message: errorText(error) });
    } finally {
      if (this.current(revision)) {
        this.busy = false;
        this.post({ type: "busy", busy: false });
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.revision++;
    this.session.dispose();
    this.panel.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}

/** Palette, Android tree and device menu share selection and owned panel lifetimes. */
export function registerAndroidDatabase(
  workspace: ElideWorkspace,
  context: vscode.ExtensionContext,
  deploymentTarget: () => Readonly<AndroidDeploymentTarget> | undefined,
): vscode.Disposable {
  const panels = new Map<string, DatabasePanel>();
  let disposed = false;
  let generation = 0;
  let discovery: AbortController | undefined;
  let openingRoot: string | undefined;
  const valid = (root: string) => !disposed && vscode.workspace.isTrusted && !!workspace.projectAt(root)?.model?.android;
  const fresh = (root: string, revision: number) => valid(root) && revision === generation;
  const cancelDiscovery = () => { generation++; discovery?.abort(); discovery = undefined; openingRoot = undefined; };

  const open = async (value: unknown): Promise<void> => {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage("Elide: trust this workspace before inspecting Android databases.");
      return;
    }
    cancelDiscovery();
    const revision = generation;
    const target = toAndroidTarget(value);
    try {
      const projects = workspace.projects.filter((project) => project.model?.android);
      const editor = vscode.window.activeTextEditor;
      const owner = editor?.document.uri.scheme === "file" ? workspace.projectFor(editor.document.uri.fsPath) : undefined;
      const deployed = deploymentTarget();
      let project: ElideProject | undefined = target ? workspace.projectAt(target.root)
        : preferredAndroidProject(projects, owner, deployed?.root) ?? (projects.length === 1 ? projects[0] : undefined);
      if (!project && !target && projects.length) {
        project = (await vscode.window.showQuickPick(projects.map((project) => ({ label: project.model?.name ?? project.root, description: project.root, project })),
          { placeHolder: "Android project for database inspection" }))?.project;
      }
      if (!project?.model?.android) {
        if (target || !projects.length) void vscode.window.showWarningMessage(NO_ANDROID_PROJECT);
        return;
      }
      const root = project.root;
      if (!fresh(root, revision)) return;
      openingRoot = root;
      const sdk = androidSdkFor(project);
      if (!sdk || !existsSync(adbExecutable(sdk))) throw new Error("Android platform-tools are missing. Install the SDK or set elide.android.sdk.");
      const devices = await attachedDevices(project);
      if (!fresh(root, revision)) return;
      const ready = devices?.filter((device) => device.ready) ?? [];
      const preferred = target?.device ?? (deployed?.root === root && deployed.destination.kind === "device" ? deployed.destination.serial : undefined);
      let device = ready.find((device) => device.serial === preferred);
      if (preferred && !device) throw new Error(`Device ${preferred} is ${devices?.find((item) => item.serial === preferred)?.state ?? "disconnected"}. Reconnect it or select a different deployment target.`);
      if (!ready.length) throw new Error("No ready Android device. Connect and authorize a device or start an emulator.");
      if (!device) device = ready.length === 1 ? ready[0] : (await vscode.window.showQuickPick(ready.map((device) => ({ label: device.serial, description: device.emulator ? "Emulator" : "Device", device })),
        { placeHolder: "Connected device to inspect" }))?.device;
      if (!device || !fresh(root, revision)) return;
      const controller = new AbortController();
      discovery = controller;
      const packages = await listAndroidDatabasePackages(adbExecutable(sdk), device.serial, controller.signal);
      if (!fresh(root, revision)) return;
      if (!packages.length) throw new Error("No third-party applications installed for the current Android user. Install and launch a debuggable app first.");
      const openable = packages.filter((item) => item.refusal === undefined);
      const refused = packages.filter((item) => item.refusal !== undefined);
      if (!openable.length) {
        throw new Error(refused.every((item) => item.notDebuggable)
          ? `None of the ${refused.length} installed applications on ${device.serial} is debuggable. ${ANDROID_DATABASE_DEBUGGABLE_HINT}`
          : `run-as cannot open any installed application on ${device.serial}: ${refused.map((item) => `${item.packageName}: ${item.refusal}`).slice(0, 5).join("; ")}.`);
      }
      type Item = vscode.QuickPickItem & { item?: AndroidDatabasePackage };
      const items: Item[] = openable.map((item) => ({ label: item.packageName, item }));
      if (refused.length) {
        items.push({ label: "Cannot be opened", kind: vscode.QuickPickItemKind.Separator });
        items.push(...refused.map((item) => ({
          label: `$(circle-slash) ${item.packageName}`,
          description: item.notDebuggable ? "not debuggable" : "run-as refused",
          detail: item.notDebuggable ? "run-as only opens debuggable builds" : item.refusal,
          item,
        })));
      }
      const picked = (await vscode.window.showQuickPick(items, { title: `Database explorer · ${device.serial}`, placeHolder: "Installed debuggable application to inspect", matchOnDescription: true }))?.item;
      if (!picked || !fresh(root, revision)) return;
      if (picked.refusal !== undefined) {
        throw new Error(`${picked.packageName} cannot be opened: ${picked.refusal}.${picked.notDebuggable ? ` ${ANDROID_DATABASE_DEBUGGABLE_HINT}` : ""}`);
      }
      const options = { adb: adbExecutable(sdk), device: device.serial, packageName: picked.packageName, helperDex: context.asAbsolutePath("media/database/inspector.dex") };
      panels.get(root)?.dispose();
      const panel = new DatabasePanel(options, () => valid(root), () => { if (panels.get(root) === panel) panels.delete(root); });
      panels.set(root, panel);
    } catch (error) {
      if (!disposed && revision === generation) void vscode.window.showErrorMessage(`Elide database explorer: ${errorText(error)}`);
    } finally {
      if (revision === generation) { discovery = undefined; openingRoot = undefined; }
    }
  };

  const subscriptions = [
    vscode.commands.registerCommand("elide.androidDatabase", open),
    workspace.onDidChange(() => {
      if (openingRoot && !valid(openingRoot)) cancelDiscovery();
      for (const [root, panel] of panels) if (!valid(root)) { panel.dispose(); panels.delete(root); }
    }),
  ];
  return new vscode.Disposable(() => {
    disposed = true;
    cancelDiscovery();
    for (const panel of panels.values()) panel.dispose();
    panels.clear();
    for (const subscription of subscriptions) subscription.dispose();
  });
}
