/**
 * The `compose-komodo` scenario (see runner.ts): the `elide-android-sample` previews with the `komodo` engine, which renders every
 * card in the workspace language server and none with layoutlib snapshots. Analysis and preview share one process
 * and Workspace compiler; Komodo's language server (ELIDE_KOMODO_LSP, `elide.kotlinLsp.server` = `komodo`) also discovers
 * the previews. In components' JourneyCard.kt every card is live, the two values of the
 * `@PreviewParameter(limit = 2)` provider the file declares included: unsaved edits reach the plain card by push, a click runs its
 * handler, and an edit that does not compile is a Komodo diagnostic in Problems. The app's PreviewGallery.kt is live in full, its
 * `@PreviewParameter` cards included: they keep their `previewId:index` identity through a pushed edit, and a click on one
 * recomposes that card alone. Prewarming, body edits and cross-module edits must keep the same workspace daemon without touching disk sources.
 * Last, every sample file that declares a `@Preview` opens with all its cards live.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as vscode from "vscode";
import type { ComposePreviewPaint } from "../../src/composePreview.js";
import type { ElideExtensionApi as ElideApi } from "../../src/extension.js";
import { log, waitFor } from "./helpers.js";

/**
 * Unsaved edit to the live card's new frame: Komodo's compile is 1.5 to 3.5 s on this host (2.6 s measured for JourneyCard.kt,
 * 4.4 s for the 13-card gallery), plus the panel.
 */
const LIVE_EDIT_BUDGET_MS = 6_000;
/** A live card's first frame: the daemon compiles the file and starts the renderer when the preview opens. */
const LIVE_TIMEOUT_MS = 300_000;


