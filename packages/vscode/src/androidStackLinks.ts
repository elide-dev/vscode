import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { AndroidStackSourceIndex, parseAndroidStackFrame } from "./androidStackSource.js";
import type { ElideWorkspace } from "./projects.js";

export const ANDROID_LOGCAT_LANGUAGE = "elide-android-logcat";
const SOURCE_GLOB = "**/*.{kt,java}";
const IGNORED_DIRECTORIES: Record<string, true> = {
  ".git": true, ".gradle": true, ".dev": true, ".idea": true,
  "node_modules": true, ".kotlin": true,
};

/** Explicit model roots are traversed even when the root itself is in a build/generated directory. */
async function sourceFiles(roots: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  const visited = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    if (visited.has(directory)) return;
    visited.add(directory);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && !Object.hasOwn(IGNORED_DIRECTORIES, entry.name)) await visit(file);
      else if (entry.isFile() && /\.(?:kt|java)$/.test(entry.name)) files.push(file);
    }
  };
  for (const root of roots) await visit(root);
  return files;
}

/** Owns no adb lifecycle: navigation is an additive provider on our custom-language Output documents. */
export function registerAndroidStackLinks(workspace: ElideWorkspace): vscode.Disposable {
  let roots: string[] = [];
  let watchers: vscode.Disposable[] = [];
  let disposed = false;
  let revision = 0;
  const index = new AndroidStackSourceIndex(() => sourceFiles(roots), (file) => readFile(file, "utf8"));
  const invalidate = () => {
    revision++;
    index.invalidate();
  };
  const refresh = () => {
    invalidate();
    for (const watcher of watchers) watcher.dispose();
    watchers = [];
    roots = [...new Set(workspace.projects.flatMap((project) =>
      project.model?.modules.flatMap((module) => module.contentRoots.flatMap((content) =>
        content.sourceRoots.filter((root) => root.kind === "source" || root.kind === "test").map((root) => path.resolve(root.path)))) ?? [],
    ))];
    for (const root of roots) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), SOURCE_GLOB));
      watchers.push(watcher, watcher.onDidCreate(invalidate),
        watcher.onDidChange(invalidate), watcher.onDidDelete(invalidate));
    }
  };
  refresh();
  const registration = vscode.languages.registerDocumentLinkProvider(
    // OutputChannel has no public URI. A private contributed language scopes ownership without guessing channel IDs.
    { scheme: "output", language: ANDROID_LOGCAT_LANGUAGE },
    {
      async provideDocumentLinks(document, token) {
        if (disposed || !vscode.workspace.isTrusted) return [];
        const version = document.version;
        const sourceRevision = revision;
        const links: vscode.DocumentLink[] = [];
        for (let line = 0; line < document.lineCount; line++) {
          if (token.isCancellationRequested || disposed || document.version !== version) return [];
          const frame = parseAndroidStackFrame(document.lineAt(line).text);
          if (!frame) continue;
          const location = await index.resolve(frame);
          if (token.isCancellationRequested || disposed || document.version !== version || sourceRevision !== revision) return [];
          if (!location) continue;
          const target = vscode.Uri.file(location.file).with({ fragment: `L${location.line + 1},1` });
          const link = new vscode.DocumentLink(new vscode.Range(line, frame.start, line, frame.end), target);
          link.tooltip = `Open ${frame.fileName}:${frame.line}`;
          links.push(link);
        }
        return links;
      },
    },
  );
  const projects = workspace.onDidChange(refresh);
  return new vscode.Disposable(() => {
    disposed = true;
    registration.dispose();
    projects.dispose();
    for (const watcher of watchers) watcher.dispose();
    watchers = [];
    roots = [];
    index.dispose();
  });
}
