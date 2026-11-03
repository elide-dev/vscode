import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { MANIFEST_NAME, isPathUnder, normalizePath, parseManifestBuildExtensions } from "@elide/ide-core";
import * as vscode from "vscode";
import type { ElideWorkspace } from "./projects.js";

/** Local build-extension navigation reads the current editor buffer, never the last synced manifest model. */
export function registerBuildExtensionLinks(workspace: ElideWorkspace): vscode.Disposable {
  return vscode.languages.registerDocumentLinkProvider(
    { scheme: "file", pattern: `**/${MANIFEST_NAME}` },
    {
      async provideDocumentLinks(document, token) {
        if (!vscode.workspace.isTrusted || document.uri.scheme !== "file" || path.basename(document.uri.fsPath) !== MANIFEST_NAME) return [];
        const located = workspace.locate(document.uri);
        if (!located) return [];
        const project = workspace.projectAt(path.dirname(located.fsPath));
        if (!project) return [];
        const version = document.version;
        const links: vscode.DocumentLink[] = [];
        let tree: string;
        try {
          tree = normalizePath(await realpath(project.workspaceRoot ?? project.root));
        } catch {
          return [];
        }
        for (const declaration of parseManifestBuildExtensions(document.getText())) {
          if (token.isCancellationRequested || document.version !== version || !vscode.workspace.isTrusted) return [];
          const target = vscode.Uri.file(path.resolve(project.root, declaration.path));
          // A member may refer to ../tools within its workspace, but neither lexical traversal nor symlinks
          // may turn a declaration into a link outside the source tree or the editor's workspace folders.
          if (!workspace.locate(target)) continue;
          try {
            const resolved = normalizePath(await realpath(target.fsPath));
            if (!isPathUnder(resolved, tree) || !(await stat(target.fsPath)).isFile()) continue;
          } catch {
            continue;
          }
          if (token.isCancellationRequested || document.version !== version || !vscode.workspace.isTrusted) return [];
          const link = new vscode.DocumentLink(
            new vscode.Range(document.positionAt(declaration.start), document.positionAt(declaration.end)), target,
          );
          link.tooltip = `Open build extension ${declaration.path}`;
          links.push(link);
        }
        return links;
      },
    },
  );
}
