import * as vscode from "vscode";

export type StatusKind = "idle" | "syncing" | "stale" | "error" | "none";

/** Output channel plus status bar item shared by every part of the extension. */
export class ElideUi implements vscode.Disposable {
  readonly output: vscode.OutputChannel;
  private readonly status: vscode.StatusBarItem;

  constructor() {
    this.output = vscode.window.createOutputChannel("Elide");
    this.status = vscode.window.createStatusBarItem("elide.status", vscode.StatusBarAlignment.Left, 50);
    this.status.name = "Elide";
    this.status.command = "elide.sync";
    this.setStatus("none");
  }

  log(line: string): void {
    this.output.appendLine(line);
  }

  setStatus(kind: StatusKind, detail?: string): void {
    switch (kind) {
      case "none":
        this.status.hide();
        return;
      case "idle":
        this.status.text = "$(check) Elide";
        this.status.tooltip = detail ?? "Elide project is in sync. Click to sync again.";
        this.status.backgroundColor = undefined;
        break;
      case "syncing":
        this.status.text = "$(sync~spin) Elide";
        this.status.tooltip = detail ?? "Syncing Elide project…";
        this.status.backgroundColor = undefined;
        break;
      case "stale":
        this.status.text = "$(warning) Elide: out of date";
        this.status.tooltip = detail ?? "elide.pkl changed. Click to sync.";
        this.status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        break;
      case "error":
        this.status.text = "$(error) Elide";
        this.status.tooltip = detail ?? "Elide sync failed. Click to retry.";
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
