import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";
import { adbExecutable, parseAdbDevices } from "@elide/ide-core";
import * as vscode from "vscode";
import { androidSdkFor, pickAndroidFolder } from "./android.js";
import type { ElideUi } from "./output.js";

export interface AndroidReadinessAction {
  label: string;
  command: string;
  arguments?: unknown[];
}

export interface AndroidReadinessFinding {
  id: string;
  status: "ok" | "warning" | "error" | "unknown" | "info";
  title: string;
  detail: string;
  actions: AndroidReadinessAction[];
}

export interface AndroidReadinessReport {
  root: string;
  checkedAt: string;
  cancelled: boolean;
  findings: AndroidReadinessFinding[];
}

const run = promisify(execFile);
const sdkSettings: AndroidReadinessAction = {
  label: "Configure elide.android.sdk", command: "workbench.action.openSettings", arguments: ["elide.android.sdk"],
};
const output: AndroidReadinessAction = { label: "Show Elide Output", command: "elide.showOutput" };

function isPath(file: string, directory = false): boolean {
  try { return directory ? statSync(file).isDirectory() : statSync(file).isFile(); }
  catch { return false; }
}

/** Inspect installed SDK tools and connected devices; never evaluate a manifest or invoke Elide. */
export async function inspectAndroidReadiness(
  folder: vscode.WorkspaceFolder,
  token?: vscode.CancellationToken,
): Promise<AndroidReadinessReport> {
  const report: AndroidReadinessReport = { root: folder.uri.fsPath, checkedAt: new Date().toISOString(), cancelled: false, findings: [] };
  if (!vscode.workspace.isTrusted) {
    report.findings.push({
      id: "trust", status: "unknown", title: "Workspace trust required",
      detail: "Local executable checks are not run in an untrusted workspace.",
      actions: [{ label: "Manage Workspace Trust", command: "workbench.trust.manage" }],
    });
    return report;
  }
  const controller = new AbortController();
  const subscription = token?.onCancellationRequested(() => controller.abort());
  if (token?.isCancellationRequested) controller.abort();
  const signal = controller.signal;
  const add = (id: string, status: AndroidReadinessFinding["status"], title: string, detail: string, actions: AndroidReadinessAction[] = []) => {
    report.findings.push({ id, status, title, detail, actions });
  };
  try {
    add("scope", "info", "Standalone Android SDK tools",
      "Checks SDK platform-tools and connected devices for Logcat. No Elide Android build, install, launch, emulator management, or debugging pipeline is available.");
    const sdk = androidSdkFor(folder);
    const sdkPresent = !!sdk && isPath(sdk, true);
    add("sdk", sdkPresent ? "ok" : "error", "Android SDK", sdk
      ? `${sdk}${sdkPresent ? "" : "\nDirectory does not exist."}`
      : "No installed SDK found. Set elide.android.sdk or ANDROID_HOME, or install the SDK using Android Studio.", [sdkSettings]);
    const adb = sdk ? adbExecutable(sdk) : undefined;
    const adbPresent = !!adb && sdkPresent && isPath(adb);
    add("adb", !sdkPresent ? "unknown" : adbPresent ? "ok" : "error", "ADB / platform-tools",
      !sdkPresent ? "Not checked: no usable SDK directory." : `${adb}${adbPresent ? "" : "\nInstall Android SDK Platform-Tools using Android Studio's SDK Manager."}`, [sdkSettings]);
    if (adb && adbPresent) {
      try {
        signal.throwIfAborted();
        const { stdout } = await run(adb, ["devices"], {
          cwd: folder.uri.fsPath, signal, timeout: 8_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024,
          encoding: "utf8", windowsHide: true,
        });
        const devices = parseAdbDevices(stdout);
        const ready = devices.some((device) => device.ready);
        add("devices", ready ? "ok" : "warning", "Connected devices",
          devices.length ? devices.map((device) => `${device.serial}: ${device.state}`).join("\n")
            : "No attached devices. Connect a physical device with USB debugging enabled, or start an emulator using Android Studio.",
          ready ? [{ label: "Open Android Logcat", command: "elide.androidLogcat", arguments: [{ root: folder.uri.fsPath }] }] : [output]);
        for (const device of devices.filter((entry) => !entry.ready)) {
          add(`device:${device.serial}`, "warning", `${device.serial}: ${device.state}`,
            device.state === "unauthorized" ? "Unlock the device and accept its USB debugging authorization prompt, then inspect again."
              : device.state === "offline" ? "Reconnect the device (or restart its emulator in Android Studio), then inspect again. ADB currently reports it offline."
                : `ADB reports ${device.state}; this device is not ready for Logcat.`, [output]);
        }
      } catch (error) {
        add("devices", signal.aborted ? "unknown" : "error", "Connected devices",
          signal.aborted ? "Not checked: inspection cancelled." : `ADB failed: ${error instanceof Error ? error.message : String(error)}\nCheck that the SDK's adb server can start.`, [sdkSettings, output]);
      }
    } else add("devices", "unknown", "Connected devices", "Not checked: ADB is unavailable.", [sdkSettings]);
    report.cancelled = signal.aborted;
    return report;
  } finally { subscription?.dispose(); }
}

/** Registers a native, actionable report and returns structured results to command callers. */
export function registerAndroidReadiness(ui: ElideUi): vscode.Disposable {
  return vscode.commands.registerCommand("elide.androidDoctor", async (value: unknown): Promise<AndroidReadinessReport | undefined> => {
    const folder = await pickAndroidFolder(value);
    if (!folder) return undefined;
    const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Checking Android SDK environment", cancellable: true },
      (_progress, token) => inspectAndroidReadiness(folder, token));
    ui.log(`Android environment: ${report.root}${report.cancelled ? " (cancelled)" : ""}`);
    for (const finding of report.findings) ui.log(`[${finding.status}] ${finding.title}\n${finding.detail}`);
    if (!report.cancelled) {
      const finding = await vscode.window.showQuickPick(report.findings.map((entry) => ({
        label: entry.title, description: entry.status, detail: entry.detail.replace(/\n/g, " — "), finding: entry,
      })), { title: "Android Environment", placeHolder: "Select a finding for fixes; full report is in Elide Output", matchOnDetail: true });
      if (finding) {
        const action = await vscode.window.showQuickPick([...finding.finding.actions, output].map((entry) => ({ label: entry.label, action: entry })),
          { title: finding.finding.title, placeHolder: finding.finding.detail.replace(/\n/g, " ") });
        if (action) await vscode.commands.executeCommand(action.action.command, ...(action.action.arguments ?? []));
      }
    }
    return report;
  });
}
