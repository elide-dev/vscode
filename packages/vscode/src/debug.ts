import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { killProcessTree, resolveElideDistribution } from "@elide/ide-core";
import * as vscode from "vscode";
import { readConfig } from "./config.js";
import { jetBrainsDebuggerType } from "./jetbrains.js";
import type { ElideUi } from "./output.js";
import type { ElideWorkspace } from "./projects.js";

export const ELIDE_DEBUG_TYPE = "elide";
const JAVA_DEBUG_EXTENSION = "vscjava.vscode-java-debug";
/** Banner printed by the JDWP agent (`server=y`) once it is ready for a client. */
const JDWP_BANNER = /Listening for transport dt_socket at address:\s*(\d+)/;

interface ElideLaunchConfig extends vscode.DebugConfiguration {
  entrypoint?: string;
  args?: string[];
  project?: string;
  env?: Record<string, string>;
}

/**
 * `elide` launch configurations run `elide run --debugger …` in a terminal, wait for the JDWP banner, and start an
 * attach session with the configured JVM debugger. The provider never lets a session of type `elide` start itself.
 */
export class ElideDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  private readonly sessions = new Map<string, ChildProcess>();

  constructor(
    private readonly workspace: ElideWorkspace,
    private readonly ui: ElideUi,
    subscriptions: vscode.Disposable[],
  ) {
    subscriptions.push(
      vscode.debug.onDidTerminateDebugSession((session) => {
        const child = this.sessions.get(session.id);
        if (!child) return;
        this.sessions.delete(session.id);
        if (child.exitCode === null && child.pid !== undefined) killProcessTree(child.pid, "SIGTERM");
      }),
    );
  }

  provideDebugConfigurations(): vscode.DebugConfiguration[] {
    return [{ type: ELIDE_DEBUG_TYPE, request: "launch", name: "Elide: Run (debug)" }];
  }

  async resolveDebugConfigurationWithSubstitutedVariables(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined> {
    const launch = config as ElideLaunchConfig;
    const targetFolder = folder ?? vscode.workspace.workspaceFolders?.[0];
    if (!targetFolder) {
      void vscode.window.showErrorMessage("Elide: open a workspace folder containing elide.pkl to debug.");
      return undefined;
    }
    const projectRoot = launch.project
      ? path.resolve(targetFolder.uri.fsPath, launch.project)
      : (this.workspace.projectsIn(targetFolder)[0]?.root ?? targetFolder.uri.fsPath);

    const settings = readConfig(targetFolder);
    const attachType = settings.debugAdapter === "java" ? "java" : jetBrainsDebuggerType();
    if (!attachType) {
      void vscode.window.showErrorMessage("Elide: the JetBrains Kotlin extension contributes no JVM debugger; set `elide.debug.adapter` to `java`.");
      return undefined;
    }
    if (attachType === "java" && !vscode.extensions.getExtension(JAVA_DEBUG_EXTENSION)) {
      const pick = await vscode.window.showErrorMessage("Elide: `elide.debug.adapter` is `java` but Debugger for Java is not installed.", "Install");
      if (pick === "Install") void vscode.commands.executeCommand("workbench.extensions.installExtension", JAVA_DEBUG_EXTENSION);
      return undefined;
    }

    let dist;
    try {
      dist = resolveElideDistribution({ explicitHome: settings.home });
    } catch (e) {
      void vscode.window.showErrorMessage(`Elide: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }

    const argv = ["run", "--debugger"];
    if (launch.entrypoint) argv.push(launch.entrypoint);
    if (launch.args?.length) argv.push("--", ...launch.args);

    const name = typeof launch.name === "string" && launch.name ? launch.name : "Elide: Run (debug)";
    this.ui.log(`debug: ${dist.bin} ${argv.join(" ")} (cwd ${projectRoot})`);
    void this.launch({ dist: dist.bin, argv, cwd: projectRoot, env: launch.env, name, folder: targetFolder, attachType });
    // The real session is the attach started once the JVM is listening; never start a session of type `elide`.
    return undefined;
  }

  private async launch(opts: {
    dist: string;
    argv: string[];
    cwd: string;
    env?: Record<string, string>;
    name: string;
    folder: vscode.WorkspaceFolder;
    attachType: string;
  }): Promise<void> {
    const writeEmitter = new vscode.EventEmitter<string>();
    const closeEmitter = new vscode.EventEmitter<number | void>();
    let child: ChildProcess | undefined;
    let attached = false;
    let closed = false;

    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      onDidClose: closeEmitter.event,
      open: () => {
        writeEmitter.fire(`\x1b[2m$ elide ${opts.argv.join(" ")}\x1b[0m\r\n`);
        child = spawn(opts.dist, opts.argv, {
          cwd: opts.cwd,
          env: { ...process.env, ...opts.env },
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
        const onChunk = (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          writeEmitter.fire(text.replace(/\r?\n/g, "\r\n"));
          if (!attached) {
            const m = JDWP_BANNER.exec(text);
            if (m?.[1]) {
              attached = true;
              void this.attach(Number(m[1]), opts, child!);
            }
          }
        };
        child.stdout?.on("data", onChunk);
        child.stderr?.on("data", onChunk);
        child.once("error", (e) => {
          writeEmitter.fire(`\r\n\x1b[31mFailed to start elide: ${e.message}\x1b[0m\r\n`);
          closeEmitter.fire(1);
        });
        child.once("close", (code) => {
          closed = true;
          writeEmitter.fire(`\r\n\x1b[2m[elide exited with code ${code ?? "signal"}]\x1b[0m\r\n`);
          if (!attached) {
            void vscode.window.showErrorMessage(`Elide exited with code ${code ?? "signal"} before opening a JDWP port.`, "Show Output").then((pick) => {
              if (pick === "Show Output") this.ui.output.show(true);
            });
          }
        });
      },
      close: () => {
        if (child && !closed && child.pid !== undefined) killProcessTree(child.pid, "SIGTERM");
      },
      handleInput: (data) => {
        child?.stdin?.write(data.replace(/\r/g, "\n"));
      },
    };
    const terminal = vscode.window.createTerminal({ name: opts.name, pty });
    terminal.show(true);
  }

  private async attach(port: number, opts: { name: string; folder: vscode.WorkspaceFolder; attachType: string }, child: ChildProcess): Promise<void> {
    this.ui.log(`debug: JDWP listening on ${port}; attaching with ${opts.attachType}`);
    const config: vscode.DebugConfiguration = {
      type: opts.attachType,
      request: "attach",
      name: opts.name,
      hostName: "127.0.0.1",
      port,
      ...(opts.attachType === "java" ? {} : { timeout: 30_000 }),
    };
    const listener = vscode.debug.onDidStartDebugSession((session) => {
      if (session.name === opts.name && session.type === opts.attachType) {
        this.sessions.set(session.id, child);
        listener.dispose();
      }
    });
    const started = await vscode.debug.startDebugging(opts.folder, config);
    if (!started) {
      listener.dispose();
      this.ui.log("debug: attach session did not start");
      void vscode.window.showErrorMessage(`Elide: could not attach ${opts.attachType} debugger to port ${port}.`);
    }
  }
}
