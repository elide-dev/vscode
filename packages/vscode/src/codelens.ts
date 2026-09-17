import path from "node:path";
import {
  MANIFEST_NAME,
  isNativeImageBinary,
  isPathUnder,
  normalizePath,
  parseManifestArtifacts,
  type ManifestArtifact,
} from "@elide/ide-core";
import * as vscode from "vscode";
import { readConfig } from "./config.js";
import type { ElideProject, ElideWorkspace } from "./projects.js";

/** Kotlin `fun main(`, including the `@JvmStatic fun main(` form used inside an `object`. */
const KOTLIN_MAIN = /^\s*(?:@JvmStatic\s+)?(?:public\s+)?fun\s+main\s*\(/;
const JAVA_MAIN = /^\s*public\s+static\s+void\s+main\s*\(/;
const PACKAGE = /^\s*package\s+([\w.]+)/m;
/** `name {` opening a manifest block. */
const BLOCK_OPEN = /^\s*(\w+)\s*\{/;
const MANIFEST_MAIN = /^\s*main\s*=\s*"[^"]+"/;
/** A listing element: `"src/main.ts"`. */
const LIST_ENTRY = /^\s*"([^"]+)"\s*,?\s*$/;
/** A mapping key: `["dev"] = "…"`. */
const MAP_ENTRY = /^\s*\["([^"]+)"\]\s*=/;

/**
 * Run/Debug lenses on JVM `main` functions and on the entrypoints, scripts and artifacts declared in `elide.pkl`.
 *
 * Detection is regex-based on purpose: the extension has no Kotlin or Java parser, and the Kotlin LSP exposes no
 * symbol index the extension host can query cheaply per document.
 */
export class ElideCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  static readonly selector: vscode.DocumentSelector = [
    { language: "kotlin", scheme: "file" },
    { language: "java", scheme: "file" },
    { pattern: `**/${MANIFEST_NAME}`, scheme: "file" },
  ];

  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly workspace: ElideWorkspace) {
    this.subscriptions = [
      // A new model can add source roots or change `jvm.main`, both of which decide the lenses below.
      workspace.onDidChange(() => this.changed.fire()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("elide.codeLens")) this.changed.fire();
      }),
    ];
  }

  dispose(): void {
    for (const d of this.subscriptions) d.dispose();
    this.changed.dispose();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!readConfig(document.uri).codeLens) return [];
    const fsPath = document.uri.fsPath;
    if (path.basename(fsPath) === MANIFEST_NAME) {
      const root = path.dirname(fsPath);
      // Only the manifest of a tracked project: a nested manifest belongs to a build this one does not include.
      return this.workspace.projectAt(root) ? manifestLenses(document, root) : [];
    }
    const project = this.workspace.projectFor(fsPath);
    return project ? sourceLenses(document, project) : [];
  }
}

/**
 * `qualifier` distinguishes the source-file pair from the Kotlin LSP's own Run/Debug lenses, which the JetBrains
 * server contributes unconditionally on every JVM `main` (`LSJvmRunMainCodeLensProvider`) and no setting disables.
 */
function runLenses(line: number, length: number, root: string, args: string[], qualifier = ""): vscode.CodeLens[] {
  const range = new vscode.Range(line, 0, line, length);
  return [
    new vscode.CodeLens(range, { title: `$(play) Run${qualifier}`, command: "elide.run", arguments: [{ root, args }] }),
    new vscode.CodeLens(range, { title: `$(debug-alt) Debug${qualifier}`, command: "elide.debug", arguments: [{ root, args }] }),
  ];
}

/** Lenses of one `artifacts` entry: a Native Image binary is also runnable, the rest only build. */
function artifactLenses(line: number, length: number, root: string, artifact: ManifestArtifact): vscode.CodeLens[] {
  const range = new vscode.Range(line, 0, line, length);
  const build = new vscode.CodeLens(range, {
    title: "$(package) Build",
    command: "elide.build",
    arguments: [{ root, args: [artifact.name] }],
  });
  if (!isNativeImageBinary(artifact)) return [build];
  const run = new vscode.CodeLens(range, {
    title: "$(play) Build & Run",
    command: "elide.runArtifact",
    arguments: [{ root, args: [artifact.name], outputName: artifact.outputName }],
  });
  return [run, build];
}

