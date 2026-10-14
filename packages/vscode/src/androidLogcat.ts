import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { buffer } from "node:stream/consumers";
import { promisify } from "node:util";
import * as yauzl from "yauzl";
import {
  ANDROID_LOGCAT_PRIORITIES,
  AndroidLogcatFormatter,
  AndroidLogcatSession,
  adbExecutable,
  binaryManifestPackage,
  listAndroidDevices,
  parseAndroidPackageUid,
  type AndroidTargetModel,
  type AndroidLogcatOptions,
  type AndroidLogcatPriority,
} from "@elide/ide-core";
import * as vscode from "vscode";
import { androidSdkFor, toAndroidTarget } from "./android.js";
import { androidApks, preferredAndroidProject, type AndroidDeploymentTarget } from "./androidDeploymentState.js";
import { ANDROID_LOGCAT_LANGUAGE, registerAndroidStackLinks } from "./androidStackLinks.js";
import type { ElideProject, ElideWorkspace } from "./projects.js";

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

/** The compiled manifest of a published APK; absent before the first build or for an unreadable archive. */
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

/**
 * The ID the artifact installs as. The published APK is authoritative: `--rename-manifest-package` and placeholders
 * apply while linking. Before a build, the source manifest's `package` is only a suggestion.
 */
async function applicationId(artifact: AndroidTargetModel): Promise<string | undefined> {
  const manifest = await apkManifest(artifact.output);
  const built = manifest && binaryManifestPackage(manifest);
  if (built && PACKAGE_NAME.test(built)) return built;
  try {
    const xml = await readFile(artifact.manifestFile, "utf8");
    const declared = /<manifest\b[^>]*\bpackage\s*=\s*["']([^"']+)["']/.exec(xml)?.[1];
    return declared && PACKAGE_NAME.test(declared) ? declared : undefined;
  } catch {
    return undefined;
  }
}

