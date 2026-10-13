/**
 * Where an operation's time goes: a tree of timed steps, each with the output lines it produced.
 *
 * A root covers one user-visible operation (a project sync, a Compose preview build); its children are the steps it
 * went through, the CLI invocations each step made, and the build tasks those invocations reported. Nodes either run
 * under this clock (`start` … `end`) or are recorded after the fact with the duration a tool measured itself.
 */

export type TimelineState = "running" | "succeeded" | "failed" | "cancelled" | "skipped";

export interface TimelineLine {
  /** Epoch milliseconds. */
  at: number;
  text: string;
  node: TimelineNode;
}

export interface TimelineOptions {
  /** Epoch milliseconds; injectable for tests. */
  clock?: () => number;
  /** Lines kept per root; the oldest go first. */
  maxLines?: number;
  /** Children kept per node; the oldest finished ones go first. */
  maxChildren?: number;
  /** Called after any node of the tree changed. */
  onChange?: (node: TimelineNode) => void;
}

interface Shared {
  clock: () => number;
  maxLines: number;
  maxChildren: number;
  onChange?: (node: TimelineNode) => void;
  lines: TimelineLine[];
  nextId: number;
}

const DEFAULT_MAX_LINES = 20_000;
const DEFAULT_MAX_CHILDREN = 500;

export class TimelineNode {
  readonly id: number;
  readonly children: TimelineNode[] = [];
  readonly startedAt: number;
  endedAt: number | undefined;
  state: TimelineState = "running";
  /** Short secondary text: an outcome, a count, the reason a step was skipped. */
  detail: string | undefined;
  /** What this node is doing at this moment, in a few words; only a running node has one. See {@link liveStatus}. */
  status: string | undefined;
  /** Duration the tool measured itself, for a node recorded after the fact. */
  private reportedMs: number | undefined;

  private constructor(
    readonly label: string,
    readonly parent: TimelineNode | undefined,
    private readonly shared: Shared,
    startedAt?: number,
  ) {
    this.id = shared.nextId++;
    this.startedAt = startedAt ?? shared.clock();
  }

  static root(label: string, options: TimelineOptions = {}): TimelineNode {
    return new TimelineNode(label, undefined, {
      clock: options.clock ?? Date.now,
      maxLines: options.maxLines ?? DEFAULT_MAX_LINES,
      maxChildren: options.maxChildren ?? DEFAULT_MAX_CHILDREN,
      onChange: options.onChange,
      lines: [],
      nextId: 0,
    });
  }

  get root(): TimelineNode {
    return this.parent ? this.parent.root : this;
  }

  get running(): boolean {
    return this.state === "running";
  }

  /** Elapsed time so far while running, the final duration afterwards. */
  get durationMs(): number {
    if (this.reportedMs !== undefined) return this.reportedMs;
    return (this.endedAt ?? this.shared.clock()) - this.startedAt;
  }

  /** The running direct step: the phase the operation is in ("Installing dependencies"), not the command it runs. */
  get phase(): TimelineNode | undefined {
    return this.children.findLast((child) => child.running);
  }

  /** Labels from the root down to this node. */
  get path(): string[] {
    return this.parent ? [...this.parent.path, this.label] : [this.label];
  }

  /** Begin a child step, running from now until its `end`. */
  start(label: string, detail?: string): TimelineNode {
    const child = new TimelineNode(label, this, this.shared);
    child.detail = detail;
    this.adopt(child);
    return child;
  }

  /** Add a finished child that took `durationMs` by its own measure, ending now. */
  record(label: string, durationMs: number | undefined, state: Exclude<TimelineState, "running"> = "succeeded", detail?: string): TimelineNode {
    const now = this.shared.clock();
    const child = new TimelineNode(label, this, this.shared, now - (durationMs ?? 0));
    child.state = state;
    child.endedAt = now;
    child.reportedMs = durationMs ?? 0;
    child.detail = detail;
    this.adopt(child);
    return child;
  }