/** Inspect only this extension host's descendants, never unrelated developer JVMs. */
function workspaceServerPid(checkpoint: string): number {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8" }).trim().split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((row): row is RegExpExecArray => row !== null)
    .map((row) => ({ pid: Number(row[1]), parent: Number(row[2]), rssKiB: Number(row[3]), command: row[4]! }));
  const descendants = new Set([process.pid]);
  for (let previous = -1; previous !== descendants.size;) {
    previous = descendants.size;
    for (const row of rows) if (descendants.has(row.parent)) descendants.add(row.pid);
  }
  const children = rows.filter((row) => row.pid !== process.pid && descendants.has(row.pid));
  assert.ok(!children.some((row) => /komodo-preview|ArchiveClassesAtExit=.*training/.test(row.command)),
    `no standalone preview or preview CDS trainer: ${JSON.stringify(children)}`);
  const jvms = children.filter((row) => /(?:java|java\.bin)\s/.test(row.command));
  const comparison = process.env.ELIDE_KOMODO_RUNTIME === "jvm";
  if (!comparison) assert.equal(jvms.length, 0, `native workspace must not launch a JVM: ${JSON.stringify(jvms)}`);
  const servers = comparison
    ? jvms.filter((row) => /komodo|dev\.elide\.kotlin/.test(row.command))
    : children.filter((row) => /\/komodo(?:\s|$)/.test(row.command));
  assert.equal(servers.length, 1, `one workspace Komodo daemon: ${JSON.stringify(children)}`);
  log(`${checkpoint}: workspace pid ${servers[0]!.pid}, RSS ${(servers[0]!.rssKiB / 1024).toFixed(1)} MiB (${comparison ? "JVM comparison" : "native"})`);
  return servers[0]!.pid;
}
export async function runComposeKomodoScenario(): Promise<void> {
  const sample = process.env.ELIDE_TEST_SAMPLE!;
  const card = vscode.Uri.file(path.join(sample, "components", "src", "main", "kotlin", "sample", "components", "JourneyCard.kt"));
  const gallery = vscode.Uri.file(path.join(sample, "app", "src", "main", "kotlin", "sample", "app", "PreviewGallery.kt"));
  const diskSources = new Map([card, gallery].map((uri) => [uri.fsPath, readFileSync(uri.fsPath)]));
  const extension = vscode.extensions.all.find((e) => e.id.endsWith(".elide"));
  assert.ok(extension, "elide extension found");
  assert.equal(vscode.workspace.getConfiguration("elide.android.composePreview").get("engine"), "komodo");
  const api = await waitFor("compose preview api", () => (extension.exports as ElideApi | undefined)?.composePreview, 60_000, 200);
  const paints: ComposePreviewPaint[] = [];
  api.onDidError((error) => log("preview error", JSON.stringify(error)));
  api.onDidPaint((paint) => {
    log("paint", JSON.stringify({ ...paint, inspection: undefined, cards: undefined }));
    paints.push(paint);
  });
  const nextPaint = async (source: vscode.Uri, after: number, what: string, matches: (paint: ComposePreviewPaint) => boolean, timeoutMs = LIVE_TIMEOUT_MS) => {
    const paint = await waitFor(what, () => paints.slice(after).find((paint) => paint.source === source.fsPath && matches(paint)), timeoutMs, 20).catch((error: unknown) => {
      // The extension host's console does not reach the runner: the failure carries what was painted.
      throw new Error(`${error instanceof Error ? error.message : String(error)}; paints: ${JSON.stringify(paints.slice(after).map((paint) => ({ ...paint, inspection: undefined, cards: undefined })))}`);
    });
    return paint;
  };
  const assertLayout = (paint: ComposePreviewPaint, ids = paint.live) => {
    for (const id of ids) {
      const layout = paint.inspection.layouts[id];
      assert.ok(layout, `published image dimensions for ${id}`);
      assert.ok(paint.cards[id], `layout accompanies pixels for ${id}`);
      assert.ok(Number.isInteger(layout.width) && layout.width > 0);
      assert.ok(Number.isInteger(layout.height) && layout.height > 0);
      assert.ok(layout.nodes.length > 0 && layout.nodes.length <= 2048, `measured nodes for ${id}`);
      assert.equal(new Set(layout.nodes.map((node) => node.id)).size, layout.nodes.length, "node identities are unique within a card");
      for (const node of layout.nodes) {
        assert.ok(node.id.length > 0 && node.name.length > 0, "composable calls have identities and names");
        assert.ok([node.x, node.y, node.width, node.height].every(Number.isInteger), "bounds use image pixels");
        assert.ok(node.x >= 0 && node.y >= 0 && node.width > 0 && node.height > 0);
        assert.ok(node.x + node.width <= layout.width && node.y + node.height <= layout.height, "measured bounds are clipped to the published image");
      }
    }
    assert.ok(paint.inspection.sources.length > 0, "inspection resolves project call sites");
  };
  const bounds = (paint: ComposePreviewPaint, id: string) => paint.inspection.layouts[id]!.nodes
    .map(({ x, y, width, height }) => ({ x, y, width, height }));
  /** Inspect's Open source for a `name` call of card `id`: the editor of `source` selects that call, in the text Komodo compiled. */
  const openCall = async (paint: ComposePreviewPaint, id: string, name: string, source: vscode.Uri) => {
    // A card can call `name` in several files (LocalizedPreview's Column and JourneyCard's own, when Elide built the components
    // module with Compose source information): take the call in `source`.
    const node = paint.inspection.layouts[id]?.nodes.find((candidate) => candidate.name === name
      && candidate.source?.fileName === path.basename(source.fsPath));
    assert.ok(node, `${id} has a located ${name} call: ${JSON.stringify(paint.inspection.layouts[id]?.nodes.map((n) => n.name))}`);
    assert.ok(await api.openSource(id, node.id), `${name} of ${id} opens its source`);
    const opened = vscode.window.activeTextEditor;
    assert.equal(opened?.document.uri.fsPath, source.fsPath, `${name} of ${id} opens ${path.basename(source.fsPath)}`);
    const selected = opened!.document.getText(opened!.selection);
    assert.ok(selected.startsWith(name), `the selection is the ${name} call: ${JSON.stringify(selected)}`);
    assert.equal(opened!.selection.start.line + 1, node.source!.lineNumber, `${name} of ${id} is on its line`);
    log(`open source: ${name} of ${id} at ${path.basename(source.fsPath)}:${node.source!.lineNumber}`);
    return selected;
  };
  const komodoDiagnostics = (source: vscode.Uri) => vscode.languages.getDiagnostics(source).filter((diagnostic) => diagnostic.source === "Komodo");
  const replace = async (editor: vscode.TextEditor, before: string, after: string) => {
    const text = editor.document.getText();
    const offset = text.indexOf(before);
    assert.ok(offset >= 0 && text.indexOf(before, offset + before.length) < 0, `unique fixture edit: ${before}`);
    assert.ok(await editor.edit((builder) => builder.replace(
      new vscode.Range(editor.document.positionAt(offset), editor.document.positionAt(offset + before.length)), after)));
  };
  const revert = async (editor: vscode.TextEditor) => {
    if (!editor.document.isDirty) return;
    await vscode.window.showTextDocument(editor.document, { preview: false, viewColumn: vscode.ViewColumn.One });
    await vscode.commands.executeCommand("workbench.action.files.revert");
  };
  /** An edit that does not compile is a Komodo diagnostic at its line, cleared by the next good edit. */
  const brokenEdit = async (editor: vscode.TextEditor, source: vscode.Uri, before: string, after: string) => {
    const started = performance.now();
    await replace(editor, before, after);
    const broken = await waitFor("Komodo compile diagnostic", () => komodoDiagnostics(source).length ? komodoDiagnostics(source) : undefined, 60_000, 50);
    log(`broken edit: ${broken.length} diagnostics after ${Math.round(performance.now() - started)} ms: ${broken.map((d) => `${d.range.start.line + 1}: ${d.message}`).join(" | ")}`);
    const brokenLine = editor.document.getText().split("\n").findIndex((line) => line.includes(after));
    assert.ok(broken.some((diagnostic) => diagnostic.range.start.line === brokenLine), `a diagnostic on line ${brokenLine + 1}`);
    const recoveryMark = paints.length;
    await replace(editor, after, before);
    await waitFor("Komodo diagnostics cleared", () => komodoDiagnostics(source).length === 0 || undefined, 60_000, 50);
    const recovered = await nextPaint(source, recoveryMark, "layout after compile recovery",
      (paint) => paint.failed === 0 && paint.live.length > 0 && paint.inspection.enabled);
    assertLayout(recovered);
  };

  // 0. Prewarm from the existing build without touching the sample's disk sources.
  {
    let galleryPrewarmed: string | undefined;
    const stop = api.onDidPrewarm((key) => { galleryPrewarmed = key; });
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(gallery), { preview: false });
    await waitFor("gallery workspace-session prewarm", () => galleryPrewarmed, 120_000, 200);
    stop.dispose();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  }

  // 1. Every card is live, the provider's cards included: the provider is declared in the previewed file, so Compose tooling loads it
  //    from Komodo's program classes, and `limit = 2` keeps its first two values. Focusing the file after the sync prewarms its
  //    backend; the preview opens after that, as in the layoutlib scenario.
  let prewarmed: string | undefined;
  api.onDidPrewarm((key) => { prewarmed = key; });
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(card), { preview: false });
  await waitFor("sync and prewarm", () => prewarmed, 120_000, 200);
  let mark = paints.length;
  let started = performance.now();
  await vscode.commands.executeCommand("elide.androidComposePreview");
  const live = await nextPaint(card, mark, "live card", (paint) => paint.live.length > 0);
  log(`open: ${live.live.length} of ${live.images} cards live after ${Math.round(performance.now() - started)} ms: ${live.live.join(", ")}`);
  assert.equal(live.images, 3, "LibraryCardPreview and LibraryDataPreview's two values");
  assert.equal(live.failed, 0);
  assert.equal(live.live.length, 3, "every JourneyCard.kt card is live");
  const serverPid = workspaceServerPid("prewarmed gallery and library");
  log(`shared workspace language server pid: ${serverPid}`);
  const libraryData = live.live.filter((id) => /\.LibraryDataPreview_[^:]*:\d+$/.test(id)).sort();
  assert.deepEqual(libraryData.map((id) => id.slice(id.lastIndexOf(":"))), [":0", ":1"], "limit = 2: one live card per kept value");
  assert.notEqual(live.cards[libraryData[0]!], live.cards[libraryData[1]!], "each provider card shows its own value");
  const hosted = live.live.find((id) => /LibraryCardPreview/.test(id));
  assert.ok(hosted, "LibraryCardPreview is live");
  mark = paints.length;
  api.setInspect(true);
  const inspected = await nextPaint(card, mark, "library inspection", (paint) => paint.inspection.enabled);
  assert.equal(inspected.inspection.images, 3, "every live library card has measured bounds");
  assertLayout(inspected);
  assert.deepEqual(inspected.cards, live.cards, "enabling inspection preserves published pixels");
  // Inspect off shows the painted publication again without its overlay: that is no new paint.
  api.setInspect(false);
  mark = paints.length;
  api.setInspect(true);
  const reinspected = await nextPaint(card, mark, "inspection re-enabled", (paint) => paint.inspection.enabled);
  assertLayout(reinspected);
  assert.ok(reinspected.inspection.sources.includes(card.fsPath), "library cards locate their calls in JourneyCard.kt");
  assert.ok((await openCall(reinspected, hosted, "JourneyCard", card)).startsWith('JourneyCard(Journey("Shared components"'));

  try {
    // 2. An unsaved body edit reaches the live card as a pushed frame.
    mark = paints.length;
    started = performance.now();
    await replace(editor, "Rendered using the consuming app's resources", "Rendered live by Komodo");
    const edited = await nextPaint(card, mark, "live body edit", (paint) => paint.cards[hosted] !== live.cards[hosted] && paint.live.includes(hosted));
    const editMs = performance.now() - started;
    log(`live edit: painted in ${Math.round(editMs)} ms`);
    assert.ok(editMs < LIVE_EDIT_BUDGET_MS, `live edit painted in ${Math.round(editMs)} ms, budget ${LIVE_EDIT_BUDGET_MS} ms`);
    assertLayout(edited);
    // The edit shortened LibraryCardPreview, above LibraryDataPreview: that function only moved, and Open source follows it.
    const moved = editor.document.getText().indexOf("JourneyCard(journey)");
    const relocated = await nextPaint(card, mark, "moved call located", (paint) => paint.inspection.layouts[libraryData[0]!]?.nodes
      .some((node) => node.name === "JourneyCard" && node.source?.offset === moved) ?? false);
    assert.equal(await openCall(relocated, libraryData[0]!, "JourneyCard", card), "JourneyCard(journey)");

    // 3. A stateful edit, then a click on the live card runs its handler and recomposes it.
    mark = paints.length;
    assert.equal(workspaceServerPid("library body edit"), serverPid, "unsaved preview edits reuse the analysis daemon");
    await replace(editor, "import androidx.compose.foundation.background\n", "import androidx.compose.foundation.background\nimport androidx.compose.foundation.clickable\n");
    await replace(editor, 'JourneyCard(Journey("Shared components", "Rendered live by Komodo", 2))', [
      "val clicks = androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(0) }",
      "  Column {",
      '    BasicText("Clicks: ${clicks.value}", Modifier.clickable { clicks.value++ }.padding(16.dp))',
      '    JourneyCard(Journey("Shared components", "Rendered live by Komodo", 2))',
      "  }",
    ].join("\n"));
    const stateful = await nextPaint(card, mark, "stateful edit", (paint) => paint.cards[hosted] !== edited.cards[hosted] && paint.live.includes(hosted));
    assertLayout(stateful);
    assert.notDeepEqual(bounds(stateful, hosted), bounds(edited, hosted),
      "adding measured content updates layout together with the image");
    api.setInspect(false);
    mark = paints.length;
    started = performance.now();
    assert.ok(api.pointer(hosted, "down", 40, 40), "the live card takes pointer input");
    await sleep(100);
    assert.ok(api.pointer(hosted, "up", 40, 40));
    const clicked = await nextPaint(card, mark, "click recomposition", (paint) => paint.cards[hosted] !== stateful.cards[hosted], 30_000);
    log(`click: recomposed in ${Math.round(performance.now() - started)} ms (${clicked.live.length} live)`);
    assertLayout(clicked);
    mark = paints.length;
    api.setInspect(true);
    await nextPaint(card, mark, "inspection after click", (paint) => paint.inspection.enabled);

    // 4. An edit that does not compile is a Komodo diagnostic at its line, cleared by the next good edit.
    await brokenEdit(editor, card, "clicks.value++", 'clicks.value += "one"');

    // 4b. A changed @Preview configuration re-hosts the card at its new size, and the next edit still reaches it: a daemon that
    //     hosted a second preview set must keep applying deltas (Komodo finding #3).
    mark = paints.length;
    started = performance.now();
    const before = paints.at(-1)!.cards[hosted];
    await replace(editor, 'name = "Library resource context", widthDp = 340', 'name = "Library resource context", widthDp = 300');
    const resized = await nextPaint(card, mark, "re-hosted card", (paint) => paint.cards[hosted] !== before && paint.live.includes(hosted));
    log(`preview configuration change: ${resized.live.length} of ${resized.images} live after ${Math.round(performance.now() - started)} ms`);
    assert.equal(resized.live.length, 3, "every card is live after the preview set changed");
    assertLayout(resized);
    assert.ok(resized.inspection.layouts[hosted]!.width < stateful.inspection.layouts[hosted]!.width,
      "re-hosting at a smaller width publishes smaller image bounds");
    mark = paints.length;
    started = performance.now();
    await replace(editor, '"Rendered live by Komodo"', '"Rendered live, resized"');
    await nextPaint(card, mark, "edit after the preview set changed", (paint) => paint.cards[hosted] !== resized.cards[hosted] && paint.live.includes(hosted));
    log(`edit after the preview set changed: painted in ${Math.round(performance.now() - started)} ms`);

    // 4c. A @Preview added while typing is live before the file is saved (the daemon compiles the buffer), and takes edits.
    mark = paints.length;
    started = performance.now();
    await replace(editor, "@Preview(name = \"Library sample data\"", [
      '@Preview(name = "Added while typing", widthDp = 200)',
      "@Composable",
      "fun AddedLivePreview() {",
      '  JourneyCard(Journey("Added", "Added while typing", 1))',
      "}",
      "",
      '@Preview(name = "Library sample data"',
    ].join("\n"));
    const grown = await nextPaint(card, mark, "added preview", (paint) => paint.images === 4 && paint.live.length === 4);
    log(`added preview: ${grown.live.length} of ${grown.images} live after ${Math.round(performance.now() - started)} ms`);
    const added = grown.live.find((id) => /AddedLivePreview/.test(id));
    assert.ok(added, "the added preview is live");
    assertLayout(grown);
    mark = paints.length;
    started = performance.now();
    await replace(editor, '"Added while typing", 1', '"Added and edited", 1');
    await nextPaint(card, mark, "edit of the added preview", (paint) => paint.cards[added] !== grown.cards[added] && paint.live.includes(added));
    log(`edit of the added preview: painted in ${Math.round(performance.now() - started)} ms`);

    // Transparent child geometry changes without changing the PNG: metadata must not be deduplicated by pixels.
    const addedBody = 'JourneyCard(Journey("Added", "Added and edited", 1))';
    const transparent = "Box(Modifier.size(120.dp)) { Box(Modifier.size(20.dp)) }";
    const beforeTransparent = paints.at(-1)!.cards[added];
    mark = paints.length;
    await replace(editor, addedBody, transparent);
    const empty = await nextPaint(card, mark, "transparent measured preview",
      (paint) => paint.live.includes(added) && paint.cards[added] !== beforeTransparent);
    assertLayout(empty, [added]);
    const emptyBounds = JSON.stringify(bounds(empty, added));
    mark = paints.length;
    await replace(editor, "Box(Modifier.size(20.dp))", "Box(Modifier.size(40.dp))");
    const geometryOnly = await nextPaint(card, mark, "layout-only frame update",
      (paint) => paint.live.includes(added) && JSON.stringify(bounds(paint, added)) !== emptyBounds);
    assert.equal(geometryOnly.cards[added], empty.cards[added], "transparent resize leaves the PNG byte-identical");
    assertLayout(geometryOnly, [added]);
    log("layout-only update: changed measured bounds with identical PNG");
    mark = paints.length;
    await replace(editor, transparent.replace("size(20.dp)", "size(40.dp)"), addedBody);
    await nextPaint(card, mark, "restored visible preview", (paint) => paint.cards[added] !== empty.cards[added]);

    // Real text fields: the small measured marker encodes exact text, so cursor blinking cannot satisfy these assertions.
    const keyboardBody = `val first = androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf("") }
  val second = androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf("") }
  Column(Modifier.width(180.dp)) {
    androidx.compose.foundation.text.BasicTextField(first.value, { first.value = it }, Modifier.fillMaxWidth().height(44.dp),
      textStyle = TextStyle(color = Color.Black, fontSize = 16.sp))
    androidx.compose.foundation.text.BasicTextField(second.value, { second.value = it }, Modifier.fillMaxWidth().height(44.dp),
      textStyle = TextStyle(color = Color.Black, fontSize = 16.sp))
    BasicText("first=" + first.value + "; second=" + second.value, style = TextStyle(color = Color.Black))
    val signature = when (first.value + "|" + second.value) {
      "|" -> 11
      "abc|" -> 31
      "aZc|" -> 41
      "aZc|B" -> 51
      "aZc|B\\n" -> 61
      "aZc|B\\nx" -> 71
      "aZc|B\\nxé😀" -> 81
      else -> 3
    }
    Box(Modifier.width(signature.dp).height(5.dp).background(Color.Red))
  }`;
    api.setInspect(false);
    mark = paints.length;
    await replace(editor, addedBody, keyboardBody);
    const marker = (paint: ComposePreviewPaint, id: string, signature: number, widthDp = 200) => {
      const layout = paint.inspection.layouts[id];
      if (!layout) return false;
      const density = layout.width / widthDp;
      return layout.nodes.some((node) => Math.abs(node.width - signature * density) <= 1
        && Math.abs(node.height - 5 * density) <= 1);
    };
    await nextPaint(card, mark, "empty keyboard fields", (paint) => marker(paint, added, 11));
    const keyEvent = (key: string, code: string, action: "down" | "up" = "down",
      modifiers: Partial<Parameters<typeof api.keyboard>[1]> = {}) => ({
      action, key, code, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: false, ...modifiers,
    });
    const press = (key: string, code: string, modifiers: Partial<Parameters<typeof api.keyboard>[1]> = {}) => {
      assert.ok(api.keyboard(added, keyEvent(key, code, "down", modifiers)), `accepted keydown ${key}`);
      assert.ok(api.keyboard(added, keyEvent(key, code, "up", modifiers)), `accepted keyup ${key}`);
    };
    const field = (id: string, second = false, widthDp = 200) => {
      assert.ok(api.focusInput(id), "focus live keyboard card");
      const density = paints.at(-1)!.inspection.layouts[id]!.width / widthDp;
      assert.ok(api.pointer(id, "down", 20 * density, (second ? 64 : 20) * density));
      assert.ok(api.pointer(id, "up", 20 * density, (second ? 64 : 20) * density));
    };
    await vscode.commands.executeCommand("workbench.action.focusSecondEditorGroup");
    field(added);
    assert.equal(api.keyboard(hosted, keyEvent("q", "KeyQ")), false, "another card never receives focused input");
    mark = paints.length;
    // As a browser types: caret movement and deletion queued behind the insertions, with no frame in between.
    for (const letter of "abc") press(letter, `Key${letter.toUpperCase()}`);
    press("ArrowLeft", "ArrowLeft");
    press("Backspace", "Backspace");
    press("Z", "KeyZ", { shiftKey: true });
    await nextPaint(card, mark, "typed abc, then arrow/backspace/shift produce aZc", (paint) => marker(paint, added, 41));
    mark = paints.length;
    press("Tab", "Tab");
    press("B", "KeyB", { shiftKey: true });
    await nextPaint(card, mark, "Tab focuses second field", (paint) => marker(paint, added, 51));
    mark = paints.length;
    press("Enter", "Enter");
    await nextPaint(card, mark, "Enter inserts newline", (paint) => marker(paint, added, 61));
    assert.ok(api.keyboard(added, keyEvent("Shift", "ShiftLeft", "down", { shiftKey: true })));
    api.focusInput(undefined);
    assert.equal(api.keyboard(added, keyEvent("Shift", "ShiftLeft", "up")), false, "blur discards late releases");
    field(added, true);
    mark = paints.length;
    press("End", "End", { ctrlKey: true });
    press("x", "KeyX");
    await nextPaint(card, mark, "blur clears held modifier", (paint) => marker(paint, added, 71));
    mark = paints.length;
    press("é", "");
    press("😀", "");
    await nextPaint(card, mark, "Unicode keyboard values", (paint) => marker(paint, added, 81));
    api.setInspect(true);
    assert.equal(api.focusInput(added), false, "Inspect cannot focus application input");
    assert.equal(api.keyboard(added, keyEvent("q", "KeyQ")), false, "Inspect owns keyboard input");
    mark = paints.length;
    api.setInspect(false);
    // Inspect re-requests the scene; input stays refused until those fresh images paint, then the card is focusable again.
    await nextPaint(card, mark, "Inspect released keyboard card", (paint) => !paint.inspection.enabled && marker(paint, added, 81));
    field(added);
    assert.ok(api.keyboard(added, keyEvent("Control", "ControlLeft", "down", { ctrlKey: true })));
    mark = paints.length;
    await replace(editor, '@Preview(name = "Added while typing", widthDp = 200)', '@Preview(name = "Added while typing", widthDp = 220)');
    const reconfiguredKeys = await nextPaint(card, mark, "keyboard card reconfigured", (paint) => {
      const id = paint.live.find((id) => /AddedLivePreview/.test(id));
      return !!id && marker(paint, id, 11, 220);
    });
    assert.equal(api.keyboard(added, keyEvent("Control", "ControlLeft", "up")), false, "reconfigure discards stale held input");
    const newAdded = reconfiguredKeys.live.find((id) => /AddedLivePreview/.test(id))!;
    field(newAdded, false, 220);
    mark = paints.length;
    for (const letter of "abc") {
      assert.ok(api.keyboard(newAdded, keyEvent(letter, `Key${letter.toUpperCase()}`, "down")));
      assert.ok(api.keyboard(newAdded, keyEvent(letter, `Key${letter.toUpperCase()}`, "up")));
    }
    await nextPaint(card, mark, "text input recovers after reconfigure", (paint) => marker(paint, newAdded, 31, 220));
    api.focusInput(undefined);
    mark = paints.length;
    await replace(editor, keyboardBody, addedBody);
    await nextPaint(card, mark, "restored added card", (paint) => paint.live.includes(newAdded) && !marker(paint, newAdded, 31, 220));
    await replace(editor, '@Preview(name = "Added while typing", widthDp = 220)', '@Preview(name = "Added while typing", widthDp = 200)');
    api.setInspect(true);
    log("keyboard: text editing, modifiers, Tab/Enter, focus isolation, Inspect, blur and reconfigure recovery passed");
    assert.equal(workspaceServerPid("keyboard lifecycle recovery"), serverPid, "keyboard input shares the original native workspace daemon");

    // 4d. Removing a function changes the program's shape, which the daemon rejects as a delta (and every later one): the preview
    //     configures again from the buffer, and the next edit still reaches the remaining cards.
    mark = paints.length;
    started = performance.now();
    const beforeRemoval = paints.at(-1)!.cards[hosted];
    await replace(editor, [
      '@Preview(name = "Added while typing", widthDp = 200)',
      "@Composable",
      "fun AddedLivePreview() {",
      '  JourneyCard(Journey("Added", "Added and edited", 1))',
      "}",
      "",
      "",
    ].join("\n"), "");
    const shrunk = await nextPaint(card, mark, "removed preview", (paint) => paint.images === 3 && paint.live.length === 3);
    log(`removed preview: ${shrunk.live.length} of ${shrunk.images} live after ${Math.round(performance.now() - started)} ms`);
    assertLayout(shrunk);
    assert.equal(shrunk.inspection.layouts[added], undefined, "removed cards leave no inspectable layout");
    mark = paints.length;
    started = performance.now();
    await replace(editor, '"Rendered live, resized"', '"Rendered after a removal"');
    await nextPaint(card, mark, "edit after a removed function", (paint) => paint.cards[hosted] !== beforeRemoval && paint.cards[hosted] !== shrunk.cards[hosted] && paint.live.includes(hosted), 30_000);
    log(`edit after a removed function: painted in ${Math.round(performance.now() - started)} ms`);
  } finally {
    await revert(editor);
  }

  // 5. The gallery is live in full: repeated and device @Previews, the member function, the Room-backed state card, and the
  //    provider's three values as one card each, with distinct pixels.
  const galleryEditor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(gallery), { preview: false, viewColumn: vscode.ViewColumn.One });
  mark = paints.length;
  started = performance.now();
  await vscode.commands.executeCommand("elide.androidComposePreview");
  const opened = await nextPaint(gallery, mark, "gallery live", (paint) => paint.live.length > 0);
  log(`gallery: ${opened.live.length} of ${opened.images} cards live after ${Math.round(performance.now() - started)} ms: ${opened.live.join(", ")}`);
  assert.equal(opened.images, 13);
  assert.equal(opened.failed, 0, "every gallery card renders");
  assert.equal(opened.live.length, 13, "every gallery card is live");
  const data = opened.live.filter((id) => /\.DataPreview_[^:]*:\d+$/.test(id)).sort();
  assert.deepEqual(data.map((id) => id.slice(id.lastIndexOf(":"))), [":0", ":1", ":2"], "one live card per provider value");
  assert.equal(new Set(data.map((id) => opened.cards[id])).size, 3, "each provider card shows its own value");
  mark = paints.length;
  api.setInspect(false);
  api.setInspect(true);
  const galleryInspected = await nextPaint(gallery, mark, "gallery inspection", (paint) => paint.inspection.enabled);
  assert.equal(galleryInspected.inspection.images, 13);
  assertLayout(galleryInspected);
  assert.ok(galleryInspected.inspection.sources.includes(gallery.fsPath), "gallery cards locate their calls in PreviewGallery.kt");
  // The card's own calls in this file are located whether or not Elide's build of the components module (JourneyCard)
  // recorded Compose source information.
  const localized = opened.live.find((id) => /\.LocalizedPreview_/.test(id))!;
  assert.ok((await openCall(galleryInspected, localized, "Column", gallery)).startsWith("Column {"));

  try {
    // A file initializer is evaluated once: changing it must refresh cached values, not merely report a successful delta.
    const initialAppearance = opened.live.find((id) => /\.AppearancePreview_/.test(id))!;
    mark = paints.length;
    await replace(galleryEditor, '"Coastal express"', '"Coastal expresso"');
    await nextPaint(gallery, mark, "initializer edit", (paint) => paint.live.includes(initialAppearance)
      && paint.cards[initialAppearance] !== opened.cards[initialAppearance]);
    mark = paints.length;
    await replace(galleryEditor, '"Coastal expresso"', '"Coastal express"');
    await nextPaint(gallery, mark, "initializer revert", (paint) => paint.live.includes(initialAppearance)
      && paint.cards[initialAppearance] === opened.cards[initialAppearance]);
    assert.equal(workspaceServerPid("initializer refresh"), serverPid, "initializer refresh retains the shared daemon");

    // 6. A pushed edit of the provider's composable reaches its three cards, which keep their identity (previewId:index).
    // The sample's gallery imports no clickable: add it first, outside the timed edit.
    await replace(galleryEditor, "import androidx.compose.foundation.background\n", "import androidx.compose.foundation.background\nimport androidx.compose.foundation.clickable\n");
    mark = paints.length;
    started = performance.now();
    await replace(galleryEditor, "fun DataPreview(@PreviewParameter(JourneyProvider::class) journey: Journey) {\n    JourneyCard(journey)", [
      "fun DataPreview(@PreviewParameter(JourneyProvider::class) journey: Journey) {",
      "    val clicks = androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(0) }",
      "    Column {",
      '        BasicText("Clicks: ${clicks.value}", Modifier.clickable { clicks.value++ }.padding(16.dp))',
      "        JourneyCard(journey)",
      "    }",
    ].join("\n"));
    const first = await nextPaint(gallery, mark, "provider card edit", (paint) => data.some((id) => paint.cards[id] !== opened.cards[id]));
    const providerEditMs = performance.now() - started;
    log(`provider edit: first card painted in ${Math.round(providerEditMs)} ms`);
    assert.ok(providerEditMs < LIVE_EDIT_BUDGET_MS, `provider edit painted in ${Math.round(providerEditMs)} ms, budget ${LIVE_EDIT_BUDGET_MS} ms`);
    const pushed = await nextPaint(gallery, mark, "every provider card repainted", (paint) => data.every((id) => paint.cards[id] !== opened.cards[id]), 30_000);
    assert.deepEqual(pushed.live.filter((id) => data.includes(id)).sort(), data, "provider cards stay live through a reload");
    assert.equal(first.live.length, 13, "a pushed edit changes no card's engine");
    assert.equal(new Set(data.map((id) => pushed.cards[id])).size, 3, "each provider card still shows its own value");
    assertLayout(pushed);

    // 7. A click on the second value's card recomposes that card alone.
    api.setInspect(false);
    mark = paints.length;
    started = performance.now();
    assert.ok(api.pointer(data[1]!, "down", 40, 40), "a provider card takes pointer input");
    await sleep(100);
    assert.ok(api.pointer(data[1]!, "up", 40, 40));
    const clickedProvider = await nextPaint(gallery, mark, "provider card click", (paint) => paint.cards[data[1]!] !== pushed.cards[data[1]!], 30_000);
    log(`provider click: recomposed in ${Math.round(performance.now() - started)} ms`);
    assert.equal(clickedProvider.cards[data[0]!], pushed.cards[data[0]!], "the first value's card did not change");
    assert.equal(clickedProvider.cards[data[2]!], pushed.cards[data[2]!], "the third value's card did not change");
    assertLayout(clickedProvider);
    assert.deepEqual(clickedProvider.inspection.layouts[data[0]!], pushed.inspection.layouts[data[0]!], "untouched provider retains its measured layout");
    assert.deepEqual(clickedProvider.inspection.layouts[data[2]!], pushed.inspection.layouts[data[2]!], "third provider retains its measured layout");
    mark = paints.length;
    api.setInspect(true);
    await nextPaint(gallery, mark, "inspection after provider click", (paint) => paint.inspection.enabled);

    // 8. Compile diagnostics for the gallery's file.
    await brokenEdit(galleryEditor, gallery, "clicks.value++", 'clicks.value += "one"');

    // 9. Unsaved edits of a file the gallery calls into (JourneyCard.kt, another module) reach the gallery's cards: the file joins the
    //    daemon's program. Its first edit does not compile: a Komodo diagnostic in that file, not a file left out of the program.
    //    Edited without showing it, so the panel keeps previewing the gallery.
    const journeyCard = await vscode.workspace.openTextDocument(card);
    const editCard = async (before: string, after: string) => {
      const at = journeyCard.getText().indexOf(before);
      assert.ok(at >= 0, `JourneyCard.kt has ${before}`);
      const change = new vscode.WorkspaceEdit();
      change.replace(card, new vscode.Range(journeyCard.positionAt(at), journeyCard.positionAt(at + before.length)), after);
      assert.ok(await vscode.workspace.applyEdit(change));
    };
    const appearance = opened.live.find((id) => /\.AppearancePreview_/.test(id))!;
    const beforeDependency = paints.at(-1)!.cards[appearance];
    const beforeDependencyBounds = bounds(paints.at(-1)!, appearance);
    started = performance.now();
    await editCard("Spacer(Modifier.height(64.dp))", 'Spacer(Modifier.height("4".dp))');
    const brokenDependency = await waitFor("dependency compile diagnostic", () => komodoDiagnostics(card).length ? komodoDiagnostics(card) : undefined, 60_000, 50);
    log(`broken dependency edit: ${brokenDependency.length} diagnostics in JourneyCard.kt after ${Math.round(performance.now() - started)} ms`);
    mark = paints.length;
    started = performance.now();
    await editCard('Spacer(Modifier.height("4".dp))', "Spacer(Modifier.height(4.dp))");
    const dependency = await nextPaint(gallery, mark, "dependency edit", (paint) => paint.cards[appearance] !== beforeDependency && paint.live.includes(appearance));
    log(`dependency edit: ${dependency.live.length} of ${dependency.images} live, painted in ${Math.round(performance.now() - started)} ms`);
    await waitFor("dependency diagnostics cleared", () => komodoDiagnostics(card).length === 0 || undefined, 60_000, 50);
    assertLayout(dependency);
    assert.notDeepEqual(bounds(dependency, appearance), beforeDependencyBounds,
      "recovered cross-module spacing edit publishes newly measured bounds");
    mark = paints.length;
    started = performance.now();
    await editCard("Spacer(Modifier.height(4.dp))", "Spacer(Modifier.height(40.dp))");
    const secondDependency = await nextPaint(gallery, mark, "second dependency edit", (paint) => paint.cards[appearance] !== dependency.cards[appearance] && paint.live.includes(appearance));
    assertLayout(secondDependency);
    assert.notDeepEqual(bounds(secondDependency, appearance), bounds(dependency, appearance),
      "the next dependency edit updates measured bounds again");
    log(`second dependency edit: painted in ${Math.round(performance.now() - started)} ms`);
    assert.equal(workspaceServerPid("gallery dependent-module edits"), serverPid, "gallery and cross-module edits share the original workspace daemon");
  } finally {
    await revert(galleryEditor);
    await revert(editor);
  }
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(gallery), { preview: false });
  mark = paints.length;
  await vscode.commands.executeCommand("elide.androidComposePreview");
  await nextPaint(gallery, mark, "reopened gallery", (paint) => paint.live.length === 13 && paint.failed === 0);
  mark = paints.length;
  api.setInspect(false);
  api.setInspect(true);
  const reopened = await nextPaint(gallery, mark, "reopened gallery inspection", (paint) => paint.inspection.enabled);
  assertLayout(reopened);
  assert.equal(reopened.inspection.images, 13, "reopened sessions retain all measured cards");
  assert.equal(workspaceServerPid("inspection session reopen"), serverPid, "inspection and session lifecycle reuse the native workspace daemon");
  for (const [file, bytes] of diskSources) assert.deepEqual(readFileSync(file), bytes, `sample source unchanged: ${file}`);
  await previewEverySampleFile(sample, api, paints);
  assert.equal(editor.document.isDirty, false);
  assert.equal(galleryEditor.document.isDirty, false);
  log("compose-komodo ok");
}

