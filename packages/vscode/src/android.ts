import path from "node:path";
import {
  ANDROID_AVD_TASK,
  ANDROID_DEVICE_OPTION,
  ANDROID_EMULATOR_STOP_TASK,
  ANDROID_EMULATOR_TASK,
  ANDROID_INSTALL_SDK_OPTION,
  ANDROID_NO_WINDOW_OPTION,
  ANDROID_SDK_TASK,
  androidKeystoreTask,
  androidRunTask,
  androidSdkRoot,
  listAndroidDevices,
  type AndroidDevice,
  type AndroidTargetModel,
} from "@elide/ide-core";
import * as vscode from "vscode";
import { ELIDE_ANDROID_DEBUG_TYPE } from "./androidDebug.js";
import { readConfig } from "./config.js";
import type { ElideUi } from "./output.js";
import type { ElideProject, ElideWorkspace } from "./projects.js";
import { executeElideTask } from "./tasks.js";

/**
 * The Android side of the extension.
 *
 * Elide registers no Android subcommand — every step is a build target — so everything here is one
 * `elide build <target>` away. The exception is the device list: the CLI never prints one, so the SDK's own `adb`
 * is asked, through the SDK root a build of this project would resolve.
 */

/** What an `elide.android*` command is invoked with; the sidebar rows and the code lenses pass their own objects. */
export interface AndroidTarget {
  root: string;
  /** Artifact key, for the commands that act on one. */
  artifact?: string;
  /** Device serial to pin the run to; absent lets the run target choose. */
  device?: string;
}

export function toAndroidTarget(value: unknown): AndroidTarget | undefined {
  if (typeof value !== "object" || value === null || !("root" in value) || typeof value.root !== "string") return undefined;
  const artifact = "artifact" in value && typeof value.artifact === "string" ? value.artifact : undefined;
  const device = "device" in value && typeof value.device === "string" ? value.device : undefined;
  return { root: value.root, ...(artifact ? { artifact } : {}), ...(device ? { device } : {}) };
}

/** A command invocation resolved against the workspace: which project it acts on, and what the caller asked for. */
interface AndroidInvocation {
  project: ElideProject;
  target: AndroidTarget;
}

/**
 * The project a command acts on. A sidebar row or a code lens names one; the command palette names none, so the
 * workspace's Android projects answer instead — the only one there is, or whichever the user picks.
 */
async function resolve(workspace: ElideWorkspace, value: unknown): Promise<AndroidInvocation | undefined> {
  const target = toAndroidTarget(value);
  if (target) {
    const project = workspace.projectAt(target.root);
    if (!project) {
      void vscode.window.showWarningMessage(`Elide: project ${target.root} is not synced; run 'Elide: Sync Project(s)'.`);
      return undefined;
    }
    return { project, target };
  }

  const candidates = workspace.projects.filter((project) => project.model?.android);
  if (candidates.length === 0) {
    void vscode.window.showWarningMessage("Elide: no synced project declares an `android` block.");
    return undefined;
  }
  const only = candidates.length === 1 ? candidates[0] : undefined;
  if (only) return { project: only, target: { root: only.root } };
  const pick = await vscode.window.showQuickPick(
    candidates.map((project) => ({ label: project.model?.name ?? project.root, description: project.root, project })),
    { placeHolder: "Android project" },
  );
  return pick ? { project: pick.project, target: { root: pick.project.root } } : undefined;
}

/**
 * SDK root `adb` is taken from: the `elide.android.sdk` setting first, then whatever the project model resolved
 * (the manifest's `android.sdk`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, the conventional location), then that same
 * search without a manifest, for a project that has not been synced yet.
 */
export function androidSdkFor(project: ElideProject): string | undefined {
  const configured = readConfig(project.folder).androidSdk;
  if (configured) return configured;
  return project.model?.android?.sdkRoot ?? androidSdkRoot();
}

/** APKs the project publishes; only those have run targets. */
function apksOf(project: ElideProject): AndroidTargetModel[] {
  return (project.model?.android?.targets ?? []).filter((target) => target.kind === "apk");
}

/**
 * The APK a command acts on: the one it names, else the project's only one, else whichever the user picks. A
 * project declaring none has nothing to run.
 */
async function pickApk(project: ElideProject, named: string | undefined): Promise<string | undefined> {
  const apks = apksOf(project);
  if (named) return named;
  if (apks.length === 1) return apks[0]?.name;
  if (apks.length === 0) {
    void vscode.window.showWarningMessage("Elide: this project declares no Android application package.");
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    apks.map((apk) => ({ label: apk.name, description: apk.output })),
    { placeHolder: "Android application to run" },
  );
  return pick?.label;
}

/** Devices attached to the project's SDK, or `undefined` when there is no SDK (or no `platform-tools`) to ask. */
export async function attachedDevices(project: ElideProject): Promise<AndroidDevice[] | undefined> {
  const sdk = androidSdkFor(project);
  return sdk ? await listAndroidDevices(sdk) : undefined;
}

/** How one run reaches a device: a pinned serial, the project's emulator, or whatever the run target finds. */
interface RunChoice {
  task: string;
  device?: string;
}