/** `main` functions in a production source root of the project (test sources are the Test Explorer's business). */
function sourceLenses(document: vscode.TextDocument, project: ElideProject): vscode.CodeLens[] {
  const model = project.model;
  if (!model) return [];
  const file = normalizePath(document.uri.fsPath);
  const inSourceRoot = model.modules.some(
    (m) =>
      m.kind === "source" &&
      m.contentRoots.some((cr) => cr.sourceRoots.some((sr) => sr.kind === "source" && isPathUnder(file, normalizePath(sr.path)))),
  );
  if (!inSourceRoot) return [];

  const java = path.extname(document.uri.fsPath) === ".java";
  const pattern = java ? JAVA_MAIN : KOTLIN_MAIN;
  const args = entryArgs(document, project, java);
  const lenses: vscode.CodeLens[] = [];
  for (let i = 0; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;
    if (pattern.test(text)) lenses.push(...runLenses(i, text.length, project.root, args, " with Elide"));
  }
  return lenses;
}

/**
 * Argument vector `elide run` takes for this file: nothing when its main class is already the manifest's `jvm.main`
 * (Elide resolves it itself), otherwise the file, which is how Elide selects a different entrypoint.
 */
function entryArgs(document: vscode.TextDocument, project: ElideProject, java: boolean): string[] {
  const pkg = PACKAGE.exec(document.getText())?.[1];
  const base = path.basename(document.uri.fsPath, java ? ".java" : ".kt");
  // Kotlin compiles top-level declarations into a `<File>Kt` facade class, with the first letter capitalized.
  const simple = java ? base : `${base.charAt(0).toUpperCase()}${base.slice(1)}Kt`;
  const mainClass = pkg ? `${pkg}.${simple}` : simple;
  const declared = project.model?.entrypoints.find((e) => e.kind === "jvmMain")?.value;
  if (declared === mainClass) return [];
  return [normalizePath(path.relative(project.root, document.uri.fsPath))];
}

/** Entrypoints, scripts and artifacts of `elide.pkl`, found by tracking which block each line sits in. */
function manifestLenses(document: vscode.TextDocument, root: string): vscode.CodeLens[] {
  const lenses: vscode.CodeLens[] = [];
  const stack: { name: string; depth: number }[] = [];
  // Artifacts carry settings of their own (the image name, the image type), which the core parser reads.
  const artifacts = new Map(parseManifestArtifacts(document.getText()).map((a) => [a.line, a] as const));
  let depth = 0;
  for (let i = 0; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;
    const block = stack[stack.length - 1]?.name;
    const artifact = artifacts.get(i);
    if (artifact) {
      lenses.push(...artifactLenses(i, text.length, root, artifact));
    } else if (block === "jvm" && MANIFEST_MAIN.test(text)) {
      lenses.push(...runLenses(i, text.length, root, []));
    } else if (block === "entrypoint") {
      const entry = LIST_ENTRY.exec(text);
      if (entry?.[1]) lenses.push(...runLenses(i, text.length, root, [entry[1]]));
    } else if (block === "scripts") {
      const script = MAP_ENTRY.exec(text);
      // Scripts are shell command lines, not JVM programs: there is nothing for JDWP to attach to.
      if (script?.[1]) {
        lenses.push(
          new vscode.CodeLens(new vscode.Range(i, 0, i, text.length), {
            title: "$(play) Run script",
            command: "elide.run",
            arguments: [{ root, args: [script[1]] }],
          }),
        );
      }
    }

    const opened = BLOCK_OPEN.exec(text);
    if (opened?.[1]) stack.push({ name: opened[1], depth });
    depth += count(text, "{") - count(text, "}");
    while (stack.length > 0 && depth <= (stack[stack.length - 1]?.depth ?? 0)) stack.pop();
  }
  return lenses;
}

function count(text: string, char: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === char) n++;
  return n;
}
