import path from "node:path";
import * as vscode from "vscode";
import type { KomodoDebugLaunch } from "./komodoLsp.js";

/** Where a debug session finds what Komodo's adapter runs with: the language server of the session's folder. */
export interface KomodoDebugTargets {
  komodoDebugLaunch(folder: vscode.WorkspaceFolder): Promise<KomodoDebugLaunch>;
}

/**
 * The same native executable and resolved JDK inputs in DAP mode. DAP evaluates through JDWP, not the analysis
 * compiler, so compiler-plugin arguments belong to the language server rather than this adapter.
 */
export function komodoDebugAdapterExecutable(launch: KomodoDebugLaunch): vscode.DebugAdapterExecutable {
  return new vscode.DebugAdapterExecutable(launch.launcher, ["--dap", "--project", launch.manifest], {
    cwd: path.dirname(launch.manifest),
    // Merged over the extension host's environment by VS Code.
    env: {
      ...(launch.javaHome ? { JAVA_HOME: launch.javaHome } : {}),
    },
  });
}

/** Starts Komodo's adapter for `komodo-kotlin` sessions; a folder Komodo cannot debug fails the session, saying why. */
export class KomodoDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  constructor(private readonly targets: KomodoDebugTargets, private readonly log: (message: string) => void) {}

  async createDebugAdapterDescriptor(session: vscode.DebugSession): Promise<vscode.DebugAdapterDescriptor> {
    const folder = session.workspaceFolder;
    if (!folder) throw new Error("Elide: Komodo's debugger needs a workspace folder on Komodo's language server.");
    const launch = await this.targets.komodoDebugLaunch(folder);
    this.log(`debug: ${launch.launcher} --dap --project ${launch.manifest}${launch.javaHome ? ` (JAVA_HOME=${launch.javaHome})` : ""}`);
    return komodoDebugAdapterExecutable(launch);
  }
}
