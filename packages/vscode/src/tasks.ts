import { existsSync } from "node:fs";
import path from "node:path";
import {
  ElideCli,
  ElideCommandFailedError,
  ElideFailureReport,
  elideInvocationArgs,
  elideInvocationOptionsFrom,
  mergeElideInvocationOptions,
  resolveElideDistribution,
  type ElideCommand,
  type ElideDistribution,
  type ElideFailure,
  type ElideInvocationOptions,
  type Entrypoint,
  type RunOptions,
} from "@elide/ide-core";
import * as vscode from "vscode";
import { configuredInvocation, readConfig } from "./config.js";
import type { ElideProject, ElideWorkspace } from "./projects.js";

export const ELIDE_TASK_TYPE = "elide";

/**
 * One `elide` task. Beyond the subcommand it carries the whole invocation: positional `args` (build targets, test
 * paths, the entrypoint `run` runs), `-f` build `flags`, CLI `options`, `programArgs` passed after `--`, and `env`.
 * Workspace settings (`elide.flags`, `elide.<command>.options`) apply underneath and are overridden per key.
 */
export interface ElideTaskDefinition extends vscode.TaskDefinition, ElideInvocationOptions {
  type: typeof ELIDE_TASK_TYPE;
  command: ElideCommand;
  /** Project root relative to the workspace folder. */
  project?: string;
}

/** Argument vector `elide run …` takes for a manifest entrypoint (mirrors the IntelliJ plugin). */
export function entrypointArgs(entrypoint: Entrypoint): string[] {
  return entrypoint.kind === "jvmMain" ? [] : [entrypoint.value];
}

export function entrypointLabel(entrypoint: Entrypoint): string {
  return entrypoint.kind === "jvmMain" ? "run" : `run ${entrypoint.value}`;
}

/** The task definition `executeElideTask` runs for a project, before workspace settings are applied. */
function taskDefinition(project: ElideProject, command: ElideCommand, invocation: ElideInvocationOptions): { definition: ElideTaskDefinition; label: string } {
  const rel = path.relative(project.folder.uri.fsPath, project.root);
  return {
    definition: { type: ELIDE_TASK_TYPE, command, ...invocation, ...(rel ? { project: rel } : {}) },
    label: [command, ...(invocation.args ?? [])].join(" "),
  };
}

/** Run one `elide` task for a project, as if the user had picked it from the task list. */
export async function executeElideTask(
  workspace: ElideWorkspace,
  project: ElideProject,
  command: ElideCommand,
  invocation: ElideInvocationOptions = {},
  presentation?: vscode.TaskPresentationOptions,
): Promise<vscode.TaskExecution | undefined> {
  const { definition, label } = taskDefinition(project, command, invocation);
  const task = new ElideTaskProvider(workspace).resolveTask(new vscode.Task(definition, project.folder, label, ELIDE_TASK_TYPE));
  if (!task) return undefined;
  if (presentation) task.presentationOptions = { ...task.presentationOptions, ...presentation };
  return await vscode.tasks.executeTask(task);
}

/**
 * Run one `elide` task whose output the extension follows too. The task terminal shows the output and the `$elide`
 * problem matcher reads it as for any other task, while `onCommand` sees the process start, each line it prints and
 * its exit — what a caller needs to show the build's progress somewhere the terminal is not.
 *
 * `exitCode` settles when the process ends; `undefined` means it was terminated or never started.
 */
