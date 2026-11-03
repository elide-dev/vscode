/**
 * The `compose-agent` scenario (see runner.ts): the Compose preview MCP tools, driven over HTTP as an external agent drives them,
 * on the `elide-android-sample` (`ELIDE_ANDROID_SAMPLE`, built once) with the engine `ELIDE_COMPOSE_ENGINE` names (`layoutlib`,
 * the default, or `komodo`). Composables without `@Preview` render through generated wrappers (placeholders, agent arguments,
 * a private composable, a private value of its file), an existing `@Preview` renders its own configuration, and wrong references
 * and wrapper compile errors are reported. A live session follows an unsaved edit; with `komodo` its cards take taps and typing,
 * and the preview panel is paused while it is open and resumes when it closes. Nothing reaches the disk, and no editor ever holds
 * a wrapper.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import type { ComposePreviewPaint } from "../../src/composePreview.js";
import type { ElideExtensionApi as ElideApi } from "../../src/extension.js";
import { log, waitFor } from "./helpers.js";

/** A cold first render builds and starts the renderer (and, for komodo, the session). */
const RENDER_TIMEOUT_MS = 600_000;

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
interface ToolResult { content: Content[]; isError?: boolean }

class McpClient {
  private id = 0;
  constructor(readonly url: string, private readonly token: string) {}

  async post(body: unknown, token = this.token): Promise<Response> {
    return fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
    });
  }

  /** A request's result: a JSON response, or the final message of an SSE stream (progress notifications before it). */
  async request(method: string, params: Record<string, unknown>, onProgress?: () => Promise<void>): Promise<Record<string, unknown>> {
    const id = ++this.id;
    const response = await this.post({ jsonrpc: "2.0", id, method, params });
    if (response.status !== 200) assert.fail(`${method}: HTTP ${response.status} ${await response.text()}`);
    let text = "";
    if (onProgress) {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let notified = false;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          text += decoder.decode(chunk.value, { stream: true });
          if (!notified && text.includes('"notifications/progress"')) {
            notified = true;
            await onProgress();
          }
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      assert.ok(notified, "the render reported progress before closing its session");
    } else text = await response.text();
    const messages = response.headers.get("content-type")?.includes("text/event-stream")
      ? text.split(/\n\n/).flatMap((event) => event.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)) as Record<string, unknown>))
      : [JSON.parse(text) as Record<string, unknown>];
    const answer = messages.find((message) => message.id === id);
    assert.ok(answer, `${method}: no response in ${text.slice(0, 500)}`);
    assert.equal(answer.error, undefined, `${method}: ${JSON.stringify(answer.error)}`);
    return answer.result as Record<string, unknown>;
  }

  /** With KEEP_TEST_DIRS, the PNGs every call returned, for looking at. */
  private readonly images = process.env.KEEP_TEST_DIRS ? mkdtempSync(path.join(tmpdir(), "elide-compose-agent-")) : undefined;
  private calls = 0;

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const started = performance.now();
    const result = await this.request("tools/call", { name, arguments: args, _meta: { progressToken: `t${this.id}` } }) as unknown as ToolResult;
    log(`${name}: ${Math.round(performance.now() - started)} ms${result.isError ? " (error)" : ""}`, JSON.stringify(result.content.map((item) => item.type === "text" ? item.text : `<png ${item.data.length} b64>`)).slice(0, 4_000));
    const call = ++this.calls;
    if (this.images) {
      result.content.forEach((item, index) => {
        if (item.type === "image") writeFileSync(path.join(this.images!, `${String(call).padStart(2, "0")}-${name}-${index}.png`), Buffer.from(item.data, "base64"));
      });
      log(`images kept in ${this.images}`);
    }
    return result;
  }
}

function texts(result: ToolResult): string {
  return result.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
}

function images(result: ToolResult): string[] {
  return result.content.flatMap((item) => item.type === "image" ? [item.data] : []);
}

function assertPng(data: string): void {
  const png = Buffer.from(data, "base64");
  assert.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "a PNG image");
  assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0, "PNG dimensions");
}

function ok(result: ToolResult, what: string): ToolResult {
  assert.ok(!result.isError, `${what}: ${texts(result)}`);
  return result;
}

