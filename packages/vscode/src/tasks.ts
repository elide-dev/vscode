import path from "node:path";
import {
  elideInvocationArgs,
  elideInvocationOptionsFrom,
  mergeElideInvocationOptions,
  resolveElideDistribution,
  type ElideCommand,
  type ElideInvocationOptions,
  type Entrypoint,
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

/** Run one `elide` task for a project, as if the user had picked it from the task list. */
export async function executeElideTask(
  workspace: ElideWorkspace,
  project: ElideProject,
  command: ElideCommand,
  invocation: ElideInvocationOptions = {},
): Promise<vscode.TaskExecution | undefined> {
  const rel = path.relative(project.folder.uri.fsPath, project.root);
  const definition: ElideTaskDefinition = {
    type: ELIDE_TASK_TYPE,
    command,
    ...invocation,
    ...(rel ? { project: rel } : {}),
  };
  const label = [command, ...(invocation.args ?? [])].join(" ");
  const task = new ElideTaskProvider(workspace).resolveTask(new vscode.Task(definition, project.folder, label, ELIDE_TASK_TYPE));
  if (!task) return undefined;
  return await vscode.tasks.executeTask(task);
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

  private createTask(project: ElideProject, def: ElideTaskDefinition, label?: string, name?: string): vscode.Task {
    const rel = path.relative(project.folder.uri.fsPath, project.root);
    const suffix = rel ? ` (${rel})` : "";
    const taskName = name ?? `${label ?? [def.command, ...(def.args ?? [])].join(" ")}${suffix}`;
    const settings = readConfig(project.folder);
    const dist = resolveElideDistribution({ explicitHome: settings.home });
    // The definition comes from tasks.json: it is sanitized, and each of its keys overrides the configured default.
    const invocation = mergeElideInvocationOptions(configuredInvocation(settings, def.command), elideInvocationOptionsFrom(def));
    const execution = new vscode.ProcessExecution(dist.bin, elideInvocationArgs(def.command, invocation), {
      cwd: project.root,
      ...(invocation.env ? { env: { ...invocation.env } } : {}),
    });
    const task = new vscode.Task(def, project.folder, taskName, ELIDE_TASK_TYPE, execution, ["$elide"]);
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Shared, clear: true };
    return task;
  }
}
