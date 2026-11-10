import { spawn, type ChildProcess } from "node:child_process";
import { Socket } from "node:net";
import { constants } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { parseElideRecord, renderElideRecord, type ElideRecord } from "@elide/ide-core";

const PREVIOUS_NODE_MODE = "ELIDE_TASK_RUNNER_ELECTRON_RUN_AS_NODE";
const CONNECT_TIMEOUT_MS = 5_000;
const TERMINATION_GRACE_MS = 5_000;
const FLUSH_TIMEOUT_MS = 1_000;

type ProgressMessage =
  | { type: "start"; secret: string; label: string; argv: string[]; cwd: string; pid: number }
  | { type: "record"; record: ElideRecord }
  | { type: "line"; text: string; stderr: boolean }
  | { type: "end"; exitCode: number | null; durationMs: number; aborted: boolean };

/** Only JSON candidates wait for a newline; ordinary stderr, including prompts, is displayed immediately. */
class TaskStderr {
  private pending = "";
  private mode: "start" | "record" | "text" = "start";

  constructor(
    private readonly terminal: (text: string) => void,
    private readonly send: (message: ProgressMessage) => void,
    private readonly color: boolean,
  ) {}

  push(chunk: string): void {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      const part = chunk.slice(start, newline < 0 ? undefined : newline);
      if (this.mode === "start" && part.length > 0) this.mode = part.startsWith("{") ? "record" : "text";
      this.pending += part;
      if (this.mode === "text") this.terminal(part);
      if (newline < 0) return;
      this.complete(true);
      start = newline + 1;
    }
  }

  flush(): void {
    if (this.pending.length > 0) this.complete(false);
  }

  private complete(newline: boolean): void {
    const text = this.pending.endsWith("\r") ? this.pending.slice(0, -1) : this.pending;
    const record = this.mode === "record" ? parseElideRecord(text) : undefined;
    if (record) {
      this.send({ type: "record", record });
      const style = this.color ? recordStyle(record) : undefined;
      for (const line of renderElideRecord(record)) {
        this.terminal(`${style && line ? `\x1b[${style}m${line}\x1b[0m` : line}\n`);
        this.line(line);
      }
    } else {
      if (this.mode !== "text") this.terminal(this.pending);
      if (newline) this.terminal("\n");
      this.line(text);
    }
    this.pending = "";
    this.mode = "start";
  }

  private line(text: string): void {
    this.send({ type: "line", text: stripVTControlCharacters(text).replace(/\r/g, ""), stderr: true });
  }
}

function recordStyle(record: ElideRecord): string | undefined {
  if (record.type === "task-finished") return record.outcome === "success" ? "32" : record.outcome === "failure" ? "31" : "2";
  if (record.type === "build-finished") return record.outcome === "success" ? "32" : "31";
  if (record.type === "message") return record.level === "error" ? "31" : record.level === "warning" ? "33" : record.level === "hint" ? "36" : undefined;
  return undefined;
}

interface ProcessInfo {
  pid: number;
  parent: number;
  group: number;
  born: string;
}

/** `detached` would take the CLI out of the terminal's foreground group and break interactive input. */
class TaskProcessTree {
  private known = new Map<number, string>();
  private ownedGroup = false;
  private groupSignalled = false;
  private stopping: NodeJS.Signals | undefined;
  private forced = false;
  private stopped = false;
  private warned = false;
  private readonly signalled = new Set<string>();
  private refreshing: Promise<void> | undefined;

  constructor(
    private readonly child: ChildProcess,
    private readonly env: NodeJS.ProcessEnv,
    private readonly warn: (text: string) => void,
  ) {}

  terminate(signal: NodeJS.Signals): void {
    this.stopping = signal;
    // Enumerate before signalling the launcher so its JVMs can still be discovered and tracked after reparenting.
    void this.refresh();
  }

  async force(): Promise<void> {
    this.forced = true;
    await this.refresh();
  }

  dispose(): void {
    this.stopped = true;
  }

  async waitForExit(): Promise<void> {
    while (!this.stopped) {
      await this.refresh();
      if (this.known.size === 0) return;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, process.platform === "win32" ? 500 : 100);
      await promise;
    }
  }

  private signalGroup(): void {
    if (!this.ownedGroup || this.groupSignalled || !this.stopping) return;
    this.groupSignalled = true;
    // The runner handles this signal itself. Never signal somebody else's foreground group.
    signalProcess(-process.pid, this.stopping);
  }

  private refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = processSnapshot(this.env).then((rows) => {
      if (this.stopped) return;
      this.ownedGroup = rows.some((row) => row.pid === process.pid && row.group === process.pid);
      const children = new Map<number, ProcessInfo[]>();
      for (const row of rows) {
        const siblings = children.get(row.parent);
        if (siblings) siblings.push(row);
        else children.set(row.parent, [row]);
      }
      const pending = rows.filter((row) => row.pid !== process.pid && (
        (row.pid === this.child.pid && this.child.exitCode === null && this.child.signalCode === null)
        || this.known.get(row.pid) === row.born
        || (this.ownedGroup && row.group === process.pid)
      ));
      const descendants = new Map<number, ProcessInfo>();
      for (let at = 0; at < pending.length; at++) {
        const row = pending[at]!;
        if (row.pid === process.pid || descendants.has(row.pid)) continue;
        descendants.set(row.pid, row);
        pending.push(...(children.get(row.pid) ?? []));
      }
      this.known = new Map([...descendants.values()].map((row) => [row.pid, row.born]));
      this.signalGroup();
      if (!this.stopping) return;
      // Descendants first: the launcher must not disappear before its JVM is signalled.
      for (const row of [...descendants.values()].reverse()) {
        const identity = `${row.pid}:${row.born}`;
        if (!this.forced && this.signalled.has(identity)) continue;
        this.signalled.add(identity);
        if (process.platform === "win32" && !this.forced) this.windowsTerminate(row.pid);
        else signalProcess(row.pid, this.forced ? "SIGKILL" : this.stopping);
      }
    }).catch((error: unknown) => {
      if (!this.stopping || this.stopped) return;
      if (!this.warned) {
        this.warned = true;
        this.warn(`Could not inspect the task process tree: ${errorText(error)}`);
      }
      if (this.child.pid !== undefined) signalProcess(this.child.pid, this.forced ? "SIGKILL" : this.stopping);
    }).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private windowsTerminate(pid: number): void {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t"], {
      env: this.env,
      stdio: "ignore",
      windowsHide: true,
    });
    const timer = setTimeout(() => killer.kill(), FLUSH_TIMEOUT_MS);
    killer.once("error", () => signalProcess(pid, "SIGTERM"));
    killer.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) signalProcess(pid, "SIGTERM");
    });
  }
}