export async function executeObservedElideTask(
  project: ElideProject,
  command: ElideCommand,
  invocation: ElideInvocationOptions,
  presentation: vscode.TaskPresentationOptions,
  onCommand: NonNullable<RunOptions["onCommand"]>,
): Promise<{ execution: vscode.TaskExecution; exitCode: Promise<number | undefined> }> {
  const { definition, label } = taskDefinition(project, command, invocation);
  const elide = taskProcess(project, definition);
  const exit = Promise.withResolvers<number | undefined>();
  const rel = path.relative(project.folder.uri.fsPath, project.root);
  const task = new vscode.Task(definition, project.folder, `${label}${rel ? ` (${rel})` : ""}`, ELIDE_TASK_TYPE,
    new vscode.CustomExecution(async () => new ObservedElideTerminal(elide, onCommand, exit.resolve)), ["$elide"]);
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Shared, clear: true, ...presentation };
  // VS Code runs one instance of a task: executing it while an earlier run still holds its terminal — as one does
  // for CLOSE_DELAY_MS after its process exits — hands back that run, which then ends without this one starting.
  const key = JSON.stringify(definition);
  await Promise.all(vscode.tasks.taskExecutions
    .filter((running) => running.task.source === ELIDE_TASK_TYPE && JSON.stringify(running.task.definition) === key)
    .map((running) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      const subscription = vscode.tasks.onDidEndTask((e) => {
        if (e.execution !== running) return;
        subscription.dispose();
        resolve();
      });
      return promise;
    }));
  const execution = await vscode.tasks.executeTask(task);
  const ended = vscode.tasks.onDidEndTask((e) => {
    if (e.execution !== execution) return;
    ended.dispose();
    exit.resolve(undefined);
  });
  return { execution, exitCode: exit.promise };
}

interface TaskProcess {
  dist: ElideDistribution;
  cwd: string;
  argv: string[];
  env?: Record<string, string>;
}

/** What `elide` process a task definition stands for, with the workspace's configured defaults underneath. */
function taskProcess(project: ElideProject, def: ElideTaskDefinition): TaskProcess {
  const settings = readConfig(project.folder);
  // The definition comes from tasks.json: it is sanitized, and each of its keys overrides the configured default.
  const invocation = mergeElideInvocationOptions(configuredInvocation(settings, def.command), elideInvocationOptionsFrom(def));
  return {
    dist: resolveElideDistribution({ explicitHome: settings.home }),
    cwd: project.root,
    argv: elideInvocationArgs(def.command, invocation),
    ...(invocation.env ? { env: { ...invocation.env } } : {}),
  };
}

/** A task terminal running `elide` with piped output, so the extension sees every line the terminal shows. */
class ObservedElideTerminal implements vscode.Pseudoterminal {
  private readonly written = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.written.event;
  private readonly closed = new vscode.EventEmitter<number>();
  readonly onDidClose = this.closed.event;
  private readonly controller = new AbortController();

  constructor(
    private readonly elide: TaskProcess,
    private readonly onCommand: NonNullable<RunOptions["onCommand"]>,
    private readonly settle: (exitCode: number | undefined) => void,
  ) {}

  open(): void {
    const { dist, cwd, argv, env } = this.elide;
    this.written.fire(`> elide ${argv.join(" ")}\r\n`);
    void Promise.resolve()
      .then(() => new ElideCli(dist, cwd).run(argv, {
        signal: this.controller.signal,
        onCommand: this.onCommand,
        onLine: (line) => this.written.fire(`${withAbsoluteLocation(line, cwd)}\r\n`),
        // The terminal is read by a person and the `$elide` matcher, not as records; with piped output, `plain` is
        // the mode that still says which task started.
        env: { ELIDE_PROGRESS: "plain", ...env },
      }))
      .then(
        () => 0,
        (error: unknown) => {
          if (error instanceof ElideCommandFailedError) return error.exitCode ?? 1;
          if (!this.controller.signal.aborted) this.written.fire(`${error instanceof Error ? error.message : String(error)}\r\n`);
          return 1;
        },
      )
      .then((code) => {
        this.settle(this.controller.signal.aborted ? undefined : code);
        // The terminal parses what was written asynchronously, and the task's problem matcher stops reading when the
        // terminal closes: closing right after the last line loses the compiler errors that precede the verdict.
        setTimeout(() => this.closed.fire(code), CLOSE_DELAY_MS);
      });
  }

  close(): void {
    this.controller.abort(new Error("Elide task terminated"));
  }
}

const IN_FILE = /^In file:\s+(?:file:\/\/)?(\S+?)((?::\d+){0,2})\s*$/;
/** How long the terminal stays open after the process exits, for the problem matcher to read the last lines. */
const CLOSE_DELAY_MS = 500;

/**
 * `line`, with the relative path of an `In file:` location resolved against the task's directory. The `$elide`
 * problem matcher finds relative paths by searching the workspace folder, which VS Code does not do for a task it
 * does not run as a process itself; an absolute path needs no search.
 */
