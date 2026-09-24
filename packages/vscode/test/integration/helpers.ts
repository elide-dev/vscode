/** Polling and editor helpers shared by the integration scenarios. */
import assert from "node:assert/strict";
import * as vscode from "vscode";

export const log = (...a: unknown[]) => console.log("[elide-test]", ...a);

export async function waitFor<T>(what: string, probe: () => Promise<T | undefined> | T | undefined, timeoutMs: number, intervalMs = 1_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function hoverText(hovers: vscode.Hover[] | undefined): string {
  return (hovers ?? [])
    .flatMap((h) => h.contents)
    .map((c) => (typeof c === "string" ? c : c.value))
    .join("\n");
}

export async function hoverAt(uri: vscode.Uri, needle: string): Promise<string> {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
  const offset = doc.getText().indexOf(needle);
  assert.ok(offset >= 0, `${needle} not found in ${uri.fsPath}`);
  const pos = doc.positionAt(offset + 1);
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", uri, pos);
  return hoverText(hovers);
}

export function errorsOf(uri: vscode.Uri): vscode.Diagnostic[] {
  return vscode.languages.getDiagnostics(uri).filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
}