/** Which of `candidates` the device has installed for its current user; undefined when adb cannot say. */
async function installedOf(device: Pick<AndroidLogcatOptions, "adb" | "device">, candidates: readonly string[]): Promise<string[] | undefined> {
  try {
    const { stdout } = await promisify(execFile)(
      device.adb,
      ["-s", device.device, "shell", "cmd", "package", "list", "packages", "--user", "current", "-U"],
      { encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
    );
    return candidates.filter((candidate) => parseAndroidPackageUid(stdout, candidate) !== undefined);
  } catch {
    return undefined;
  }
}

/**
 * Registers the palette/tree commands and owns all adb processes and output channels. Showing logcat never asks to
 * confirm filters: it reuses the open stream's, else the deployment target's application. Only an ambiguous project,
 * device or application is chosen interactively; **Filter Android Logcat** edits the filters.
 */
export function registerAndroidLogcat(workspace: ElideWorkspace, deploymentTarget: () => Readonly<AndroidDeploymentTarget> | undefined): vscode.Disposable {
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
    !disposed && vscode.workspace.isTrusted && revision === generation && workspace.projectAt(root) !== undefined;
  const trusted = () => {
    if (vscode.workspace.isTrusted) return true;
    void vscode.window.showWarningMessage("Elide: trust this workspace before running Android logcat.");
    return false;
  };
  const report = (error: unknown) => {
    if (!disposed) void vscode.window.showErrorMessage(`Elide logcat: ${error instanceof Error ? error.message : String(error)}`);
  };

  /** Explicit, the only Android project, the active editor's app, the open stream, the deployment target, the only app. */
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
    const editor = vscode.window.activeTextEditor;
    const owner = editor?.document.uri.scheme === "file" ? workspace.projectFor(editor.document.uri.fsPath) : undefined;
    const editing = preferredAndroidProject(projects, owner, undefined);
    if (editing) return editing;
    const open = projects.filter((project) => views.has(project.root));
    if (open.length === 1) return open[0];
    const remembered = preferredAndroidProject(projects, undefined, deploymentTarget()?.root);
    if (remembered) return remembered;
    const apps = projects.filter((project) => androidApks(project).length > 0);
    if (apps.length === 1) return apps[0];
    const picked = await vscode.window.showQuickPick(
      (apps.length ? apps : projects).map((project) => ({ label: project.model?.name ?? project.root, description: project.root, project })),
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

  /** An explicit serial must be ready; otherwise the first ready preferred serial, the only ready device, or a choice. */
  const deviceOptions = async (project: ElideProject, serial: string | undefined, preferred: readonly (string | undefined)[] = []): Promise<Pick<AndroidLogcatOptions, "adb" | "device"> | undefined> => {
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
    const picked = preferred.map((candidate) => ready.find((device) => device.serial === candidate)).find((device) => device !== undefined)
      ?? (ready.length === 1 ? ready[0] : await vscode.window.showQuickPick(
        ready.map((device) => ({ label: device.serial, description: device.emulator ? "emulator" : "device", ...device })),
        { placeHolder: "Device to stream logcat from" },
      ));
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
    const { device, packageName, priority, text } = view.options;
    notice(view, `${device} · ${packageName ?? "all applications"} · ${PRIORITIES[priority]} and above${text ? ` · text "${text}"` : ""} (Elide: Filter Android Logcat to change)`);
    await view.stream.start(view.options);
  };

  /**
   * The application to filter when no stream exists yet: explicit, deployed, the only APK, the one ID every APK
   * shares, or the only one installed on the device. Several installed variants are a genuine choice.
   */
  const defaultPackage = async (project: ElideProject, explicit: string | undefined, device: Pick<AndroidLogcatOptions, "adb" | "device">): Promise<{ packageName?: string } | undefined> => {
    const apks = project.model?.android?.targets.filter((artifact) => artifact.kind === "apk") ?? [];
    if (explicit) {
      const artifact = apks.find((apk) => apk.name === explicit);
      if (!artifact) throw new Error(`Artifact ${explicit} is not an Android application package.`);
      const packageName = await applicationId(artifact);
      return packageName ? { packageName } : {};
    }
    const deployed = deploymentTarget();
    const artifact = (deployed?.root === project.root ? apks.find((apk) => apk.name === deployed.artifact) : undefined) ?? (apks.length === 1 ? apks[0] : undefined);
    if (artifact || !apks.length) {
      const packageName = artifact && await applicationId(artifact);
      return packageName ? { packageName } : {};
    }
    const ids = await Promise.all(apks.map(applicationId));
    const candidates = [...new Set(ids.filter((id): id is string => id !== undefined))];
    if (candidates.length <= 1) return candidates[0] ? { packageName: candidates[0] } : {};
    const installed = await installedOf(device, candidates);
    if (installed?.length === 1) return { packageName: installed[0] };
    const offered = installed?.length ? installed : candidates;
    const picked = await vscode.window.showQuickPick(
      [
        { label: "All applications", packageName: undefined },
        ...offered.map((id) => ({ label: id, description: apks.filter((_, index) => ids[index] === id).map((apk) => apk.name).join(", "), packageName: id })),
      ],
      { placeHolder: "Application to filter" },
    );
    if (!picked) return undefined;
    return picked.packageName ? { packageName: picked.packageName } : {};
  };

  const start = async (value: unknown) => {
    if (!trusted()) return;
    cancelPending();
    const revision = generation;
    const project = await pickProject(value);
    if (!project || !usable(project.root, revision)) return;
    const target = toAndroidTarget(value);
    const existing = views.get(project.root);
    const deployed = deploymentTarget();
    const deployedSerial = deployed?.root === project.root && deployed.destination.kind === "device" ? deployed.destination.serial : undefined;
    const device = await deviceOptions(project, target?.device, [existing?.options.device, deployedSerial]);
    if (!device || !usable(project.root, revision)) return;
    const application = existing && !target?.artifact
      ? (existing.options.packageName ? { packageName: existing.options.packageName } : {})
      : await defaultPackage(project, target?.artifact, device);
    if (!application || !usable(project.root, revision)) return;
    const options: AndroidLogcatOptions = { ...device, ...application, priority: existing?.options.priority ?? "I", text: existing?.options.text ?? "" };
    if (existing?.stream.active && sameOptions(existing.options, options)) {
      existing.output.show(true);
      return;
    }
    let view = existing;
    if (!view) {
      const output = vscode.window.createOutputChannel(`Elide Logcat: ${project.model?.name ?? project.root} (${project.root})`, ANDROID_LOGCAT_LANGUAGE);
      const formatter = new AndroidLogcatFormatter();
      const stream = new AndroidLogcatSession(
        (line) => output.appendLine(formatter.format(line)),
        (error) => {
          notice({ output, formatter }, `${error ? error.message : "Stream ended."} Use Elide: Restart Android Logcat to reconnect.`);
          if (error) report(error);
        },
      );
      view = { root: project.root, output, formatter, stream, options };
      views.set(project.root, view);
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
