import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import {
  LineSplitter,
  elideInvocationArgs,
  elideInvocationOptionsFrom,
  elideStringArrayFrom,
  killProcessTree,
  mergeElideInvocationOptions,
  resolveElideDistribution,
  type ElideCommand,
  type ElideInvocationOptions,
  type ElideOptionValue,
} from "@elide/ide-core";
import * as vscode from "vscode";
import { configuredInvocation, readConfig, type ElideConfig } from "./config.js";
import { jetBrainsDebuggerType } from "./jetbrains.js";
import type { ElideUi } from "./output.js";
import type { ElideWorkspace } from "./projects.js";

export const ELIDE_DEBUG_TYPE = "elide";
const JAVA_DEBUG_EXTENSION = "vscjava.vscode-java-debug";
/** Banner printed by the JDWP agent (`server=y`) once it is ready for a client. */
const JDWP_BANNER = /Listening for transport dt_socket at address:\s*(\d+)/;
/**
 * Subcommands with a JVM to attach to, and the session name each gets when the configuration leaves `name` empty.
 * `install` downloads dependencies: there is nothing to debug.
 */
const DEBUG_COMMANDS = {
  run: "Elide: Run (debug)",
  test: "Elide: Test (debug)",
  build: "Elide: Build (debug)",
} as const satisfies Partial<Record<ElideCommand, string>>;

type DebugCommand = keyof typeof DEBUG_COMMANDS;

interface ElideLaunchConfig extends vscode.DebugConfiguration {
  /** Subcommand to debug: `run` (the default), `test` or `build`. */
  command?: ElideCommand;
  /**
   * File, manifest script or entrypoint name `elide run` runs, as its first positional argument; empty lets Elide
   * resolve `entrypoint`/`jvm.main`. Only `run` and `test` take it — `build` takes `targets`.
   */
  entrypoint?: string;
  /** Build targets to debug (`run`, `jvm-test`, … — see `elide build --inspect`); `build` only. */
  targets?: string[];
  /** Arguments passed to the debugged program, after `--`. */
  args?: string[];
  /** Further positional arguments of the Elide command itself: test paths, for instance. */
  elideArgs?: string[];
  /** `-f NAME[=VALUE]` build flags. */
  flags?: string[];
  /** CLI options for the subcommand, e.g. `{ "no-cache": true, "test-name-pattern": "MyTest" }`. */
  options?: Record<string, ElideOptionValue>;
  project?: string;
  env?: Record<string, string>;
}

/** A complete Elide invocation to run under a JDWP agent; `argv` includes the debugger flag the CLI expects. */
export interface JdwpLaunch {
  /** Path to the Elide binary. */
  dist: string;
  argv: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
  /** Terminal and attach-session name. */
  name: string;
  folder: vscode.WorkspaceFolder;
  attachType: string;
  /** Receives every output line of the Elide process, as it arrives. */
  onLine?: (line: string, stderr: boolean) => void;
}

export interface JdwpSession {
  /** Settles with the exit code once the Elide process closes (`null` when it was signalled or never started). */
  exit: Promise<number | null>;
  /** Terminate the process tree and close the terminal. */
  cancel(): void;
}

/**
 * The JVM debugger to attach with, or `undefined` when none is usable (the user has been told why).
 *
 * `intellij` borrows the debugger the JetBrains Kotlin extension contributes; `java` needs Debugger for Java, and
 * offers to install it when it is missing.
 */
export async function resolveAttachType(settings: ElideConfig): Promise<string | undefined> {
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
  return attachType;
}

/**
 * Run an Elide subcommand in a pseudoterminal and attach the configured JVM debugger once the JDWP agent announces
 * the port it listens on.
 *
 * `argv` is complete, debugger flag included: Elide 1.5.3 only accepts a bare `--debugger` on `run`/`test` (JDWP
 * then binds 5005) and a `--debugger=<host>:<port>` option on build targets, so the caller owns that choice and the
 * launcher attaches to whatever port the banner reports.
 *
 * The Elide process is the one the user sees and kills; the attach session is bound to it through `sessions`, so
 * ending the debug session ends the process too.
 */
