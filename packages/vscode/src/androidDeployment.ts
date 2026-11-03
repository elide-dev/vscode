import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { ANDROID_EMULATOR_TASK, ANDROID_NO_WINDOW_OPTION, adbExecutable, type AndroidDevice } from "@elide/ide-core";
import * as vscode from "vscode";
import { androidSdkFor, attachedDevices, toAndroidTarget } from "./android.js";
import { androidApks, androidAvdToBoot, androidDeviceProblem, preferredAndroidProject, restoredAndroidTarget } from "./androidDeploymentState.js";
import type { AndroidDeploymentDestination, AndroidDeploymentTarget } from "./androidDeploymentState.js";
import { readConfig } from "./config.js";
import type { ElideProject, ElideWorkspace } from "./projects.js";
import { executeElideTask, taskExitCode } from "./tasks.js";

const STATE_KEY = "elide.android.deploymentTarget";
const SELECT_COMMAND = "elide.androidSelectTarget";
const BOOT_TIMEOUT_MS = 120_000;
const BOOT_POLL_MS = 2_000;
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
    const avd = project.model!.android!.avd;
    let destination: AndroidDeploymentDestination | undefined = explicit?.device
      ? (remembered?.destination.kind === "device" && remembered.destination.serial === explicit.device ? remembered.destination : { kind: "device", serial: explicit.device })
      : choose ? undefined : remembered?.destination;
    // A stopped emulator is booted at deployment time; only a physical device needs the user to bring it back.
    if (destination?.kind === "device" && !androidAvdToBoot(devices, destination, avd) && !await this.validateDevice(devices, destination.serial)) return undefined;
    if (!destination) {
      const ready = devices.filter((device) => device.ready);
      const sdk = androidSdkFor(project);
      const avds = await Promise.all(ready.map((device) => device.emulator && sdk ? this.avdOf(sdk, device.serial) : undefined));
      const items: (vscode.QuickPickItem & { destination: AndroidDeploymentDestination })[] = ready.map((device, index) => {
        const running = avds[index];
        return {
          label: `$(device-mobile) ${device.serial}`,
          description: device.emulator ? `running emulator${running ? ` · ${running}` : ""}` : "connected device",
          destination: { kind: "device", serial: device.serial, ...(running ? { avd: running } : {}) },
        };
      });
      items.push({ label: "$(vm) Project emulator", description: avd, destination: { kind: "emulator" } });
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
    if (!await this.remember(selection)) return undefined;
    return { ...selection, project };
  }

  /**
   * The serial a deployment installs on, booting its emulator first when it is not running. A pinned emulator is
   * resolved again by AVD identity, since a reboot may give it another port; a physical device is never swapped.
   */
  async readyDevice(deployment: AndroidDeployment): Promise<string | undefined> {
    if (this.disposed) return undefined;
    const { project, destination } = deployment;
    const projectAvd = project.model!.android!.avd;
    if (destination.kind === "emulator") return this.bootAvd(project, projectAvd);
    const devices = await this.devices(project);
    if (!devices) return undefined;
    const avd = androidAvdToBoot(devices, destination, projectAvd);
    if (!avd) return await this.validateDevice(devices, destination.serial) ? destination.serial : undefined;
    const serial = await this.bootAvd(project, avd);
    if (!serial) return undefined;
    if (serial !== destination.serial || destination.avd !== avd) {
      const remembered = await this.remember({ root: deployment.root, artifact: deployment.artifact, destination: { kind: "device", serial, avd } });
      if (!remembered) return undefined;
    }
    return serial;
  }

  /**
   * Boot `avd` unless it already runs, and return its serial once Android finished booting. The project's AVD goes
   * through Elide, which also creates it; any other AVD is launched with the SDK's emulator, which Elide cannot name.
   */
  private async bootAvd(project: ElideProject, avd: string): Promise<string | undefined> {
    const sdk = androidSdkFor(project);
    if (!sdk) {
      await this.problem("No Android SDK is configured. Set elide.android.sdk or install the Android SDK components, then retry.");
      return undefined;
    }
    try {
      const running = await this.findEmulator(project, sdk, avd);
      if (running?.ready && await this.bootCompleted(sdk, running.serial)) return running.serial;
      const windowed = readConfig(project.folder).androidEmulatorWindow;
      const booted = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Elide: starting Android emulator '${avd}'`, cancellable: true }, async (_progress, token) => {
        if (token.isCancellationRequested || this.disposed) return false;
        if (avd === project.model!.android!.avd) return this.bootThroughElide(project, windowed, token);
        return this.bootThroughSdk(project, sdk, avd, windowed, running !== undefined, token);
      });
      if (this.disposed) return undefined;
      if (!booted) {
        await this.problem(`Emulator '${avd}' startup was cancelled, failed, or exceeded two minutes. Check the Elide task terminal or the emulator, then retry.`);
        return undefined;
      }
      const serial = await this.findEmulator(project, sdk, avd);
      if (!serial?.ready) await this.problem(`AVD '${avd}' did not appear as a ready device after startup. Check the emulator and select its device serial.`);
      return serial?.ready ? serial.serial : undefined;
    } catch (error) {
      await this.problem(`Could not start Android emulator '${avd}': ${error instanceof Error ? error.message : String(error)} Check adb and the emulator, then retry.`);
      return undefined;
    }
  }

  /** `android-emulator` creates the AVD when missing, adopts a running instance, and exits once it has booted. */
  private async bootThroughElide(project: ElideProject, windowed: boolean, token: vscode.CancellationToken): Promise<boolean> {
    const execution = await executeElideTask(this.workspace, project, "build", {
      args: [ANDROID_EMULATOR_TASK],
      ...(windowed ? {} : { options: { [ANDROID_NO_WINDOW_OPTION]: true } }),
    });
    if (!execution) return false;
    this.bootTasks.add(execution);
    let timer: NodeJS.Timeout | undefined;
    let cancellation: vscode.Disposable | undefined;
    try {
      const interrupted = new Promise<false>((resolve) => {
        const stop = () => { execution.terminate(); resolve(false); };
        cancellation = token.onCancellationRequested(stop);
        timer = setTimeout(stop, BOOT_TIMEOUT_MS);
        if (token.isCancellationRequested || this.disposed) stop();
      });
      return await Promise.race([taskExitCode(execution).then((code) => code === 0), interrupted]);
    } finally {
      clearTimeout(timer);
      cancellation?.dispose();
      this.bootTasks.delete(execution);
    }
  }

  /** Launch `avd` detached (unless an instance is already coming up) and wait for `sys.boot_completed`. */
  private async bootThroughSdk(project: ElideProject, sdk: string, avd: string, windowed: boolean, starting: boolean, token: vscode.CancellationToken): Promise<boolean> {
    let failure: Error | undefined;
    let child: ChildProcess | undefined;
    if (!starting) {
      const emulator = path.join(sdk, "emulator", process.platform === "win32" ? "emulator.exe" : "emulator");
      if (!existsSync(emulator)) throw new Error(`${emulator} is missing; install the Android Emulator SDK component.`);
      child = spawn(emulator, ["-avd", avd, ...(windowed ? [] : ["-no-window"])], { detached: true, stdio: "ignore" });
      child.once("error", (error) => { failure = error; });
      child.once("exit", (code) => { if (code) failure = new Error(`the emulator exited with code ${code}.`); });
      child.unref();
    }
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    try {
      while (!token.isCancellationRequested && !this.disposed && Date.now() < deadline) {
        if (failure) throw failure;
        const device = await this.findEmulator(project, sdk, avd);
        if (device?.ready && await this.bootCompleted(sdk, device.serial)) { child = undefined; return true; }
        await sleep(BOOT_POLL_MS);
      }
      return false;
    } finally {
      child?.kill();
    }
  }

  /** The emulator running `avd`, in whatever adb state; two instances of one AVD are ambiguous. */
  private async findEmulator(project: ElideProject, sdk: string, avd: string): Promise<AndroidDevice | undefined> {
    const devices = await attachedDevices(project);
    if (!devices) throw new Error("Android platform-tools are unavailable; install the Android SDK components.");
    const emulators = devices.filter((device) => device.emulator);
    const names = await Promise.all(emulators.map((device) => this.avdOf(sdk, device.serial)));
    const matching = emulators.filter((_device, index) => names[index] === avd);
    if (matching.filter((device) => device.ready).length > 1) throw new Error(`Multiple emulators run AVD '${avd}'. Select a specific emulator serial instead.`);
    return matching.find((device) => device.ready) ?? matching[0];
  }

  /** AVD an emulator runs, through its console; undefined when the console does not answer. */
  private async avdOf(sdk: string, serial: string): Promise<string | undefined> {
    try {
      const { stdout } = await exec(adbExecutable(sdk), ["-s", serial, "emu", "avd", "name"], { encoding: "utf8", timeout: 10_000 });
      return stdout.trim().split(/\r?\n/)[0]?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** `adb` reports `device` before Android can take an install; `sys.boot_completed` marks when it can. */
  private async bootCompleted(sdk: string, serial: string): Promise<boolean> {
    try {
      const { stdout } = await exec(adbExecutable(sdk), ["-s", serial, "shell", "getprop", "sys.boot_completed"], { encoding: "utf8", timeout: 10_000 });
      return stdout.trim() === "1";
    } catch {
      return false;
    }
  }

  /** Persist the selection; false once disposed, so a late answer never resurrects a torn-down controller. */
  private async remember(selection: AndroidDeploymentTarget): Promise<boolean> {
    await this.state.update(STATE_KEY, selection);
    if (this.disposed) return false;
    this.selected = selection;
    this.updateStatus();
    return true;
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
      const destination = selected.destination.kind === "device" ? selected.destination.avd ?? selected.destination.serial : project!.model!.android!.avd;
      this.status.text = `$(device-mobile) ${selected.artifact} → ${destination}`;
      this.status.tooltip = `${project!.model?.name ?? selected.root}\n${selected.root}\nSelect Android Deployment Target (connection checked before deployment)`;
    } else {
      this.status.text = "$(device-mobile) Select Android Target";
      this.status.tooltip = "Select the Android project, APK and deployment device for Run and Debug";
    }
    this.status.show();
  }
}
