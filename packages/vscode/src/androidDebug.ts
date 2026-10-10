import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { ANDROID_DEVICE_OPTION, androidDebugTask, elideInvocationArgs, mergeElideInvocationOptions, resolveElideDistribution } from "@elide/ide-core";
import * as vscode from "vscode";
import { configuredInvocation, readConfig } from "./config.js";
import { launchWithJdwp, resolveAttachType } from "./debug.js";
import type { ElideUi } from "./output.js";
import type { ElideWorkspace } from "./projects.js";

export const ELIDE_ANDROID_DEBUG_TYPE = "elide-android";

/**
 * `elide-android` launch configuration: build an APK, install it, launch it waiting for a debugger and attach to
 * the JDWP socket forwarded off the device. `artifact` is the mapping key of the entry in the `artifacts` block of
 * `elide.pkl`, which is also the build target `elide build` takes.
 */
interface ElideAndroidLaunchConfig extends vscode.DebugConfiguration {
  /** Android application package to build, install and debug. */
  artifact?: string;
  /** Device serial to pin the run to; absent lets the debug target choose, booting the emulator when nothing is attached. */
  device?: string;
  /** Local port of a JDWP socket already forwarded off a device: attach to it, building and installing nothing. */
  port?: number;
  project?: string;
}

/**
 * `elide-android` launch configurations run `elide build android-debug-<artifact>` in a terminal and attach the
 * configured JVM debugger once the forwarded JDWP agent announces its port. The provider never lets a session of
 * type `elide-android` start itself: the session that matters is the attach one. Breakpoints resolve because the
 * project's modules are already in `workspace.json`.
 */
export class ElideAndroidDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  constructor(
    private readonly workspace: ElideWorkspace,
    private readonly ui: ElideUi,
    /** Attach sessions and the Elide process each owns, shared with the `elide` provider so ending one ends the other. */
    private readonly sessions: Map<string, ChildProcess>,
  ) {}

  provideDebugConfigurations(): vscode.DebugConfiguration[] {
    return [{ type: ELIDE_ANDROID_DEBUG_TYPE, request: "launch", name: "Elide: Debug Android App", artifact: "" }];
  }

  async resolveDebugConfigurationWithSubstitutedVariables(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined> {
    const launch = config as ElideAndroidLaunchConfig;
    const targetFolder = folder ?? vscode.workspace.workspaceFolders?.[0];
    if (!targetFolder) {
      void vscode.window.showErrorMessage("Elide: open a workspace folder containing elide.pkl to debug.");
      return undefined;
    }
    if (!launch.artifact && launch.port === undefined) {
      void vscode.window.showErrorMessage("Elide: name the Android application package to debug in `artifact`.");
      return undefined;
    }
    const root = launch.project
      ? path.resolve(targetFolder.uri.fsPath, launch.project)
      : (this.workspace.projectsIn(targetFolder)[0]?.root ?? targetFolder.uri.fsPath);
    const project = this.workspace.projectAt(root);
    if (!project) {
      void vscode.window.showWarningMessage(`Elide: project ${root} is not synced; run 'Elide: Sync Project(s)'.`);
      return undefined;
    }

    const settings = readConfig(targetFolder);
    const attachType = await resolveAttachType(settings);
    if (!attachType) return undefined;
    const name = typeof launch.name === "string" && launch.name ? launch.name : `Elide: Debug ${launch.artifact}`;

    if (launch.port !== undefined) {
      // Nothing to build: the port is already forwarded, so the attach session is the whole of it.
      this.ui.log(`android debug: attaching with ${attachType} to port ${launch.port}`);
      const attached = await vscode.debug.startDebugging(targetFolder, {
        type: attachType,
        request: "attach",
        name,
        hostName: "127.0.0.1",
        port: launch.port,
      });
      if (!attached) void vscode.window.showErrorMessage(`Elide: could not attach ${attachType} debugger to port ${launch.port}.`);
      return undefined;
    }

    let dist;
    try {
      dist = resolveElideDistribution({ explicitHome: settings.home });
    } catch (e) {
      void vscode.window.showErrorMessage(`Elide: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
    const invocation = mergeElideInvocationOptions(configuredInvocation(settings, "build"), {
      args: [androidDebugTask(launch.artifact ?? "")],
      ...(launch.device ? { options: { [ANDROID_DEVICE_OPTION]: launch.device } } : {}),
    });
    const argv = elideInvocationArgs("build", invocation);
    this.ui.log(`android debug: ${dist.bin} ${argv.join(" ")} (cwd ${project.root})`);
    launchWithJdwp({ dist: dist.bin, argv, cwd: project.root, name, folder: targetFolder, attachType }, this.ui, this.sessions);
    // The real session is the attach started once the device's JVM is listening.
    return undefined;
  }
}
