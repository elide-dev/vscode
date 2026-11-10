import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { stripVTControlCharacters } from "node:util";
import {
  ElideFailureReport,
  LineSplitter,
  observeCommands,
  type CommandObserver,
  type ElideFailure,
  type ElideRecord,
  type TimelineNode,
} from "@elide/ide-core";
import * as vscode from "vscode";
import type { ElideActivity } from "./activity.js";
import { TaskProgressView } from "./taskProgressView.js";

interface TaskCommand {
  bin: string;
  cwd: string;
  argv: string[];
  env?: Record<string, string>;
}

interface TaskFailure {
  exitCode: number | undefined;
  failure: ElideFailure;
}

interface Launch {
  name: string;
  onFailure?: (failure: TaskFailure) => void;
}

type RunnerMessage =
  | { type: "start"; secret: string; label: string; argv: string[]; cwd: string; pid: number }
  | { type: "record"; record: ElideRecord }
  | { type: "line"; text: string; stderr: boolean }
  | { type: "end"; exitCode: number | null; durationMs: number; aborted: boolean };

/** Structured stderr from native process tasks; stdin/stdout stay attached to VS Code's actual task terminal. */
export class ElideTaskProgress implements vscode.Disposable {
  private readonly view: TaskProgressView;
  private readonly launches = new Map<string, Launch>();
  private readonly executions = new Map<number, vscode.TaskExecution>();
  private readonly cancelled = new Set<number>();
  private readonly sockets = new Set<Socket>();
  private readonly subscriptions: vscode.Disposable[];
  private server: Server | undefined;
  private listening: Promise<number> | undefined;
  private disposed = false;

  constructor(activity: ElideActivity, state: vscode.Memento, private readonly runnerPath: string) {
    this.view = new TaskProgressView(activity, state);
    this.subscriptions = [
      vscode.tasks.onDidStartTaskProcess(({ processId, execution }) => {
        const process = execution.task.execution;
        if (!(process instanceof vscode.ProcessExecution) || typeof process.args[2] !== "string" || !this.launches.has(process.args[2])) return;
        this.executions.set(processId, execution);
        if (this.cancelled.delete(processId)) execution.terminate();
      }),
      vscode.tasks.onDidEndTaskProcess(({ execution }) => {
        for (const [pid, candidate] of this.executions) {
          if (candidate === execution) {
            this.executions.delete(pid);
            this.cancelled.delete(pid);
          }
        }
      }),
    ];
  }

  /** A fresh connection represents each run, including VS Code's Rerun Last Task action. */
  async execution(name: string, command: TaskCommand, onFailure?: (failure: TaskFailure) => void): Promise<vscode.ProcessExecution> {
    const port = await this.listen();
    const secret = randomBytes(32).toString("hex");
    // Keep launch metadata while tasks can be rerun; it contains no process output or timeline history.
    this.launches.set(secret, { name, onFailure });
    const env = { ...command.env };
    const electronRunAsNode = env.ELECTRON_RUN_AS_NODE ?? process.env.ELECTRON_RUN_AS_NODE ?? null;
    return new vscode.ProcessExecution(process.execPath, [
      this.runnerPath, String(port), secret, name, command.bin, ...command.argv,
    ], {
      cwd: command.cwd,
      env: { ...env, ELECTRON_RUN_AS_NODE: "1", ELIDE_TASK_RUNNER_ELECTRON_RUN_AS_NODE: JSON.stringify(electronRunAsNode) },
    });
  }

  private listen(): Promise<number> {
    if (this.disposed) return Promise.reject(new Error("Elide task progress has been disposed."));
    if (this.listening) return this.listening;
    const { promise, resolve, reject } = Promise.withResolvers<number>();
    this.listening = promise;
    const server = this.server = createServer((socket) => this.accept(socket));
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Elide task progress could not open a local socket."));
        return;
      }
      resolve(address.port);
    });
    return promise;
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    let launch: Launch | undefined;
    let operation: TimelineNode | undefined;
    let observer: CommandObserver | undefined;
    let pid: number | undefined;
    let ended = false;
    const report = new ElideFailureReport();
    const started = performance.now();
    const handshake = setTimeout(() => socket.destroy(), 5_000);
    const cancel = () => {
      if (pid === undefined || ended) return;
      const execution = this.executions.get(pid);
      if (execution) execution.terminate();
      else this.cancelled.add(pid);
    };
    const finish = (outcome: { exitCode: number | null; durationMs: number; aborted: boolean }) => {
      if (ended) return;
      ended = true;
      if (pid !== undefined) this.cancelled.delete(pid);
      observer?.end(outcome);
      operation?.end(outcome.aborted ? "cancelled" : outcome.exitCode === 0 ? "succeeded" : "failed");
      if (!outcome.aborted && outcome.exitCode !== 0) launch?.onFailure?.({ exitCode: outcome.exitCode ?? undefined, failure: report.failure });
    };
    const lines = new LineSplitter((line) => {
      let message: RunnerMessage;
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== "object" || !("type" in value)) { socket.destroy(); return; }
        message = value as RunnerMessage;
      }
      catch { socket.destroy(); return; }
      if (!launch) {
        if (message.type !== "start" || typeof message.secret !== "string" || !(launch = this.launches.get(message.secret))
          || !Array.isArray(message.argv) || !message.argv.every((arg) => typeof arg === "string")
          || typeof message.cwd !== "string" || !Number.isSafeInteger(message.pid) || message.pid <= 0) { socket.destroy(); return; }
        clearTimeout(handshake);
        pid = message.pid;
        operation = this.view.start(`Task ${launch.name}`, { detail: message.cwd, cancel });
        observer = observeCommands(() => operation!)(message.argv, message.cwd);
        void this.view.reveal().catch((error: unknown) => operation?.log(`Could not show Task Progress: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      if (ended) return;
      switch (message.type) {
        case "record":
          report.record(message.record);
          observer?.record?.(message.record);
          break;
        case "line": {
          const text = stripVTControlCharacters(message.text);
          report.line(text);
          observer?.line?.(text, message.stderr);
          break;
        }
        case "end":
          finish(message);
          break;
        default:
          socket.destroy();
      }
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => lines.push(chunk));
    socket.on("error", () => { /* The close event settles a connected task, including extension shutdown. */ });
    socket.on("close", () => {
      clearTimeout(handshake);
      this.sockets.delete(socket);
      finish({ exitCode: null, durationMs: performance.now() - started, aborted: true });
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const execution of this.executions.values()) execution.terminate();
    for (const socket of this.sockets) socket.destroy();
    this.server?.close();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.executions.clear();
    this.cancelled.clear();
    this.launches.clear();
    this.view.dispose();
  }
}
