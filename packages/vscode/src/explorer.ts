import path from "node:path";
import {
  ElideCli,
  LIBRARY_NAME_PREFIX,
  resolveElideDistribution,
  type BuildTaskInfo,
  type ElideCommand,
  type Entrypoint,
  type ModuleModel,
  type SourceRootKind,
} from "@elide/ide-core";
import * as vscode from "vscode";
import { readConfig } from "./config.js";
import type { ElideUi } from "./output.js";
import type { ElideProject, ElideWorkspace } from "./projects.js";
import { entrypointArgs } from "./tasks.js";

export const PROJECTS_VIEW_ID = "elide.projects";

/** The fixed sections of a project, plus the lazily loaded build targets nested under `Tasks`. */
type GroupKind = "entrypoints" | "tasks" | "buildTargets" | "sourceSets" | "dependencies";

const GROUP_LABELS: Record<GroupKind, string> = {
  entrypoints: "Entrypoints",
  tasks: "Tasks",
  buildTargets: "Build targets",
  sourceSets: "Source sets",
  dependencies: "Dependencies",
};

const GROUP_ICONS: Record<GroupKind, string> = {
  entrypoints: "rocket",
  tasks: "tools",
  buildTargets: "list-tree",
  sourceSets: "folder-library",
  dependencies: "library",
};

/** Tasks offered for every project, whether or not its model has been resolved yet. */
const PROJECT_TASKS: ElideCommand[] = ["build", "test", "install"];

/**
 * A row of the Elide sidebar.
 *
 * The command-carrying kinds are shaped like the argument `elide.run`/`elide.debug`/`elide.executeTask` accept
 * (`root`, `args`, and for tasks `command`), so a node can be handed to those commands unchanged — that is what the
 * inline buttons of `view/item/context` pass.
 */
export type ElideNode =
  | { kind: "project"; label: string; root: string }
  | { kind: "group"; label: string; root: string; group: GroupKind }
  | { kind: "entrypoint"; label: string; root: string; args: string[]; script: boolean }
  | { kind: "task"; label: string; root: string; command: ElideCommand; args: string[] }
  | { kind: "buildTarget"; label: string; root: string; command: ElideCommand; args: string[]; description: string; debuggable: boolean }
  | { kind: "module"; label: string; root: string; module: ModuleModel }
  | { kind: "sourceRoot"; label: string; root: string; module: string; path: string; sourceKind: SourceRootKind }
  | { kind: "library"; label: string; root: string; classes: string; attached: string }
  | { kind: "message"; label: string };

/** What `activate` exposes for the extension-host integration test. */
export interface ElideExplorerApi {
  getChildren(node?: unknown): Promise<unknown[]>;
}

/**
 * The **Elide** activity-bar tree: one node per project with its entrypoints, tasks, source sets and dependencies.
 *
 * Everything but the build targets comes from the project model the sync already resolved, so expanding the tree
 * never shells out; `elide build --inspect` runs on first expansion of `Build targets` and is cached until the next
 * model change.
 */
