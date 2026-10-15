import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  adbExecutable, androidPlatformApiLevel, decodeManifest, isSupportedElideVersion, MIN_ELIDE_VERSION,
  parseAdbDevices, parseElideVersion, resolveElideDistribution, resolveJdk,
  type ElideDistribution,
} from "@elide/ide-core";
import * as vscode from "vscode";
import { androidSdkFor, toAndroidTarget } from "./android.js";
import { readConfig } from "./config.js";
import { JETBRAINS_EXTENSION_ID, jetBrainsExtension } from "./jetbrains.js";
import type { ElideUi } from "./output.js";
import type { ElideProject, ElideWorkspace } from "./projects.js";

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
const settings = (key: string): AndroidReadinessAction => ({
  label: `Configure ${key}`, command: "workbench.action.openSettings", arguments: [key],
});
const sync: AndroidReadinessAction = { label: "Sync Project(s)…", command: "elide.sync" };
const output: AndroidReadinessAction = { label: "Show Elide Output", command: "elide.showOutput" };

function isPath(file: string, directory = false): boolean {
  try { return directory ? statSync(file).isDirectory() : statSync(file).isFile(); }
  catch { return false; }
}

/** Local inspection only: never export/evaluate a manifest (even export can rewrite the lockfile). */
export async function inspectAndroidReadiness(
  project: ElideProject,
  token?: vscode.CancellationToken,
): Promise<AndroidReadinessReport> {
  const report: AndroidReadinessReport = { root: project.root, checkedAt: new Date().toISOString(), cancelled: false, findings: [] };
  if (vscode.workspace.isTrusted === false) {
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
  const config = readConfig(project.folder);
  const android = project.model?.android;
  const target = { root: project.root };
  const manifest: AndroidReadinessAction = { label: "Open elide.pkl", command: "elide.openManifest", arguments: [target] };
  const sdkActions = [settings("elide.android.sdk"), manifest, sync];
  if (android) sdkActions.push({ label: "Install missing SDK components… (requires license confirmation)", command: "elide.androidInstallSdk", arguments: [target] });
  const add = (id: string, status: AndroidReadinessFinding["status"], title: string, detail: string, actions: AndroidReadinessAction[] = []) => {
    report.findings.push({ id, status, title, detail, actions });
  };
  // SIGKILL bounds both timeout and cancellation even when a tool ignores graceful termination.
  const probe = async (binary: string, args: string[], includeStderr = false): Promise<string> => {
    signal.throwIfAborted();
    const result = await run(binary, args, {
      cwd: project.root, signal, timeout: 8_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024,
      encoding: "utf8", windowsHide: true,
    });
    return (includeStderr ? `${result.stdout}\n${result.stderr}` : result.stdout).trim();
  };
  const check = async (id: string, title: string, actions: AndroidReadinessAction[], action: () => Promise<void>, failure: "error" | "warning" = "error") => {
    if (signal.aborted) {
      add(id, "unknown", title, "Not checked: inspection cancelled.", actions);
      return;
    }
    try { await action(); }
    catch (error) {
      add(id, signal.aborted ? "unknown" : failure, title,
        signal.aborted ? "Not checked: inspection cancelled." : String(error instanceof Error ? error.message : error), actions);
    }
  };
  try {
    add("model", project.model ? "info" : "unknown", "Project declarations",
      project.model ? "Project-specific checks use the last successful sync; sync again after manifest changes. No build or dependency resolution is performed."
        : "No synced model. Local tools can still be checked; project SDK declarations, Java target, compile SDK, AVD and artifact kinds are unknown until sync.", [manifest, sync, output]);
    await check("workspacePath", "Workspace source path", [output], async () => {
      const opened = path.resolve(project.folder.uri.fsPath);
      const canonical = realpathSync(opened);
      const same = process.platform === "win32" ? opened.toLowerCase() === canonical.toLowerCase() : opened === canonical;
      add("workspacePath", same ? "ok" : "warning", "Workspace source path", same ? canonical :
        `${opened} resolves to ${canonical}. The JetBrains debugger can report "Source file not found" for breakpoints opened through a symlink. Open the canonical folder for source debugging.`,
        same ? [] : [{ label: "Open canonical folder in a new window", command: "vscode.openFolder", arguments: [vscode.Uri.file(canonical), true] }]);
    }, "warning");
    let distribution: ElideDistribution | undefined;
    await check("elide", "Elide CLI", [settings("elide.home"), output], async () => {
      distribution = resolveElideDistribution({ explicitHome: config.home });
      const version = (await probe(distribution.bin, ["--version"])).split(/\r?\n/)[0] ?? "";
      const minimum = `${MIN_ELIDE_VERSION.major}.${MIN_ELIDE_VERSION.minor}.${MIN_ELIDE_VERSION.patch}`;
      add("elide", !parseElideVersion(version) ? "unknown" : isSupportedElideVersion(version) ? "ok" : "error", "Elide CLI",
        `${distribution.bin}\nVersion: ${version || "not reported"}. Minimum supported by this extension: ${minimum}.`, [settings("elide.home"), output]);
    });
    await check("jdk", "JDK for Kotlin analysis", [settings("elide.jdk.home"), sync], async () => {
      // The model retains the manifest-selected home; without a model, explicitly report the
      // environment-only result rather than pretend that the project's JVM requirements are known.
      const jdk = await resolveJdk(decodeManifest("{}"), distribution ?? { home: "", bin: "" }, {
        override: config.jdkHome ?? project.model?.jdk?.home,
        exists: (file) => !signal.aborted && isPath(file),
        javaVersionOutput: (home) => probe(path.join(home, "bin", process.platform === "win32" ? "java.exe" : "java"), ["-version"], true),
      });
      signal.throwIfAborted();
      if (!jdk) {
        add("jdk", "error", "JDK for Kotlin analysis", "No symbol-resolution JDK found by the existing Elide resolver. Configure an installed JDK with a release file and class roots.", [settings("elide.jdk.home"), sync]);
        return;
      }
      const java = path.join(jdk.home, "bin", process.platform === "win32" ? "java.exe" : "java");
      const version = await probe(java, ["-version"], true);
      add("jdk", "ok", "JDK for Kotlin analysis", `${jdk.home}\n${version}\n${project.model ? "Uses configured or last-synced JDK, then the existing resolver." : "Environment candidate only; manifest Java home/target not checked until sync."}`, [settings("elide.jdk.home"), sync]);
      if (config.jdkHome && path.resolve(jdk.home) !== path.resolve(config.jdkHome)) {
        add("jdkOverride", "warning", "Configured JDK was not usable", `${config.jdkHome}\nThe existing resolver selected ${jdk.home} instead.`, [settings("elide.jdk.home")]);
      }
    });
    const sdk = androidSdkFor(project);
    const sdkPresent = !!sdk && isPath(sdk, true);
    add("sdk", sdkPresent ? "ok" : "error", "Android SDK", sdk
      ? `${sdk}\n${config.androidSdk ? "From elide.android.sdk (device tooling override; does not change the build's SDK declaration)." : android ? "From the last synced model or environment lookup." : "Environment lookup only; manifest SDK declaration is not checked until sync."}${sdkPresent ? "" : "\nDirectory does not exist."}`
      : "No SDK located. Set elide.android.sdk for device tooling; configure android.sdk in elide.pkl or ANDROID_HOME for builds.", sdkActions);
    const adb = sdk ? adbExecutable(sdk) : undefined;
    add("adb", !sdkPresent ? "unknown" : adb && isPath(adb) ? "ok" : "error", "ADB / platform-tools",
      !sdkPresent ? "Not checked: no usable SDK directory." : `${adb}${adb && isPath(adb) ? "" : "\nInstall SDK platform-tools."}`, sdkActions);
    if (adb && sdkPresent && isPath(adb)) {
      await check("devices", "Connected devices", [output], async () => {
        const devices = parseAdbDevices(await probe(adb, ["devices"]));
        add("devices", devices.some((device) => device.ready) ? "ok" : "warning", "Connected devices",
          devices.length ? devices.map((device) => `${device.serial}: ${device.state}`).join("\n")
            : "No attached devices. Connect a physical device with USB debugging enabled or start an emulator.",
          android ? [{ label: "Start Android Emulator", command: "elide.androidStartEmulator", arguments: [target] }, output] : [output]);
        for (const device of devices.filter((entry) => !entry.ready)) {
          add(`device:${device.serial}`, "warning", `${device.serial}: ${device.state}`,
            device.state === "unauthorized" ? "Unlock the device and accept its USB debugging authorization prompt, then inspect again."
              : device.state === "offline" ? "Reconnect the device (or restart its emulator), then inspect again. ADB currently reports it offline."
                : `ADB reports ${device.state}; this device cannot currently accept an install.`, [output]);
        }
      });
    } else add("devices", "unknown", "Connected devices", "Not checked: ADB is unavailable.", sdkActions);
    // The resolved classpath is authoritative: platform directories can use minor API versions
    // (android-37.0), so reconstructing one from compileSdk would report an installed SDK missing.
    const platformJars = project.model?.libraries.map((library) => library.classes)
      .filter((file) => androidPlatformApiLevel(file) !== undefined) ?? [];
    add("compileSdk", !platformJars.length ? "unknown" : platformJars.every((file) => isPath(file)) ? "ok" : "error", "Compile SDK android.jar",
      platformJars.length ? platformJars.map((file) => `${file}${isPath(file) ? "" : " — missing; install the project's SDK platform and sync again."}`).join("\n")
        : "Not checked: no Android platform jar in the synced classpath.", sdkActions);
    const emulator = sdk ? path.join(sdk, "emulator", process.platform === "win32" ? "emulator.exe" : "emulator") : undefined;
    add("emulator", !sdkPresent ? "unknown" : emulator && isPath(emulator) ? "ok" : "info", "Emulator (optional)",
      emulator && sdkPresent ? `${emulator}\n${isPath(emulator) ? "Installed." : "Not installed. Only needed for virtual devices; physical-device workflows do not require it."}`
        : "Not checked: no usable SDK. Physical-device workflows do not require an emulator.", sdkActions);
    if (android?.avd && emulator && isPath(emulator)) {
      await check("avd", "Project AVD (optional)", [output], async () => {
        const avds = (await probe(emulator, ["-list-avds"])).split(/\r?\n/).map((line) => line.trim());
        const present = avds.includes(android.avd);
        add("avd", present ? "ok" : "warning", "Project AVD (optional)", `${android.avd}\n${present ? "Listed by the SDK emulator." : "Not listed. Create this AVD to use the project's emulator workflow; physical devices are unaffected."}`,
          [{ label: "Create Android AVD", command: "elide.androidCreateAvd", arguments: [target] }, output]);
      }, "warning");
    } else add("avd", "unknown", "Project AVD (optional)", "Not checked: AVD declaration or emulator binary is unavailable. Physical devices are unaffected.", [manifest, sync]);
    const kotlin = jetBrainsExtension();
    add("kotlin", !kotlin ? "warning" : kotlin.isActive ? "ok" : "info", "JetBrains Kotlin extension",
      !kotlin ? `${JETBRAINS_EXTENSION_ID} is not installed. Install/enable it for Kotlin analysis.`
        : `${JETBRAINS_EXTENSION_ID}: installed, ${kotlin.isActive ? "active" : "not active; open a Kotlin or Java file to activate it"}.`,
      [{ label: "Show JetBrains Kotlin Extension", command: "extension.open", arguments: [JETBRAINS_EXTENSION_ID] }, sync]);
    const apks = android?.targets.filter((artifact) => artifact.kind === "apk") ?? [];
    add("artifacts", !project.model ? "unknown" : apks.length ? "ok" : "info", "Runnable Android artifacts",
      !project.model ? "Unknown until sync; the doctor does not evaluate elide.pkl."
        : apks.length ? apks.map((artifact) => `${artifact.name}: APK → ${artifact.output}`).join("\n") + "\nDeclarations only; APK build/install readiness is not checked."
          : android?.targets.length ? `No runnable APK. Declared artifacts: ${android.targets.map((artifact) => `${artifact.name} (${artifact.kind})`).join(", ")}. Libraries, bundles and features are not standalone run targets.`
            : "No Android APK is declared in the last synced model.", [manifest, sync]);
    report.cancelled = signal.aborted;
    return report;
  } finally { subscription?.dispose(); }
}

/** Registers a native, actionable report and returns structured results to command callers. */
export function registerAndroidReadiness(workspace: ElideWorkspace, ui: ElideUi): vscode.Disposable {
  return vscode.commands.registerCommand("elide.androidDoctor", async (value: unknown): Promise<AndroidReadinessReport | undefined> => {
    const named = toAndroidTarget(value);
    let project = named ? workspace.projectAt(named.root) : undefined;
    if (named && !project) {
      void vscode.window.showWarningMessage(`Elide: project ${named.root} is not tracked. Open its workspace folder first.`);
      return undefined;
    }
    if (!project) {
      const projects = workspace.projects;
      if (projects.length === 1) project = projects[0];
      else if (projects.length > 1) project = (await vscode.window.showQuickPick(projects.map((entry) => ({
        label: entry.model?.name ?? path.basename(entry.root), description: entry.root, project: entry,
      })), { title: "Android Environment", placeHolder: "Select a project (sync is not required)" }))?.project;
      else void vscode.window.showWarningMessage("Elide: no project is discovered. Open a folder containing elide.pkl.");
    }
    if (!project) return undefined;
    const selected = project;
    const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Checking Android environment", cancellable: true },
      (_progress, token) => inspectAndroidReadiness(selected, token));
    const error = workspace.lastError(selected.folder);
    if (error || workspace.isStale(selected.folder)) report.findings.unshift({
      id: "syncState", status: "warning", title: error ? "Last sync failed" : "Project model is stale",
      detail: error ?? "Sync again to refresh project-specific declarations.", actions: [sync, output],
    });
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
