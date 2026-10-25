import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  ANDROID_AVD_TASK,
  ANDROID_DEVICE_OPTION,
  ANDROID_EMULATOR_STOP_TASK,
  ANDROID_EMULATOR_TASK,
  ANDROID_INSTALL_SDK_OPTION,
  ANDROID_NO_WINDOW_OPTION,
  ANDROID_SDK_TASK,
  androidKeystoreTask,
  androidMappingTask,
  androidRunTask,
  androidSdkRoot,
  adbExecutable,
  parseAdbDevices,
  type AndroidDevice,
  type AndroidTargetModel,
  type ElideInvocationOptions,
} from "@elide/ide-core";
import * as vscode from "vscode";
import { ELIDE_ANDROID_DEBUG_TYPE } from "./androidDebug.js";
import type { AndroidDeploymentController } from "./androidDeployment.js";
import { NO_ANDROID_PROJECT, androidApks } from "./androidDeploymentState.js";
import { readConfig } from "./config.js";
import { androidFailureActions, showElideFailure } from "./failures.js";
import type { ElideUi } from "./output.js";
import type { ElideProject, ElideWorkspace } from "./projects.js";
import { executeElideTask, executeReportedElideTask, taskExitCode } from "./tasks.js";

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
  /** Device serial to pin the deployment to. */
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
    void vscode.window.showWarningMessage(NO_ANDROID_PROJECT);
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

/** Artifacts signed with a keystore of their own: the APKs, and the bundles a store takes. */
function signedArtifacts(project: ElideProject): AndroidTargetModel[] {
  return (project.model?.android?.targets ?? []).filter((target) => target.kind === "apk" || target.kind === "aab");
}

/**
 * The signed artifact a command acts on: the one it names, else the project's only one, else whichever the user
 * picks. A project declaring none has nothing to sign.
 */
async function pickSignedArtifact(project: ElideProject, named: string | undefined): Promise<string | undefined> {
  const signed = signedArtifacts(project);
  if (named) {
    if (signed.some((artifact) => artifact.name === named)) return named;
    void vscode.window.showErrorMessage(`Elide: '${named}' is not an Android APK or app bundle in this project's current model. Sync the project or select another.`);
    return undefined;
  }
  if (signed.length === 1) return signed[0]?.name;
  if (signed.length === 0) {
    void vscode.window.showWarningMessage("Elide: this project declares no Android application package or app bundle.");
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    signed.map((artifact) => ({ label: artifact.name, description: artifact.output })),
    { placeHolder: "Android artifact to create the signing keystore of" },
  );
  return pick?.label;
}

/**
 * Run an Android build target as a task whose failure is reported in Elide's words — its error, its hint, and the
 * fix the hint names — rather than in the terminal only. `reinstall` is how a run that installs an app recovers from
 * a copy on the device signed with another key (see {@link androidFailureActions}).
 */
export async function executeAndroidTask(workspace: ElideWorkspace, ui: ElideUi, project: ElideProject, invocation: ElideInvocationOptions, reinstall?: (application: string) => Promise<void>): Promise<vscode.TaskExecution> {
  return await executeReportedElideTask(workspace, project, "build", invocation, ({ name, exitCode, failure, reveal }) =>
    showElideFailure(ui, failure, `${name} failed${exitCode === undefined ? "" : ` (exit ${exitCode})`}.`, reveal,
      androidFailureActions([project, ...workspace.projects], failure, reinstall)));
}

/** Whether `elide build <args>` builds something Android: an artifact of the project's `android` block, or an `android-*` target. */
export function isAndroidBuild(project: ElideProject, args: readonly string[]): boolean {
  const targets = project.model?.android?.targets ?? [];
  return args.some((arg) => /(?:^|:)android-/.test(arg) || targets.some((target) => target.name === arg));
}

/** Devices attached to the project's SDK; missing platform-tools returns undefined, adb failures are surfaced. */
export async function attachedDevices(project: ElideProject): Promise<AndroidDevice[] | undefined> {
  const sdk = androidSdkFor(project);
  if (!sdk || !existsSync(adbExecutable(sdk))) return undefined;
  const { stdout } = await promisify(execFile)(adbExecutable(sdk), ["devices"], { encoding: "utf8", timeout: 10_000 });
  return parseAdbDevices(stdout);
}

/** Uninstall `application`, and with it its data, from device `serial` of the project's SDK. */
export async function uninstallAndroidApp(project: ElideProject, serial: string, application: string): Promise<void> {
  const sdk = androidSdkFor(project);
  if (!sdk || !existsSync(adbExecutable(sdk))) throw new Error("Android SDK platform-tools (adb) are unavailable.");
  const { stdout } = await promisify(execFile)(adbExecutable(sdk), ["-s", serial, "uninstall", application], { encoding: "utf8", timeout: 60_000 });
  // Older adb exits 0 on a refused uninstall: only its `Success` line says it happened.
  if (!/^Success\b/m.test(stdout)) throw new Error(stdout.trim() || "adb printed no result.");
}

/**
 * Build, install and launch the selected APK without letting adb implicitly choose another device. The project
 * emulator is booted by the run target itself, headless when `elide.android.emulatorWindow` is off; a pinned emulator
 * that stopped is booted again before the build.
 */
