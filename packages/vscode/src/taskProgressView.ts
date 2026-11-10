import type { TimelineNode } from "@elide/ide-core";
import * as vscode from "vscode";
import type { ElideActivity } from "./activity.js";

export const TASK_PROGRESS_VIEW_ID = "elide.taskProgress";
const PLACED_STATE_KEY = "elide.taskProgress.terminalPlacement";

/** A task-only projection of Activity's live history, beside the native task terminal. */
export class TaskProgressView implements vscode.TreeDataProvider<TimelineNode>, vscode.Disposable {
  private readonly tasks = new WeakSet<TimelineNode>();
  private readonly expanded = new WeakSet<TimelineNode>();
  private readonly tree: vscode.TreeView<TimelineNode>;
  private readonly subscriptions: vscode.Disposable[];
  private disposed = false;
  readonly onDidChangeTreeData: vscode.Event<TimelineNode | undefined>;
  private placement: Promise<void> | undefined;

  constructor(private readonly activity: ElideActivity, private readonly state: vscode.Memento) {
    this.onDidChangeTreeData = activity.onDidChangeTreeData;
    this.tree = vscode.window.createTreeView(TASK_PROGRESS_VIEW_ID, { treeDataProvider: this });
    this.subscriptions = [
      this.tree,
      activity.onDidChangeOperation((operation) => this.expandSteps(operation)),
      vscode.commands.registerCommand("elide.showTaskProgress", () => this.reveal()),
    ];
  }

  /** Place on first use, not during activation or task discovery, which must not open a terminal. */
  get ready(): Promise<void> {
    return this.placement ??= this.place(this.state).catch((error: unknown) => {
      if (!this.disposed) void vscode.window.showErrorMessage(`Elide: could not place Task Progress beside the terminal: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    });
  }

  start(label: string, options: { detail?: string; cancel?: () => void } = {}): TimelineNode {
    const operation = this.activity.start(label, options);
    this.tasks.add(operation);
    return operation;
  }

  getChildren(node?: TimelineNode): TimelineNode[] {
    return node ? this.activity.getChildren(node) : this.activity.getChildren().filter((operation) => this.tasks.has(operation));
  }

  getTreeItem(node: TimelineNode): vscode.TreeItem {
    return this.activity.getTreeItem(node);
  }

  getParent(node: TimelineNode): TimelineNode | undefined {
    return this.activity.getParent(node);
  }

  /** Open the user's current location of the view without taking keyboard focus from the terminal. */
  async reveal(): Promise<void> {
    await this.ready;
    if (!this.disposed) await vscode.commands.executeCommand(`${TASK_PROGRESS_VIEW_ID}.open`, { preserveFocus: true });
  }

  /** Expand once when the first reported task arrives, even if its CLI row was initially a leaf. */
  private expandSteps(operation: TimelineNode): void {
    if (!this.tasks.has(operation) || this.expanded.has(operation)) return;
    const command = operation.children.find((child) => child.children.length > 0);
    if (!command) return;
    this.expanded.add(operation);
    void this.ready.then(async () => {
      if (!this.disposed) await this.tree.reveal(command, { expand: true, select: false, focus: false });
    }).catch((error: unknown) => operation.log(`Could not expand task steps: ${error instanceof Error ? error.message : String(error)}`));
  }

  private async place(state: vscode.Memento): Promise<void> {
    if (state.get<boolean>(PLACED_STATE_KEY, false)) return;
    // Contributed views cannot target the built-in Terminal container directly. Never undo later user moves.
    await vscode.commands.executeCommand("vscode.moveViews", { viewIds: [TASK_PROGRESS_VIEW_ID], destinationId: "terminal" });
    await state.update(PLACED_STATE_KEY, true);
  }

  dispose(): void {
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}
