import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { ElideExtensionApi } from "../../src/extension.js";
import { errorsOf, hoverAt, log, waitFor } from "./helpers.js";

/** Real built-in TS server, manifest providers, Elide sync and terminal builds; no companion Kotlin extension. */
export async function runBuildExtensionScenario(): Promise<void> {
  const sample = process.env.ELIDE_TEST_SAMPLE!;
  const extension = vscode.extensions.getExtension<ElideExtensionApi>("elide.elide");
  assert.ok(extension);
  const api = await extension.activate();
  const typescript = vscode.extensions.getExtension("vscode.typescript-language-features");
  assert.ok(typescript, "built-in TypeScript extension available");
  await typescript.activate();
  const taskUri = vscode.Uri.file(path.join(sample, "tools/tasks.ts"));
  const taskDoc = await vscode.workspace.openTextDocument(taskUri);
  await vscode.window.showTextDocument(taskDoc);

  // Inferred projects work before any Elide sync or project config has been written.
  const hover = await waitFor("ElideBuild API hover", async () => {
    const value = await hoverAt(taskUri, "ElideBuild");
    return /interface ElideBuild/.test(value) ? value : undefined;
  }, 60_000, 500);
  log("build extension API:", hover.replace(/\n/g, " ").slice(0, 160));
  assert.ok(!existsSync(path.join(sample, "tsconfig.json")), "no generated project config");
  const original = taskDoc.getText();
  const definitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
    "vscode.executeDefinitionProvider", taskUri, taskDoc.positionAt(original.indexOf("ElideBuild") + 2),
  );
  assert.ok(definitions?.some((definition) =>
    ("targetUri" in definition ? definition.targetUri : definition.uri).fsPath.endsWith("/elide-build-typescript-plugin/build.d.ts")),
  "Go to Definition opens the bundled build API");

  const replace = async (document: vscode.TextDocument, text: string) => {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    assert.ok(await vscode.workspace.applyEdit(edit));
  };
  const complete = async (document: vscode.TextDocument, text: string, marker: string, expected: string[]) => {
    await replace(document, text);
    const position = document.positionAt(text.indexOf(marker) + marker.length);
    const names = await waitFor(`completions ${expected.join(", ")}`, async () => {
      const result = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", document.uri, position);
      const labels = result?.items.map((item) => typeof item.label === "string" ? item.label : item.label.label) ?? [];
      return expected.every((name) => labels.includes(name)) ? labels : undefined;
    }, 30_000, 500);
    log("completion:", expected.join(", "), `(${names.length} candidates)`);
  };
  await complete(taskDoc, 'export default (build: ElideBuild) => { build. };\n', "build.", ["task", "project", "config", "layout"]);
  await complete(taskDoc, 'export default ({ task }: ElideBuild) => { task("check", (ctx) => { ctx.tools. }); };\n', "ctx.tools.", ["classpath", "kotlinc", "javac", "jar", "format"]);
  await replace(taskDoc, 'export default ({ task }: ElideBuild) => { task("check", { description: 42 }, (ctx) => { ctx.log("check"); }); };\n');
  await waitFor("invalid build task option diagnostic", () => errorsOf(taskUri).find((error) => /number.*string/.test(error.message)), 30_000, 500);
  await replace(taskDoc, original);
  await waitFor("valid build extension diagnostics", () => errorsOf(taskUri).length === 0 ? true : undefined, 30_000, 500);

  // A configured project uses the same API; JSDoc gives JavaScript actions contextual types too.
  writeFileSync(path.join(sample, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, allowJs: true, checkJs: true, target: "ES2022", module: "ESNext" }, include: ["tools/**/*"] }));
  await vscode.commands.executeCommand("typescript.restartTsServer");
  await waitFor("configured ElideBuild API", async () => /interface ElideBuild/.test(await hoverAt(taskUri, "ElideBuild")) ? true : undefined, 60_000, 500);
  const jsUri = vscode.Uri.file(path.join(sample, "tools/javascript.mjs"));
  const jsDoc = await vscode.workspace.openTextDocument(jsUri);
  await vscode.window.showTextDocument(jsDoc);
  const jsOriginal = jsDoc.getText();
  await complete(jsDoc, '/** @param {ElideBuild} build */\nexport default function ({ task }) { task("js", ctx => { ctx. }); }\n', "ctx.", ["exec", "state", "tools", "log"]);
  await replace(jsDoc, jsOriginal);
  await waitFor("valid JavaScript extension diagnostics", () => errorsOf(jsUri).length === 0 ? true : undefined, 30_000, 500);

  // The contributed snippet produces real, typed extension code rather than requiring a hand-written reference.
  const snippetUri = vscode.Uri.file(path.join(sample, "tools/snippet.ts"));
  writeFileSync(snippetUri.fsPath, "");
  const snippetDoc = await vscode.workspace.openTextDocument(snippetUri);
  await vscode.window.showTextDocument(snippetDoc);
  await vscode.commands.executeCommand("editor.action.insertSnippet", { langId: "typescript", name: "Elide build extension" });
  assert.match(snippetDoc.getText(), /ElideBuild/);
  assert.match(snippetDoc.getText(), /task\("greet"/);
  await waitFor("snippet API hover", async () => /interface ElideBuild/.test(await hoverAt(snippetUri, "ElideBuild")) ? true : undefined, 30_000, 500);
  await vscode.commands.executeCommand("leaveSnippet");
  await replace(snippetDoc, "");

  const manifestUri = vscode.Uri.file(path.join(sample, "elide.pkl"));
  const manifestDoc = await vscode.workspace.openTextDocument(manifestUri);
  await vscode.window.showTextDocument(manifestDoc);
  const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>("vscode.executeLinkProvider", manifestUri);
  assert.ok(links?.some((link) => link.target?.fsPath === taskUri.fsPath), "configured extension links to its source");
  assert.ok(links?.some((link) => link.target?.fsPath === jsUri.fsPath), "bare extension links to its source");
  assert.ok(!links?.some((link) => manifestDoc.getText(link.range) === "Hello"), "config strings are not links");
  log("manifest links:", links?.map((link) => manifestDoc.getText(link.range)).join(", "));
  const manifestOriginal = manifestDoc.getText();
  const outside = mkdtempSync(path.join(path.dirname(sample), "outside-extension-"));
  const escapingLink = path.join(sample, "tools/outside.ts");
  try {
    writeFileSync(path.join(outside, "tasks.ts"), "export default () => {};\n");
    symlinkSync(path.join(outside, "tasks.ts"), escapingLink);
    await replace(manifestDoc, manifestOriginal.replace('from = "tools/tasks.ts"', 'from = "tools/outside.ts"'));
    const editedLinks = await vscode.commands.executeCommand<vscode.DocumentLink[]>("vscode.executeLinkProvider", manifestUri);
    assert.ok(!editedLinks?.some((link) => link.target?.fsPath === taskUri.fsPath), "navigation reflects the unsaved declaration");
    assert.ok(!editedLinks?.some((link) => link.target?.fsPath === escapingLink), "navigation rejects symlinks outside the source tree");
    assert.ok(editedLinks?.some((link) => link.target?.fsPath === jsUri.fsPath), "other valid declarations still link");
  } finally {
    await replace(manifestDoc, manifestOriginal);
    rmSync(escapingLink, { force: true });
    rmSync(outside, { recursive: true, force: true });
  }

  await vscode.commands.executeCommand("elide.sync");
  assert.ok(api.activity.getChildren().some((operation) => operation.label.startsWith("Sync ") && operation.state === "succeeded"), "real Elide sync succeeded");
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", manifestUri);
  const archive = lenses?.find((lens) => lens.command?.command === "elide.build" && lens.command.arguments?.[0]?.args?.[0] === "package-extension-tasks");
  assert.ok(archive?.command, "extension archive Build lens selects its actual packaging target");
  const build = async (args: string[]) => {
    const { promise, resolve, reject } = Promise.withResolvers<number | undefined>();
    const subscription = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution.task.source === "elide") resolve(event.exitCode);
    });
    const timeout = setTimeout(() => reject(new Error(`build ${args} timed out`)), 60_000);
    try {
      await vscode.commands.executeCommand("elide.build", { root: sample, args });
      assert.equal(await promise, 0);
    } finally {
      clearTimeout(timeout);
      subscription.dispose();
    }
  };
  await build(["greet", "greet-js"]);
  await build(archive.command.arguments![0].args);
  assert.ok(existsSync(path.join(sample, ".dev/artifacts/tasks.elx")), "archive produced by the code lens target");
  log("real Elide builds passed: greet, greet-js, package-extension-tasks");
  const buildTargets = { kind: "group", label: "Build targets", root: sample, group: "buildTargets" };
  const targetLabels = async () => (await api.explorer.getChildren(buildTargets) as { label: string }[]).map((node) => node.label);
  assert.ok((await targetLabels()).includes("greet"), "extension tasks appear in the existing Build targets tree");
  await replace(taskDoc, original.replace("\n};", '\n  task("added-on-save", { description: "Added while authoring" }, ctx => { ctx.log("saved extension"); });\n};'));
  assert.ok(await taskDoc.save());
  await waitFor("saved extension target refresh", async () => (await targetLabels()).includes("added-on-save") ? true : undefined, 30_000, 500);
  await build(["added-on-save"]);
  await replace(taskDoc, original);
  assert.ok(await taskDoc.save());
  assert.ok(!(await targetLabels()).includes("added-on-save"), "removed extension task disappears without re-sync");
  log("Build targets refreshed after task addition/removal on save");

  // A separate non-Elide folder must not inherit the build globals.
  const ordinary = mkdtempSync(path.join(path.dirname(sample), "ordinary-typescript-"));
  try {
    const ordinaryUri = vscode.Uri.file(path.join(ordinary, "ordinary.ts"));
    writeFileSync(ordinaryUri.fsPath, "const build: ElideBuild = undefined;\n");
    assert.ok(vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders!.length, 0, { uri: vscode.Uri.file(ordinary) }));
    const ordinaryDoc = await vscode.workspace.openTextDocument(ordinaryUri);
    await vscode.window.showTextDocument(ordinaryDoc);
    await waitFor("non-Elide API isolation", () => errorsOf(ordinaryUri).find((error) => /Cannot find name 'ElideBuild'/.test(error.message)), 30_000, 500);
    log("non-Elide TypeScript project remains isolated");
  } finally {
    rmSync(ordinary, { recursive: true, force: true });
  }
  // Everything modified by the editor stayed unsaved; the runnable sources are unchanged.
  assert.equal(readFileSync(taskUri.fsPath, "utf8"), original);
  assert.equal(readFileSync(jsUri.fsPath, "utf8"), jsOriginal);
  log("build-extension authoring scenario passed");
}
