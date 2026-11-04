import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { MANIFEST_NAME, isPathUnder, normalizePath, parseManifestWorkspaceMembers } from "@elide/ide-core";
import * as vscode from "vscode";
import type { ElideWorkspace } from "./projects.js";

/** Navigation follows the buffer; descriptive metadata comes only from an already synced member. */
export function registerWorkspaceMemberNavigation(workspace: ElideWorkspace): vscode.Disposable {
  const selector = { scheme: "file", pattern: `**/${MANIFEST_NAME}` };

  function declarations(document: vscode.TextDocument) {
    if (!vscode.workspace.isTrusted || document.uri.scheme !== "file" || path.basename(document.uri.fsPath) !== MANIFEST_NAME) return [];
    const root = path.dirname(document.uri.fsPath);
    if (!workspace.locate(document.uri) || !workspace.projectAt(root)) return [];
    return parseManifestWorkspaceMembers(document.getText()).map((entry) => ({
      root: path.resolve(root, entry.path),
      path: entry.path,
      range: new vscode.Range(document.positionAt(entry.start), document.positionAt(entry.end)),
    }));
  }

  async function target(document: vscode.TextDocument, root: string): Promise<vscode.Uri | undefined> {
    const uri = vscode.Uri.file(path.join(root, MANIFEST_NAME));
    if (!workspace.locate(uri)) return undefined;
    try {
      const tree = normalizePath(await realpath(path.dirname(document.uri.fsPath)));
      if (!isPathUnder(normalizePath(await realpath(uri.fsPath)), tree) || !(await stat(uri.fsPath)).isFile()) return undefined;
      return uri;
    } catch {
      return undefined;
    }
  }

  return vscode.Disposable.from(
    vscode.languages.registerDocumentLinkProvider(selector, {
      async provideDocumentLinks(document, token) {
        const version = document.version;
        const links: vscode.DocumentLink[] = [];
        for (const entry of declarations(document)) {
          const uri = await target(document, entry.root);
          if (token.isCancellationRequested || document.version !== version || !vscode.workspace.isTrusted) return [];
          if (!uri) continue;
          const link = new vscode.DocumentLink(entry.range, uri);
          link.tooltip = `Open workspace member ${entry.path}`;
          links.push(link);
        }
        return links;
      },
    }),
    vscode.languages.registerDefinitionProvider(selector, {
      async provideDefinition(document, position, token) {
        const version = document.version;
        const entry = declarations(document).find((entry) => entry.range.contains(position));
        if (!entry) return undefined;
        const uri = await target(document, entry.root);
        if (!uri || token.isCancellationRequested || document.version !== version || !vscode.workspace.isTrusted) return undefined;
        return [{ originSelectionRange: entry.range, targetUri: uri, targetRange: new vscode.Range(0, 0, 0, 0) }];
      },
    }),
    vscode.languages.registerHoverProvider(selector, {
      provideHover(document, position, token) {
        if (token.isCancellationRequested) return undefined;
        const entry = declarations(document).find((entry) => entry.range.contains(position));
        if (!entry) return undefined;
        const owner = path.dirname(document.uri.fsPath);
        const member = workspace.projectAt(entry.root);
        if (!member?.model || member.workspaceRoot !== owner) return undefined;
        const content = new vscode.MarkdownString();
        content.appendText(member.model.name);
        if (member.model.description) content.appendMarkdown("\n\n").appendText(member.model.description);
        return new vscode.Hover(content, entry.range);
      },
    }),
  );
}
