import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ANDROID_EMULATOR_TASK, ANDROID_NO_WINDOW_OPTION, adbExecutable, type AndroidDevice } from "@elide/ide-core";
import * as vscode from "vscode";
import { androidSdkFor, attachedDevices, toAndroidTarget } from "./android.js";
import { androidApks, androidDeviceProblem, preferredAndroidProject, restoredAndroidTarget } from "./androidDeploymentState.js";
import type { AndroidDeploymentDestination, AndroidDeploymentTarget } from "./androidDeploymentState.js";
import { readConfig } from "./config.js";
import type { ElideProject, ElideWorkspace } from "./projects.js";
import { executeElideTask, taskExitCode } from "./tasks.js";

const STATE_KEY = "elide.android.deploymentTarget";
const SELECT_COMMAND = "elide.androidSelectTarget";
const exec = promisify(execFile);

export interface AndroidDeployment extends AndroidDeploymentTarget {
  project: ElideProject;
}

function runnable(project: ElideProject): boolean {
  return project.model?.android?.targets.some((target) => target.kind === "apk") ?? false;
}

/** One workspace's Run/Debug target. Device discovery is demand-driven, never a background poll. */
export class AndroidDeploymentController implements vscode.Disposable {
  private selected: AndroidDeploymentTarget | undefined;
  private readonly status = vscode.window.createStatusBarItem("elide.androidTarget", vscode.StatusBarAlignment.Left, 90);
  private readonly subscriptions: vscode.Disposable[];
  private disposed = false;
  private readonly bootTasks = new Set<vscode.TaskExecution>();

  constructor(private readonly workspace: ElideWorkspace, private readonly state: vscode.Memento) {
    this.selected = restoredAndroidTarget(state.get<unknown>(STATE_KEY));
    this.status.name = "Elide Android Deployment Target";
    this.status.command = SELECT_COMMAND;
    this.subscriptions = [workspace.onDidChange(() => this.updateStatus())];
    this.updateStatus();
  }

  get target(): Readonly<AndroidDeploymentTarget> | undefined {
    return this.selected;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    for (const execution of this.bootTasks) execution.terminate();
    this.bootTasks.clear();
    this.status.dispose();
  }

  async select(value?: unknown): Promise<void> {
    await this.resolve(value, true);
  }

  /** Explicit invocation, active runnable owner, remembered app, then a choice among runnable apps. */
  async resolve(value?: unknown, choose = false): Promise<AndroidDeployment | undefined> {
    if (this.disposed) return undefined;
    const explicit = toAndroidTarget(value);
    const candidates = this.workspace.projects.filter(runnable);
    let project: ElideProject | undefined;
    if (explicit) {
      project = this.workspace.projectAt(explicit.root);
      if (!project || !runnable(project)) {
        await this.problem(`Project ${explicit.root} has no synced Android application package. Sync the project and select an APK target.`);
        return undefined;
      }
    } else if (!choose) {
      const editor = vscode.window.activeTextEditor;
      const owner = editor?.document.uri.scheme === "file" ? this.workspace.projectFor(editor.document.uri.fsPath) : undefined;
      project = preferredAndroidProject(this.workspace.projects, owner, this.selected?.root);
      if (!project && this.selected) {
        await this.problem(`Remembered Android project ${this.selected.root} is no longer runnable. Select a current deployment target.`);
        return undefined;
      }
    }
    if (!project) {
      if (candidates.length === 0) {
        await this.problem("No synced project declares an Android application package. Sync an Android app project first.");
        return undefined;
      }
      project = candidates.length === 1 ? candidates[0] : (await vscode.window.showQuickPick(
        candidates.map((candidate) => ({ label: candidate.model?.name ?? candidate.root, description: candidate.root, project: candidate })),
        { placeHolder: "Android deployment project" },
      ))?.project;
    }
    if (!project) return undefined;
    const remembered = this.selected?.root === project.root ? this.selected : undefined;
    const apks = androidApks(project);
    let artifact = explicit?.artifact ?? (choose ? undefined : remembered?.artifact);
    if (artifact && !apks.some((apk) => apk.name === artifact)) {
      await this.problem(`Android APK '${artifact}' is no longer declared by ${project.model?.name ?? project.root}. Select a current deployment target.`);
      return undefined;
    }
    if (!artifact) {
      artifact = apks.length === 1 ? apks[0]?.name : (await vscode.window.showQuickPick(
        apks.map((apk) => ({ label: apk.name, description: apk.output })), { placeHolder: "Android application package" },
      ))?.label;
    }
    if (!artifact) return undefined;
    const devices = await this.devices(project);
    if (!devices) return undefined;
    let destination: AndroidDeploymentDestination | undefined = explicit?.device
      ? { kind: "device", serial: explicit.device }
      : choose ? undefined : remembered?.destination;
    if (destination?.kind === "device" && !await this.validateDevice(devices, destination.serial)) return undefined;
    if (!destination) {
      const items: (vscode.QuickPickItem & { destination: AndroidDeploymentDestination })[] = devices.filter((device) => device.ready).map((device) => ({
        label: `$(device-mobile) ${device.serial}`,
        description: device.emulator ? "running emulator" : "connected device",
        destination: { kind: "device", serial: device.serial },
      }));
      items.push({ label: "$(vm) Project emulator", description: project.model!.android!.avd, destination: { kind: "emulator" } });
      const unavailable = devices.filter((device) => !device.ready).map((device) => `${device.serial}: ${device.state}`);
      destination = (await vscode.window.showQuickPick(items, {
        placeHolder: unavailable.length ? `Deploy ${artifact}; unavailable: ${unavailable.join(", ")}. Authorize USB debugging or reconnect.` : `Deploy ${artifact} on`,
      }))?.destination;
      if (destination?.kind === "device") {
        const refreshed = await this.devices(project);
        if (!refreshed || !await this.validateDevice(refreshed, destination.serial)) return undefined;
      }
    }
    if (!destination || this.disposed) return undefined;
    const selection = { root: project.root, artifact, destination };
    await this.state.update(STATE_KEY, selection);
    if (this.disposed) return undefined;
    this.selected = selection;
    this.updateStatus();
    return { ...selection, project };
  }

