/**
 * The `compose` scenario (see runner.ts), on the `elide-android-sample` checkout, built at least once. Checks the
 * Compose preview latency a user sees: focusing a preview file prewarms the renderer and compiler, so opening the
 * preview paints within about a second; a live edit repaints within the edit budget; and a reopened panel reuses
 * the backend kept alive after closing.
 */
import assert from "node:assert/strict";
import path from "node:path";
import * as vscode from "vscode";
import type { ComposePreviewPaint } from "../../src/composePreview.js";
import type { ElideExtensionApi as ElideApi } from "../../src/extension.js";
import { log, waitFor } from "./helpers.js";

const GALLERY = 13;
const OPEN_BUDGET_MS = 1_500;
const EDIT_BUDGET_MS = 1_500;

export async function runComposeScenario(): Promise<void> {
  const sample = process.env.ELIDE_TEST_SAMPLE!;
  const gallery = vscode.Uri.file(path.join(sample, "app", "src", "main", "kotlin", "sample", "app", "PreviewGallery.kt"));
  const extension = vscode.extensions.all.find((e) => e.id.endsWith(".elide"));
  assert.ok(extension, "elide extension found");
  const api = await waitFor("compose preview api", () => (extension.exports as ElideApi | undefined)?.composePreview, 60_000, 200);
  const paints: ComposePreviewPaint[] = [];
  api.onDidPaint((paint) => {
    log("paint", JSON.stringify(paint));
    paints.push(paint);
  });
  const nextPaint = (after: number, what: string, final: boolean) =>
    waitFor(what, () => paints.slice(after).find((paint) => paint.source === gallery.fsPath && (!final || !paint.verifying)), 300_000, 20);

  // 1. Focusing a preview file after the sync prewarms its backend from the last build's classes.
  let prewarmed: string | undefined;
  api.onDidPrewarm((key) => { prewarmed = key; });
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(gallery), { preview: false });
  log("waiting for sync and prewarm");
  const key = await waitFor("sync and prewarm", () => prewarmed, 300_000, 200);
  log("prewarmed", key);

  // 2. Opening the preview paints the gallery within the open budget, then the build confirms it.
  let mark = paints.length;
  let started = performance.now();
  await vscode.commands.executeCommand("elide.androidComposePreview");
  const first = await nextPaint(mark, "first paint", false);
  const openMs = performance.now() - started;
  log(`open: painted ${first.images} images in ${Math.round(openMs)} ms (verifying: ${first.verifying})`);
  assert.equal(first.images, GALLERY);
  assert.equal(first.failed, 0);
  assert.ok(openMs < OPEN_BUDGET_MS, `prewarmed preview painted in ${Math.round(openMs)} ms, budget ${OPEN_BUDGET_MS} ms`);
  const confirmed = await nextPaint(mark, "build confirmation", true);
  log(`open: build confirmed after ${Math.round(performance.now() - started)} ms (${confirmed.elapsedMs} ms in session)`);

  // The sync and the preview build are recorded step by step, with the commands they ran and where the time went.
  const activity = (extension.exports as ElideApi).activity;
  const operations = activity.getChildren();
  const sync = operations.find((operation) => operation.label.startsWith("Sync ") && operation.state === "succeeded");
  assert.ok(sync, "a finished sync in the Activity view");
  const manifestStep = sync.children.find((step) => step.label === "Reading the project manifest");
  assert.ok(manifestStep?.children.some((command) => command.label.startsWith("elide project export") && command.state === "succeeded"), "the sync's manifest step ran `elide project export`");
  const opened = operations.find((operation) => operation.label === "Compose preview: PreviewGallery.kt" && operation.state === "succeeded");
  assert.ok(opened, "the preview build in the Activity view");
  const buildStep = opened.children.find((step) => step.label === "Build");
  assert.equal(buildStep?.state, "succeeded");
  assert.match(buildStep.children[0]?.label ?? "", /^elide build /);
  const buildLog = activity.provideTextDocumentContent(activity.uriOf(opened));
  assert.match(buildLog, /where the time went:/);
  assert.match(buildLog, /\$ elide build|Build successful/);
  log(`activity: ${opened.label} ${opened.durationMs} ms: ${opened.children.map((step) => `${step.label} ${step.durationMs} ms`).join(", ")}`);

  // 3. A live edit (unsaved) repaints within the edit budget.
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(gallery), { preview: false, viewColumn: vscode.ViewColumn.One });
  mark = paints.length;
  started = performance.now();
  await editor.edit((builder) => builder.insert(new vscode.Position(editor.document.lineCount, 0), `\n// preview edit ${Date.now()}\n`));
  const edited = await nextPaint(mark, "edit paint", true);
  const editMs = performance.now() - started;
  log(`edit: painted in ${Math.round(editMs)} ms`);
  assert.equal(edited.images, GALLERY);
  assert.ok(editMs < EDIT_BUDGET_MS, `edit painted in ${Math.round(editMs)} ms, budget ${EDIT_BUDGET_MS} ms`);
  mark = paints.length;
  await vscode.commands.executeCommand("workbench.action.files.revert");
  await nextPaint(mark, "revert paint", true);

  // 4. Closing keeps the backend alive: reopening paints within the open budget again.
  const closeTab = async () => {
    const tab = vscode.window.tabGroups.all.flatMap((group) => group.tabs).find((item) => item.label === "Compose: PreviewGallery.kt");
    assert.ok(tab, "preview panel tab");
    await vscode.window.tabGroups.close(tab);
  };
  await closeTab();
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(gallery), { preview: false, viewColumn: vscode.ViewColumn.One });
  mark = paints.length;
  started = performance.now();
  await vscode.commands.executeCommand("elide.androidComposePreview");
  const reopened = await nextPaint(mark, "reopen paint", false);
  const reopenMs = performance.now() - started;
  log(`reopen: painted in ${Math.round(reopenMs)} ms`);
  assert.equal(reopened.images, GALLERY);
  assert.ok(reopenMs < OPEN_BUDGET_MS, `reopened preview painted in ${Math.round(reopenMs)} ms, budget ${OPEN_BUDGET_MS} ms`);
  await nextPaint(mark, "reopen confirmation", true);

  // 5. Without a warm backend (as after restarting VS Code), unchanged sources still paint their stored gallery
  //    while the renderer and the build start; the next edit renders from scratch.
  await closeTab();
  const settings = vscode.workspace.getConfiguration("elide.android.composePreview");
  await settings.update("prewarm", false, vscode.ConfigurationTarget.Global);
  await settings.update("keepAliveMinutes", 0, vscode.ConfigurationTarget.Global);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(gallery), { preview: false, viewColumn: vscode.ViewColumn.One });
  mark = paints.length;
  started = performance.now();
  await vscode.commands.executeCommand("elide.androidComposePreview");
  const restored = await nextPaint(mark, "cold backend paint", false);
  const restoredMs = performance.now() - started;
  log(`cold backend: painted stored gallery in ${Math.round(restoredMs)} ms`);
  assert.equal(restored.images, GALLERY);
  assert.ok(restoredMs < OPEN_BUDGET_MS, `stored gallery painted in ${Math.round(restoredMs)} ms, budget ${OPEN_BUDGET_MS} ms`);
  await nextPaint(mark, "cold backend confirmation", true);
  const coldEditor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(gallery), { preview: false, viewColumn: vscode.ViewColumn.One });
  mark = paints.length;
  started = performance.now();
  await coldEditor.edit((builder) => builder.insert(new vscode.Position(coldEditor.document.lineCount, 0), `\n// cold edit ${Date.now()}\n`));
  const coldEdit = await nextPaint(mark, "cold backend edit paint", true);
  log(`cold backend: first edit painted in ${Math.round(performance.now() - started)} ms`);
  assert.equal(coldEdit.images, GALLERY);
  await vscode.commands.executeCommand("workbench.action.files.revert");
  await closeTab();
  log("compose ok");
}
