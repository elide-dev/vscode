import * as vscode from "vscode";

export type StatusKind = "idle" | "syncing" | "stale" | "error" | "none";

/** Output channel plus status bar item shared by every part of the extension. */
export class ElideUi implements vscode.Disposable {
  readonly output: vscode.OutputChannel;
  private readonly status: vscode.StatusBarItem;
  private kind: StatusKind = "none";
  private detail: string | undefined;
  private projectLabel: string | undefined;

  constructor() {
    this.output = vscode.window.createOutputChannel("Elide");
    this.status = vscode.window.createStatusBarItem("elide.status", vscode.StatusBarAlignment.Left, 50);
    this.status.name = "Elide";
    this.status.command = "elide.showMenu";
    this.setStatus("none");
  }

  log(line: string): void {
    this.output.appendLine(line);
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
    switch (this.kind) {
      case "none":
        this.status.hide();
        return;
      case "idle":
        this.status.text = `$(check) Elide${suffix}`;
        this.status.tooltip = this.detail ?? "Elide project is in sync. Click for Elide actions.";
        this.status.backgroundColor = undefined;
        break;
      case "syncing":
        this.status.text = `$(sync~spin) Elide${suffix}`;
        this.status.tooltip = this.detail ?? "Syncing Elide project…";
        this.status.backgroundColor = undefined;
        break;
      case "stale":
        this.status.text = `$(warning) Elide${suffix}: out of date`;
        this.status.tooltip = this.detail ?? "elide.pkl changed. Click for Elide actions.";
        this.status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        break;
      case "error":
        this.status.text = `$(error) Elide${suffix}`;
        this.status.tooltip = this.detail ?? "Elide sync failed. Click for Elide actions.";
        this.status.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
        break;
    }
    this.status.show();
  }

  dispose(): void {
    this.status.dispose();
    this.output.dispose();
  }
}