/** The first `### cN` card id of a report, and the layout node whose line contains `needle`. */
function card(result: ToolResult): string {
  const id = /^### (c\d+)/m.exec(texts(result))?.[1];
  assert.ok(id, `a card id in ${texts(result)}`);
  return id;
}

function node(result: ToolResult, needle: RegExp): string {
  const line = texts(result).split("\n").find((candidate) => /^\s*n\d+ /.test(candidate) && needle.test(candidate));
  assert.ok(line, `a layout node matching ${needle} in ${texts(result)}`);
  return /^\s*(n\d+) /.exec(line)![1]!;
}

export async function runComposeAgentScenario(): Promise<void> {
  const sample = process.env.ELIDE_TEST_SAMPLE!;
  const komodo = vscode.workspace.getConfiguration("elide.android.composePreview").get("engine") === "komodo";
  const gallery = vscode.Uri.file(path.join(sample, "app", "src", "main", "kotlin", "sample", "app", "PreviewGallery.kt"));
  const journey = vscode.Uri.file(path.join(sample, "components", "src", "main", "kotlin", "sample", "components", "JourneyCard.kt"));
  const disk = new Map([gallery, journey].map((uri) => [uri.fsPath, readFileSync(uri.fsPath, "utf8")]));
  const extension = vscode.extensions.all.find((e) => e.id.endsWith(".elide"));
  assert.ok(extension, "elide extension found");
  const api = await waitFor("extension api", () => extension.exports as ElideApi | undefined, 60_000, 200);
  const endpoint = await waitFor("MCP endpoint", () => api.composePreviewMcp.endpoint(), 60_000, 200);
  assert.match(endpoint.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  log("MCP endpoint", endpoint.url, komodo ? "(komodo engine)" : "(layoutlib engine)");
  const client = new McpClient(endpoint.url, endpoint.token);

  // The protocol, as any client sees it.
  assert.equal((await client.post({ jsonrpc: "2.0", id: 0, method: "ping" }, "wrong")).status, 401, "a wrong token is refused");
  const initialized = await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "elide-test", version: "1" } });
  assert.equal(initialized.protocolVersion, "2025-06-18");
  assert.equal((await client.post({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const tools = (await client.request("tools/list", {})).tools as { name: string }[];
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["compose_preview_close", "compose_preview_interact", "compose_preview_list", "compose_preview_refresh", "compose_preview_render"]);

  const listed = texts(ok(await client.call("compose_preview_list", { file: path.relative(sample, journey.fsPath) }), "list"));
  assert.match(listed, /sample\.components\.JourneyCard .*JourneyCard\.kt:\d+/);
  assert.match(listed, /sample\.components\.LibraryCardPreview .* @Preview/);

  // VS Code's agents reach the same server through the extension's MCP server definition provider, whose servers VS Code lists
  // once it loads the provider. A user trusts a server on its first start (a dialog); this start is trusted as the user's
  // explicit one is (`autoTrustChanges`), without the dialog.
  const tool = await waitFor("VS Code's compose_preview_list tool", async () => {
    await vscode.commands.executeCommand("workbench.mcp.startServer", "*", { promptType: "never", autoTrustChanges: true, waitForLiveTools: true });
    return vscode.lm.tools.find((candidate) => candidate.name.endsWith("compose_preview_list"));
  }, 60_000, 1_000).catch((error: unknown) => { throw new Error(`${error instanceof Error ? error.message : String(error)}; tools: ${vscode.lm.tools.map((candidate) => candidate.name).join(", ")}`); });
  const invoked = await vscode.lm.invokeTool(tool.name, { input: { query: "JourneyCard" }, toolInvocationToken: undefined });
  const invokedText = invoked.content.flatMap((part) => part instanceof vscode.LanguageModelTextPart ? [part.value] : []).join("\n");
  log(`VS Code tool ${tool.name}`, invokedText.slice(0, 300));
  assert.match(invokedText, /sample\.components\.JourneyCard/);

  // A required parameter without a placeholder names what to pass.
  const missing = await client.call("compose_preview_render", { composables: [{ reference: "sample.components.JourneyCard" }] });
  assert.ok(missing.isError, "a required Journey has no placeholder");
  assert.match(texts(missing), /journey: Journey/);
  assert.match(texts((await client.call("compose_preview_render", { composables: ["sample.components.NoSuchCard"] }))), /No top-level @Composable function sample\.components\.NoSuchCard/);

  // Composables without @Preview: agent arguments, placeholders, a private composable and a private value of its file.
  const rendered = ok(await client.call("compose_preview_render", {
    composables: [
      { reference: "sample.components.JourneyCard", arguments: { journey: "Journey(\"Agent trip\", \"Rendered for an agent\", 4)" }, preview: { widthDp: 320 } },
      { reference: "app/src/main/kotlin/sample/app/PreviewGallery.kt#ActionButton" },
      { reference: "sample.app.SampleScreen", arguments: { journeys: "listOf(example)" }, preview: { widthDp: 360, heightDp: 480 } },
      { reference: "sample.components.LibraryCardPreview" },
    ],
  }), "render");
  const report = texts(rendered);
  assert.equal(images(rendered).length, 4, `four cards: ${report}`);
  images(rendered).forEach(assertPng);
  assert.match(report, /generated preview ElideAgentPreview_[0-9a-f]{10}\(\): JourneyCard\(journey = Journey\("Agent trip"/);
  assert.match(report, /ActionButton\(label = "label" \(placeholder\), onClick = \{\} \(placeholder\)\)/);
  assert.match(report, /Its own @Preview at .*JourneyCard\.kt:\d+/);
  assert.match(report, /n\d+ \S+ \d+,\d+ \d+×\d+ — components\/src\/main\/kotlin\/sample\/components\/JourneyCard\.kt:\d+:\d+/, "layout nodes at their call sites");
  assert.match(report, /n\d+ \S+ \d+,\d+ \d+×\d+ — app\/src\/main\/kotlin\/sample\/app\/PreviewGallery\.kt:\d+:\d+/);
  const wide = Buffer.from(images(rendered)[2]!, "base64");
  const narrow = Buffer.from(images(rendered)[0]!, "base64");
  assert.ok(wide.readUInt32BE(16) > narrow.readUInt32BE(16), "widthDp applies (360 dp wider than 320 dp)");

  // Closing sessions also cancels a render that has not returned its session id yet.
  const closing = await client.request("tools/call", {
    name: "compose_preview_render", arguments: { composables: ["sample.components.LibraryCardPreview"], live: true },
    _meta: { progressToken: "close-during-render" },
  }, async () => { await vscode.commands.executeCommand("elide.composePreviewMcp.closeSessions"); }) as unknown as ToolResult;
  assert.ok(closing.isError, "Close Agent Compose Preview Sessions cancels an in-flight render");
  assert.match(texts(closing), /closed|cancel/i);

  // An argument that does not compile is the wrapper's error, shown with its numbered lines.
  const mistyped = await client.call("compose_preview_render", { composables: [{ reference: "sample.components.JourneyCard", arguments: { journey: "42" } }] });
  assert.ok(mistyped.isError, "a mistyped argument fails");
  assert.match(texts(mistyped), /generated wrapper, appended for the preview only/);

  // A live session over an unsaved edit (the agent's composable exists only in the editor).
  const document = await vscode.workspace.openTextDocument(gallery);
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const fixture = [
    "",
    "@Composable",
    "private fun AgentCounter(start: Int) {",
    "    val count = androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(start) }",
    "    val text = androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(\"\") }",
    "    Column(Modifier.background(androidx.compose.ui.graphics.Color.White).padding(8.dp)) {",
    "        ActionButton(\"Count ${count.value}\") { count.value++ }",
    "        androidx.compose.foundation.text.BasicTextField(text.value, { text.value = it }, Modifier.width(200.dp).background(androidx.compose.ui.graphics.Color(0xFFE0E0E0)).padding(8.dp))",
    "        androidx.compose.foundation.text.BasicText(DeprecationLevel.WARNING.name)",
    "    }",
    "}",
    "",
  ].join("\n");
  await editor.edit((edit) => edit.insert(document.lineAt(document.lineCount - 1).range.end, fixture));
  const live = ok(await client.call("compose_preview_render", {
    composables: [{ reference: "sample.app.AgentCounter", preview: { widthDp: 240 } }], live: true,
  }), "live render");
  const session = /Live session (s\d+)/.exec(texts(live))?.[1];
  assert.ok(session, `a session id: ${texts(live)}`);
  assert.match(texts(live), /AgentCounter\(start = 0 \(placeholder\)\)/);
  const counter = card(live);
  const before = images(live)[0]!;

  if (komodo) {
    const paints: ComposePreviewPaint[] = [];
    api.composePreview.onDidPaint((paint) => paints.push(paint));
    const tapped = ok(await client.call("compose_preview_interact", { session, card: counter, actions: [{ type: "tap", node: node(live, /ActionButton|BasicText/) }] }), "tap");
    assert.notEqual(images(tapped)[0], before, "the tap ran the click handler and recomposed");
    const typed = ok(await client.call("compose_preview_interact", {
      session, card: counter, actions: [{ type: "tap", node: node(tapped, /BasicTextField/) }, { type: "type", text: "Hi agent" }],
    }), "type");
    assert.notEqual(images(typed)[0], images(tapped)[0], "typing edited the text field");

    // The panel waits while the agent holds Komodo's one preview session, and resumes when it ends.
    await vscode.window.showTextDocument(journey, { preview: false });
    await vscode.commands.executeCommand("elide.androidComposePreview");
    const paused = await waitFor("paused panel", () => paints.find((paint) => paint.source === journey.fsPath && paint.failed === paint.images), RENDER_TIMEOUT_MS, 50);
    log("panel paused", JSON.stringify({ images: paused.images, failed: paused.failed }));
    const after = paints.length;
    ok(await client.call("compose_preview_close", { session }), "close");
    await waitFor("resumed panel", () => paints.slice(after).find((paint) => paint.source === journey.fsPath && paint.failed === 0 && paint.live.length === paint.images), RENDER_TIMEOUT_MS, 50);
  } else {
    const snapshot = await client.call("compose_preview_interact", { session, card: counter, actions: [{ type: "tap", x: 10, y: 10 }] });
    assert.ok(snapshot.isError, "snapshot cards take no input");
    assert.match(texts(snapshot), /snapshot/);
  }

  // The session follows the agent's next (unsaved) edit; komodo reconnects after the close above by rendering again.
  // Showing another file closed this TextEditor; edits go through the one showing the document again.
  const shown = await vscode.window.showTextDocument(document, { preview: false });
  const labelAt = document.getText().indexOf("\"Count ${count.value}\"");
  await shown.edit((edit) => edit.replace(new vscode.Range(document.positionAt(labelAt), document.positionAt(labelAt + "\"Count ${count.value}\"".length)), "\"Total ${count.value}!\""));
  if (komodo) {
    const reopened = ok(await client.call("compose_preview_render", { composables: [{ reference: "sample.app.AgentCounter", preview: { widthDp: 240 } }], live: true }), "live again");
    const again = /Live session (s\d+)/.exec(texts(reopened))![1]!;
    assert.notEqual(images(reopened)[0], before, "the edited label renders");
    const labelEnd = document.getText().indexOf("\"Total ${count.value}!\"");
    await shown.edit((edit) => edit.replace(new vscode.Range(document.positionAt(labelEnd), document.positionAt(labelEnd + "\"Total ${count.value}!\"".length)), "\"Sum ${count.value}\""));
    const refreshed = ok(await client.call("compose_preview_refresh", { session: again }), "refresh");
    assert.notEqual(images(refreshed)[0], images(reopened)[0], "refresh renders the pushed edit");
    ok(await client.call("compose_preview_close", { session: again }), "close again");
  } else {
    const refreshed = ok(await client.call("compose_preview_refresh", { session }), "refresh");
    assert.notEqual(images(refreshed)[0], before, "refresh renders the edited label");
    ok(await client.call("compose_preview_close", { session }), "close");
  }
  assert.ok((await client.call("compose_preview_refresh", { session })).isError, "a closed session is gone");

  // Nothing the agent rendered reached a file or an editor.
  await vscode.commands.executeCommand("workbench.action.files.revert");
  for (const open of vscode.workspace.textDocuments) assert.ok(!open.getText().includes("ElideAgentPreview_"), `no wrapper in ${open.uri.fsPath}`);
  for (const [file, text] of disk) assert.equal(readFileSync(file, "utf8"), text, `${file} unchanged on disk`);
  log("compose-agent scenario passed");
}
