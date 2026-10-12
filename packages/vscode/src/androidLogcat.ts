import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  ANDROID_LOGCAT_PRIORITIES,
  AndroidLogcatSession,
  adbExecutable,
  listAndroidDevices,
  type AndroidLogcatOptions,
  type AndroidLogcatPriority,
} from "@elide/ide-core";
import * as vscode from "vscode";
import { androidSdkFor, toAndroidTarget } from "./android.js";
import type { ElideProject, ElideWorkspace } from "./projects.js";

interface LogcatView {
  root: string;
  output: vscode.OutputChannel;
  stream: AndroidLogcatSession;
  options: AndroidLogcatOptions;
}

const PRIORITIES: Record<AndroidLogcatPriority, string> = {
  V: "Verbose", D: "Debug", I: "Info", W: "Warning", E: "Error", F: "Fatal",
};
const PACKAGE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;

/** Registers the palette/tree commands and owns all adb processes and output channels. */
export function registerAndroidLogcat(workspace: ElideWorkspace): vscode.Disposable {
  const views = new Map<string, LogcatView>();
  const registrations: vscode.Disposable[] = [];
  let disposed = false;
  let generation = 0;
  let discovery: { root: string; controller: AbortController } | undefined;

  const cancelPending = () => {
    generation++;
    discovery?.controller.abort();
    discovery = undefined;
  };
  const usable = (root: string, revision: number) =>
    !disposed && vscode.workspace.isTrusted && revision === generation && workspace.projectAt(root) !== undefined;
  const trusted = () => {
    if (vscode.workspace.isTrusted) return true;
    void vscode.window.showWarningMessage("Elide: trust this workspace before running Android logcat.");
    return false;
  };
  const report = (error: unknown) => {
    if (!disposed) void vscode.window.showErrorMessage(`Elide logcat: ${error instanceof Error ? error.message : String(error)}`);
  };

  const pickProject = async (value: unknown): Promise<ElideProject | undefined> => {
    const target = toAndroidTarget(value);
    if (target) {
      const project = workspace.projectAt(target.root);
      if (!project?.model?.android) void vscode.window.showWarningMessage("Elide: sync an Android project before opening logcat.");
      return project?.model?.android ? project : undefined;
    }
    const projects = workspace.projects.filter((project) => project.model?.android);
    if (!projects.length) {
      void vscode.window.showWarningMessage("Elide: no synced project declares an `android` block.");
      return undefined;
    }
    if (projects.length === 1) return projects[0];
    const picked = await vscode.window.showQuickPick(
      projects.map((project) => ({ label: project.model?.name ?? project.root, description: project.root, project })),
      { placeHolder: "Android project for logcat" },
    );
    return picked?.project;
  };

  const pickView = async (value: unknown): Promise<LogcatView | undefined> => {
    const target = toAndroidTarget(value);
    if (target) return views.get(target.root);
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

  const deviceOptions = async (project: ElideProject, serial: string | undefined): Promise<Pick<AndroidLogcatOptions, "adb" | "device"> | undefined> => {
    const sdk = androidSdkFor(project);
    if (!sdk || !existsSync(adbExecutable(sdk))) throw new Error("Android platform-tools are missing. Install the SDK or set elide.android.sdk.");
    const controller = new AbortController();
    discovery = { root: project.root, controller };
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
    const picked = ready.length === 1 ? ready[0] : await vscode.window.showQuickPick(
      ready.map((device) => ({ label: device.serial, description: device.emulator ? "emulator" : "device", ...device })),
      { placeHolder: "Device to stream logcat from" },
    );
    return picked ? { adb: adbExecutable(sdk), device: picked.serial } : undefined;
  };

  const filters = async (initial: Pick<AndroidLogcatOptions, "packageName" | "priority" | "text">): Promise<Pick<AndroidLogcatOptions, "packageName" | "priority" | "text"> | undefined> => {
    const packageName = await vscode.window.showInputBox({
      title: "Android Logcat: application",
      prompt: "Application ID (blank for all applications). Includes every process using the app UID.",
      value: initial.packageName ?? "",
      validateInput: (value) => !value.trim() || PACKAGE_NAME.test(value.trim()) ? undefined : "Enter an application ID such as com.example.app, or leave blank.",
      ignoreFocusOut: true,
    });
    if (packageName === undefined) return undefined;
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
    view.output.appendLine(`[Elide logcat] ${view.options.device} · ${view.options.packageName ?? "all applications"} · ${view.options.priority}+${view.options.text ? ` · text: ${view.options.text}` : ""}`);
    await view.stream.start(view.options);
  };

  const start = async (value: unknown) => {
    if (!trusted()) return;
    cancelPending();
    const revision = generation;
    const project = await pickProject(value);
    if (!project || !usable(project.root, revision)) return;
    const target = toAndroidTarget(value);
    const device = await deviceOptions(project, target?.device);
    if (!device || !usable(project.root, revision)) return;
    const existing = views.get(project.root);
    let packageName = existing?.options.packageName;
    const apks = project.model?.android?.targets.filter((artifact) => artifact.kind === "apk") ?? [];
    let artifact = target?.artifact ? apks.find((apk) => apk.name === target.artifact) : apks.length === 1 ? apks[0] : undefined;
    if (target?.artifact && !artifact) throw new Error(`Artifact ${target.artifact} is not an Android application package.`);
    if (!artifact && !existing && apks.length > 1) {
      const picked = await vscode.window.showQuickPick(
        [{ label: "All applications / custom package", artifact: undefined }, ...apks.map((apk) => ({ label: apk.name, artifact: apk }))],
        { placeHolder: "Application to filter" },
      );
      if (!picked) return;
      artifact = picked.artifact;
    }
    if (artifact && (!existing || target?.artifact)) {
      // This is only a suggestion: merged manifests/placeholders may resolve to a different installed ID.
      try {
        const xml = await readFile(artifact.manifestFile, "utf8");
        const declared = /<manifest\b[^>]*\bpackage\s*=\s*["']([^"']+)["']/.exec(xml)?.[1];
        packageName = declared && PACKAGE_NAME.test(declared) ? declared : undefined;
      } catch {
        packageName = undefined;
      }
    }
    if (!usable(project.root, revision)) return;
    const chosen = await filters({ ...(packageName ? { packageName } : {}), priority: existing?.options.priority ?? "I", text: existing?.options.text ?? "" });
    if (!chosen || !usable(project.root, revision)) return;
    let view = existing;
    if (!view) {
      const output = vscode.window.createOutputChannel(`Elide Logcat: ${project.model?.name ?? project.root} (${project.root})`);
      const stream = new AndroidLogcatSession(
        (line) => output.appendLine(line),
        (error) => {
          output.appendLine(`[Elide logcat] ${error ? error.message : "Stream ended."} Use Elide: Restart Android Logcat to reconnect.`);
          if (error) report(error);
        },
      );
      view = { root: project.root, output, stream, options: { ...device, ...chosen } };
      views.set(project.root, view);
    } else view.options = { ...device, ...chosen };
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
      view.output.show(true);
    } else if (action === "stop") {
      view.stream.stop();
      view.output.appendLine("[Elide logcat] Stopped.");
    } else {
      const project = workspace.projectAt(view.root);
      if (!project) return;
      const device = await deviceOptions(project, view.options.device);
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
  registrations.push(workspace.onDidChange(() => {
    if (discovery && !workspace.projectAt(discovery.root)) cancelPending();
    for (const [root, view] of views) {
      if (workspace.projectAt(root)?.model?.android && vscode.workspace.isTrusted) continue;
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