  /**
   * Finish this node. Steps still running finish with it: as succeeded when it succeeded (a step whose end was never
   * signalled ran until here), as cancelled otherwise. Ending twice keeps the first outcome.
   */
  end(state: Exclude<TimelineState, "running"> = "succeeded", detail?: string): void {
    if (!this.running) return;
    for (const child of this.children) if (child.running) child.end(state === "succeeded" ? "succeeded" : "cancelled");
    this.state = state;
    this.endedAt = this.shared.clock();
    this.status = undefined;
    if (detail !== undefined) this.detail = detail;
    this.changed();
  }

  /** Take this node out of its parent's steps: it turned out to be nothing worth showing. */
  discard(): void {
    const siblings = this.parent?.children;
    const at = siblings?.indexOf(this) ?? -1;
    if (at < 0) return;
    siblings!.splice(at, 1);
    this.parent!.changed();
  }

  /** Run `work` as a child step that fails when it throws. */
  async run<T>(label: string, work: (step: TimelineNode) => Promise<T>): Promise<T> {
    const step = this.start(label);
    try {
      const result = await work(step);
      step.end("succeeded");
      return result;
    } catch (error) {
      step.end("failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  setDetail(detail: string | undefined): void {
    if (detail === this.detail) return;
    this.detail = detail;
    this.changed();
  }

  setStatus(status: string | undefined): void {
    if (status === this.status || !this.running) return;
    this.status = status;
    this.changed();
  }

  /** Append an output line produced while this node ran. */
  log(text: string): void {
    const lines = this.shared.lines;
    lines.push({ at: this.shared.clock(), text, node: this });
    if (lines.length > this.shared.maxLines) lines.splice(0, lines.length - this.shared.maxLines);
    this.changed();
  }

  /** The lines of this node and its descendants, oldest first. */
  lines(): TimelineLine[] {
    return this.shared.lines.filter((line) => line.node === this || line.node.isDescendantOf(this));
  }

  isDescendantOf(ancestor: TimelineNode): boolean {
    for (let node = this.parent; node; node = node.parent) if (node === ancestor) return true;
    return false;
  }

  private adopt(child: TimelineNode): void {
    this.children.push(child);
    if (this.children.length > this.shared.maxChildren) {
      const oldest = this.children.findIndex((node) => !node.running);
      if (oldest >= 0) this.children.splice(oldest, 1);
    }
    this.changed();
  }

  private changed(): void {
    this.shared.onChange?.(this);
  }
}

/** `431 ms`, `4.2 s`, `1 m 05 s`: compact, and stable in width for a ticking display. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0 ms";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)} s`;
  const seconds = Math.floor(ms / 1_000);
  return `${Math.floor(seconds / 60)} m ${String(seconds % 60).padStart(2, "0")} s`;
}

/**
 * What `node` is doing at this moment: the {@link TimelineNode.status} of the deepest running step that has one,
 * following the latest running step at each level. `undefined` when nothing below reports a status.
 */
export function liveStatus(node: TimelineNode): string | undefined {
  let status: string | undefined;
  for (let at: TimelineNode | undefined = node; at?.running; at = at.phase) status = at.status ?? status;
  return status;
}

/**
 * The direct steps of `node` with their share of its time, slowest first: the lines a log shows under a finished
 * operation to say where its time went. Steps under `minShare` of the total are folded into one line.
 */
export function timelineBreakdown(node: TimelineNode, minShare = 0.02): string[] {
  const total = node.durationMs;
  if (node.children.length === 0 || total <= 0) return [];
  const sorted = [...node.children].sort((a, b) => b.durationMs - a.durationMs);
  const shown = sorted.filter((child) => child.durationMs / total >= minShare);
  const rest = sorted.slice(shown.length);
  const width = Math.max(...shown.map((child) => formatDuration(child.durationMs).length), 0);
  const row = (ms: number, label: string) =>
    `${formatDuration(ms).padStart(width)}  ${`${Math.round((ms / total) * 100)}%`.padStart(4)}  ${label}`;
  const rows = shown.map((child) => row(child.durationMs, `${child.label}${child.state === "failed" ? " (failed)" : ""}`));
  if (rest.length > 0) rows.push(row(rest.reduce((sum, child) => sum + child.durationMs, 0), `${rest.length} more step${rest.length === 1 ? "" : "s"}`));
  return rows;
}
