import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { ANDROID_DEVICE_OPTION, androidDebugTask, elideInvocationArgs, elideInvocationOptionsFrom, mergeElideInvocationOptions, resolveElideDistribution, type ElideOptionValue } from "@elide/ide-core";
import * as vscode from "vscode";
import type { AndroidDeploymentController } from "./androidDeployment.js";
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
  /** Device serial to validate and pin; absent uses the shared Android deployment selection. */
  device?: string;
  /** Local port of a JDWP socket already forwarded off a device: attach to it, building and installing nothing. */
  port?: number;
  project?: string;
  flags?: string[];
  options?: Record<string, ElideOptionValue>;
  env?: Record<string, string>;
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
    private readonly deployments: AndroidDeploymentController,
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
    if ((typeof launch.artifact !== "string" || !launch.artifact) && launch.port === undefined) {
      void vscode.window.showErrorMessage("Elide: name the Android application package to debug in `artifact`.");
      return undefined;
    }
    if (launch.device !== undefined && (typeof launch.device !== "string" || !launch.device)) {
      void vscode.window.showErrorMessage("Elide: `device` must name a nonempty Android device serial.");
      return undefined;
    }
    let root: string | undefined;
    if (launch.project) {
      root = path.resolve(targetFolder.uri.fsPath, launch.project);
    } else if (launch.port !== undefined) {
      root = this.workspace.projectsIn(targetFolder)[0]?.root ?? targetFolder.uri.fsPath;
    } else {
      const candidates = this.workspace.projectsIn(targetFolder).filter((candidate) =>
        candidate.model?.android?.targets.some((target) => target.kind === "apk" && target.name === launch.artifact),
      );
      const editor = vscode.window.activeTextEditor;
      const owner = editor?.document.uri.scheme === "file" ? this.workspace.projectFor(editor.document.uri.fsPath) : undefined;
      root = candidates.find((candidate) => candidate === owner)?.root
        ?? candidates.find((candidate) => candidate.root === this.deployments.target?.root)?.root;
      if (!root) root = candidates.length === 1 ? candidates[0]?.root : (await vscode.window.showQuickPick(
        candidates.map((candidate) => ({ label: candidate.model?.name ?? candidate.root, description: candidate.root, root: candidate.root })),
        { placeHolder: `Android project declaring APK '${launch.artifact}'` },
      ))?.root;
      if (candidates.length === 0) void vscode.window.showErrorMessage(`Elide: '${launch.artifact}' is not an Android APK in any synced project in this folder.`);
      if (!root) return undefined;
    }
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

    if (!await vscode.workspace.saveAll(false)) return undefined;
    const deployment = await this.deployments.resolve({
      root: project.root,
      artifact: launch.artifact,
      ...(launch.device ? { device: launch.device } : {}),
    });
    if (!deployment) return undefined;

    let dist;
    try {
      dist = resolveElideDistribution({ explicitHome: settings.home });
    } catch (e) {
      void vscode.window.showErrorMessage(`Elide: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
    const device = await this.deployments.debugDevice(deployment);
    if (!device) return undefined;
    const invocation = mergeElideInvocationOptions(
      configuredInvocation(settings, "build"),
      elideInvocationOptionsFrom({ flags: launch.flags, options: launch.options, env: launch.env }),
      { args: [androidDebugTask(deployment.artifact)], options: { [ANDROID_DEVICE_OPTION]: device } },
    );
    const argv = elideInvocationArgs("build", invocation);
    this.ui.log(`android debug: ${dist.bin} ${argv.join(" ")} (cwd ${project.root})`);
    launchWithJdwp({ dist: dist.bin, argv, cwd: project.root, name, folder: targetFolder, attachType, ...(invocation.env ? { env: invocation.env } : {}) }, this.ui, this.sessions);
    // The real session is the attach started once the device's JVM is listening.
    return undefined;
  }
}
