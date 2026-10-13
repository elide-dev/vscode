import { TimelineNode, formatDuration, timelineBreakdown, type TimelineState } from "@elide/ide-core";
import * as vscode from "vscode";

export const ACTIVITY_VIEW_ID = "elide.activity";
const LOG_SCHEME = "elide-activity";
/** Finished operations kept in the view; running ones are never dropped. */
const MAX_OPERATIONS = 25;
const REFRESH_MS = 150;

const STATE_ICONS: Record<TimelineState, vscode.ThemeIcon> = {
  running: new vscode.ThemeIcon("loading~spin"),
  succeeded: new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed")),
  failed: new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed")),
  cancelled: new vscode.ThemeIcon("circle-slash"),
  skipped: new vscode.ThemeIcon("debug-step-over"),
};

/** What `activate` exposes of the Activity view for the extension-host integration test. */
export interface ElideActivityApi {
  /** Operations newest first, or the steps of one. */
  getChildren(node?: TimelineNode): TimelineNode[];
  provideTextDocumentContent(uri: vscode.Uri): string;
  uriOf(node: TimelineNode): vscode.Uri;
}

/**
 * What Elide is doing and has done in this window: syncs and preview builds, each a tree of the steps it went
 * through, every step with its duration and share of the whole, and the output it produced, readable as a log.
 *
 * The status bar and notifications only ever show the step in progress; this view is where a slow or failed
 * operation can be taken apart afterwards.
 */
export class ElideActivity implements vscode.TreeDataProvider<TimelineNode>, vscode.TextDocumentContentProvider, vscode.Disposable, ElideActivityApi {
  private readonly operations: TimelineNode[] = [];
  private readonly cancels = new Map<TimelineNode, () => void>();
  /** Stable per-operation prefix of tree item ids: node ids restart at zero in every operation. */
  private readonly serials = new Map<TimelineNode, number>();
  private serial = 0;
  private readonly treeChanged = new vscode.EventEmitter<TimelineNode | undefined>();
  readonly onDidChangeTreeData = this.treeChanged.event;
  private readonly documentChanged = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.documentChanged.event;
  private readonly operationChanged = new vscode.EventEmitter<TimelineNode>();
  /** An operation or one of its steps changed; fires at most every {@link REFRESH_MS}. */
  readonly onDidChangeOperation = this.operationChanged.event;
  private readonly dirty = new Set<TimelineNode>();
  private flushTimer: NodeJS.Timeout | undefined;
  /** Ticks the durations of running operations, which change without any event. */
  private ticker: NodeJS.Timeout | undefined;
  private readonly subscriptions: vscode.Disposable[];

  constructor() {
    this.subscriptions = [
      vscode.workspace.registerTextDocumentContentProvider(LOG_SCHEME, this),
      vscode.commands.registerCommand("elide.showActivity", () => vscode.commands.executeCommand(`${ACTIVITY_VIEW_ID}.focus`)),
      vscode.commands.registerCommand("elide.openActivityLog", (node: unknown) => this.openLog(node)),
      vscode.commands.registerCommand("elide.cancelActivity", (node: unknown) => {
        if (node instanceof TimelineNode) this.cancels.get(node.root)?.();
      }),
      vscode.commands.registerCommand("elide.clearActivity", () => this.clear()),
    ];
  }

  /** Begin an operation; `cancel` is offered in the view while it runs. */
  start(label: string, options: { detail?: string; cancel?: () => void } = {}): TimelineNode {
    const operation = TimelineNode.root(label, { onChange: (node) => this.schedule(node.root) });
    operation.detail = options.detail;
    this.serials.set(operation, this.serial++);
    if (options.cancel) this.cancels.set(operation, options.cancel);
    this.operations.unshift(operation);
    for (let index = this.operations.length - 1; index >= 0 && this.operations.length > MAX_OPERATIONS; index--) {
      if (!this.operations[index]!.running) this.forget(this.operations[index]!);
    }
    this.schedule(operation);
    return operation;
  }

  get running(): TimelineNode[] {
    return this.operations.filter((operation) => operation.running);
  }

  getTreeItem(node: TimelineNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, node.children.length === 0
      ? vscode.TreeItemCollapsibleState.None
      : node.parent === undefined && node.state !== "succeeded" ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `${this.serials.get(node.root)}/${node.id}`;
    item.iconPath = STATE_ICONS[node.state];
    item.contextValue = `activity${node.parent ? "Step" : "Operation"}${node.running && this.cancels.has(node.root) ? "Cancellable" : ""}`;
    const parent = node.parent;
    const share = parent && !parent.running && parent.children.length > 1 && parent.durationMs > 0
      ? `${Math.round((node.durationMs / parent.durationMs) * 100)}%` : undefined;
    const started = node.parent ? undefined : new Date(node.startedAt).toLocaleTimeString();
    item.description = [formatDuration(node.durationMs), share, node.detail, started].filter(Boolean).join(" · ");
    item.tooltip = this.tooltip(node);
    if (node.children.length === 0) item.command = { command: "elide.openActivityLog", title: "Open Log", arguments: [node] };
    return item;
  }