export class ElideProjectsView implements vscode.TreeDataProvider<ElideNode>, ElideExplorerApi, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ElideNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];
  /** `elide build --inspect` results per project root, dropped whenever the project model changes. */
  private readonly buildTargets = new Map<string, BuildTaskInfo[]>();

  constructor(
    private readonly workspace: ElideWorkspace,
    private readonly ui: ElideUi,
  ) {
    this.subscriptions = [
      workspace.onDidChange(() => {
        this.buildTargets.clear();
        this.changed.fire(undefined);
      }),
    ];
  }

  dispose(): void {
    for (const d of this.subscriptions) d.dispose();
    this.changed.dispose();
  }

  getTreeItem(node: ElideNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, collapsibleState(node));
    item.contextValue = contextValueOf(node);
    const id = nodeId(node);
    if (id) item.id = id;
    switch (node.kind) {
      case "project": {
        const project = this.workspace.projectAt(node.root);
        item.iconPath = new vscode.ThemeIcon("package");
        item.description = project?.model ? `elide ${project.model.elideVersion}` : "not synced";
        item.tooltip = node.root;
        break;
      }
      case "group":
        item.iconPath = new vscode.ThemeIcon(GROUP_ICONS[node.group]);
        break;
      case "entrypoint":
        item.iconPath = new vscode.ThemeIcon(node.script ? "terminal" : "play");
        item.command = { command: "elide.run", title: "Run", arguments: [node] };
        break;
      case "task":
        item.iconPath = new vscode.ThemeIcon("play");
        item.description = `elide ${[node.command, ...node.args].join(" ")}`;
        item.command = { command: "elide.executeTask", title: "Run", arguments: [node] };
        break;
      case "buildTarget":
        item.iconPath = new vscode.ThemeIcon("target");
        item.description = node.description;
        item.tooltip = node.debuggable ? `elide build ${node.label} [--debugger]` : `elide build ${node.label}`;
        item.command = { command: "elide.executeTask", title: "Build", arguments: [node] };
        break;
      case "module":
        item.iconPath = new vscode.ThemeIcon(node.module.kind === "test" ? "beaker" : "symbol-namespace");
        item.description = node.module.kind;
        break;
      case "sourceRoot":
        // `resourceUri` lets the active file icon theme draw the folder; the tree item still shows our label.
        item.resourceUri = vscode.Uri.file(node.path);
        item.iconPath = vscode.ThemeIcon.Folder;
        item.description = node.sourceKind;
        item.tooltip = node.path;
        item.command = { command: "revealInExplorer", title: "Reveal", arguments: [item.resourceUri] };
        break;
      case "library":
        item.iconPath = new vscode.ThemeIcon("file-zip");
        item.description = node.attached;
        item.tooltip = node.classes;
        break;
      case "message":
        item.iconPath = new vscode.ThemeIcon("warning");
        break;
    }
    return item;
  }

  async getChildren(node?: ElideNode): Promise<ElideNode[]> {
    if (!node) return this.workspace.projects.map((p) => projectNode(p));
    switch (node.kind) {
      case "project":
        return this.projectGroups(node.root);
      case "group":
        return await this.groupChildren(node);
      case "module":
        return node.module.contentRoots.flatMap((content) =>
          content.sourceRoots.map((sourceRoot) => ({
            kind: "sourceRoot" as const,
            label: path.relative(node.root, sourceRoot.path) || ".",
            root: node.root,
            module: node.module.name,
            path: sourceRoot.path,
            sourceKind: sourceRoot.kind,
          })),
        );
      default:
        return [];
    }
  }

  /** A project without a model knows no entrypoints, source sets or libraries yet; its tasks still run. */
  private projectGroups(root: string): ElideNode[] {
    const groups: GroupKind[] = this.workspace.projectAt(root)?.model
      ? ["entrypoints", "tasks", "sourceSets", "dependencies"]
      : ["tasks"];
    return groups.map((group) => ({ kind: "group", label: GROUP_LABELS[group], root, group }));
  }

  private async groupChildren(node: Extract<ElideNode, { kind: "group" }>): Promise<ElideNode[]> {
    const project = this.workspace.projectAt(node.root);
    if (!project) return [];
    const model = project.model;
    switch (node.group) {
      case "entrypoints":
        return (model?.entrypoints ?? []).map((entrypoint) => entrypointNode(node.root, entrypoint));
      case "tasks":
        return [
          ...PROJECT_TASKS.map((command) => ({ kind: "task" as const, label: command, root: node.root, command, args: [] })),
          { kind: "group", label: GROUP_LABELS.buildTargets, root: node.root, group: "buildTargets" },
        ];
      case "buildTargets":
        return await this.buildTargetNodes(project);
      case "sourceSets":
        return (model?.modules ?? []).map((module) => ({ kind: "module", label: module.sourceSet, root: node.root, module }));
      case "dependencies":
        return [...(model?.libraries ?? [])]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((library) => ({
            kind: "library",
            label: library.name.startsWith(LIBRARY_NAME_PREFIX) ? library.name.slice(LIBRARY_NAME_PREFIX.length) : library.name,
            root: node.root,
            classes: library.classes,
            attached: [library.sources ? "sources" : undefined, library.javadoc ? "javadoc" : undefined].filter(Boolean).join(", "),
          }));
    }
  }

  private async buildTargetNodes(project: ElideProject): Promise<ElideNode[]> {
    let targets = this.buildTargets.get(project.root);
    if (!targets) {
      try {
        const settings = readConfig(project.folder);
        const dist = resolveElideDistribution({ explicitHome: settings.home });
        targets = await new ElideCli(dist, project.root, settings.flags).buildInspect();
        this.buildTargets.set(project.root, targets);
      } catch (e) {
        this.ui.log(`could not list build targets of ${project.root}: ${e instanceof Error ? e.message : String(e)}`);
        return [{ kind: "message", label: "could not list build targets — see Elide output" }];
      }
    }
    return targets.map((target) => ({
      kind: "buildTarget",
      label: target.name,
      root: project.root,
      command: "build",
      args: [target.name],
      description: target.description,
      // Only a target that starts a JVM declares `--debugger`; compilation targets have nothing to attach to.
      debuggable: target.options.some((option) => option.option === "--debugger"),
    }));
  }
}

function projectNode(project: ElideProject): ElideNode {
  return { kind: "project", label: project.model?.name ?? path.basename(project.root), root: project.root };
}

/**
 * `view/item/context` key. A script entrypoint offers no Debug action (a script is a shell command line), and a
 * build target only does when the target itself declares `--debugger`.
 */
function contextValueOf(node: ElideNode): string {
  if (node.kind === "entrypoint") return node.script ? "script" : node.kind;
  if (node.kind === "buildTarget" && node.debuggable) return "buildTargetDebuggable";
  return node.kind;
}

function entrypointNode(root: string, entrypoint: Entrypoint): ElideNode {
  return {
    kind: "entrypoint",
    label: entrypoint.value,
    root,
    args: entrypointArgs(entrypoint),
    // Scripts are shell commands the manifest declares: they run, but there is no JVM to attach a debugger to.
    script: entrypoint.kind === "script",
  };
}

function collapsibleState(node: ElideNode): vscode.TreeItemCollapsibleState {
  switch (node.kind) {
    case "project":
      return vscode.TreeItemCollapsibleState.Expanded;
    case "group":
    case "module":
      return vscode.TreeItemCollapsibleState.Collapsed;
    default:
      return vscode.TreeItemCollapsibleState.None;
  }
}

/** Stable per-row identity, so expansion survives a refresh and same-named rows of different projects never clash. */
function nodeId(node: ElideNode): string | undefined {
  switch (node.kind) {
    case "project":
      return `p:${node.root}`;
    case "group":
      return `g:${node.root}:${node.group}`;
    case "entrypoint":
      return `e:${node.root}:${node.label}`;
    case "task":
      return `t:${node.root}:${node.command}`;
    case "buildTarget":
      return `b:${node.root}:${node.label}`;
    case "module":
      return `m:${node.root}:${node.module.name}`;
    case "sourceRoot":
      return `s:${node.root}:${node.module}:${node.path}`;
    case "library":
      return `l:${node.root}:${node.label}`;
    case "message":
      return undefined;
  }
}
