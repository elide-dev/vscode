import { formatDuration, liveStatus, timelineBreakdown, type TimelineNode, type TimelineState } from "@elide/ide-core";
import * as vscode from "vscode";
import { ElideActivity } from "./activity.js";

export type StatusKind = "idle" | "stale" | "error" | "none";

/** Longest step label the status bar shows before eliding it; the tooltip and Activity view have the rest. */
const STATUS_STEP_CHARS = 48;
const STEP_GLYPHS: Record<TimelineState, string> = { running: "…", succeeded: "✓", failed: "✗", cancelled: "–", skipped: "–" };

/** Output channel, status bar item and activity record shared by every part of the extension. */
export class ElideUi implements vscode.Disposable {
  readonly output: vscode.OutputChannel;
  readonly activity: ElideActivity;
  private readonly status: vscode.StatusBarItem;
  private kind: StatusKind = "none";
  private detail: string | undefined;
  private projectLabel: string | undefined;
  /** Syncs in flight, whose current step the status bar shows. */
  private readonly syncs = new Set<TimelineNode>();
  /** The sync that finished last, whose breakdown the tooltip shows. */
  private lastSync: TimelineNode | undefined;
  private readonly subscription: vscode.Disposable;

  constructor() {
    this.output = vscode.window.createOutputChannel("Elide");
    this.activity = new ElideActivity();
    this.status = vscode.window.createStatusBarItem("elide.status", vscode.StatusBarAlignment.Left, 50);
    this.status.name = "Elide";
    this.subscription = this.activity.onDidChangeOperation((operation) => {
      if (!this.syncs.has(operation)) return;
      if (!operation.running) {
        this.syncs.delete(operation);
        this.lastSync = operation;
      }
      this.render();
    });
    this.setStatus("none");
  }

  log(line: string): void {
    this.output.appendLine(line);
  }

  /** Show the progress of `sync` in the status bar until it ends. */
  trackSync(sync: TimelineNode): void {
    this.syncs.add(sync);
    this.render();
  }

  /** Name of the single project in the window, or `undefined` when there is none or several. */
  setProjectLabel(label: string | undefined): void {
    if (label === this.projectLabel) return;
    this.projectLabel = label;
    this.render();
  }

  setStatus(kind: StatusKind, detail?: string): void {
    this.kind = kind;
    this.detail = detail;
    this.render();
  }

  private render(): void {
    const suffix = this.projectLabel ? ` ${this.projectLabel}` : "";
    const sync = [...this.syncs].find((operation) => operation.running);
    this.status.command = sync ? "elide.showActivity" : "elide.showMenu";
    if (sync) {
      // What the CLI reports doing ("Resolving Maven dependencies: 40% (1/3)") when it reports anything; otherwise
      // the step directly under the sync, which names the phase ("Installing dependencies").
      const phase = liveStatus(sync) ?? sync.phase?.label ?? "starting";
      const shown = phase.length > STATUS_STEP_CHARS ? `${phase.slice(0, STATUS_STEP_CHARS - 1)}…` : phase;
      this.status.text = `$(sync~spin) Elide${suffix}: ${shown} (${formatDuration(sync.durationMs)})`;
      this.status.tooltip = this.tooltip(sync);
      this.status.backgroundColor = undefined;
      this.status.show();
      return;
    }
    switch (this.kind) {
      case "none":
        this.status.hide();
        return;
      case "idle":
        this.status.text = `$(check) Elide${suffix}`;
        this.status.tooltip = this.tooltip(undefined, this.detail ?? "Elide project is in sync. Click for Elide actions.");
        this.status.backgroundColor = undefined;
        break;
      case "stale":
        this.status.text = `$(warning) Elide${suffix}: out of date`;
        this.status.tooltip = this.tooltip(undefined, this.detail ?? "elide.pkl changed. Click for Elide actions.");
        this.status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        break;
      case "error":
        this.status.text = `$(error) Elide${suffix}`;
        this.status.tooltip = this.tooltip(undefined, this.detail ?? "Elide sync failed. Click for Elide actions.");
        this.status.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
        break;
    }
    this.status.show();
  }

  /** The running sync's steps so far, or the state line plus where the last sync's time went. */
  private tooltip(running: TimelineNode | undefined, state?: string): vscode.MarkdownString {
    const tip = new vscode.MarkdownString(undefined, true);
    tip.isTrusted = { enabledCommands: ["elide.showActivity", "elide.openActivityLog", "elide.showMenu"] };
    const sync = running ?? this.lastSync;
    if (state) tip.appendText(state);
    if (sync) {
      if (state) tip.appendMarkdown("\n\n---\n\n");
      tip.appendText(running ? `${sync.label}: running for ${formatDuration(sync.durationMs)}` : `Last ${sync.label.toLowerCase()}: ${sync.state} in ${formatDuration(sync.durationMs)}`);
      const now = running && liveStatus(sync);
      if (now) tip.appendText(`\n\n${sync.phase?.label ?? "Starting"}: ${now}`);
      const rows = running ? sync.children.map((step) => `${STEP_GLYPHS[step.state]} ${formatDuration(step.durationMs).padStart(8)}  ${step.label}`).slice(-8) : timelineBreakdown(sync).slice(0, 8);
      if (rows.length > 0) tip.appendCodeblock(rows.join("\n"), "text");
      const log = encodeURIComponent(JSON.stringify([this.activity.uriOf(sync).toString()]));
      tip.appendMarkdown(`\n[$(pulse) Show activity](command:elide.showActivity) · [$(output) Open log](command:elide.openActivityLog?${log})`);
    }
    if (!running) tip.appendMarkdown(`${sync ? " · " : "\n\n"}[$(list-unordered) Elide actions](command:elide.showMenu)`);
    return tip;
  }

  dispose(): void {
    this.subscription.dispose();
    this.activity.dispose();
    this.status.dispose();
    this.output.dispose();
  }
}
