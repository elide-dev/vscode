import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// Keep the VS Code boundary mocks out of the other suites; use the real HTTP server.
test("MCP disposal during port persistence cannot republish terminal credentials", () => {
  const source = new URL("../src/", import.meta.url).pathname;
  const result = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict";
    import { mock } from "bun:test";
    const source = ${JSON.stringify(source)};
    class Disposable { constructor(close = () => {}) { this.close = close; } dispose() { this.close(); } }
    class EventEmitter { event = () => new Disposable(); fire() {} dispose() {} }
    mock.module("vscode", () => ({
      Disposable, EventEmitter,
      workspace: { onDidChangeConfiguration: () => new Disposable() },
      commands: { registerCommand: () => new Disposable() },
    }));
    mock.module(source + "config.js", () => ({ readConfig: () => ({ composePreviewMcp: true }) }));
    // Load after installing the VS Code boundary; a static import would run before the mocks.
    const { registerComposePreviewMcp } = await import(source + "composeAgentMcp.ts");
    const entered = Promise.withResolvers();
    const saved = Promise.withResolvers();
    const environment = new Map();
    const context = {
      secrets: { get: async () => "test-token", store: async () => {} },
      workspaceState: { get: () => 0, update: (_key, port) => { entered.resolve(port); return saved.promise; } },
      environmentVariableCollection: {
        delete: key => environment.delete(key), replace: (key, value) => environment.set(key, value),
      },
    };
    const registration = registerComposePreviewMcp(context, {}, { log() {} }, "1");
    try {
      const port = await entered.promise;
      const response = await fetch("http://127.0.0.1:" + port + "/mcp", {
        method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      assert.equal(response.status, 200);
      await response.text();
      registration.disposable.dispose();
      saved.resolve();
      assert.equal(await registration.api.endpoint(), undefined);
      assert.deepEqual([...environment], [], "shutdown must not advertise a closed server or restore its token");
    } finally {
      saved.resolve();
      registration.disposable.dispose();
    }
  `], { encoding: "utf8", timeout: 10_000 });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
});

test("agent native gating preserves listing and layoutlib and retires pending/live native work", () => {
  const source = new URL("../src/", import.meta.url).pathname;
  const result = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict";
    import { mock } from "bun:test";
    const source = ${JSON.stringify(source)};
    class Disposable { constructor(close = () => {}) { this.close = close; } dispose() { this.close(); } }
    class EventEmitter {
      listeners = new Set();
      event = listener => { this.listeners.add(listener); return new Disposable(() => this.listeners.delete(listener)); };
      fire() { for (const listener of this.listeners) listener(); }
    }
    const changed = new EventEmitter();
    let engine = "komodo";
    let available = false;
    let allocated = 0;
    let resources = 0;
    let applications = 0;
    let gate = Promise.resolve();
    mock.module("vscode", () => ({
      Disposable,
      workspace: { isTrusted: true, asRelativePath: file => file },
      languages: { createDiagnosticCollection: () => ({ clear() {}, dispose() {} }) },
    }));
    mock.module(source + "config.js", () => ({ readConfig: () => ({ composePreviewEngine: engine, composePreviewKeepAlive: 1 }) }));
    mock.module(source + "composeRuntime.js", () => ({ ensureComposeRuntime: async () => { resources++; return {}; } }));
    mock.module(source + "tasks.js", () => ({
      runObservedElide: async () => { resources++; throw new Error("Native gating must prevent preview builds"); },
    }));
    mock.module(source + "composePreview.js", () => ({
      backendKey: () => "app", buildErrors: () => [], javaFor: () => "java", ownedBy: () => true,
      previewApp: () => { applications++; throw new Error("no Android application"); },
      previewBuild: () => { resources++; return {}; },
    }));
    // Install boundary mocks before evaluating the service; a static import would load VS Code first.
    const { ComposeAgentPreviews } = await import(source + "composeAgent.ts");
    const workspace = {
      get komodoPreviewAvailable() { return available; },
      onDidChangeKomodoAvailability: changed.event,
      requireKomodoPreview: async () => { await gate; if (!available) throw new Error("Komodo unavailable: install then sync"); },
      projectFor: () => ({ model: {}, root: "/app", folder: {} }),
      projectAt: () => { resources++; return undefined; },
    };
    const host = {
      backends: { acquire() { allocated++; }, detached() { allocated++; }, release() {} },
      arbiter: { setActive() {} },
    };
    const service = new ComposeAgentPreviews(workspace, {}, host);
    service.declaration = async () => ({ declaration: { file: "/app/Card.kt", name: "Card" }, text: "" });
    service.kotlinFiles = async () => ["/app/Card.kt"];
    service.text = async () => "package app\\n@Composable fun Card() {}";
    const options = { composables: [{ reference: "app.Card" }] };
    const signal = new AbortController().signal;
    try {
      assert.match(await service.list(undefined, undefined), /app.Card/);
      await assert.rejects(service.render(options, signal, () => {}), /Komodo unavailable/);
      assert.equal(applications, 0, "native gating precedes Android application lookup");
      assert.equal(allocated, 0);
      assert.equal(resources, 0);
      available = true;
      changed.fire();
      await assert.rejects(service.render(options, signal, () => {}), /no Android application/);
      assert.equal(applications, 1, "sync recovery permits a fresh request without reloading");
      available = false;
      engine = "layoutlib";
      await assert.rejects(service.render(options, signal, () => {}), /no Android application/);
      assert.equal(applications, 2, "layoutlib does not depend on native availability");

      const backend = { disposed: false, blur() {}, dispose() { this.disposed = true; } };
      const group = { key: "native", sourceFile: "/app/Card.kt", backend, komodo: backend,
        latest: new Map(), subscriptions: [], released: false, appendices: new Map() };
      const session = { id: "s1", groups: [group], closed: false, queue: Promise.resolve(), closing: new AbortController() };
      const layoutlib = { id: "s2", groups: [{ komodo: undefined, backend: {}, subscriptions: [], released: false }],
        closed: false, queue: Promise.resolve(), closing: new AbortController() };
      service.groups.add(group);
      service.sessions.set(session.id, session);
      service.sessions.set(layoutlib.id, layoutlib);
      available = true;
      const reporting = Promise.withResolvers();
      const entered = Promise.withResolvers();
      const pending = service.serialized(session, signal, async () => { entered.resolve(); await reporting.promise; return ["obsolete pixels"]; });
      await entered.promise;
      const controller = new AbortController();
      const snapshot = new AbortController();
      service.rendering.set(controller, true);
      service.rendering.set(snapshot, false);
      const requiring = Promise.withResolvers();
      gate = requiring.promise;
      const rendering = service.renderNow(group, true, controller.signal, undefined, () => {}).catch(error => error);
      available = false;
      changed.fire();
      assert.equal(backend.disposed, true);
      assert.equal(session.closed, true);
      assert.equal(layoutlib.closed, false);
      assert.equal(controller.signal.aborted, true);
      assert.equal(snapshot.signal.aborted, false);
      reporting.resolve();
      await assert.rejects(pending, /closed/);
      available = true;
      changed.fire();
      requiring.resolve();
      assert.ok(await rendering instanceof Error);
      assert.equal(resources, 0, "loss followed by quick recovery cannot revive queued native work");
      service.rendering.clear();
    } finally { service.dispose(); }
  `], { encoding: "utf8", timeout: 10_000 });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
});
