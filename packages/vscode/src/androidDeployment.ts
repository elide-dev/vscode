import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { ANDROID_EMULATOR_TASK, ANDROID_NO_WINDOW_OPTION, adbExecutable, type AndroidDevice } from "@elide/ide-core";
import * as vscode from "vscode";
import { androidSdkFor, attachedDevices, toAndroidTarget, uninstallAndroidApp } from "./android.js";
import { NO_ANDROID_PROJECT, androidApks, androidAvdToBoot, androidDeviceProblem, androidApkOffers, androidUseTask, deployableApks, hasAndroidProjects, preferredAndroidProject, restoredAndroidTarget } from "./androidDeploymentState.js";
import type { AndroidDeploymentDestination, AndroidDeploymentTarget, AndroidDeploymentUse } from "./androidDeploymentState.js";
import { readConfig } from "./config.js";
import type { ElideProject, ElideWorkspace } from "./projects.js";
import { executeElideTask, taskExitCode } from "./tasks.js";

const STATE_KEY = "elide.android.deploymentTarget";
const SELECT_COMMAND = "elide.androidSelectTarget";
const BOOT_TIMEOUT_MS = 120_000;
const BOOT_POLL_MS = 2_000;
const UNINSTALL = "Uninstall";
const exec = promisify(execFile);

export interface AndroidDeployment extends AndroidDeploymentTarget {
  project: ElideProject;
}

function deployable(project: ElideProject, use?: AndroidDeploymentUse): boolean {
  return deployableApks(project, use).length > 0;
}

function sameTarget(a: AndroidDeploymentTarget | undefined, b: AndroidDeploymentTarget): boolean {
  if (a?.root !== b.root || a.artifact !== b.artifact || a.destination.kind !== b.destination.kind) return false;
  return a.destination.kind === "emulator" || b.destination.kind === "emulator"
    || (a.destination.serial === b.destination.serial && a.destination.avd === b.destination.avd);
}

/** What each use is called in a refusal; a device-only action needs any device target. */
const USE_LABELS: Record<AndroidDeploymentUse, string> = { run: "Run", debug: "Debug", test: "instrumented-test" };
/** Why Elide lists no device target for an APK, in the case a user can do something about. */
const INSTALLABLE_HINT = "Elide lists none for an APK it cannot install, such as an unsigned one: check its `signing` and sync again.";
/** Why an installable APK offers no Debug: its manifest, or the build it was merged into, leaves it undebuggable. */
const DEBUGGABLE_HINT = "Build it with `release = false` (with an Elide that marks such builds debuggable), or set `android:debuggable=\"true\"` on `<application>` in its manifest, then build it again.";

