import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ElideCli,
  LIBRARY_NAME_PREFIX,
  androidFeatureTask,
  buildTasksOf,
  currentAndroidDeviceTargets,
  isAndroidDeviceTask,
  isNativeImageBinary,
  parseManifestArtifacts,
  resolveElideDistribution,
  unqualifiedTaskName,
  type AndroidArtifactKind,
  type AndroidDeviceTargets,
  type AndroidTargetModel,
  type BuildTaskInfo,
  type ElideCommand,
  type Entrypoint,
  type ManifestArtifact,
  type ModuleModel,
  type SourceRootKind,
} from "@elide/ide-core";
import * as vscode from "vscode";
import { androidSdkFor, attachedDevices } from "./android.js";
import { androidEmulatorOwners, androidToolsProject } from "./androidDeploymentState.js";
import { readConfig } from "./config.js";
import { onDidEndDebugRun } from "./debug.js";
import type { ElideUi } from "./output.js";
import type { ElideProject, ElideWorkspace } from "./projects.js";
import { TargetShortcuts, type ShortcutKind, type TargetRef } from "./targetShortcuts.js";
import { entrypointArgs } from "./tasks.js";

export const PROJECTS_VIEW_ID = "elide.projects";

/**
 * The fixed sections of a project, plus the lazily loaded build targets and Android devices nested under them. A
 * workspace tree's devices and Android tools are one `androidTools` section of its top-level row, not one per member.
 * `pinned` and `frequent` sit above every project: the targets pinned, and the ones run from the sidebar most often.
 */
type GroupKind = "pinned" | "frequent" | "entrypoints" | "android" | "androidTools" | "androidDevices" | "tasks" | "buildTargets" | "sourceSets" | "dependencies";

const GROUP_LABELS: Record<GroupKind, string> = {
  pinned: "Pinned",
  frequent: "Frequently used",
  entrypoints: "Entrypoints",
  android: "Android",
  androidTools: "Android devices & tools",
  androidDevices: "Devices",
  tasks: "Tasks",
  buildTargets: "Build targets",
  sourceSets: "Source sets",
  dependencies: "Dependencies",
};

const GROUP_ICONS: Record<GroupKind, string> = {
  pinned: "pinned",
  frequent: "history",
  entrypoints: "rocket",
  android: "device-mobile",
  androidTools: "remote-explorer",
  androidDevices: "plug",
  tasks: "tools",
  buildTargets: "list-tree",
  sourceSets: "folder-library",
  dependencies: "library",
};

/** Rows of the `frequent` section: the most used targets that are not pinned. */
const FREQUENT_LIMIT = 5;

/** Tasks offered for every project, whether or not its model has been resolved yet. */
const PROJECT_TASKS: ElideCommand[] = ["build", "test", "install"];

/**
 * A row of the Elide sidebar.
 *
 * The command-carrying kinds are shaped like the argument `elide.run`/`elide.debug`/`elide.executeTask` accept
 * (`root`, `args`, and for tasks `command`), so a node can be handed to those commands unchanged — that is what the
 * inline buttons of `view/item/context` pass. A target row repeated in the `pinned` or `frequent` section says which
 * in `shortcut`.
 */