function withAbsoluteLocation(line: string, cwd: string): string {
  const match = IN_FILE.exec(line);
  if (!match || path.isAbsolute(match[1]!)) return line;
  const file = path.resolve(cwd, match[1]!);
  return existsSync(file) ? `In file: ${file}${match[2]}` : line;
}

/**
 * Exit code of a running task's process, once it ends. `undefined` means no process reported one: the task was
 * terminated, or it never started.
 */
export function taskExitCode(execution: vscode.TaskExecution): Promise<number | undefined> {
  const { promise, resolve } = Promise.withResolvers<number | undefined>();
  const subscriptions: vscode.Disposable[] = [];
  const settle = (code: number | undefined) => {
    for (const s of subscriptions) s.dispose();
    resolve(code);
  };
  // A process task fires `onDidEndTaskProcess` before `onDidEndTask`, so the exit code wins whenever there is one.
  subscriptions.push(
    vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution === execution) settle(e.exitCode);
    }),
    vscode.tasks.onDidEndTask((e) => {
      if (e.execution === execution) settle(undefined);
    }),
  );
  return promise;
}

/**
 * Run a program an Elide build produced, as a task of the project. Its terminal is a dedicated one: the build that
 * preceded it wrote to the shared Elide panel, and that log stays readable while the program runs.
 */
export async function executeProgramTask(project: ElideProject, label: string, program: string): Promise<vscode.TaskExecution> {
  const rel = path.relative(project.folder.uri.fsPath, project.root);
  const name = `${label}${rel ? ` (${rel})` : ""}`;
  const execution = new vscode.ProcessExecution(program, { cwd: project.root });
  const task = new vscode.Task({ type: "process", program }, project.folder, name, ELIDE_TASK_TYPE, execution);
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
  return await vscode.tasks.executeTask(task);
}

export class ElideTaskProvider implements vscode.TaskProvider<vscode.Task> {
  constructor(private readonly workspace: ElideWorkspace) {}

  provideTasks(): vscode.Task[] {
    const tasks: vscode.Task[] = [];
    for (const project of this.workspace.projects) {
      const rel = path.relative(project.folder.uri.fsPath, project.root) || undefined;
      const base = (command: ElideCommand, args: string[] = []): ElideTaskDefinition => ({ type: ELIDE_TASK_TYPE, command, ...(args.length ? { args } : {}), ...(rel ? { project: rel } : {}) });
      const build = this.createTask(project, base("build"));
      build.group = vscode.TaskGroup.Build;
      tasks.push(build);
      const test = this.createTask(project, base("test"));
      test.group = vscode.TaskGroup.Test;
      tasks.push(test);
      tasks.push(this.createTask(project, base("install")));
      for (const ep of project.model?.entrypoints ?? []) {
        tasks.push(this.createTask(project, base("run", entrypointArgs(ep)), entrypointLabel(ep)));
      }
    }
    return tasks;
  }

  resolveTask(task: vscode.Task): vscode.Task | undefined {
    const def = task.definition as Partial<ElideTaskDefinition>;
    if (def.type !== ELIDE_TASK_TYPE || !def.command) return undefined;
    const project = this.projectForDefinition(def, task.scope);
    if (!project) return undefined;
    return this.createTask(project, def as ElideTaskDefinition, undefined, task.name);
  }

  private projectForDefinition(def: Partial<ElideTaskDefinition>, scope: vscode.Task["scope"]): ElideProject | undefined {
    const folder = scope && typeof scope !== "number" ? scope : vscode.workspace.workspaceFolders?.[0];
    if (!folder) return undefined;
    const candidates = this.workspace.projectsIn(folder);
    if (def.project) {
      const root = path.resolve(folder.uri.fsPath, def.project);
      return candidates.find((p) => p.root === root) ?? { root, manifestPath: path.join(root, "elide.pkl"), folder };
    }
    return candidates[0] ?? { root: folder.uri.fsPath, manifestPath: path.join(folder.uri.fsPath, "elide.pkl"), folder };
  }