export async function runAndroid(workspace: ElideWorkspace, ui: ElideUi, deployments: AndroidDeploymentController, value: unknown): Promise<void> {
  if (!await vscode.workspace.saveAll(false)) return;
  const deployment = await deployments.resolve(value, "run");
  if (!deployment) return;
  const { project, artifact, destination } = deployment;
  const reinstall = (serial?: string) => async (application: string) => {
    if (await deployments.uninstall(deployment, application, serial)) await runAndroid(workspace, ui, deployments, value);
  };
  if (destination.kind === "emulator") {
    const windowed = readConfig(project.folder).androidEmulatorWindow;
    await executeAndroidTask(workspace, ui, project, {
      args: [androidRunTask(artifact, "emulator")],
      ...(windowed ? {} : { options: { [ANDROID_NO_WINDOW_OPTION]: true } }),
    }, reinstall());
    return;
  }
  const serial = await deployments.readyDevice(deployment);
  if (!serial) return;
  await executeAndroidTask(workspace, ui, project, {
    args: [androidRunTask(artifact)],
    options: { [ANDROID_DEVICE_OPTION]: serial },
  }, reinstall(serial));
}

/**
 * Build, install and debug an APK. An `elide-android` configuration owns the whole sequence — build, install,
 * launch waiting for a debugger, forward the JDWP socket, attach — so the command only names what to debug.
 */
export async function debugAndroid(_workspace: ElideWorkspace, deployments: AndroidDeploymentController, value: unknown): Promise<void> {
  if (!await vscode.workspace.saveAll(false)) return;
  const deployment = await deployments.resolve(value, "debug");
  if (!deployment) return;
  const { project, artifact, destination } = deployment;
  const rel = path.relative(project.folder.uri.fsPath, project.root);
  await vscode.debug.startDebugging(project.folder, {
    type: ELIDE_ANDROID_DEBUG_TYPE,
    request: "launch",
    name: `Elide: Debug ${artifact}`,
    artifact,
    ...(destination.kind === "device" ? { device: destination.serial } : {}),
    // Named even at the folder root: without it the configuration would choose among every project declaring the APK.
    project: rel || ".",
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

/**
 * Stop an emulator: the one a device row names, or else the one running the project's own AVD. Elide leaves every
 * other emulator running, so stopping the project's never takes an unrelated one down with it.
 */
export async function stopAndroidEmulator(workspace: ElideWorkspace, value: unknown): Promise<void> {
  const invocation = await resolve(workspace, value);
  if (!invocation) return;
  const { device } = invocation.target;
  await executeElideTask(workspace, invocation.project, "build", {
    args: [ANDROID_EMULATOR_STOP_TASK],
    ...(device ? { options: { [ANDROID_DEVICE_OPTION]: device } } : {}),
  });
}

export async function createAndroidAvd(workspace: ElideWorkspace, value: unknown): Promise<void> {
  const invocation = await resolve(workspace, value);
  if (invocation) await executeElideTask(workspace, invocation.project, "build", { args: [ANDROID_AVD_TASK] });
}

/**
 * Run a build target that installs onto one device — a Build targets row of `android-test-<artifact>`, say — on the
 * deployment target's device. Without `--device` Elide would pick an attached device itself, which with several
 * attached is not the one the user selected; a selected device that is gone is refused, never swapped for another.
 */
export async function runAndroidDeviceTask(workspace: ElideWorkspace, ui: ElideUi, deployments: AndroidDeploymentController, value: unknown): Promise<void> {
  const task = typeof value === "object" && value !== null && "args" in value && Array.isArray(value.args) ? value.args[0] : undefined;
  const target = toAndroidTarget(value);
  if (typeof task !== "string" || !target) return;
  if (!await vscode.workspace.saveAll(false)) return;
  const deployment = await deployments.resolve({ root: target.root });
  if (!deployment) return;
  const serial = await deployments.readyDevice(deployment);
  if (!serial) return;
  await executeAndroidTask(workspace, ui, deployment.project, { args: [task], options: { [ANDROID_DEVICE_OPTION]: serial } }, async (application) => {
    if (await deployments.uninstall(deployment, application, serial)) await runAndroidDeviceTask(workspace, ui, deployments, value);
  });
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

/** Mint the keystore an APK or app bundle signs with, once, using the Android debug conventions. */
export async function createAndroidKeystore(workspace: ElideWorkspace, ui: ElideUi, value: unknown): Promise<void> {
  const invocation = await resolve(workspace, value);
  if (!invocation) return;
  const { project, target } = invocation;
  const artifact = await pickSignedArtifact(project, target.artifact);
  if (!artifact) return;
  ui.log(`creating the signing keystore of ${artifact}`);
  await executeAndroidTask(workspace, ui, project, { args: [androidKeystoreTask(artifact)] });
}

/**
 * Open an artifact's obfuscation mapping, publishing it first when it is not on disk.
 *
 * `elide build <artifact>` does not write it: the mapping is handed over by a target of its own, so a row that only
 * opened the file would be a dead end on every project whose minified APK was built by name.
 */
export async function openAndroidMapping(workspace: ElideWorkspace, value: unknown): Promise<void> {
  const invocation = await resolve(workspace, value);
  if (!invocation) return;
  const { project, target } = invocation;
  const artifact = target.artifact;
  const mapping = project.model?.android?.targets.find((t) => t.name === artifact)?.mapping;
  if (!artifact || !mapping) {
    void vscode.window.showWarningMessage("Elide: this artifact publishes no obfuscation mapping; it does not minify.");
    return;
  }
  if (!existsSync(mapping)) {
    const execution = await executeElideTask(workspace, project, "build", { args: [androidMappingTask(artifact)] });
    if (!execution || (await taskExitCode(execution)) !== 0) return;
  }
  await vscode.window.showTextDocument(vscode.Uri.file(mapping));
}