function processSnapshot(env: NodeJS.ProcessEnv): Promise<ProcessInfo[]> {
  const { promise, resolve, reject } = Promise.withResolvers<ProcessInfo[]>();
  const windows = process.platform === "win32";
  const ps = windows
    ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} 0 - {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.Ticks }"],
    { env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true })
    : spawn("/bin/ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="], { env, stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  const timer = setTimeout(() => {
    ps.kill("SIGKILL");
    reject(new Error("process enumeration timed out"));
  }, windows ? CONNECT_TIMEOUT_MS : FLUSH_TIMEOUT_MS);
  ps.stdout.setEncoding("utf8").on("data", (text: string) => { output += text; });
  ps.once("error", (error) => { clearTimeout(timer); reject(error); });
  ps.once("close", (code) => {
    clearTimeout(timer);
    if (code !== 0) return reject(new Error(`process enumeration exited with code ${code}`));
    const rows: ProcessInfo[] = [];
    for (const line of output.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
      if (match && !match[4]!.startsWith("Z") && Number(match[1]) !== ps.pid) {
        rows.push({ pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), born: match[5]! });
      }
    }
    resolve(rows);
  });
  return promise;
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(pid, signal); } catch { /* Already exited. */ }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ELIDE_PROGRESS: "json" };
  const previous: unknown = JSON.parse(env[PREVIOUS_NODE_MODE] ?? "null");
  if (previous === null) delete env.ELECTRON_RUN_AS_NODE;
  else if (typeof previous === "string") env.ELECTRON_RUN_AS_NODE = previous;
  else throw new Error("Invalid saved ELECTRON_RUN_AS_NODE value");
  delete env[PREVIOUS_NODE_MODE];
  return env;
}

