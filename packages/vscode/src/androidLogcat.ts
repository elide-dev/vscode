import { existsSync } from "node:fs";
import { buffer } from "node:stream/consumers";
import * as yauzl from "yauzl";
import {
  ANDROID_LOGCAT_PRIORITIES,
  AndroidLogcatFormatter,
  AndroidLogcatSession,
  adbExecutable,
  binaryManifestPackage,
  listAndroidDevices,
  type AndroidLogcatOptions,
  type AndroidLogcatPriority,
} from "@elide/ide-core";
import * as vscode from "vscode";
import { androidFolderAt, androidSdkFor, pickAndroidFolder, toAndroidTarget } from "./android.js";
import { ANDROID_LOGCAT_LANGUAGE, registerAndroidStackLinks } from "./androidStackLinks.js";
import type { ElideWorkspace } from "./projects.js";

interface LogcatView {
  root: string;
  output: vscode.OutputChannel;
  formatter: AndroidLogcatFormatter;
  stream: AndroidLogcatSession;
  options: AndroidLogcatOptions;
}

const PRIORITIES: Record<AndroidLogcatPriority, string> = {
  V: "Verbose", D: "Debug", I: "Info", W: "Warning", E: "Error", F: "Fatal",
};
const PACKAGE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;

/** Notices interrupt record blocks: the record after one always shows its full header. */
function notice(view: Pick<LogcatView, "output" | "formatter">, text: string): void {
  view.formatter.reset();
  view.output.appendLine(`[Elide logcat] ${text}`);
}

function sameOptions(a: AndroidLogcatOptions, b: AndroidLogcatOptions): boolean {
  return a.adb === b.adb && a.device === b.device && a.packageName === b.packageName && a.priority === b.priority && a.text === b.text;
}

/** Read the compiled manifest of an existing APK without invoking a build tool. */
function apkManifest(apk: string): Promise<Uint8Array | undefined> {
  const { promise, resolve } = Promise.withResolvers<Uint8Array | undefined>();
  yauzl.open(apk, { lazyEntries: true, autoClose: false }, (error, zip) => {
    if (error || !zip) return resolve(undefined);
    let settled = false;
    const done = (value?: Uint8Array) => {
      if (settled) return;
      settled = true;
      zip.close();
      resolve(value);
    };
    zip.on("error", () => done());
    zip.on("end", () => done());
    zip.on("entry", (entry: yauzl.Entry) => {
      if (entry.fileName !== "AndroidManifest.xml") return zip.readEntry();
      if (entry.uncompressedSize > 4 * 1024 * 1024) return done();
      zip.openReadStream(entry, (streamError, stream) => {
        if (streamError || !stream) return done();
        buffer(stream).then(done, () => done());
      });
    });
    zip.readEntry();
  });
  return promise;
}

/** The compiled APK is authoritative for its installed application ID. */
async function applicationId(apk: string): Promise<string | undefined> {
  const manifest = await apkManifest(apk);
  const id = manifest && binaryManifestPackage(manifest);
  return id && PACKAGE_NAME.test(id) ? id : undefined;
}