  /**
   * The task a definition stands for. With `onFailure` the extension runs the process itself, in a pseudoterminal,
   * and reports a failure with what Elide printed; a process task's output reaches only its terminal.
   */
  createTask(project: ElideProject, def: ElideTaskDefinition, label?: string, name?: string, onFailure?: (failed: ElideTaskFailure) => void): vscode.Task {
    const rel = path.relative(project.folder.uri.fsPath, project.root);
    const suffix = rel ? ` (${rel})` : "";
    const taskName = name ?? `${label ?? [def.command, ...(def.args ?? [])].join(" ")}${suffix}`;
    const elide = taskProcess(project, def);
    const execution = onFailure ? reportedExecution(taskName, elide, onFailure)
      : new vscode.ProcessExecution(elide.dist.bin, elide.argv, { cwd: elide.cwd, ...(elide.env ? { env: elide.env } : {}) });
    const task = new vscode.Task(def, project.folder, taskName, ELIDE_TASK_TYPE, execution, ["$elide"]);
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Shared, clear: true };
    return task;
  }
}

/** A task {@link executeReportedElideTask} ran that failed: what Elide said, and the terminal it said it in. */
export interface ElideTaskFailure {
  /** The task's name, which its terminal is titled with. */
  name: string;
  /** Elide's exit code; `undefined` when it could not be started. */
  exitCode: number | undefined;
  failure: ElideFailure;
  /** Bring the task's terminal forward. */
  reveal(): void;
}

/**
 * Run one `elide` task like {@link executeElideTask}, reporting a failure to `onFailure` with Elide's error and hint.
 * Its terminal shows Elide's plain-text progress (`ELIDE_PROGRESS=plain`) — the form it prints without a terminal of
 * its own — which the `$elide` problem matcher reads as before. VS Code ends it with `onDidEndTaskProcess` and the
 * exit code, as it does a process task.
 */
export async function executeReportedElideTask(
  workspace: ElideWorkspace,
  project: ElideProject,
  command: ElideCommand,
  invocation: ElideInvocationOptions,
  onFailure: (failed: ElideTaskFailure) => void,
): Promise<vscode.TaskExecution> {
  const { definition, label } = taskDefinition(project, command, invocation);
  return await vscode.tasks.executeTask(new ElideTaskProvider(workspace).createTask(project, definition, undefined, label, onFailure));
}

function reportedExecution(name: string, { dist, cwd, argv, env }: TaskProcess, onFailure: (failed: ElideTaskFailure) => void): vscode.CustomExecution {
  return new vscode.CustomExecution(async () => {
    const write = new vscode.EventEmitter<string>();
    const close = new vscode.EventEmitter<number>();
    const abort = new AbortController();
    const report = new ElideFailureReport();
    const run = async () => {
      write.fire(`\x1b[2m$ elide ${argv.join(" ")}\x1b[0m\r\n`);
      let exitCode: number | undefined = 0;
      try {
        await new ElideCli(dist, cwd).run(argv, {
          signal: abort.signal,
          env: { ELIDE_PROGRESS: "plain", ...env },
          onLine: (line) => {
            report.line(line);
            write.fire(`${line}\r\n`);
          },
        });
      } catch (error) {
        if (abort.signal.aborted) return;
        exitCode = error instanceof ElideCommandFailedError ? error.exitCode ?? 1 : undefined;
        if (exitCode === undefined) {
          const message = error instanceof Error ? error.message : String(error);
          report.line(`error: ${message}`);
          write.fire(`\x1b[31mFailed to start elide: ${message}\x1b[0m\r\n`);
        }
      }
      close.fire(exitCode ?? 1);
      if (exitCode !== 0) onFailure({ name, exitCode, failure: report.failure, reveal: () => revealTerminal(name) });
    };
    return { onDidWrite: write.event, onDidClose: close.event, open: () => void run(), close: () => abort.abort() };
  });
}

/** The terminal a task ran in, which VS Code titles with the task's name; else the terminal panel. */
export function revealTerminal(name: string): void {
  const terminal = vscode.window.terminals.find((candidate) => candidate.name.includes(name));
  if (terminal) terminal.show();
  else void vscode.commands.executeCommand("workbench.action.terminal.focus");
}
