import { spawn } from "node:child_process";
import path from "node:path";
import * as vscode from "vscode";
import type { KomodoDebugLaunch } from "./komodoLsp.js";

/** Where a debug session finds what Komodo's adapter runs with: the language server of the session's folder. */
export interface KomodoDebugTargets {
  komodoDebugLaunch(folder: vscode.WorkspaceFolder): Promise<KomodoDebugLaunch>;
}

/**
 * An executable override has no managed DAP identity. Negotiate the adapter's real initialize response before
 * exposing a debug target; neither --version (the Kotlin compiler version) nor an executable bit proves support.
 */
export async function requireKomodoDebugProtocol(launch: KomodoDebugLaunch, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const child = spawn(launch.launcher, ["--dap", "--project", launch.manifest], {
    cwd: path.dirname(launch.manifest),
    env: { ...process.env, ...(launch.javaHome ? { JAVA_HOME: launch.javaHome } : {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const initialized = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  child.once("close", () => exited.resolve());
  let buffered = Buffer.alloc(0);
  let stderr = "";
  const fail = (reason: string) => initialized.reject(new Error(`Komodo's DAP handshake failed: ${reason}. Fix elide.kotlinLsp.komodo.path or install a compatible Komodo, then sync again.`));
  const aborted = () => initialized.reject(signal?.reason ?? new Error("Komodo DAP handshake cancelled."));
  const timer = setTimeout(() => fail("no compatible initialize response within 10 seconds"), 10_000);
  child.once("error", (error) => fail(error.message));
  child.once("exit", (code) => fail(`adapter exited (${code ?? "signal"})${stderr ? `: ${stderr.trim()}` : ""}`));
  child.stdin.on("error", (error) => fail(error.message));
  child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4_096) stderr += chunk.toString().slice(0, 4_096 - stderr.length); });
  child.stdout.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length > 1_048_576) { fail("invalid initialize response"); return; }
    for (;;) {
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      const header = /^Content-Length:\s*(\d+)$/im.exec(buffered.subarray(0, end).toString());
      if (!header) { fail("missing DAP Content-Length"); return; }
      const size = Number(header[1]);
      if (size > 1_048_576) { fail("invalid initialize response length"); return; }
      if (buffered.length < end + 4 + size) return;
      const body = buffered.subarray(end + 4, end + 4 + size).toString();
      buffered = buffered.subarray(end + 4 + size);
      try {
        const response = JSON.parse(body) as { type?: string; request_seq?: number; command?: string; success?: boolean; body?: { supportsConfigurationDoneRequest?: boolean; supportsEvaluateForHovers?: boolean } };
        if (response.type !== "response" || response.request_seq !== 1) continue;
        if (response.command !== "initialize" || response.success !== true ||
          response.body?.supportsConfigurationDoneRequest !== true || response.body.supportsEvaluateForHovers !== true) {
          fail("adapter does not support initialization, configurationDone and Kotlin evaluation");
        } else initialized.resolve();
      } catch { fail("invalid DAP JSON"); }
    }
  });
  signal?.addEventListener("abort", aborted, { once: true });
  const request = JSON.stringify({ seq: 1, type: "request", command: "initialize", arguments: {
    adapterID: "komodo-kotlin", linesStartAt1: true, columnsStartAt1: true, pathFormat: "path",
  } });
  try {
    child.stdin.write(`Content-Length: ${Buffer.byteLength(request)}\r\n\r\n${request}`);
    if (signal?.aborted) aborted();
    await initialized.promise;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", aborted);
    // This probe never attaches a debuggee. EOF asks the adapter to dispose; kill also bounds old non-DAP images.
    child.stdin.end();
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited.promise;
  }
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
