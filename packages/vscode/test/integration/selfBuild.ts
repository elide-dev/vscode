/** Exercises the self-build checkout in place; all source edits stay unsaved and are reverted. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as vscode from "vscode";
import type { ElideExtensionApi } from "../../src/extension.js";
import { errorsOf, hoverAt, log, waitFor } from "./helpers.js";

export async function runSelfBuildScenario(): Promise<void> {
  const root = process.env.ELIDE_TEST_SAMPLE!;
  const files = [
    "packages/base/main/dev/elide/core/jvm/JvmLogger.kt",
    "packages/jvmlang/main/dev/elide/runtime/kotlin/KotlinRunnable.kt",
    "packages/base/test/dev/elide/core/jvm/JvmLoggerTest.kt",
  ];
  const originals = new Map(files.map((file) => [file, readFileSync(path.join(root, file), "utf8")]));
  const failures: string[] = [];
  const check = async (name: string, run: () => Promise<void>) => {
    const started = Date.now();
    try { await run(); log(`PASS ${name} (${Date.now() - started} ms)`); }
    catch (error) { failures.push(`${name}: ${error}`); log(`FAIL ${name}: ${error}`); }
  };
  const at = (document: vscode.TextDocument, text: string, delta = 0) => {
    const offset = document.getText().indexOf(text);
    assert.ok(offset >= 0, `${text} in ${document.uri.fsPath}`);
    return document.positionAt(offset + delta);
  };
  const open = async (file: string) => vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, file)));
  const extension = vscode.extensions.getExtension<ElideExtensionApi>("elide.elide")!;
  const api = await extension.activate();
  await check("self-build synchronization", async () => {
    const sync = await waitFor("self-build sync", () => api.activity.getChildren().find((node) => node.label.startsWith("Sync ") && !node.running), 600_000, 1_000);
    const output = api.activity.provideTextDocumentContent(api.activity.uriOf(sync));
    log(output);
    assert.equal(sync.state, "succeeded", output);
    const pending = [...sync.children];
    while (pending.length) {
      const step = pending.pop()!;
      assert.notEqual(step.state, "failed", `${step.path.join(" > ")} failed; see the sync log above`);
      pending.push(...step.children);
    }
  });
  const logger = await open(files[0]!);
  const runnable = await open(files[1]!);
  const test = await open(files[2]!);
  await vscode.window.showTextDocument(logger, { preview: false });
  await waitFor("self-build Kotlin analysis", async () => {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", logger.uri, at(logger, "class JvmLogger", 6));
    return hovers?.length ? hovers : undefined;
  }, 240_000, 1_000);

  try {
    for (const document of [logger, runnable, test]) {
      await vscode.window.showTextDocument(document, { preview: false });
      await check(`resolved CodeLenses: ${path.basename(document.uri.fsPath)}`, async () => {
        const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", document.uri, 1_000);
        const reference = lenses.find((lens) => lens.command?.command === "komodo.showReferences");
        assert.ok(reference?.command, `resolved reference lens among ${JSON.stringify(lenses)}`);
        assert.ok(lenses.every((lens) => lens.command), "every returned lens resolves");
        log("lenses", lenses.map((lens) => `${lens.range.start.line + 1}: ${lens.command?.title}`).join(" | "));
        await vscode.commands.executeCommand(reference.command.command, ...(reference.command.arguments ?? []));
        await vscode.commands.executeCommand("closeReferenceSearch");
      });
      await check(`semantic highlighting: ${path.basename(document.uri.fsPath)}`, async () => {
        const declaration = document === runnable ? "interface KotlinRunnable" : document === logger ? "class JvmLogger" : "class JvmLoggerTest";
        const position = at(document, declaration, declaration.indexOf(" ") + 1);
        const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>("vscode.provideDocumentSemanticTokensLegend", document.uri);
        const full = await vscode.commands.executeCommand<vscode.SemanticTokens>("vscode.provideDocumentSemanticTokens", document.uri);
        const ranged = await vscode.commands.executeCommand<vscode.SemanticTokens>("vscode.provideDocumentRangeSemanticTokens",
          document.uri, new vscode.Range(0, 0, document.lineCount, 0));
        for (const tokens of [full, ranged]) {
          let line = 0;
          let character = 0;
          let declaredType: string | undefined;
          for (let index = 0; index < tokens.data.length; index += 5) {
            line += tokens.data[index]!;
            character = tokens.data[index] === 0 ? character + tokens.data[index + 1]! : tokens.data[index + 1]!;
            if (line === position.line && character === position.character) declaredType = legend.tokenTypes[tokens.data[index + 3]!];
          }
          assert.equal(declaredType, document === runnable ? "interface" : "class");
        }
      });
      await check(`diagnostics: ${path.basename(document.uri.fsPath)}`, async () => {
        // Opening the document initiates diagnostics; CodeLens resolution above waits for the same analysis.
        await delay(1_000);
        assert.deepEqual(errorsOf(document.uri).map((d) => `${d.range.start.line + 1}: ${d.message}`), []);
      });
    }
    await check("cross-module definition", async () => {
      const definitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>("vscode.executeDefinitionProvider", runnable.uri, at(runnable, "Precompiler.BundleInfo"));
      const targets = definitions.map((item) => ("targetUri" in item ? item.targetUri : item.uri).fsPath);
      assert.ok(targets.some((target) => target.includes("/packages/base/") && target.endsWith("Precompiler.kt")), targets.join(", "));
    });
    await check("library hover and source navigation", async () => {
      const position = at(runnable, "Function<Context");
      assert.match(await hoverAt(runnable.uri, "Function<Context"), /Function/);
      const definitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>("vscode.executeDefinitionProvider", runnable.uri, position);
      const target = definitions.map((item) => "targetUri" in item ? item.targetUri : item.uri).find((uri) => uri.scheme === "komodo-library");
      assert.ok(target, JSON.stringify(definitions));
      assert.match((await vscode.workspace.openTextDocument(target)).getText(), /interface Function/);
    });
    await check("unsaved declaration edits, diagnostics and lens recovery", async () => {
      const editor = await vscode.window.showTextDocument(logger, { preview: false });
      const end = logger.positionAt(logger.getText().length);
      assert.ok(await editor.edit((edit) => edit.insert(end, "\nprivate fun selfBuildEditorProbe(): String = 123\n")));
      await waitFor("type mismatch after unsaved edit", () => errorsOf(logger.uri).find((diagnostic) => diagnostic.range.start.line >= end.line && /type mismatch|return type/i.test(diagnostic.message)), 30_000, 100);
      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", logger.uri, 1_000);
      assert.ok(lenses.some((lens) => lens.range.contains(at(logger, "selfBuildEditorProbe")) && lens.command?.command === "komodo.showReferences"));
      await vscode.commands.executeCommand("workbench.action.files.revert");
      await waitFor("diagnostics clear after revert", () => errorsOf(logger.uri).length === 0, 30_000, 100);
      const restored = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", logger.uri, 1_000);
      assert.ok(restored.some((lens) => lens.range.contains(at(logger, "class JvmLogger", 6)) && lens.command?.command === "komodo.showReferences"));
    });
    await check("build-extension TypeScript authoring", async () => {
      const document = await open("tools/build/tasks/jvm.ts");
      await vscode.window.showTextDocument(document, { preview: false });
      const position = at(document, "ElideBuild");
      await waitFor("ElideBuild API type", async () => {
        const result = await hoverAt(document.uri, "ElideBuild");
        return /interface ElideBuild/.test(result) ? result : undefined;
      }, 60_000, 500);
      const definitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        "vscode.executeDefinitionProvider", document.uri, position);
      const targets = definitions.map((item) => ("targetUri" in item ? item.targetUri : item.uri).fsPath);
      assert.ok(targets.some((target) => target.endsWith("/build.d.ts")), targets.join(", "));
      await delay(1_000);
      assert.deepEqual(errorsOf(document.uri).map((diagnostic) => diagnostic.message), []);
    });
    await check("workspace task discovery", async () => {
      const tasks = await vscode.tasks.fetchTasks({ type: "elide" });
      const names = tasks.map((task) => task.name);
      for (const project of ["packages/generated", "packages/jvmlang", "packages/cli", "packages/jvmtools"]) {
        assert.ok(tasks.some((task) => task.definition.command === "build" && task.definition.project === project),
          `build task for ${project} among ${names.join(", ")}`);
      }
    });
  } finally {
    for (const document of [logger, runnable, test]) {
      if (document.isDirty) {
        await vscode.window.showTextDocument(document);
        await vscode.commands.executeCommand("workbench.action.files.revert");
      }
    }
    for (const [file, original] of originals) assert.equal(readFileSync(path.join(root, file), "utf8"), original, `${file} unchanged on disk`);
  }
  assert.deepEqual(failures, [], failures.join("\n"));
}