/** One workspace's Run/Debug target. Device discovery is demand-driven, never a background poll. */
export class AndroidDeploymentController implements vscode.Disposable {
  private selected: AndroidDeploymentTarget | undefined;
  private readonly status = vscode.window.createStatusBarItem("elide.androidTarget", vscode.StatusBarAlignment.Left, 90);
  private readonly subscriptions: vscode.Disposable[];
  private disposed = false;
  /** Bumped whenever a different selection is persisted: a resolution that began before it is stale. */
  private revision = 0;
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
    await this.resolve(value, undefined, true);
  }

  /**
   * Explicit invocation, active deployable owner, remembered app, then a choice among deployable apps. `use` names
   * what the caller deploys for — its APK must offer that target; without it, any device target will do, which is
   * what an action needing only the device asks for.
   */
  async resolve(value?: unknown, use?: AndroidDeploymentUse, choose = false): Promise<AndroidDeployment | undefined> {
    if (this.disposed) return undefined;
    // Only another selection persisted meanwhile supersedes this one; a picker dismissed elsewhere does not.
    const revision = this.revision;
    const explicit = toAndroidTarget(value);
    const candidates = this.workspace.projects.filter((project) => deployable(project, use));
    const label = use ? USE_LABELS[use] : "device";
    if (!hasAndroidProjects(this.workspace.projects)) {
      void vscode.window.showWarningMessage(NO_ANDROID_PROJECT);
      return undefined;
    }
    // Selecting a target only helps when there is another one to select, and never from the selection itself.
    const selectable = !choose && candidates.length > 0;
    const editor = vscode.window.activeTextEditor;
    const owner = editor?.document.uri.scheme === "file" ? this.workspace.projectFor(editor.document.uri.fsPath) : undefined;
    let project: ElideProject | undefined;
    if (explicit) {
      project = this.workspace.projectAt(explicit.root);
      if (explicit.device && !explicit.artifact && !choose) {
        // A device row names only the device. Its root is the project its tree's tools act for, not an app the user
        // picked: the app is the one the tree would deploy without a target, the active or the remembered one.
        const top = project?.workspaceRoot ? this.workspace.projectAt(project.workspaceRoot) : project;
        const tree = top ? [top, ...this.workspace.membersOf(top.root)] : [];
        project = preferredAndroidProject(tree, owner && tree.includes(owner) ? owner : undefined, this.selected?.root, use) ?? project;
      }
      if (!project || !deployable(project, use)) {
        this.problem(project && androidApks(project).length > 0
          ? `No APK of ${project.model?.name ?? project.root} has a ${label} target. ${INSTALLABLE_HINT}`
          : `Project ${explicit.root} has no synced Android application package. Sync the project and select an APK target.`, selectable);
        return undefined;
      }
    } else if (!choose) {
      project = preferredAndroidProject(this.workspace.projects, owner, this.selected?.root, use);
      if (!project && this.selected) {
        this.problem(`Remembered Android project ${this.selected.root} has no APK with a ${label} target. Select a current deployment target.`, selectable);
        return undefined;
      }
    }
    if (!project) {
      if (candidates.length === 0) {
        this.problem(this.workspace.projects.some((candidate) => androidApks(candidate).length > 0)
          ? `No synced Android APK has a ${label} target. ${INSTALLABLE_HINT}`
          : "No synced Android project declares an application package (APK); its projects build only libraries or bundles.", false);
        return undefined;
      }
      project = candidates.length === 1 ? candidates[0] : (await vscode.window.showQuickPick(
        candidates.map((candidate) => ({ label: candidate.model?.name ?? candidate.root, description: candidate.root, project: candidate })),
        { placeHolder: "Android deployment project" },
      ))?.project;
    }
    if (!project || this.disposed || revision !== this.revision) return undefined;
    const root = project.root;
    // A sync gives the project a new model, and a workspace member a new project: what counts is that it is still Android.
    const current = () => !this.disposed && revision === this.revision && this.workspace.projectAt(root)?.model?.android !== undefined;
    if (!current()) return undefined;
    project = this.workspace.projectAt(root)!;
    const android = project.model!.android!;
    const remembered = this.selected?.root === project.root ? this.selected : undefined;
    const apks = deployableApks(project, use);
    let artifact = explicit?.artifact ?? (choose ? undefined : remembered?.artifact);
    const declared = artifact === undefined ? undefined : androidApks(project).find((apk) => apk.name === artifact);
    if (artifact && !declared) {
      this.problem(`Android APK '${artifact}' is no longer declared by ${project.model?.name ?? project.root}. Select a current deployment target.`, selectable);
      return undefined;
    }
    if (artifact && declared && !androidApkOffers(declared, use)) {
      // An installable APK without Debug is one that cannot be debugged, not one Elide cannot install.
      this.problem(use === "debug" && declared.device?.runnable ? `'${artifact}' is not debuggable. ${DEBUGGABLE_HINT}`
        : `Elide lists no ${use ? androidUseTask(use, artifact) : "device"} target for '${artifact}'. ${INSTALLABLE_HINT} Or select a different deployment target.`, selectable);
      return undefined;
    }
    if (!artifact) {
      artifact = apks.length === 1 ? apks[0]?.name : (await vscode.window.showQuickPick(
        apks.map((apk) => ({ label: apk.name, description: apk.output })), { placeHolder: "Android application package" },
      ))?.label;
    }
    if (!artifact || !current()) return undefined;
    const devices = await this.devices(project);
    if (!devices || !current()) return undefined;
    const avd = android.avd;
    let destination: AndroidDeploymentDestination | undefined = explicit?.device
      ? (remembered?.destination.kind === "device" && remembered.destination.serial === explicit.device ? remembered.destination : { kind: "device", serial: explicit.device })
      : choose ? undefined : remembered?.destination;
    // A stopped emulator is booted at deployment time; only a physical device needs the user to bring it back.
    if (destination?.kind === "device" && !androidAvdToBoot(devices, destination, avd) && !this.validateDevice(devices, destination.serial, selectable)) return undefined;
    if (!current()) return undefined;
    if (!destination) {
      const ready = devices.filter((device) => device.ready);
      const sdk = androidSdkFor(project);
      const avds = await Promise.all(ready.map((device) => device.emulator && sdk ? this.avdOf(sdk, device.serial) : undefined));
      if (!current()) return undefined;
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
      if (!current()) return undefined;
      if (destination?.kind === "device") {
        const refreshed = await this.devices(project);
        if (!refreshed || !current() || !this.validateDevice(refreshed, destination.serial, false)) return undefined;
      }
    }
    if (!current()) return undefined;
    if (destination?.kind === "device" && !destination.avd) {
      const serial = destination.serial;
      const device = devices.find((candidate) => candidate.serial === serial);
      const sdk = device?.emulator && device.ready ? androidSdkFor(project) : undefined;
      const identity = sdk ? await this.avdOf(sdk, serial) : undefined;
      if (identity) destination = { ...destination, avd: identity };
    }
    if (!destination || !current()) return undefined;
    const selection = { root: project.root, artifact, destination };
    // Persisting a different selection supersedes every resolution begun before it, this one excepted.
    if (!await this.remember(selection, revision)) return undefined;
    const deployed = this.workspace.projectAt(root);
    return deployed?.model?.android ? { ...selection, project: deployed } : undefined;
  }

  /**
   * The serial a deployment installs on, booting its emulator first when it is not running. A pinned emulator is
   * resolved again by AVD identity, since a reboot may give it another port; a physical device is never swapped.
   * The deployment must stay the selection meanwhile: when another target is selected while its emulator starts,
   * nothing is deployed, and the user is told so.
   */
  async readyDevice(deployment: AndroidDeployment): Promise<string | undefined> {
    // Re-pinning a rebooted emulator's serial replaces the selection this deployment has to remain.
    const pin = { target: { root: deployment.root, artifact: deployment.artifact, destination: deployment.destination } };
    const serial = await this.prepareDevice(pin);
    if (this.disposed) return undefined;
    if (!sameTarget(this.selected, pin.target)) {
      void vscode.window.showWarningMessage(`Elide: the Android deployment target changed while the device for ${deployment.artifact} was getting ready, so nothing was deployed. Start it again to deploy to the new target.`);
      return undefined;
    }
    if (!this.declares(pin.target)) {
      this.problem(`Android APK '${deployment.artifact}' is no longer declared by ${deployment.root}. Select a current deployment target.`);
      return undefined;
    }
    return serial;
  }

  private async prepareDevice(pin: { target: AndroidDeploymentTarget }): Promise<string | undefined> {
    const current = () => !this.disposed && sameTarget(this.selected, pin.target) && this.declares(pin.target);
    const { root, artifact, destination } = pin.target;
    const project = this.workspace.projectAt(root);
    const projectAvd = project?.model?.android?.avd;
    if (!project || !projectAvd || !current()) return undefined;
    if (destination.kind === "emulator") return await this.bootAvd(project, projectAvd, current);
    const devices = await this.devices(project);
    if (!devices || !current()) return undefined;
    const sdk = androidSdkFor(project);
    const currentAvd = destination.avd && sdk ? await this.avdOf(sdk, destination.serial) : undefined;
    if (!current()) return undefined;
    const avd = androidAvdToBoot(devices, destination, projectAvd, currentAvd);
    if (!avd) return this.validateDevice(devices, destination.serial) ? destination.serial : undefined;
    const serial = await this.bootAvd(project, avd, current);
    if (!serial || !current()) return undefined;
    if (serial !== destination.serial || destination.avd !== avd) {
      const repinned: AndroidDeploymentTarget = { root, artifact, destination: { kind: "device", serial, avd } };
      if (!await this.remember(repinned, this.revision)) return undefined;
      pin.target = repinned;
    }
    return serial;
  }

  /** Whether the live model still declares the target's APK; a sync may have removed it. */
  private declares(target: AndroidDeploymentTarget): boolean {
    return this.workspace.projectAt(target.root)?.model?.android?.targets.some((apk) => apk.kind === "apk" && apk.name === target.artifact) ?? false;
  }

  /**
   * Uninstall `application` from the device `deployment` installs on, once the user has confirmed that this erases
   * its data: a Run or Debug refused with `INSTALL_FAILED_UPDATE_INCOMPATIBLE` can then install its own build.
   * `serial` is the device it installed on; the project emulator, which Elide boots itself, is found again.
   */
  async uninstall(deployment: AndroidDeployment, application: string, serial?: string): Promise<boolean> {
    const device = serial ?? await this.readyDevice(deployment);
    if (!device || this.disposed) return false;
    const avd = deployment.destination.kind === "emulator" ? this.workspace.projectAt(deployment.root)?.model?.android?.avd : deployment.destination.avd;
    const name = avd ? `${device} (${avd})` : device;
    const confirmed = await vscode.window.showWarningMessage(`Uninstall ${application} from ${name}?`, {
      modal: true,
      detail: `Android refuses to update it: the copy on the device is signed with a different key. Uninstalling erases ${application}'s data on ${name}, then installs the app again.`,
    }, UNINSTALL);
    if (confirmed !== UNINSTALL || this.disposed) return false;
    try {
      await uninstallAndroidApp(deployment.project, device, application);
      return true;
    } catch (error) {
      this.problem(`Could not uninstall ${application} from ${name}: ${error instanceof Error ? error.message : String(error)}`, false);
      return false;
    }
  }

  /**
   * Boot `avd` unless it already runs, and return its serial once Android finished booting. The project's AVD goes
   * through Elide, which also creates it; any other AVD is launched with the SDK's emulator, which Elide cannot name.
   * A failure is reported without waiting for the user to dismiss it, so the startup progress closes with it.
   */
  private async bootAvd(project: ElideProject, avd: string, current: () => boolean): Promise<string | undefined> {
    const projectAvd = project.model?.android?.avd;
    if (!projectAvd || !current()) return undefined;
    const sdk = androidSdkFor(project);
    if (!sdk) {
      this.problem("No Android SDK is configured. Set elide.android.sdk or install the Android SDK components, then retry.");
      return undefined;
    }
    try {
      const running = await this.findEmulator(project, sdk, avd);
      if (!current()) return undefined;
      if (running?.ready && await this.bootCompleted(sdk, running.serial)) return current() ? running.serial : undefined;
      if (!current()) return undefined;
      const windowed = readConfig(project.folder).androidEmulatorWindow;
      return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Elide: starting Android emulator '${avd}'`, cancellable: true }, async (_progress, token) => {
        if (token.isCancellationRequested || !current()) return undefined;
        const booted = avd === projectAvd
          ? await this.bootThroughElide(project, windowed, token)
          : await this.bootThroughSdk(project, sdk, avd, windowed, running !== undefined, token);
        if (token.isCancellationRequested || !current()) return undefined;
        if (!booted) {
          this.problem(`Emulator '${avd}' startup failed or exceeded two minutes. Check the Elide task terminal or the emulator, then retry.`);
          return undefined;
        }
        const serial = await this.findEmulator(project, sdk, avd);
        if (token.isCancellationRequested || !current()) return undefined;
        if (!serial?.ready) this.problem(`AVD '${avd}' did not appear as a ready device after startup. Check the emulator and select its device serial.`);
        return serial?.ready ? serial.serial : undefined;
      });
    } catch (error) {
      this.problem(`Could not start Android emulator '${avd}': ${error instanceof Error ? error.message : String(error)} Check adb and the emulator, then retry.`);
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
        if (device?.ready && await this.bootCompleted(sdk, device.serial)) {
          if (token.isCancellationRequested || this.disposed) return false;
          child = undefined;
          return true;
        }
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

  /**
   * Persist `selection` unless another one was persisted since `revision`; an equal one is already the selection.
   * It becomes the selection at once, so a slow Memento write cannot bring back an older target after a newer one.
   */
  private async remember(selection: AndroidDeploymentTarget, revision: number): Promise<boolean> {
    if (this.disposed) return false;
    if (sameTarget(this.selected, selection)) return true;
    if (revision !== this.revision) return false;
    const generation = ++this.revision;
    this.selected = selection;
    this.updateStatus();
    await this.state.update(STATE_KEY, selection);
    return !this.disposed && generation === this.revision;
  }

  private async devices(project: ElideProject): Promise<AndroidDevice[] | undefined> {
    try {
      const devices = await attachedDevices(project);
      if (!devices) this.problem("Android SDK platform-tools (adb) are unavailable. Set elide.android.sdk or install the Android SDK components, then retry.", false);
      return devices;
    } catch (error) {
      this.problem(`Android device discovery failed: ${error instanceof Error ? error.message : String(error)} Check the SDK's adb installation and daemon, then retry.`, false);
      return undefined;
    }
  }

  private validateDevice(devices: AndroidDevice[], serial: string, selectable = true): boolean {
    const state = androidDeviceProblem(devices, serial);
    if (!state) return true;
    const action = state === "unauthorized" ? "Unlock the device and approve its USB debugging authorization." : "Reconnect the device or start its emulator.";
    this.problem(`Android target ${serial} is ${state}. ${action}${selectable ? " Select a different deployment target explicitly to switch devices." : ""}`, selectable);
    return false;
  }

  /**
   * `selectable` offers the selection only where choosing another target can fix the problem. The deployment that
   * failed ends without waiting for the notification to be dismissed.
   */
  private problem(message: string, selectable = true): void {
    if (!selectable) {
      void vscode.window.showErrorMessage(`Elide: ${message}`);
      return;
    }
    void vscode.window.showErrorMessage(`Elide: ${message}`, "Select Android Deployment Target").then((action) => {
      if (action) void vscode.commands.executeCommand(SELECT_COMMAND);
    });
  }

  private updateStatus(): void {
    if (this.disposed) return;
    if (!this.workspace.projects.some((candidate) => deployable(candidate))) { this.status.hide(); return; }
    const selected = this.selected;
    const project = selected ? this.workspace.projectAt(selected.root) : undefined;
    const valid = project ? deployableApks(project).some((apk) => apk.name === selected?.artifact) : false;
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
