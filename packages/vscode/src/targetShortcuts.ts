import type * as vscode from "vscode";

/** The sidebar rows that can be pinned and are counted: a project task, a build target, an Android artifact. */
export type ShortcutKind = "task" | "buildTarget" | "androidTarget";

/**
 * What identifies a target row across refreshes and sessions: its project and the name it is built by — the
 * subcommand of a task, the build target's name, the Android artifact's key. Everything else on the row (description,
 * the actions it offers) is read again from the project when it is shown.
 */
export interface TargetRef {
  kind: ShortcutKind;
  root: string;
  name: string;
}

interface Usage extends TargetRef {
  count: number;
  /** When it last ran, in epoch milliseconds: the tie-break between targets used equally often. */
  last: number;
}

const PINNED_KEY = "elide.sidebar.pinnedTargets";
const USAGE_KEY = "elide.sidebar.targetUsage";
/** Usage records kept per workspace; the least used go first, so targets since removed do not pile up. */
export const USAGE_LIMIT = 50;

export function sameTarget(a: TargetRef, b: TargetRef): boolean {
  return a.kind === b.kind && a.root === b.root && a.name === b.name;
}

/** Most used first, then the most recently used. */
function byUse(a: Usage, b: Usage): number {
  return b.count - a.count || b.last - a.last;
}

/**
 * The targets pinned to the top of the Elide sidebar, in the order they were pinned, and how often each target was
 * run from the sidebar. Both are per workspace (`ExtensionContext.workspaceState`): the roots are its projects'.
 */
export class TargetShortcuts {
  constructor(
    private readonly state: Pick<vscode.Memento, "get" | "update">,
    private readonly now: () => number = Date.now,
  ) {}

  pinned(): TargetRef[] {
    return this.state.get<TargetRef[]>(PINNED_KEY) ?? [];
  }

  isPinned(target: TargetRef): boolean {
    return this.pinned().some((pinned) => sameTarget(pinned, target));
  }

  async pin(target: TargetRef): Promise<void> {
    if (this.isPinned(target)) return;
    await this.state.update(PINNED_KEY, [...this.pinned(), refOf(target)]);
  }

  async unpin(target: TargetRef): Promise<void> {
    await this.state.update(PINNED_KEY, this.pinned().filter((pinned) => !sameTarget(pinned, target)));
  }

  /** Count one run of `target`. Beyond {@link USAGE_LIMIT} records the least used is dropped, never this one. */
  async record(target: TargetRef): Promise<void> {
    const usage = this.usage();
    const previous = usage.find((entry) => sameTarget(entry, target));
    const current: Usage = { ...refOf(target), count: (previous?.count ?? 0) + 1, last: this.now() };
    const others = usage.filter((entry) => entry !== previous).sort(byUse).slice(0, USAGE_LIMIT - 1);
    await this.state.update(USAGE_KEY, [current, ...others]);
  }

  /** Every target run from the sidebar, most used first; pinned ones are left out, they are at the top already. */
  frequent(): TargetRef[] {
    const pinned = this.pinned();
    return this.usage()
      .filter((entry) => !pinned.some((target) => sameTarget(target, entry)))
      .sort(byUse)
      .map(refOf);
  }

  async forget(target: TargetRef): Promise<void> {
    await this.state.update(USAGE_KEY, this.usage().filter((entry) => !sameTarget(entry, target)));
  }

  async clearUsage(): Promise<void> {
    await this.state.update(USAGE_KEY, undefined);
  }

  private usage(): Usage[] {
    return this.state.get<Usage[]>(USAGE_KEY) ?? [];
  }
}

/** Just the identity: callers pass whole sidebar rows. */
function refOf(target: TargetRef): TargetRef {
  return { kind: target.kind, root: target.root, name: target.name };
}