export type ElideNode =
  | { kind: "project"; label: string; root: string; member: boolean }
  | { kind: "group"; label: string; root: string; group: GroupKind }
  | { kind: "buildTargetProject"; label: string; root: string }
  | { kind: "entrypoint"; label: string; root: string; args: string[]; script: boolean }
  | { kind: "task"; label: string; root: string; command: ElideCommand; args: string[]; shortcut?: ShortcutSection }
  | {
      kind: "buildTarget";
      label: string;
      root: string;
      command: ElideCommand;
      args: string[];
      description: string;
      debuggable: boolean;
      /** Set when the target is a Native Image binary: `elide.runArtifact` builds it and runs what it produced. */
      runnable: boolean;
      /**
       * Set when the target installs onto one device: `elide.androidRunDeviceTask` passes it the deployment target's
       * `--device`, instead of letting Elide pick whichever device is attached.
       */
      deviceBound: boolean;
      /** Output name the artifact declares, which decides the binary `elide.runArtifact` runs. */
      outputName?: string;
      shortcut?: ShortcutSection;
      /** Distinguish rows repeated in the workspace listing from the member's own section. */
      workspaceListing?: boolean;
    }
  | {
      kind: "androidTarget";
      label: string;
      root: string;
      /** Artifact key: the build target, and what `elide.androidRun` installs and launches. */
      artifact: string;
      targetKind: AndroidArtifactKind;
      /** `args` so the row can be handed to `elide.build` unchanged. */
      args: string[];
      description: string;
      /** What Elide lists for an APK — Run, Debug, instrumented tests — which decides the actions its row offers. */
      offers?: AndroidDeviceTargets;
      shortcut?: ShortcutSection;
    }
  /** The obfuscation mapping a minifying Android artifact publishes, beside the archive it belongs to. */
  | { kind: "androidMapping"; label: string; root: string; artifact: string; path: string; description: string }
  | { kind: "androidDevice"; label: string; root: string; device: string; description: string; ready: boolean; emulator: boolean }
  /**
   * An Android action of the shared devices & tools section. `bare` actions run as from the palette, choosing among
   * all of the workspace's Android projects; the others act for the project `root` names.
   */
  | { kind: "androidAction"; label: string; root: string; command: string; description: string; icon: string; bare?: boolean }
  | { kind: "module"; label: string; root: string; module: ModuleModel }
  | { kind: "sourceRoot"; label: string; root: string; module: string; path: string; sourceKind: SourceRootKind }
  | { kind: "library"; label: string; root: string; classes: string; attached: string }
  /** A pinned target its project no longer offers, or that cannot be listed now: `description` says which. */
  | { kind: "missingTarget"; label: string; root: string; target: TargetRef; description: string }
  | { kind: "message"; label: string };

type ShortcutSection = "pinned" | "frequent";
type TargetNode = Extract<ElideNode, { kind: ShortcutKind }>;

/** What `activate` exposes for the extension-host integration test. */
export interface ElideExplorerApi {
  getChildren(node?: unknown): Promise<unknown[]>;
}

/**
 * The **Elide** activity-bar tree: one node per project with its entrypoints, tasks, source sets and dependencies.
 * The members of an Elide workspace are nested under its root, after the root's own sections. Above the projects, the
 * targets pinned and the ones run most often from this tree; a run from the CLI, a code lens or the palette is not
 * counted.
 *
 * Everything but the build targets comes from the project model the sync already resolved, so expanding the tree
 * never shells out; `elide build --inspect` runs on first expansion of `Build targets` — or of a section above that
 * lists one — and is cached until the next model change. Inside a workspace the listing covers every project of the
 * build graph wherever it is run from, so it is read once for the whole workspace.
 */