/** Standalone adb streams scoped to open folders, independent of Elide build/deployment models. */
export function registerAndroidLogcat(workspace: ElideWorkspace): vscode.Disposable {
  const views = new Map<string, LogcatView>();
  const registrations: vscode.Disposable[] = [registerAndroidStackLinks(workspace)];
  let disposed = false;
  let generation = 0;
  let discovery: { root: string; controller: AbortController } | undefined;

  const cancelPending = () => {
    generation++;
    discovery?.controller.abort();
    discovery = undefined;
  };
  const usable = (root: string, revision: number) =>
    !disposed && vscode.workspace.isTrusted && revision === generation && androidFolderAt(root)?.uri.fsPath === root;
  const trusted = () => {
    if (vscode.workspace.isTrusted) return true;
    void vscode.window.showWarningMessage("Elide: trust this workspace before running Android logcat.");
    return false;
  };
  const report = (error: unknown) => {
    if (!disposed) void vscode.window.showErrorMessage(`Elide logcat: ${error instanceof Error ? error.message : String(error)}`);
  };

  const pickView = async (value: unknown): Promise<LogcatView | undefined> => {
    const target = toAndroidTarget(value);
    if (target) return views.get(androidFolderAt(target.root)?.uri.fsPath ?? target.root);
    const sessions = [...views.values()];
    if (!sessions.length) {
      void vscode.window.showInformationMessage("Elide: open Android Logcat first.");
      return undefined;
    }
    if (sessions.length === 1) return sessions[0];
    const picked = await vscode.window.showQuickPick(
      sessions.map((view) => ({ label: view.output.name, description: view.options.device, view })),
      { placeHolder: "Android logcat session" },
    );
    return picked?.view;
  };

  /** An explicit serial must be ready; otherwise the first ready preferred serial, the only ready device, or a choice. */
  const deviceOptions = async (folder: vscode.WorkspaceFolder, serial: string | undefined, preferred: readonly (string | undefined)[] = []): Promise<Pick<AndroidLogcatOptions, "adb" | "device"> | undefined> => {
    const sdk = androidSdkFor(folder);
    if (!sdk || !existsSync(adbExecutable(sdk))) throw new Error("Android platform-tools are missing. Install the SDK or set elide.android.sdk.");
    const controller = new AbortController();
    discovery = { root: folder.uri.fsPath, controller };
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 15_000);
    let devices;
    try {
      devices = await listAndroidDevices(sdk, controller.signal);
    } finally {
      clearTimeout(timeout);
      if (discovery?.controller === controller) discovery = undefined;
    }
    if (timedOut) throw new Error("Android device discovery timed out. Check that the SDK's adb server can start.");
    if (controller.signal.aborted) return undefined;
    if (serial) {
      const device = devices?.find((candidate) => candidate.serial === serial);
      if (!device?.ready) throw new Error(`Device ${serial} is ${device?.state ?? "not connected"}. Reconnect or authorize it, then restart logcat.`);
      return { adb: adbExecutable(sdk), device: serial };
    }
    const ready = devices?.filter((device) => device.ready) ?? [];
    if (!ready.length) {
      const states = devices?.map((device) => `${device.serial}: ${device.state}`).join(", ");
      throw new Error(`No ready Android device. Connect and authorize a device or start an emulator.${states ? ` Attached: ${states}.` : " Check that the SDK's adb server can start."}`);
    }
    const picked = preferred.map((candidate) => ready.find((device) => device.serial === candidate)).find((device) => device !== undefined)
      ?? (ready.length === 1 ? ready[0] : await vscode.window.showQuickPick(
        ready.map((device) => ({ label: device.serial, description: device.emulator ? "emulator" : "device", ...device })),
        { placeHolder: "Device to stream logcat from" },
      ));
    return picked ? { adb: adbExecutable(sdk), device: picked.serial } : undefined;
  };

  const filters = async (initial: Pick<AndroidLogcatOptions, "packageName" | "priority" | "text">): Promise<Pick<AndroidLogcatOptions, "packageName" | "priority" | "text"> | undefined> => {
    const source = await vscode.window.showQuickPick([
      { label: "Enter application ID", value: "manual", description: initial.packageName ?? "All applications" },
      { label: "Read application ID from APK…", value: "apk" },
      { label: "All applications", value: "all" },
    ], { placeHolder: "Application filter" });
    if (!source) return undefined;
    let packageName = "";
    if (source.value === "apk") {
      const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { "Android package": ["apk"] }, title: "Select an existing APK" });
      if (!files?.[0]) return undefined;
      const id = await applicationId(files[0].fsPath);
      if (!id) throw new Error("Could not read an application ID from the APK's compiled AndroidManifest.xml.");
      packageName = id;
    } else if (source.value === "manual") {
      const entered = await vscode.window.showInputBox({
        title: "Android Logcat: application",
        prompt: "Application ID (blank for all applications). Includes every process using the app UID.",
        value: initial.packageName ?? "",
        validateInput: (value) => !value.trim() || PACKAGE_NAME.test(value.trim()) ? undefined : "Enter an application ID such as com.example.app, or leave blank.",
        ignoreFocusOut: true,
      });
      if (entered === undefined) return undefined;
      packageName = entered.trim();
    }
    const priorities = [initial.priority, ...ANDROID_LOGCAT_PRIORITIES.filter((priority) => priority !== initial.priority)];
    const priority = await vscode.window.showQuickPick(
      priorities.map((value) => ({ label: `${value}: ${PRIORITIES[value]}`, description: value === initial.priority ? "current" : undefined, value })),
      { placeHolder: "Minimum log priority" },
    );
    if (!priority) return undefined;
    const text = await vscode.window.showInputBox({
      title: "Android Logcat: text filter",
      prompt: "Case-insensitive literal text to match in each log line (blank for all lines)",
      value: initial.text,
      ignoreFocusOut: true,
    });
    return text === undefined ? undefined : { ...(packageName.trim() ? { packageName: packageName.trim() } : {}), priority: priority.value, text };
  };

  const startView = async (view: LogcatView) => {
    view.output.show(true);
    const { device, packageName, priority, text } = view.options;
    notice(view, `${device} · ${packageName ?? "all applications"} · ${PRIORITIES[priority]} and above${text ? ` · text "${text}"` : ""} (Elide: Filter Android Logcat to change)`);
    await view.stream.start(view.options);
  };

  const start = async (value: unknown) => {
    if (!trusted()) return;
    cancelPending();
    const revision = generation;
    const folder = await pickAndroidFolder(value);
    if (!folder || !usable(folder.uri.fsPath, revision)) return;
    const root = folder.uri.fsPath;
    const target = toAndroidTarget(value);
    const existing = views.get(root);
    const device = await deviceOptions(folder, target?.device, [existing?.options.device]);
    if (!device || !usable(root, revision)) return;
    const options: AndroidLogcatOptions = {
      ...device, ...(existing?.options.packageName ? { packageName: existing.options.packageName } : {}),
      priority: existing?.options.priority ?? "I", text: existing?.options.text ?? "",
    };
    if (existing?.stream.active && sameOptions(existing.options, options)) {
      existing.output.show(true);
      return;
    }
    let view = existing;
    if (!view) {
      const output = vscode.window.createOutputChannel(`Elide Logcat: ${folder.name} (${root})`, ANDROID_LOGCAT_LANGUAGE);
      const formatter = new AndroidLogcatFormatter();
      const stream = new AndroidLogcatSession(
        (line) => output.appendLine(formatter.format(line)),
        (error) => {
          notice({ output, formatter }, `${error ? error.message : "Stream ended."} Use Elide: Restart Android Logcat to reconnect.`);
          if (error) report(error);
        },
      );
      view = { root, output, formatter, stream, options };
      views.set(root, view);
    } else view.options = options;
    await startView(view);
  };

  const control = async (action: "filter" | "clear" | "stop" | "restart", value: unknown) => {
    if ((action === "filter" || action === "restart") && !trusted()) return;
    cancelPending();
    const revision = generation;
    const view = await pickView(value);
    if (!view || !usable(view.root, revision)) return;
    if (action === "clear") {
      // Never clear the device's shared buffers: that would affect other developers and tools.
      view.output.clear();
      view.formatter.reset();
      view.output.show(true);
    } else if (action === "stop") {
      view.stream.stop();
      notice(view, "Stopped.");
    } else {
      const folder = androidFolderAt(view.root);
      if (!folder) return;
      const device = await deviceOptions(folder, view.options.device);
      if (!device || !usable(view.root, revision)) return;
      const chosen = action === "filter" ? await filters(view.options) : view.options;
      if (!chosen || !usable(view.root, revision)) return;
      view.options = { ...device, ...(chosen.packageName ? { packageName: chosen.packageName } : {}), priority: chosen.priority, text: chosen.text };
      await startView(view);
    }
  };

  const register = (name: string, run: (value: unknown) => Promise<void>) => {
    registrations.push(vscode.commands.registerCommand(name, async (value: unknown) => {
      try { await run(value); } catch (error) { report(error); }
    }));
  };
  register("elide.androidLogcat", start);
  register("elide.androidLogcatFilter", (value) => control("filter", value));
  register("elide.androidLogcatClear", (value) => control("clear", value));
  register("elide.androidLogcatStop", (value) => control("stop", value));
  register("elide.androidLogcatRestart", (value) => control("restart", value));
  registrations.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    if (discovery && androidFolderAt(discovery.root)?.uri.fsPath !== discovery.root) cancelPending();
    for (const [root, view] of views) {
      if (androidFolderAt(root)?.uri.fsPath === root && vscode.workspace.isTrusted) continue;
      view.stream.dispose();
      view.output.dispose();
      views.delete(root);
    }
  }));
  return new vscode.Disposable(() => {
    disposed = true;
    cancelPending();
    for (const registration of registrations) registration.dispose();
    for (const view of views.values()) {
      view.stream.dispose();
      view.output.dispose();
    }
    views.clear();
  });
}