/**
 * Install and launch an APK.
 *
 * With a device named — a row of the sidebar's device list — the run is pinned to it. Otherwise the attached
 * devices are offered beside the emulator; with nothing attached there is nothing to choose, and the plain run
 * target is used, which boots the emulator itself.
 */
export async function runAndroid(workspace: ElideWorkspace, value: unknown): Promise<void> {
  const invocation = await resolve(workspace, value);
  if (!invocation) return;
  const { project, target } = invocation;
  const artifact = await pickApk(project, target.artifact);
  if (!artifact) return;

  const choice = target.device
    ? { task: androidRunTask(artifact), device: target.device }
    : await pickRunChoice(project, artifact);
  if (!choice) return;

  await executeElideTask(workspace, project, "build", {
    args: [choice.task],
    ...(choice.device ? { options: { [ANDROID_DEVICE_OPTION]: choice.device } } : {}),
  });
}

async function pickRunChoice(project: ElideProject, artifact: string): Promise<RunChoice | undefined> {
  const devices = (await attachedDevices(project))?.filter((device) => device.ready) ?? [];
  // Nothing attached: the plain run target boots the emulator, so there is nothing to ask.
  if (devices.length === 0) return { task: androidRunTask(artifact) };

  const items: (vscode.QuickPickItem & { choice: RunChoice })[] = devices.map((device) => ({
    label: `$(device-mobile) ${device.serial}`,
    description: device.emulator ? "emulator" : "device",
    choice: { task: androidRunTask(artifact), device: device.serial },
  }));
  items.push({
    label: "$(vm) Emulator",
    description: `boot ${project.model?.android?.avd ?? "the project's AVD"} if it is not running`,
    choice: { task: androidRunTask(artifact, "emulator") },
  });
  const pick = await vscode.window.showQuickPick(items, { placeHolder: `Run ${artifact} on` });
  return pick?.choice;
}

/**
 * Build, install and debug an APK. An `elide-android` configuration owns the whole sequence — build, install,
 * launch waiting for a debugger, forward the JDWP socket, attach — so the command only names what to debug.
 */
export async function debugAndroid(workspace: ElideWorkspace, value: unknown): Promise<void> {
  const invocation = await resolve(workspace, value);
  if (!invocation) return;
  const { project, target } = invocation;
  const artifact = await pickApk(project, target.artifact);
  if (!artifact) return;
  const rel = path.relative(project.folder.uri.fsPath, project.root);
  await vscode.debug.startDebugging(project.folder, {
    type: ELIDE_ANDROID_DEBUG_TYPE,
    request: "launch",
    name: `Elide: Debug ${artifact}`,
    artifact,
    ...(target.device ? { device: target.device } : {}),
    ...(rel ? { project: rel } : {}),
  });
}

/** Boot the project's virtual device, headless when `elide.android.emulatorWindow` is off. */
export async function startAndroidEmulator(workspace: ElideWorkspace, value: unknown): Promise<void> {
  const invocation = await resolve(workspace, value);
  if (!invocation) return;
  const { project } = invocation;
  const windowed = readConfig(project.folder).androidEmulatorWindow;
  await executeElideTask(workspace, project, "build", {
    args: [ANDROID_EMULATOR_TASK],
    ...(windowed ? {} : { options: { [ANDROID_NO_WINDOW_OPTION]: true } }),
  });
}

/** Run one Android build target that takes no artifact and no option of its own. */
async function runProjectTask(workspace: ElideWorkspace, value: unknown, task: string): Promise<void> {
  const invocation = await resolve(workspace, value);
  if (invocation) await executeElideTask(workspace, invocation.project, "build", { args: [task] });
}

export async function stopAndroidEmulator(workspace: ElideWorkspace, value: unknown): Promise<void> {
  await runProjectTask(workspace, value, ANDROID_EMULATOR_STOP_TASK);
}

export async function createAndroidAvd(workspace: ElideWorkspace, value: unknown): Promise<void> {
  await runProjectTask(workspace, value, ANDROID_AVD_TASK);
}

/**
 * Install the SDK components this project's pipeline is missing. `--install-sdk` is the licence acceptance:
 * nothing is downloaded without it, which is why it is a command of its own rather than part of every build.
 */
export async function installAndroidSdk(workspace: ElideWorkspace, value: unknown): Promise<void> {
  const invocation = await resolve(workspace, value);
  if (!invocation) return;
  const confirm = await vscode.window.showWarningMessage(
    "Install the missing Android SDK components? Passing --install-sdk accepts their licenses.",
    { modal: true },
    "Install",
  );
  if (confirm !== "Install") return;
  await executeElideTask(workspace, invocation.project, "build", {
    args: [ANDROID_SDK_TASK],
    options: { [ANDROID_INSTALL_SDK_OPTION]: true },
  });
}

/** Mint the keystore an APK signs with, once, using the Android debug conventions. */
export async function createAndroidKeystore(workspace: ElideWorkspace, ui: ElideUi, value: unknown): Promise<void> {
  const invocation = await resolve(workspace, value);
  if (!invocation) return;
  const { project, target } = invocation;
  const artifact = await pickApk(project, target.artifact);
  if (!artifact) return;
  ui.log(`creating the signing keystore of ${artifact}`);
  await executeElideTask(workspace, project, "build", { args: [androidKeystoreTask(artifact)] });
}