export class ElideProjectsView implements vscode.TreeDataProvider<ElideNode>, ElideExplorerApi, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ElideNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];
  /** `elide build --inspect` tasks per workspace root (a standalone project's own), dropped when the model changes. */
  private readonly buildTasks = new Map<string, BuildTaskInfo[]>();
  private buildGeneration = 0;
  /** Artifacts declared by each project's manifest, per project root, dropped when the model changes. */
  private readonly artifacts = new Map<string, ManifestArtifact[]>();
  private readonly shortcuts: TargetShortcuts;
  /** The target rows this tree handed out: a command invoked with one of them was invoked from the tree. */
  private readonly issued = new WeakSet<TargetNode>();

  constructor(
    private readonly workspace: ElideWorkspace,
    private readonly ui: ElideUi,
    state: vscode.Memento,
  ) {
    this.shortcuts = new TargetShortcuts(state);
    this.subscriptions = [
      workspace.onDidChange(() => {
        this.buildTasks.clear();
        this.buildGeneration++;
        this.artifacts.clear();
        this.changed.fire(undefined);
      }),
      workspace.onDidChangeKomodoAvailability(() => this.changed.fire(undefined)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("elide.debug.adapter")) this.changed.fire(undefined);
      }),
      // Extension tasks can change without a manifest edit. Helpers imported by an extension count too;
      // invalidate lazily rather than re-syncing JVM dependencies on every script save.
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.scheme !== "file" || !/\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/.test(document.uri.fsPath)) return;
        const project = workspace.projectFor(document.uri.fsPath);
        if (!project) return;
        this.buildTasks.delete(project.workspaceRoot ?? project.root);
        this.buildGeneration++;
        this.changed.fire(undefined);
      }),
      vscode.commands.registerCommand("elide.androidRefreshDevices", () => this.changed.fire(undefined)),
      vscode.commands.registerCommand("elide.pinTarget", (node: unknown) => this.editShortcuts(node, (target) => this.shortcuts.pin(target))),
      vscode.commands.registerCommand("elide.unpinTarget", (node: unknown) => this.editShortcuts(node, (target) => this.shortcuts.unpin(target))),
      vscode.commands.registerCommand("elide.forgetFrequentTarget", (node: unknown) => this.editShortcuts(node, (target) => this.shortcuts.forget(target))),
      vscode.commands.registerCommand("elide.clearFrequentTargets", async () => {
        await this.shortcuts.clearUsage();
        this.changed.fire(undefined);
      }),
      vscode.tasks.onDidEndTask((event) => {
        if (event.execution.task.source === "elide") this.changed.fire(undefined);
      }),
      // A debug run builds the APK, which can turn out not to be debuggable and withdraw its Debug action.
      onDidEndDebugRun(() => this.changed.fire(undefined)),
    ];
  }

  dispose(): void {
    for (const d of this.subscriptions) d.dispose();
    this.changed.dispose();
  }

  /**
   * Count a run of a target for the `frequent` section, when `value` — the argument of the command that runs it — is
   * a row of this tree: its own click or inline action. Anything else, a code lens or the palette, is not counted.
   */
  recordUse(value: unknown): void {
    if (typeof value !== "object" || value === null || !this.issued.has(value as TargetNode)) return;
    void this.shortcuts.record(targetRef(value as TargetNode)).then(() => this.changed.fire(undefined));
  }

  private async editShortcuts(value: unknown, edit: (target: TargetRef) => Promise<void>): Promise<void> {
    if (typeof value !== "object" || value === null) return;
    const node = value as ElideNode;
    const target = node.kind === "missingTarget" ? node.target : isTargetNode(node) ? targetRef(node) : undefined;
    if (!target) return;
    await edit(target);
    this.changed.fire(undefined);
  }

  getTreeItem(node: ElideNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, collapsibleState(node));
    item.contextValue = contextValueOf(node);
    if ((node.kind === "entrypoint" && !node.script) || (node.kind === "buildTarget" && node.debuggable && !node.runnable)) {
      const project = this.workspace.projectAt(node.root);
      if (project && !this.workspace.komodoDebugAvailable(project.folder)) {
        item.contextValue = node.kind === "entrypoint" ? "entrypointRunOnly" : "buildTarget";
      }
    }
    if (node.kind === "androidTarget" && node.offers?.debuggable) {
      const project = this.workspace.projectAt(node.root);
      if (project && !this.workspace.komodoDebugAvailable(project.folder)) item.contextValue = item.contextValue.replace(".debug", "");
    }
    item.contextValue += this.shortcutContext(node);
    const id = nodeId(node);
    if (id) item.id = id;
    switch (node.kind) {
      case "project": {
        const project = this.workspace.projectAt(node.root);
        const members = project?.model?.members.length ?? 0;
        item.iconPath = new vscode.ThemeIcon("package");
        // A member is synced with its root, which already names the Elide release; where it lives says more.
        if (project?.workspaceRoot) item.description = path.relative(project.workspaceRoot, project.root);
        else if (!project?.model) item.description = "not synced";
        else item.description = `elide ${project.model.elideVersion}${members > 0 ? ` · ${members} member${members === 1 ? "" : "s"}` : ""}`;
        item.tooltip = node.root;
        break;
      }
      case "group":
        item.iconPath = new vscode.ThemeIcon(GROUP_ICONS[node.group]);
        break;
      case "buildTargetProject":
        item.iconPath = new vscode.ThemeIcon("package");
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
        item.tooltip = node.deviceBound ? `elide build ${node.label} --device=<deployment target>`
          : node.debuggable ? `elide build ${node.label} [--debugger]` : `elide build ${node.label}`;
        item.command = node.deviceBound
          ? { command: "elide.androidRunDeviceTask", title: "Run on Deployment Target", arguments: [node] }
          : { command: "elide.executeTask", title: "Build", arguments: [node] };
        break;
      case "androidTarget":
        item.iconPath = new vscode.ThemeIcon(ANDROID_TARGET_ICONS[node.targetKind]);
        item.description = node.description;
        item.tooltip = `${node.description ? `${node.description}\n` : ""}elide build ${node.args.join(" ")}`
          + (node.offers && !node.offers.runnable && !node.offers.debuggable
            ? "\nNot installable: Elide lists no run or debug target for it (an unsigned APK, say)." : "");
        item.command = { command: "elide.build", title: "Build", arguments: [node] };
        break;
      case "androidMapping":
        // Publishing the mapping is a target of its own, so the row opens it and builds it first when it is absent.
        item.iconPath = new vscode.ThemeIcon("references");
        item.description = node.description;
        item.tooltip = node.path;
        item.command = { command: "elide.androidOpenMapping", title: "Open", arguments: [node] };
        break;
      case "androidDevice":
        item.iconPath = new vscode.ThemeIcon(node.ready ? "vm-running" : "vm-outline");
        item.description = node.description;
        item.tooltip = node.ready ? `${node.device} — ready to install` : `${node.device} — ${node.description}`;
        break;
      case "androidAction":
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.description = node.description;
        item.command = { command: node.command, title: node.label, arguments: node.bare ? [] : [node] };
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
      case "missingTarget":
        item.iconPath = new vscode.ThemeIcon("circle-slash");
        item.description = node.description;
        item.tooltip = `${node.label} (${node.root}): ${node.description}`;
        break;
      case "message":
        item.iconPath = new vscode.ThemeIcon("warning");
        break;
    }
    // The sections above the projects mix them; with more than one, each row says which it belongs to.
    if (((isTargetNode(node) && node.shortcut) || node.kind === "missingTarget") && this.workspace.projects.length > 1) {
      item.description = [this.workspace.projectAt(node.root)?.model?.name ?? path.basename(node.root), item.description].filter(Boolean).join(" · ");
    }
    return item;
  }

  /**
   * `.pinned` on a pinned target wherever it is shown, `.frequent` on a row of the `frequent` section: what decides
   * between its Pin, Unpin and Remove actions.
   */
  private shortcutContext(node: ElideNode): string {
    if (node.kind === "missingTarget") return ".pinned";
    if (!isTargetNode(node)) return "";
    if (this.shortcuts.isPinned(targetRef(node))) return ".pinned";
    return node.shortcut === "frequent" ? ".frequent" : "";
  }

  async getChildren(node?: ElideNode): Promise<ElideNode[]> {
    const children = await this.childrenOf(node);
    for (const child of children) if (isTargetNode(child)) this.issued.add(child);
    return children;
  }

  private async childrenOf(node?: ElideNode): Promise<ElideNode[]> {
    if (!node) return [...this.shortcutGroups(), ...this.workspace.projects.filter((p) => !p.workspaceRoot).map((p) => projectNode(p))];
    switch (node.kind) {
      case "project":
        return [...this.projectGroups(node.root), ...this.workspace.membersOf(node.root).map((p) => projectNode(p))];
      case "group":
        return await this.groupChildren(node);
      case "buildTargetProject": {
        const project = this.workspace.projectAt(node.root);
        return project ? await this.buildTargetNodes(project, node.label) : [];
      }
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

  /** The `pinned` and `frequent` sections, each while it has something to show. */
  private shortcutGroups(): ElideNode[] {
    const groups: ElideNode[] = [];
    if (this.shortcuts.pinned().length > 0) groups.push({ kind: "group", label: GROUP_LABELS.pinned, root: "", group: "pinned" });
    if (this.shortcuts.frequent().length > 0) groups.push({ kind: "group", label: GROUP_LABELS.frequent, root: "", group: "frequent" });
    return groups;
  }

  /** Every pinned target, as its project offers it now; one it no longer offers stays, saying why, until unpinned. */
  private async pinnedNodes(): Promise<ElideNode[]> {
    return await Promise.all(this.shortcuts.pinned().map(async (target): Promise<ElideNode> => {
      const node = await this.resolveTarget(target);
      return typeof node === "string"
        ? { kind: "missingTarget", label: target.name, root: target.root, target, description: node }
        : { ...node, shortcut: "pinned" };
    }));
  }

  /** The most used targets that are not pinned; one its project no longer offers is skipped, not shown. */
  private async frequentNodes(): Promise<ElideNode[]> {
    const nodes: ElideNode[] = [];
    for (const target of this.shortcuts.frequent()) {
      if (nodes.length === FREQUENT_LIMIT) break;
      const node = await this.resolveTarget(target);
      if (typeof node !== "string") nodes.push({ ...node, shortcut: "frequent" });
    }
    return nodes;
  }

  /** The row `target` names, as its project's sections list it now; or why there is none. */
  private async resolveTarget(target: TargetRef): Promise<TargetNode | string> {
    const project = this.workspace.projectAt(target.root);
    if (!project) return "project no longer in the workspace";
    switch (target.kind) {
      case "task": {
        const command = PROJECT_TASKS.find((task) => task === target.name);
        return command ? taskNode(target.root, command) : "no such task";
      }
      case "androidTarget": {
        if (!project.model) return "project not synced";
        const artifact = project.model.android?.targets.find((candidate) => candidate.name === target.name);
        return artifact ? androidTargetNode(target.root, artifact) : "no longer declared";
      }
      case "buildTarget": {
        let targets: TargetNode[];
        try {
          targets = await this.buildTargets(project);
        } catch (e) {
          this.ui.log(`could not list build targets of ${project.root}: ${e instanceof Error ? e.message : String(e)}`);
          return "could not list build targets — see Elide output";
        }
        return targets.find((candidate) => candidate.label === target.name) ?? "no longer a build target";
      }
    }
  }

  /**
   * A project without a model knows no entrypoints, source sets or libraries yet; its tasks still run. A section
   * with nothing under it is left out: a workspace root commonly declares members and no sources of its own. A
   * top-level row carries the one devices & tools section of its whole tree, acting for its first application.
   */
  private projectGroups(root: string): ElideNode[] {
    const project = this.workspace.projectAt(root);
    const model = project?.model;
    const groups: ElideNode[] = [];
    const group = (kind: GroupKind, owner = root) => groups.push({ kind: "group", label: GROUP_LABELS[kind], root: owner, group: kind });
    if (model && model.entrypoints.length > 0) group("entrypoints");
    if (model?.android && model.android.targets.length > 0) group("android");
    const tools = project && !project.workspaceRoot ? androidToolsProject([project, ...this.workspace.membersOf(root)]) : undefined;
    if (tools) group("androidTools", tools.root);
    group("tasks");
    if (model && model.modules.length > 0) group("sourceSets");
    if (model && model.libraries.length > 0) group("dependencies");
    return groups;
  }

  private async groupChildren(node: Extract<ElideNode, { kind: "group" }>): Promise<ElideNode[]> {
    if (node.group === "pinned") return await this.pinnedNodes();
    if (node.group === "frequent") return await this.frequentNodes();
    const project = this.workspace.projectAt(node.root);
    if (!project) return [];
    const model = project.model;
    switch (node.group) {
      case "entrypoints":
        return (model?.entrypoints ?? []).map((entrypoint) => entrypointNode(node.root, entrypoint));
      case "tasks":
        return [...PROJECT_TASKS.map((command) => taskNode(node.root, command)), { kind: "group", label: GROUP_LABELS.buildTargets, root: node.root, group: "buildTargets" }];
      case "buildTargets":
        return await this.buildTargetNodes(project);
      case "sourceSets":
        return (model?.modules ?? []).map((module) => ({ kind: "module", label: module.sourceSet, root: node.root, module }));
      case "android":
        return (model?.android?.targets ?? []).flatMap((target) => androidTargetNodes(node.root, target));
      case "androidTools": {
        const top = project.workspaceRoot ? this.workspace.projectAt(project.workspaceRoot) : project;
        return androidToolNodes(project, top ? [top, ...this.workspace.membersOf(top.root)] : [project]);
      }
      case "androidDevices":
        return await this.androidDeviceNodes(project);
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

  /** Mirror inspect's project groups and target order, including targets without descriptions. */
  private async buildTargetNodes(project: ElideProject, scope?: string): Promise<ElideNode[]> {
    let targets: Extract<ElideNode, { kind: "buildTarget" }>[];
    try {
      if (!scope && !project.workspaceRoot) {
        const tasks = await this.inspectBuild(project);
        const projects = [...new Set(tasks.flatMap((task) => task.project === undefined ? [] : [task.project]))];
        if (projects.length > 0) {
          return projects.map((label) => ({ kind: "buildTargetProject", label, root: project.root }));
        }
      }
      targets = await this.buildTargets(project, scope);
    } catch (e) {
      this.ui.log(`could not list build targets of ${project.root}: ${e instanceof Error ? e.message : String(e)}`);
      return [{ kind: "message", label: "could not list build targets — see Elide output" }];
    }
    return targets;
  }

  /** Every build target of the project, described or not. */
  private async buildTargets(project: ElideProject, scope?: string): Promise<Extract<ElideNode, { kind: "buildTarget" }>[]> {
    const tasks = await this.inspectBuild(project);
    const owner = scope ? [project, ...this.workspace.membersOf(project.root)]
      .find((member) => (member.model?.name ?? path.basename(member.root)) === scope) : undefined;
    if (owner) return (await this.buildTargets(owner)).map((target) => ({ ...target, workspaceListing: true }));
    // A build target takes the name of the artifact it produces, so the manifest says which ones are binaries.
    const images = new Map((await this.manifestArtifacts(project)).filter(isNativeImageBinary).map((a) => [a.name, a] as const));
    const name = scope ?? project.model?.name ?? path.basename(project.root);
    return buildTasksOf(tasks, name).map((target) => {
      const label = scope ? target.name : unqualifiedTaskName(target);
      const image = images.get(label);
      return {
        kind: "buildTarget",
        label,
        root: project.root,
        command: "build",
        args: [label],
        description: target.description,
        // Only a target that starts a JVM declares `--debugger`; compilation targets have nothing to attach to.
        debuggable: target.options.some((option) => option.option === "--debugger"),
        runnable: image !== undefined,
        deviceBound: isAndroidDeviceTask(target),
        ...(image?.outputName ? { outputName: image.outputName } : {}),
      };
    });
  }

  /**
   * Devices and emulators the project's SDK sees. There is no SDK on every machine and no `adb` in every SDK, and
   * neither is an error here: the rows say what is missing, and the Android targets report it properly when run.
   */
  private async androidDeviceNodes(project: ElideProject): Promise<ElideNode[]> {
    if (!androidSdkFor(project)) return [{ kind: "message", label: "no Android SDK found — set elide.android.sdk or ANDROID_HOME" }];
    try {
      const devices = await attachedDevices(project);
      if (!devices) return [{ kind: "message", label: "no adb in the SDK — install platform-tools" }];
      if (devices.length === 0) return [{ kind: "message", label: "no device attached — connect a device or start an emulator" }];
      return devices.map((device) => ({
        kind: "androidDevice",
        label: device.serial,
        root: project.root,
        device: device.serial,
        description: device.ready ? (device.emulator ? "emulator" : "device") :
          device.state === "unauthorized" ? "unauthorized — unlock device and accept USB debugging" : `${device.state} — reconnect device`,
        ready: device.ready,
        emulator: device.emulator,
      }));
    } catch (error) {
      this.ui.log(`Android device discovery: ${error instanceof Error ? error.message : String(error)}`);
      return [{ kind: "androidAction", label: "Device discovery failed", root: project.root,
        command: "elide.androidDoctor", description: "Check Android environment", icon: "warning" }];
    }
  }

  /** `elide build --inspect` of the workspace `project` belongs to, run in the workspace root and cached. */
  private async inspectBuild(project: ElideProject): Promise<BuildTaskInfo[]> {
    const root = project.workspaceRoot ?? project.root;
    const cached = this.buildTasks.get(root);
    if (cached) return cached;
    const settings = readConfig(project.folder);
    const generation = this.buildGeneration;
    const dist = resolveElideDistribution({ explicitHome: settings.home });
    const tasks = await new ElideCli(dist, root, settings.flags).buildInspect();
    if (generation === this.buildGeneration) this.buildTasks.set(root, tasks);
    return tasks;
  }

  /** Artifacts declared in the project's `elide.pkl`; an unreadable manifest simply declares none. */
  private async manifestArtifacts(project: ElideProject): Promise<ManifestArtifact[]> {
    const cached = this.artifacts.get(project.root);
    if (cached) return cached;
    let artifacts: ManifestArtifact[] = [];
    try {
      artifacts = parseManifestArtifacts(await readFile(project.manifestPath, "utf8"));
    } catch (e) {
      this.ui.log(`could not read ${project.manifestPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.artifacts.set(project.root, artifacts);
    return artifacts;
  }
}

function projectNode(project: ElideProject): ElideNode {
  return { kind: "project", label: project.model?.name ?? path.basename(project.root), root: project.root, member: project.workspaceRoot !== undefined };
}

function taskNode(root: string, command: ElideCommand): TargetNode {
  return { kind: "task", label: command, root, command, args: [] };
}

function isTargetNode(node: ElideNode): node is TargetNode {
  return node.kind === "task" || node.kind === "buildTarget" || node.kind === "androidTarget";
}

/** What the `pinned` and `frequent` sections remember of a target row. */
function targetRef(node: TargetNode): TargetRef {
  switch (node.kind) {
    case "task":
      return { kind: node.kind, root: node.root, name: node.command };
    case "buildTarget":
      return { kind: node.kind, root: node.root, name: node.label };
    case "androidTarget":
      return { kind: node.kind, root: node.root, name: node.artifact };
  }
}

/**
 * The devices & tools section of a workspace tree, shown once however many Android members it has: what is attached,
 * then the actions. `owner` is the project they act for; selection and logcat choose among all Android projects, as
 * from the palette. Each emulator row belongs to an application that declares its AVD; a library declares none it
 * could boot, so a library-only tree offers no emulator rows.
 */
function androidToolNodes(owner: ElideProject, tree: readonly ElideProject[]): ElideNode[] {
  const root = owner.root;
  const nodes: ElideNode[] = [
    { kind: "group", label: GROUP_LABELS.androidDevices, root, group: "androidDevices" },
    { kind: "androidAction", label: "Select deployment target", root, command: "elide.androidSelectTarget", description: "application and device for Run / Debug", icon: "device-mobile", bare: true },
    { kind: "androidAction", label: "Pair device over Wi-Fi", root, command: "elide.androidPairWireless", description: "QR code or pairing code", icon: "radio-tower" },
    { kind: "androidAction", label: "Check Android environment", root, command: "elide.androidDoctor", description: "SDK, tools and device readiness", icon: "checklist" },
    { kind: "androidAction", label: "Refresh devices", root, command: "elide.androidRefreshDevices", description: "discover connected devices", icon: "refresh" },
    { kind: "androidAction", label: "Show logcat", root, command: "elide.androidLogcat", description: "device and application logs", icon: "output", bare: true },
    { kind: "androidAction", label: "Explore databases", root, command: "elide.androidDatabase", description: "connected app's Room / SQLite data", icon: "database" },
  ];
  const emulators = androidEmulatorOwners(tree);
  for (const { avd, project } of emulators) {
    const description = emulators.length > 1 ? `${avd} · ${project.model?.name ?? path.basename(project.root)}` : avd;
    nodes.push(
      { kind: "androidAction", label: "Start emulator", root: project.root, command: "elide.androidStartEmulator", description, icon: "vm-running" },
      { kind: "androidAction", label: "Stop emulator", root: project.root, command: "elide.androidStopEmulator", description, icon: "vm-outline" },
      { kind: "androidAction", label: "Create AVD", root: project.root, command: "elide.androidCreateAvd", description, icon: "vm-connect" },
    );
  }
  if (!owner.model?.android?.sdkRoot) {
    nodes.push({ kind: "androidAction", label: "Install Android SDK components", root, command: "elide.androidInstallSdk", description: "sdkmanager --install", icon: "cloud-download" });
  }
  return nodes;
}

/**
 * The rows of one Android artifact: the target itself, and — when it minifies — the R8 mapping it publishes, which
 * is what a stack trace from a shrunk build is read with.
 */
function androidTargetNodes(root: string, target: AndroidTargetModel): ElideNode[] {
  const node = androidTargetNode(root, target);
  if (!target.mapping) return [node];
  return [
    node,
    {
      kind: "androidMapping",
      label: path.basename(target.mapping),
      root,
      artifact: target.name,
      path: target.mapping,
      description: "R8 mapping",
    },
  ];
}

function androidTargetNode(root: string, target: AndroidTargetModel): TargetNode {
  return {
    kind: "androidTarget",
    label: target.name,
    root,
    artifact: target.name,
    targetKind: target.kind,
    args: [target.kind === "feature" ? androidFeatureTask(target.name) : target.name],
    description: target.kind === "feature" ? `${target.delivery} → ${target.base}${target.featureDependencies?.length ? ` · requires: ${target.featureDependencies.join(", ")}` : ""}` :
      target.features?.length ? `${path.basename(target.output)} · features: ${target.features.join(", ")}` : path.basename(target.output),
    ...(target.device ? { offers: currentAndroidDeviceTargets(root, target) ?? target.device } : {}),
  };
}

/** Row icon and context value of each Android artifact: an installable package, an upload bundle, a library. */
const ANDROID_TARGET_ICONS: Record<AndroidArtifactKind, string> = { apk: "device-mobile", aab: "archive", aar: "package", feature: "extensions" };
const ANDROID_TARGET_CONTEXTS: Record<AndroidArtifactKind, string> = { apk: "androidApk", aab: "androidAab", aar: "androidAar", feature: "androidFeature" };

/**
 * `view/item/context` key. A member of a workspace takes no member of its own, so its row offers no such action; a
 * script entrypoint offers no Debug action (a script is a shell command line); a build target offers the JVM Debug
 * action only when it declares `--debugger`, the Run/Debug pair of a Native Image only when it is a binary one, and
 * runs on the deployment target when it installs onto a device. An APK row carries `.run`, `.debug` and `.test` for
 * the device targets Elide lists for it; only a device in the `device` state can take an install, and only an
 * emulator can be stopped. The view appends a target's pinned state (see `shortcutContext`), so menus match target
 * keys as prefixes.
 */
function contextValueOf(node: ElideNode): string {
  if (node.kind === "project") return node.member ? "projectMember" : "project";
  if (node.kind === "group" && (node.group === "android" || node.group === "androidTools" || node.group === "androidDevices" || node.group === "frequent")) return node.group;
  if (node.kind === "entrypoint") return node.script ? "script" : node.kind;
  if (node.kind === "buildTarget" && node.runnable) return "buildTargetRunnable";
  if (node.kind === "buildTarget" && node.deviceBound) return "buildTargetDevice";
  if (node.kind === "buildTarget" && node.debuggable) return "buildTargetDebuggable";
  if (node.kind === "androidTarget") {
    const offers = node.offers;
    const actions = offers ? [offers.runnable ? ".run" : "", offers.debuggable ? ".debug" : "", offers.instrumented ? ".test" : ""].join("") : "";
    return `${ANDROID_TARGET_CONTEXTS[node.targetKind]}${actions}`;
  }
  if (node.kind === "androidDevice") return `${node.emulator ? "androidEmulator" : "androidDevice"}${node.ready ? "" : "Unavailable"}`;
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
      // Members sit below their root's own sections: expanded, a workspace would bury them.
      return node.member ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded;
    case "group":
      // The sections above the projects are what the tree is opened for.
      return node.group === "pinned" || node.group === "frequent" ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
    case "buildTargetProject":
      return vscode.TreeItemCollapsibleState.Collapsed;
    case "module":
      return vscode.TreeItemCollapsibleState.Collapsed;
    default:
      return vscode.TreeItemCollapsibleState.None;
  }
}

/**
 * Stable per-row identity, so expansion survives a refresh and same-named rows of different projects never clash. A
 * target repeated in a section above the projects is a row of its own there.
 */
function nodeId(node: ElideNode): string | undefined {
  const id = ownNodeId(node);
  return id && isTargetNode(node) && node.shortcut ? `${node.shortcut}:${id}` : id;
}

function ownNodeId(node: ElideNode): string | undefined {
  switch (node.kind) {
    case "project":
      return `p:${node.root}`;
    case "group":
      return `g:${node.root}:${node.group}`;
    case "buildTargetProject":
      return `bp:${node.root}:${node.label}`;
    case "entrypoint":
      return `e:${node.root}:${node.label}`;
    case "task":
      // Several build tasks share one subcommand, so the arguments are part of the row's identity.
      return `t:${node.root}:${node.command}:${node.args.join(" ")}`;
    case "buildTarget":
      return `${node.workspaceListing ? "workspace:" : ""}b:${node.root}:${node.label}`;
    case "module":
      return `m:${node.root}:${node.module.name}`;
    case "sourceRoot":
      return `s:${node.root}:${node.module}:${node.path}`;
    case "library":
      return `l:${node.root}:${node.label}`;
    case "message":
      return undefined;
    case "androidTarget":
      return `a:${node.root}:${node.artifact}`;
    case "androidDevice":
      return `d:${node.root}:${node.device}`;
    case "androidAction":
      // The label too: a failed device discovery offers `elide.androidDoctor` beside the section's own row for it.
      return `x:${node.root}:${node.command}:${node.label}`;
    case "androidMapping":
      return `am:${node.root}:${node.artifact}`;
    case "missingTarget":
      return `pinned:missing:${node.target.kind}:${node.root}:${node.target.name}`;
  }
}
