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