  /** Resolve the project's AVD by identity, not the first emulator (or a physical device) adb lists. */
  async debugDevice(deployment: AndroidDeployment): Promise<string | undefined> {
    if (this.disposed) return undefined;
    if (deployment.destination.kind === "device") {
      const devices = await this.devices(deployment.project);
      return devices && await this.validateDevice(devices, deployment.destination.serial) ? deployment.destination.serial : undefined;
    }
    const { project } = deployment;
    const sdk = androidSdkFor(project);
    if (!sdk) return undefined;
    const find = async (): Promise<string | undefined> => {
      const devices = await attachedDevices(project);
      if (!devices) throw new Error("Android platform-tools are unavailable; install the Android SDK components.");
      const identities = await Promise.all(devices.filter((device) => device.emulator && device.ready).map(async (device) => {
        const { stdout } = await exec(adbExecutable(sdk), ["-s", device.serial, "emu", "avd", "name"], { encoding: "utf8", timeout: 10_000 });
        return { serial: device.serial, avd: stdout.trim().split(/\r?\n/)[0] };
      }));
      const matching = identities.filter((device) => device.avd === project.model!.android!.avd);
      if (matching.length > 1) throw new Error(`Multiple emulators run AVD '${project.model!.android!.avd}'. Select a specific emulator serial instead.`);
      return matching[0]?.serial;
    };
    try {
      const running = await find();
      if (running) return running;
      const booted = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Elide: starting Android emulator", cancellable: true }, async (_progress, token) => {
        if (token.isCancellationRequested || this.disposed) return false;
        const execution = await executeElideTask(this.workspace, project, "build", {
          args: [ANDROID_EMULATOR_TASK],
          ...(readConfig(project.folder).androidEmulatorWindow ? {} : { options: { [ANDROID_NO_WINDOW_OPTION]: true } }),
        });
        if (!execution) return false;
        this.bootTasks.add(execution);
        let timer: NodeJS.Timeout | undefined;
        let cancellation: vscode.Disposable | undefined;
        try {
          const interrupted = new Promise<false>((resolve) => {
            const stop = () => { execution.terminate(); resolve(false); };
            cancellation = token.onCancellationRequested(stop);
            timer = setTimeout(stop, 120_000);
            if (token.isCancellationRequested || this.disposed) stop();
          });
          return await Promise.race([taskExitCode(execution).then((code) => code === 0), interrupted]);
        } finally {
          clearTimeout(timer);
          cancellation?.dispose();
          this.bootTasks.delete(execution);
        }
      });
      if (this.disposed) return undefined;
      if (!booted) {
        await this.problem("Emulator startup was cancelled, failed, or exceeded two minutes. Check the Elide task terminal; start the emulator and try again.");
        return undefined;
      }
      const serial = await find();
      if (!serial) await this.problem(`AVD '${project.model!.android!.avd}' did not appear as a ready device after startup. Check the emulator and select its device serial.`);
      return serial;
    } catch (error) {
      await this.problem(`Could not resolve the Android emulator: ${error instanceof Error ? error.message : String(error)} Check adb and the emulator, then retry.`);
      return undefined;
    }
  }

  private async devices(project: ElideProject): Promise<AndroidDevice[] | undefined> {
    try {
      const devices = await attachedDevices(project);
      if (!devices) await this.problem("Android SDK platform-tools (adb) are unavailable. Set elide.android.sdk or install the Android SDK components, then retry.");
      return devices;
    } catch (error) {
      await this.problem(`Android device discovery failed: ${error instanceof Error ? error.message : String(error)} Check the SDK's adb installation and daemon, then retry.`);
      return undefined;
    }
  }

  private async validateDevice(devices: AndroidDevice[], serial: string): Promise<boolean> {
    const state = androidDeviceProblem(devices, serial);
    if (!state) return true;
    const action = state === "unauthorized" ? "Unlock the device and approve its USB debugging authorization." : "Reconnect the device or start its emulator.";
    await this.problem(`Android target ${serial} is ${state}. ${action} Select a different deployment target explicitly to switch devices.`);
    return false;
  }

  private async problem(message: string): Promise<void> {
    const action = await vscode.window.showErrorMessage(`Elide: ${message}`, "Select Android Deployment Target");
    if (action) void vscode.commands.executeCommand(SELECT_COMMAND);
  }

  private updateStatus(): void {
    if (this.disposed) return;
    if (!this.workspace.projects.some(runnable)) { this.status.hide(); return; }
    const selected = this.selected;
    const project = selected ? this.workspace.projectAt(selected.root) : undefined;
    const valid = project?.model?.android?.targets.some((target) => target.kind === "apk" && target.name === selected?.artifact);
    if (selected && valid) {
      const destination = selected.destination.kind === "device" ? selected.destination.serial : project!.model!.android!.avd;
      this.status.text = `$(device-mobile) ${selected.artifact} → ${destination}`;
      this.status.tooltip = `${project!.model?.name ?? selected.root}\n${selected.root}\nSelect Android Deployment Target (connection checked before deployment)`;
    } else {
      this.status.text = "$(device-mobile) Select Android Target";
      this.status.tooltip = "Select the Android project, APK and deployment device for Run and Debug";
    }
    this.status.show();
  }
}
