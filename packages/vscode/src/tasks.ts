import path from "node:path";
import { resolveElideDistribution, type Entrypoint } from "@elide/ide-core";
import * as vscode from "vscode";
import { readConfig } from "./config.js";
import type { ElideProject, ElideWorkspace } from "./projects.js";

export const ELIDE_TASK_TYPE = "elide";

export type ElideTaskCommand = "build" | "run" | "test" | "install";

export interface ElideTaskDefinition extends vscode.TaskDefinition {
  type: typeof ELIDE_TASK_TYPE;
  command: ElideTaskCommand;
  args?: string[];
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

export class ElideTaskProvider implements vscode.TaskProvider<vscode.Task> {
  constructor(private readonly workspace: ElideWorkspace) {}

  provideTasks(): vscode.Task[] {
    const tasks: vscode.Task[] = [];
    for (const project of this.workspace.projects) {
      const rel = path.relative(project.folder.uri.fsPath, project.root) || undefined;
      const base = (command: ElideTaskCommand, args: string[] = []): ElideTaskDefinition => ({ type: ELIDE_TASK_TYPE, command, ...(args.length ? { args } : {}), ...(rel ? { project: rel } : {}) });
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
    const dist = resolveElideDistribution({ explicitHome: readConfig(project.folder).home });
    const execution = new vscode.ProcessExecution(dist.bin, [def.command, ...(def.args ?? [])], { cwd: project.root });
    const task = new vscode.Task(def, project.folder, taskName, ELIDE_TASK_TYPE, execution);
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Shared, clear: true };
    return task;
  }
}
