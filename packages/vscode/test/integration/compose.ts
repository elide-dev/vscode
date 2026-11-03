/**
 * The `compose` scenario (see runner.ts), on the `elide-android-sample` checkout, built at least once. Checks the
 * 13-image gallery in a managed Kotlin module with Room/kapt: optimistic unsaved edits meet the paint budget,
 * processor confirmation is measured separately, schema changes regenerate visible output, and invalid queries
 * surface diagnostics. Reverting and reopening must reuse the confirmed gallery; opening over an unsaved edit must
 * leave it unsaved. Pointing `ELIDE_ANDROID_SAMPLE` through a symlink (macOS `/tmp`) checks a workspace opened at
 * a path other than the canonical one Elide records.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  const database = vscode.Uri.file(path.join(sample, "app", "src", "main", "kotlin", "sample", "data", "JourneyDatabase.kt"));
  const extension = vscode.extensions.all.find((e) => e.id.endsWith(".elide"));
  assert.ok(extension, "elide extension found");
  const api = await waitFor("compose preview api", () => (extension.exports as ElideApi | undefined)?.composePreview, 60_000, 200);
  const paints: ComposePreviewPaint[] = [];
  const errors: { source: string; message: string }[] = [];
  api.onDidError((error) => {
    log("preview error", JSON.stringify(error));
    errors.push(error);
  });
  api.onDidPaint((paint) => {
    log("paint", JSON.stringify(paint));
    paints.push(paint);
  });
  const nextPaint = (after: number, what: string, final: boolean, matches: (paint: ComposePreviewPaint) => boolean = () => true) =>
    waitFor(what, () => paints.slice(after).find((paint) => paint.source === gallery.fsPath && (!final || !paint.verifying) && matches(paint)), 300_000, 20);

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

  // Saved-source Inspect must expose measured call sites without a sacrificial unsaved edit.
  mark = paints.length;
  api.setInspect(true);
  const inspected = await nextPaint(mark, "saved gallery inspection", true, (paint) => paint.inspection.enabled);
  assert.equal(inspected.inspection.images, GALLERY, "every saved preview supplies selectable layout bounds");
  assert.ok(inspected.inspection.sources.includes(path.join(sample, "components", "src", "main", "kotlin", "sample", "components", "JourneyCard.kt")),
    "saved inspection includes instrumented workspace-library call sites");
  assert.equal((await vscode.workspace.openTextDocument(gallery)).isDirty, false, "Inspect does not mutate saved sources");
  log("saved Inspect", JSON.stringify(inspected.inspection));
  api.setInspect(false);

  // 3. Body-only edits paint optimistically within budget; confirmation must not rerun Room.
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(gallery), { preview: false, viewColumn: vscode.ViewColumn.One });
  const databaseDocument = await vscode.workspace.openTextDocument(database);
  assert.equal(editor.document.isDirty, false, "the fixture gallery starts saved");
  assert.equal(databaseDocument.isDirty, false, "the fixture schema starts saved");
  const replace = async (target: vscode.TextEditor, before: string, after: string) => {
    const text = target.document.getText();
    const offset = text.indexOf(before);
    assert.ok(offset >= 0 && text.indexOf(before, offset + before.length) < 0, `unique fixture edit: ${before}`);
    assert.ok(await target.edit((builder) => builder.replace(
      new vscode.Range(target.document.positionAt(offset), target.document.positionAt(offset + before.length)), after,
    )));
    assert.equal(target.document.isDirty, true, "live edits remain unsaved");
  };
  const revert = async (document: vscode.TextDocument) => {
    await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.One });
    await vscode.commands.executeCommand("workbench.action.files.revert");
  };
  const assertGallery = (paint: ComposePreviewPaint) => {
    assert.equal(paint.images, GALLERY);
    assert.equal(paint.failed, 0);
    assert.match(paint.contentHash, /^[a-f0-9]{64}$/);
  };
  assertGallery(confirmed);
  assert.ok(confirmed.processing, "the preview-bearing app has a processing stage");
  let baseline = confirmed;
  try {
    mark = paints.length;
    started = performance.now();
    await replace(editor, 'BasicText("Hello World!")', 'BasicText("Hello live Room!")');
    const edited = await nextPaint(mark, "optimistic body edit", false, (paint) => paint.contentHash !== baseline.contentHash);
    const editMs = performance.now() - started;
    assertGallery(edited);
    assert.equal(edited.verifying, true, "body edit paints before processing confirmation");
    assert.ok(editMs < EDIT_BUDGET_MS, `optimistic edit painted in ${Math.round(editMs)} ms, budget ${EDIT_BUDGET_MS} ms`);
    const bodyConfirmed = await nextPaint(mark, "body processing confirmation", true, (paint) => paint.contentHash === edited.contentHash);
    log(`body edit: optimistic ${Math.round(editMs)} ms; confirmed ${Math.round(performance.now() - started)} ms`);
    assertGallery(bodyConfirmed);
    assert.ok(bodyConfirmed.processing);
    assert.equal(bodyConfirmed.processing.apt, baseline.processing!.apt, "unchanged stubs do not rerun Room");
    assert.ok(bodyConfirmed.processing.stubs > baseline.processing!.stubs, "body edit verifies kapt stubs");
    mark = paints.length;
    started = performance.now();
    await revert(editor.document);
    baseline = await nextPaint(mark, "body revert reuses gallery", true, (paint) => paint.reused && paint.contentHash === confirmed.contentHash);
    assertGallery(baseline);
    log(`body revert: reused gallery in ${Math.round(performance.now() - started)} ms`);

    // Layout edits change the composition, not the Room declarations in this module.
    for (const [name, replacement] of [
      ["nested layout", 'Row { BasicText("Hello World!"); BasicText("Structural preview") }'],
      ["conditional composition", 'if (example.stops > 0) { BasicText("Structural branch") }'],
      ["new composable", 'LiveStructuralText()'],
    ] as const) {
      mark = paints.length;
      started = performance.now();
      const text = editor.document.getText();
      await replace(editor, text, text.replace('BasicText("Hello World!")', replacement)
        + (name === "new composable" ? '\n@Composable\nprivate fun LiveStructuralText() { BasicText("Structural helper") }\n' : ""));
      const structural = await nextPaint(mark, `${name} paint`, false, (paint) => paint.contentHash !== baseline.contentHash);
      const paintMs = performance.now() - started;
      assertGallery(structural);
      assert.ok(paintMs < EDIT_BUDGET_MS, `${name} painted in ${Math.round(paintMs)} ms, budget ${EDIT_BUDGET_MS} ms`);
      const verified = await nextPaint(mark, `${name} confirmation`, true, (paint) => paint.contentHash === structural.contentHash);
      log(`${name}: optimistic ${Math.round(paintMs)} ms; confirmed ${Math.round(performance.now() - started)} ms; processing ${JSON.stringify(verified.processing)}`);
      assertGallery(verified);
      assert.ok(performance.now() - started < 2_500, `${name} confirms without a cold recompile`);
      if (name !== "new composable") assert.equal(verified.processing!.apt, baseline.processing!.apt);
      else {
        assert.ok(verified.processing!.apt > baseline.processing!.apt, "new declarations still run processors");
        mark = paints.length;
        started = performance.now();
        await replace(editor, 'BasicText("Structural helper")', 'Row { BasicText("Warm structural follow-up"); BasicText("Still warm") }');
        const followup = await nextPaint(mark, "structural follow-up", false, (paint) => paint.contentHash !== verified.contentHash);
        const followupMs = performance.now() - started;
        assertGallery(followup);
        assert.ok(followupMs < EDIT_BUDGET_MS, `structural follow-up painted in ${Math.round(followupMs)} ms`);
        await nextPaint(mark, "structural follow-up confirmation", true, (paint) => paint.contentHash === followup.contentHash);
        log(`structural follow-up: optimistic ${Math.round(followupMs)} ms; confirmed ${Math.round(performance.now() - started)} ms`);
      }
      mark = paints.length;
      await revert(editor.document);
      baseline = await nextPaint(mark, `${name} revert`, true, (paint) => paint.reused && paint.contentHash === confirmed.contentHash);
    }

    // A column rename leaves the Kotlin constructor unchanged. Only regenerated Room code can change the
    // identity hash drawn by StatePreview: entity reflection or a stale generated class cannot pass this check.
    const schemaEditor = await vscode.window.showTextDocument(databaseDocument, { preview: false, viewColumn: vscode.ViewColumn.One });
    mark = paints.length;
    started = performance.now();
    await replace(schemaEditor, '@ColumnInfo(name = "stops")', '@ColumnInfo(name = "live_stops")');
    const schemaOptimistic = await nextPaint(mark, "optimistic entity edit", false);
    assertGallery(schemaOptimistic);
    assert.equal(schemaOptimistic.verifying, true);
    assert.equal(schemaOptimistic.contentHash, baseline.contentHash, "optimistic schema paint uses the last generated Room implementation");
    const schemaConfirmed = await nextPaint(mark, "regenerated Room schema paint", true, (paint) => paint.contentHash !== baseline.contentHash);
    assertGallery(schemaConfirmed);
    assert.ok(schemaConfirmed.processing && baseline.processing);
    assert.ok(schemaConfirmed.processing.apt > baseline.processing.apt, "changed entity stubs rerun Room");
    log(`entity edit: optimistic ${schemaOptimistic.elapsedMs} ms; regenerated confirmation ${Math.round(performance.now() - started)} ms`);
    mark = paints.length;
    await revert(databaseDocument);
    baseline = await nextPaint(mark, "entity revert reuses gallery", true, (paint) => paint.reused && paint.contentHash === confirmed.contentHash);
    assertGallery(baseline);

    // Adding a defaulted Kotlin property keeps handwritten callers valid, but the old generated
    // Java constructor call no longer compiles. Verification must recover without requiring a save.
    const declarationErrors = errors.length;
    mark = paints.length;
    await replace(schemaEditor, "  val createdAt: Long,", '  val createdAt: Long,\n  val previewNote: String = "",');
    const declarationConfirmed = await nextPaint(mark, "generated constructor recovery", true, (paint) => paint.contentHash !== baseline.contentHash);
    assertGallery(declarationConfirmed);
    assert.ok(declarationConfirmed.processing!.apt > baseline.processing!.apt);
    assert.equal(errors.length, declarationErrors, "obsolete generated constructor errors must recover through kapt");
    mark = paints.length;
    await revert(databaseDocument);
    baseline = await nextPaint(mark, "property revert reuses gallery", true, (paint) => paint.reused && paint.contentHash === confirmed.contentHash);

    // Kotlin accepts this annotation value, but Room must reject it. Do not accept a confirmed stale image.
    const queryEditor = await vscode.window.showTextDocument(databaseDocument, { preview: false, viewColumn: vscode.ViewColumn.One });
    const errorMark = errors.length;
    mark = paints.length;
    started = performance.now();
    await replace(queryEditor, "SELECT * FROM journeys ORDER BY createdAt DESC, id DESC",
      "SELECT missing_live_column FROM journeys ORDER BY createdAt DESC, id DESC");
    const processorError = await waitFor("Room query processor diagnostic", () => errors.slice(errorMark)
      .find((error) => error.source === gallery.fsPath && /missing_live_column|no such column/i.test(error.message)), 300_000, 20);
    log(`invalid query: diagnostic after ${Math.round(performance.now() - started)} ms: ${processorError.message}`);
    assert.ok(!paints.slice(mark).some((paint) => paint.source === gallery.fsPath && !paint.verifying),
      "invalid query never confirms stale generated output");
    assert.equal(databaseDocument.isDirty, true, "processor diagnostic came from an unsaved query");
    mark = paints.length;
    started = performance.now();
    await revert(databaseDocument);
    const recovered = await nextPaint(mark, "query revert reuses gallery", true, (paint) => paint.reused && paint.contentHash === confirmed.contentHash);
    assertGallery(recovered);
    assert.ok(performance.now() - started < EDIT_BUDGET_MS, "reverting a processor error reuses the stored gallery within the edit budget");
  } finally {
    if (databaseDocument.isDirty) await revert(databaseDocument);
    if (editor.document.isDirty) await revert(editor.document);
  }

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

  // 4b. Opening a preview over an unsaved edit builds from the disk without saving any editor, under VS Code's
  //     default `task.saveBeforeRun` (`always`), and paints the editor's text.
  await closeTab();
  const unsavedEditor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(gallery), { preview: false, viewColumn: vscode.ViewColumn.One });
  const onDisk = readFileSync(gallery.fsPath, "utf8");
  const saved: string[] = [];
  const saving = vscode.workspace.onWillSaveTextDocument((event) => saved.push(event.document.uri.fsPath));
  try {
    await unsavedEditor.edit((builder) => builder.insert(new vscode.Position(unsavedEditor.document.lineCount, 0), `\n// unsaved ${Date.now()}\n`));
    mark = paints.length;
    await vscode.commands.executeCommand("elide.androidComposePreview");
    const unsavedConfirmed = await nextPaint(mark, "unsaved open confirmation", true);
    assertGallery(unsavedConfirmed);
    assert.equal(unsavedEditor.document.isDirty, true, "opening a preview leaves the unsaved editor dirty");
    assert.equal(readFileSync(gallery.fsPath, "utf8"), onDisk, "opening a preview does not write editor text to disk");
    assert.deepEqual(saved, [], "opening a preview saves no editor");
    log("unsaved open: editor stays dirty, build confirmed from the disk baseline");
  } finally {
    saving.dispose();
    await revert(unsavedEditor.document);
  }

  // 5. Without a warm backend (as after restarting VS Code), unchanged sources still paint their stored gallery
  //    while the renderer and the build start; confirmation initializes one private compiler baseline.
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
  const coldConfirmed = await nextPaint(mark, "cold backend confirmation", true);
  const coldConfirmedMs = performance.now() - started;
  log(`cold backend: confirmed in ${Math.round(coldConfirmedMs)} ms; processing ${JSON.stringify(coldConfirmed.processing)}`);
  assert.equal(coldConfirmed.processing?.apt, 1, "cold initialization processes the instrumented baseline once, not seeded then private dependencies");
  assert.equal(coldConfirmed.processing?.stubs, 1, "cold initialization verifies a single dependency baseline");
  mark = paints.length;
  api.setInspect(true);
  const coldInspected = await nextPaint(mark, "cold saved gallery inspection", true, (paint) => paint.inspection.enabled);
  assert.equal(coldInspected.inspection.images, GALLERY, "cached cold reopen retains measured bounds without a live edit");
  assert.ok(coldInspected.inspection.sources.some((file) => file.endsWith(`${path.sep}JourneyCard.kt`)));
  assert.deepEqual(coldInspected.processing, coldConfirmed.processing, "Inspect reuses initialized processing and compiler state");
  api.setInspect(false);
  const coldEditor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(gallery), { preview: false, viewColumn: vscode.ViewColumn.One });
  mark = paints.length;
  started = performance.now();
  await coldEditor.edit((builder) => builder.insert(new vscode.Position(coldEditor.document.lineCount, 0), `\n// cold edit ${Date.now()}\n`));
  const coldOptimistic = await nextPaint(mark, "cold backend optimistic edit paint", false);
  const coldEditMs = performance.now() - started;
  const coldEdit = await nextPaint(mark, "cold backend edit confirmation", true);
  log(`cold backend: cached ${Math.round(restoredMs)} ms; confirmed ${Math.round(coldConfirmedMs)} ms; first edit optimistic ${Math.round(coldEditMs)} ms, confirmed ${Math.round(performance.now() - started)} ms`);
  assertGallery(coldEdit);
  assert.equal(coldOptimistic.verifying, true, "the initialized first edit paints before processing verification");
  assert.ok(coldEditMs < EDIT_BUDGET_MS, `cold backend's initialized first edit painted in ${Math.round(coldEditMs)} ms, budget ${EDIT_BUDGET_MS} ms`);
  assert.equal(coldEdit.processing?.apt, coldConfirmed.processing?.apt, "first comment edit cannot rerun Room");
  assert.equal(coldEdit.processing?.stubs, coldConfirmed.processing!.stubs + 1, "first edit needs only one processing verification");
  await vscode.commands.executeCommand("workbench.action.files.revert");
  await closeTab();

  // 6. The Kotlin LSP flags capitalized function names except on @Composable functions (Elide's server plugin).
  const lspEditor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(gallery), { preview: false, viewColumn: vscode.ViewColumn.One });
  await lspEditor.edit((builder) => builder.insert(new vscode.Position(lspEditor.document.lineCount, 0), "\nfun NotComposable() {}\n"));
  const functionNames = () => vscode.languages.getDiagnostics(gallery)
    .filter((d) => (typeof d.code === "object" ? d.code.value : d.code) === "FunctionName")
    .map((d) => lspEditor.document.getText(d.range));
  // Wait for the analysis of the edited document, which reports the plain function.
  const flagged = await waitFor("FunctionName on the plain function", () => functionNames().includes("NotComposable") ? functionNames() : undefined, 300_000);
  log(`FunctionName: ${flagged.join(", ")}`);
  assert.deepEqual(flagged, ["NotComposable"]);
  await vscode.commands.executeCommand("workbench.action.files.revert");
  log("compose ok");
}