async function run(): Promise<void> {
  const [portText, secret, label, bin, ...argv] = process.argv.slice(2);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !secret || label === undefined || !bin) {
    throw new Error("Invalid Elide task runner arguments");
  }
  const env = childEnvironment();
  const startedAt = performance.now();
  const socket = new Socket();
  socket.setNoDelay(true);
  socket.resume();
  let connected = false;
  let ending = false;
  let transportLost = false;
  let terminalBroken = false;
  let terminalBlocked = false;
  let protocolBlocked = false;
  let aborted = false;
  let cancellationSignal: NodeJS.Signals | undefined;
  let child: ChildProcess | undefined;
  let tree: TaskProcessTree | undefined;
  let terminateTimer: NodeJS.Timeout | undefined;
  let closeTimer: NodeJS.Timeout | undefined;
  let settleChild: ((code: number | null, signal: NodeJS.Signals | null, force?: boolean) => void) | undefined;
  let exitCode: number | null = null;
  let taskExitCode = 1;

  const updateFlow = () => {
    if (aborted || (!terminalBlocked && !protocolBlocked)) child?.stderr?.resume();
    else child?.stderr?.pause();
  };
  const terminal = (text: string) => {
    if (!text || terminalBroken) return;
    if (!process.stderr.write(text)) { terminalBlocked = true; updateFlow(); }
  };
  const send = (message: ProgressMessage) => {
    if (!connected || ending || transportLost || socket.destroyed) return;
    if (!socket.write(`${JSON.stringify(message)}\n`)) { protocolBlocked = true; updateFlow(); }
  };
  const report = (text: string) => {
    const line = `Elide: ${text}`;
    terminal(`${line}\n`);
    send({ type: "line", text: stripVTControlCharacters(line), stderr: true });
  };
  const cancel = (signal: NodeJS.Signals) => {
    if (aborted || ending) return;
    aborted = true;
    cancellationSignal = signal;
    updateFlow();
    if (!connected) { socket.destroy(new Error("Task cancelled")); return; }
    if (!tree) return;
    tree.terminate(signal);
    terminateTimer = setTimeout(() => {
      void tree?.force().finally(() => {
        if (!settleChild) return;
        closeTimer = setTimeout(() => {
          child?.stderr?.destroy();
          child?.unref();
          settleChild?.(null, signal, true);
        }, FLUSH_TIMEOUT_MS);
      });
    }, TERMINATION_GRACE_MS);
  };
  const lostConnection = (error?: Error) => {
    if (!connected || ending || transportLost) return;
    transportLost = true;
    report(`Task progress connection lost${error ? `: ${error.message}` : "."}`);
    cancel("SIGTERM");
  };
  socket.on("error", lostConnection);
  socket.on("close", () => lostConnection());
  const onTerminalDrain = () => { terminalBlocked = false; updateFlow(); };
  const onTerminalError = () => { terminalBroken = true; cancel("SIGTERM"); };
  process.stderr.on("drain", onTerminalDrain);
  process.stderr.on("error", onTerminalError);
  socket.on("drain", () => { protocolBlocked = false; updateFlow(); });
  const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = signals.map((signal) => () => cancel(signal));
  signals.forEach((signal, index) => process.on(signal, handlers[index]!));

  try {
    const connection = Promise.withResolvers<void>();
    const timeout = setTimeout(() => socket.destroy(new Error("Task progress connection timed out")), CONNECT_TIMEOUT_MS);
    const fail = (error: Error) => { clearTimeout(timeout); connection.reject(error); };
    socket.once("error", fail);
    socket.connect(port, "127.0.0.1", () => {
      const start: ProgressMessage = { type: "start", secret, label, argv, cwd: process.cwd(), pid: process.pid };
      socket.write(`${JSON.stringify(start)}\n`, (error) => {
        clearTimeout(timeout);
        socket.off("error", fail);
        if (error) return connection.reject(error);
        connected = true;
        connection.resolve();
      });
    });
    await connection.promise;
    if (!aborted && !transportLost) {
      let noColor = env.NO_COLOR !== undefined;
      let forceColor = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0";
      for (const argument of argv) {
        if (argument === "--") break;
        if (argument === "--no-color") noColor = true;
        else if (argument === "--color") forceColor = true;
      }
      const color = !noColor && (forceColor || (env.FORCE_COLOR !== "0" && env.TERM !== "dumb" && Boolean(process.stderr.isTTY || process.stdout.isTTY)));
      const stderr = new TaskStderr(terminal, send, color);
      const header = `$ elide${argv.length ? ` ${argv.join(" ")}` : ""}`;
      terminal(color ? `\x1b[2m${header}\x1b[0m\n` : `${header}\n`);
      // stdin and stdout are the actual task terminal, not pipes or a replacement pseudoterminal.
      child = spawn(bin, argv, { cwd: process.cwd(), env, stdio: ["inherit", "inherit", "pipe"], windowsHide: false });
      tree = new TaskProcessTree(child, env, report);
      const completion = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
      let settled = false;
      let waitingForTree = false;
      let startError: number | undefined;
      const complete = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        settleChild = undefined;
        clearTimeout(terminateTimer);
        clearTimeout(closeTimer);
        tree?.dispose();
        stderr.flush();
        completion.resolve({ code: startError ?? code, signal });
      };
      settleChild = (code, signal, force = false) => {
        if (settled) return;
        if (!aborted || force) return complete(code, signal);
        if (waitingForTree) return;
        waitingForTree = true;
        void tree!.waitForExit().then(() => complete(code, signal));
      };
      child.stderr!.setEncoding("utf8").on("data", (text: string) => stderr.push(text));
      child.once("error", (error: NodeJS.ErrnoException) => {
        startError = error.code === "ENOENT" ? 127 : error.code === "EACCES" ? 126 : 1;
        report(`Could not start ${bin}: ${error.message}`);
      });
      child.once("close", (code, signal) => {
        // Terminal interrupts can reach the CLI before the runner; crash signals are failures, not cancellations.
        if (signal && !aborted && signals.includes(signal)) cancel(signal);
        settleChild?.(code, signal);
      });
      const result = await completion.promise;
      exitCode = result.signal ? null : result.code;
      taskExitCode = result.code ?? 128 + (constants.signals[cancellationSignal ?? result.signal ?? "SIGTERM"] ?? 15);
    }
  } catch (error: unknown) {
    if (!aborted) report(`Could not run task: ${errorText(error)}`);
    exitCode = aborted ? null : 1;
  } finally {
    clearTimeout(terminateTimer);
    clearTimeout(closeTimer);
    tree?.dispose();
    ending = true;
    if (connected && !transportLost && !socket.destroyed) {
      const end: ProgressMessage = { type: "end", exitCode, durationMs: performance.now() - startedAt, aborted };
      const flushed = Promise.withResolvers<void>();
      const timeout = setTimeout(finish, FLUSH_TIMEOUT_MS);
      function finish() { clearTimeout(timeout); socket.destroy(); flushed.resolve(); }
      socket.once("error", finish);
      socket.once("close", finish);
      socket.end(`${JSON.stringify(end)}\n`, finish);
      await flushed.promise;
    } else socket.destroy();
    signals.forEach((signal, index) => process.off(signal, handlers[index]!));
    process.stderr.off("drain", onTerminalDrain);
    // Keep the error listener through pending terminal writes so a closed terminal cannot crash cleanup.
    if (aborted && cancellationSignal) taskExitCode = 128 + (constants.signals[cancellationSignal] ?? 15);
    process.exitCode = taskExitCode;
  }
}

void run().catch((error: unknown) => {
  process.stderr.write(`Elide: ${errorText(error)}\n`);
  process.exitCode = 1;
});