export function launchWithJdwp(launch: JdwpLaunch, ui: ElideUi, sessions: Map<string, ChildProcess>): JdwpSession {
  const writeEmitter = new vscode.EventEmitter<string>();
  const closeEmitter = new vscode.EventEmitter<number | void>();
  const { promise: exit, resolve: settle } = Promise.withResolvers<number | null>();
  let child: ChildProcess | undefined;
  let attached = false;
  let closed = false;

  const pty: vscode.Pseudoterminal = {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,
    open: () => {
      writeEmitter.fire(`\x1b[2m$ elide ${launch.argv.join(" ")}\x1b[0m\r\n`);
      child = spawn(launch.dist, launch.argv, {
        cwd: launch.cwd,
        env: { ...process.env, ...launch.env },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      const splitters = {
        stdout: new LineSplitter((line) => launch.onLine?.(line, false)),
        stderr: new LineSplitter((line) => launch.onLine?.(line, true)),
      };
      const onChunk = (chunk: Buffer, stderr: boolean) => {
        const text = chunk.toString("utf8");
        writeEmitter.fire(text.replace(/\r?\n/g, "\r\n"));
        if (launch.onLine) splitters[stderr ? "stderr" : "stdout"].push(text);
        if (!attached) {
          const m = JDWP_BANNER.exec(text);
          if (m?.[1] && child) {
            attached = true;
            void attach(Number(m[1]), launch, child, ui, sessions);
          }
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => onChunk(chunk, false));
      child.stderr?.on("data", (chunk: Buffer) => onChunk(chunk, true));
      child.once("error", (e) => {
        writeEmitter.fire(`\r\n\x1b[31mFailed to start elide: ${e.message}\x1b[0m\r\n`);
        closeEmitter.fire(1);
        settle(null);
      });
      child.once("close", (code) => {
        closed = true;
        splitters.stdout.flush();
        splitters.stderr.flush();
        writeEmitter.fire(`\r\n\x1b[2m[elide exited with code ${code ?? "signal"}]\x1b[0m\r\n`);
        if (!attached) {
          void vscode.window.showErrorMessage(`Elide exited with code ${code ?? "signal"} before opening a JDWP port.`, "Show Output").then((pick) => {
            if (pick === "Show Output") ui.output.show(true);
          });
        }
        settle(code);
      });
    },
    close: () => {
      if (child && !closed && child.pid !== undefined) killProcessTree(child.pid, "SIGTERM");
    },
    handleInput: (data) => {
      child?.stdin?.write(data.replace(/\r/g, "\n"));
    },
  };

  const terminal = vscode.window.createTerminal({ name: launch.name, pty });
  terminal.show(true);
  return {
    exit,
    cancel: () => {
      if (child && !closed && child.pid !== undefined) killProcessTree(child.pid, "SIGTERM");
      closed = true;
      closeEmitter.fire();
      settle(null);
    },
  };
}

async function attach(port: number, launch: JdwpLaunch, child: ChildProcess, ui: ElideUi, sessions: Map<string, ChildProcess>): Promise<void> {
  ui.log(`debug: JDWP listening on ${port}; attaching with ${launch.attachType}`);
  const config: vscode.DebugConfiguration = {
    type: launch.attachType,
    request: "attach",
    name: launch.name,
    hostName: "127.0.0.1",
    port,
    ...(launch.attachType === "java" ? {} : { timeout: 30_000 }),
  };
  const listener = vscode.debug.onDidStartDebugSession((session) => {
    if (session.name === launch.name && session.type === launch.attachType) {
      sessions.set(session.id, child);
      listener.dispose();
    }
  });
  const started = await vscode.debug.startDebugging(launch.folder, config);
  if (!started) {
    listener.dispose();
    ui.log("debug: attach session did not start");
    void vscode.window.showErrorMessage(`Elide: could not attach ${launch.attachType} debugger to port ${port}.`);
  }
}

/**
 * `elide` launch configurations run `elide <run|test|build> --debugger …` in a terminal, wait for the JDWP banner,
 * and start an attach session with the configured JVM debugger. Build flags, CLI options and the program's own
 * arguments come from the configuration, layered over `elide.flags` and `elide.<command>.options`. On `build` the
 * debugger flag is an option of the target task, so such a configuration names a target (`run`, `jvm-test`, …).
 * The provider never lets a session of type `elide` start itself.
 */
export class ElideDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  /** Attach sessions and the Elide process each of them owns; shared with every `launchWithJdwp` caller. */
  readonly sessions = new Map<string, ChildProcess>();

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
    const attachType = await resolveAttachType(settings);
    if (!attachType) return undefined;

    let dist;
    try {
      dist = resolveElideDistribution({ explicitHome: settings.home });
    } catch (e) {
      void vscode.window.showErrorMessage(`Elide: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }

    const requested = launch.command ?? "run";
    if (!(requested in DEBUG_COMMANDS)) {
      void vscode.window.showErrorMessage(`Elide: \`${requested}\` has no JVM to attach to; debug \`run\`, \`test\` or \`build\`.`);
      return undefined;
    }
    const command = requested as DebugCommand;
    const misplaced =
      command === "build"
        ? launch.entrypoint && "`entrypoint` is not a build argument; list the build targets in `targets`."
        : launch.targets?.length && "`targets` is a `build` field; name what `run` executes in `entrypoint`.";
    if (misplaced) {
      void vscode.window.showErrorMessage(`Elide: ${misplaced}`);
      return undefined;
    }
    const invocation = debugInvocation(settings, command, launch);
    // `--debugger` on `build` belongs to a target task (`run`, `jvm-test`, …), not to the build: with no target the
    // build assembles nothing, no agent starts, and the session would wait for a banner that never comes.
    if (command === "build" && !invocation.args?.length) {
      void vscode.window.showErrorMessage(
        "Elide: a `build` launch configuration needs at least one target in `targets` — `elide build --inspect` lists them (for instance `run` or `jvm-test`).",
      );
      return undefined;
    }
    const argv = elideInvocationArgs(command, invocation);
    const name = typeof launch.name === "string" && launch.name ? launch.name : DEBUG_COMMANDS[command];
    this.ui.log(`debug: ${dist.bin} ${argv.join(" ")} (cwd ${projectRoot})`);
    launchWithJdwp(
      { dist: dist.bin, argv, cwd: projectRoot, env: invocation.env, name, folder: targetFolder, attachType },
      this.ui,
      this.sessions,
    );
    // The real session is the attach started once the JVM is listening; never start a session of type `elide`.
    return undefined;
  }
}

/**
 * The invocation a launch configuration describes: the configured defaults for its subcommand, then what the
 * subcommand acts on (the `run` entrypoint, or the `build` targets), then the configuration's own fields, each key
 * overriding the layer below it.
 *
 * `--debugger` is what makes the run debuggable, so it is always present: a configured value (`dap`, `cdp`, an
 * address) is kept, and anything else falls back to the bare flag the JDWP agent needs.
 */
function debugInvocation(settings: ElideConfig, command: ElideCommand, launch: ElideLaunchConfig): ElideInvocationOptions {
  const subject = command === "build" ? elideStringArrayFrom(launch.targets) : launch.entrypoint ? [launch.entrypoint] : [];
  const requested = mergeElideInvocationOptions(
    configuredInvocation(settings, command),
    { args: subject },
    elideInvocationOptionsFrom({
      args: launch.elideArgs,
      flags: launch.flags,
      options: launch.options,
      programArgs: launch.args,
      env: launch.env,
    }),
  );
  const configured = requested.options?.debugger;
  return {
    ...requested,
    options: { ...requested.options, debugger: configured === undefined || configured === false ? true : configured },
  };
}