/**
 * Every Kotlin source of the sample that declares a `@Preview` opens with all its cards live: the sample's screens bring
 * library calls and language shapes the two files above do not, and one that Komodo cannot compile or run fails its cards.
 */
async function previewEverySampleFile(sample: string, api: ElideApi["composePreview"], paints: ComposePreviewPaint[]): Promise<void> {
  const files = readdirSync(sample, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".kt"))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !file.split(path.sep).includes(".dev") && /^@Preview\b/m.test(readFileSync(file, "utf8")))
    .sort();
  assert.ok(files.length > 2, `the sample's preview files: ${files.join(", ")}`);
  const errors: string[] = [];
  const stop = api.onDidError((error) => errors.push(`${path.basename(error.source)}: ${error.message}`));
  const failures: string[] = [];
  try {
    for (const file of files) {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)), { preview: false });
      const mark = paints.length;
      const reported = errors.length;
      await vscode.commands.executeCommand("elide.androidComposePreview");
      const paint = await waitFor(`${path.basename(file)} cards`, () => errors.length > reported ? null
        : paints.slice(mark).find((candidate) => candidate.source === file && candidate.images > 0
          && (candidate.failed > 0 || candidate.live.length === candidate.images)), LIVE_TIMEOUT_MS, 50);
      const summary = paint ? `${paint.live.length} of ${paint.images} live, ${paint.failed} failed` : errors.slice(reported).join(" | ");
      log(`sample preview ${path.relative(sample, file)}: ${summary}`);
      if (!paint || paint.failed > 0 || paint.live.length !== paint.images) failures.push(`${path.relative(sample, file)}: ${summary}`);
    }
  } finally {
    stop.dispose();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  }
  assert.deepEqual(failures, [], "every preview of the sample is live");
}
