import { androidSdkRoot } from "@elide/ide-core";
import * as vscode from "vscode";
import { readConfig } from "./config.js";

/** A workspace folder and optional connected device for standalone SDK tools. */
export interface AndroidTarget {
  root: string;
  device?: string;
}

export function toAndroidTarget(value: unknown): AndroidTarget | undefined {
  if (typeof value !== "object" || value === null || !("root" in value) || typeof value.root !== "string") return undefined;
  const device = "device" in value && typeof value.device === "string" ? value.device : undefined;
  return { root: value.root, ...(device ? { device } : {}) };
}

/** SDK tools do not depend on an Elide manifest or a synced project model. */
export function androidSdkFor(folder: vscode.WorkspaceFolder): string | undefined {
  return readConfig(folder).androidSdk ?? androidSdkRoot();
}

export function androidFolderAt(root: string): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
}

export async function pickAndroidFolder(value: unknown): Promise<vscode.WorkspaceFolder | undefined> {
  const target = toAndroidTarget(value);
  if (target) {
    const folder = androidFolderAt(target.root);
    if (!folder) void vscode.window.showWarningMessage(`Elide: open the workspace folder containing ${target.root} first.`);
    return folder;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    void vscode.window.showWarningMessage("Elide: open a workspace folder to use Android SDK tools. No Elide manifest or sync is required.");
    return undefined;
  }
  if (folders.length === 1) return folders[0];
  const editor = vscode.window.activeTextEditor;
  const active = editor?.document.uri.scheme === "file" ? vscode.workspace.getWorkspaceFolder(editor.document.uri) : undefined;
  if (active) return active;
  return (await vscode.window.showQuickPick(
    folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
    { placeHolder: "Workspace folder for Android SDK tools" },
  ))?.folder;
}