  getChildren(node?: TimelineNode): TimelineNode[] {
    return node ? node.children : this.operations;
  }

  getParent(node: TimelineNode): TimelineNode | undefined {
    return node.parent;
  }

  /** `elide-activity:/<operation>/<node>/<label>.log`: the lines of a node and its steps, live while it runs. */
  uriOf(node: TimelineNode): vscode.Uri {
    const name = node.label.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "activity";
    return vscode.Uri.from({ scheme: LOG_SCHEME, path: `/${this.serials.get(node.root)}/${node.id}/${name}.log` });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const node = this.nodeOf(uri);
    if (!node) return "This Elide activity is no longer recorded.\n";
    const status = node.running ? `running for ${formatDuration(node.durationMs)}` : `${node.state} in ${formatDuration(node.durationMs)}`;
    const out = [`${node.path.join(" › ")}: ${status}${node.detail ? ` (${node.detail})` : ""}`, `started ${new Date(node.startedAt).toLocaleString()}`];
    const breakdown = timelineBreakdown(node);
    if (breakdown.length > 0) out.push("", "where the time went:", ...breakdown.map((row) => `  ${row}`));
    out.push("");
    let section: TimelineNode | undefined;
    for (const line of node.lines()) {
      if (line.node !== section) {
        section = line.node;
        out.push(`── ${line.node.path.slice(node.path.length - 1).join(" › ")}`);
      }
      out.push(`${clockTime(line.at)}  ${line.text}`);
    }
    if (out.at(-1) === "") out.push("(no output)");
    return `${out.join("\n")}\n`;
  }

  /** Open the log of a node (a tree row), of an `elide-activity:` URI (a tooltip link), or of the latest operation. */
  async openLog(value: unknown): Promise<void> {
    const node = value instanceof TimelineNode ? value : this.operations[0];
    const uri = typeof value === "string" && value.startsWith(`${LOG_SCHEME}:`) ? vscode.Uri.parse(value) : node && this.uriOf(node);
    if (!uri) {
      void vscode.window.showInformationMessage("Elide: nothing has run yet in this window.");
      return;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(document, "log");
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private nodeOf(uri: vscode.Uri): TimelineNode | undefined {
    const [, serial, id] = uri.path.split("/");
    const pending = this.operations.filter((candidate) => String(this.serials.get(candidate)) === serial);
    for (let node = pending.pop(); node; node = pending.pop()) {
      if (String(node.id) === id) return node;
      pending.push(...node.children);
    }
    return undefined;
  }

  private tooltip(node: TimelineNode): vscode.MarkdownString {
    const tip = new vscode.MarkdownString(undefined, true);
    tip.appendMarkdown(`**${escape(node.label)}**\n\n`);
    tip.appendMarkdown(`${node.running ? "Running for" : `${node.state[0]!.toUpperCase()}${node.state.slice(1)} in`} ${formatDuration(node.durationMs)}`);
    if (node.detail) tip.appendMarkdown(` · ${escape(node.detail)}`);
    tip.appendMarkdown(`\n\nStarted ${new Date(node.startedAt).toLocaleTimeString()}`);
    const breakdown = timelineBreakdown(node);
    if (breakdown.length > 0) tip.appendCodeblock(breakdown.join("\n"), "text");
    return tip;
  }

  private schedule(operation: TimelineNode): void {
    this.dirty.add(operation);
    this.flushTimer ??= setTimeout(() => this.flush(), REFRESH_MS);
    if (operation.running && !this.ticker) {
      this.ticker = setInterval(() => {
        const running = this.running;
        if (running.length === 0) {
          clearInterval(this.ticker);
          this.ticker = undefined;
        }
        for (const operation of running) this.schedule(operation);
      }, 1_000);
    }
  }

  private flush(): void {
    this.flushTimer = undefined;
    const dirty = [...this.dirty];
    this.dirty.clear();
    this.treeChanged.fire(undefined);
    for (const operation of dirty) {
      this.operationChanged.fire(operation);
      if (!operation.running) this.cancels.delete(operation);
    }
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme !== LOG_SCHEME) continue;
      const node = this.nodeOf(document.uri);
      if (node && dirty.includes(node.root)) this.documentChanged.fire(document.uri);
    }
  }

  private clear(): void {
    for (const operation of [...this.operations]) if (!operation.running) this.forget(operation);
    this.treeChanged.fire(undefined);
  }

  private forget(operation: TimelineNode): void {
    this.operations.splice(this.operations.indexOf(operation), 1);
    this.cancels.delete(operation);
    this.serials.delete(operation);
  }

  dispose(): void {
    clearTimeout(this.flushTimer);
    clearInterval(this.ticker);
    for (const cancel of this.cancels.values()) cancel();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.treeChanged.dispose();
    this.documentChanged.dispose();
    this.operationChanged.dispose();
  }
}

function clockTime(at: number): string {
  const date = new Date(at);
  return `${date.toLocaleTimeString(undefined, { hour12: false })}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}
