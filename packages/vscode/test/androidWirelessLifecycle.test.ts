import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// Isolated process keeps the VS Code boundary mock out of other suites.
test("wireless pairing revokes late operations and QR pairing ignores unrelated services", () => {
  const source = new URL("../src/", import.meta.url).pathname;
  const result = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict";
    import { mock } from "bun:test";
    import * as core from "@elide/ide-core";
    const source = ${JSON.stringify(source)};
    const commands = new Map(), panels = [], paired = [];
    const project = { root: "/app", model: { android: {} } };
    let changed, configurationChanged, refreshes = 0;
    let discover = async () => [], pair = async () => {};
    const disposable = () => ({ dispose() {} });
    mock.module("@elide/ide-core", () => ({
      ...core, adbExecutable: () => process.execPath,
      createAndroidWirelessQr: () => ({ name: "studio-owned", secret: "secret", payload: "WIFI:T:ADB;S:studio-owned;P:secret;;" }),
      discoverAndroidWireless: (_adb, signal) => discover(signal),
      pairAndroidWireless: async (_adb, endpoint, secret, signal) => { paired.push(endpoint); await pair(signal); },
    }));
    mock.module("qrcode", () => ({ default: { toDataURL: async () => "data:image/png;base64,AA==" } }));
    mock.module(source + "android.js", () => ({ androidSdkFor: () => "/sdk", toAndroidTarget: value => value }));
    mock.module("vscode", () => ({
      workspace: { isTrusted: true, onDidChangeConfiguration: callback => { configurationChanged = callback; return disposable(); } },
      ViewColumn: { Active: 1 }, Disposable: class { constructor(dispose) { this.dispose = dispose; } },
      commands: { registerCommand: (name, callback) => { commands.set(name, callback); return disposable(); },
        executeCommand: async () => { refreshes++; } },
      window: { createWebviewPanel: () => {
        let receive, closed;
        const panel = { messages: [], disposed: false,
          webview: { onDidReceiveMessage: callback => { receive = callback; return disposable(); }, postMessage: value => panel.messages.push(value) },
          onDidDispose: callback => { closed = callback; return disposable(); }, reveal() {},
          send: value => receive(value), dispose() { if (!this.disposed) { this.disposed = true; closed(); } },
        };
        panels.push(panel); return panel;
      } },
    }));
    // Import after installing mocks: this deliberately exercises the module-loading boundary.
    const { registerAndroidWireless } = await import(source + "androidWireless.ts");
    const registration = registerAndroidWireless({ projects: [project], projectAt: () => project,
      onDidChange: callback => { changed = callback; return disposable(); } }, () => undefined);
    const open = () => commands.get("elide.androidPairWireless")({ root: "/app" });
    const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
    await open(); let panel = panels.at(-1);
    panel.send({ type: "pair", endpoint: "127.0.0.1:1234", code: "not-six" }); await flush();
    assert.equal(paired.length, 0, "invalid code must never authorize a process");
    assert.equal(panel.messages.at(-1).error, true);

    const pending = Promise.withResolvers(); let signal;
    pair = async value => { signal = value; await pending.promise; };
    panel.send({ type: "pair", endpoint: "127.0.0.1:1234", code: "123456" }); await flush();
    panel.send({ type: "pair", endpoint: "127.0.0.1:4321", code: "123456" }); await flush();
    assert.deepEqual(paired, ["127.0.0.1:1234"], "double submission must not pair a second device");
    panel.send({ type: "cancel" }); await flush();
    assert.equal(signal.aborted, true);
    pending.resolve(); await flush();
    assert.equal(refreshes, 0, "cancelled operation cannot announce success or refresh");
    assert.match(panel.messages.at(-1).status, /Cancelled/);

    const discovery = Promise.withResolvers();
    discover = async value => { signal = value; return discovery.promise; };
    panel.send({ type: "qr" }); await flush();
    assert.ok(panel.messages.at(-1).qr);
    panel.dispose(); assert.equal(signal.aborted, true);
    discovery.resolve([{ name: "studio-owned", type: "pairing", endpoint: "127.0.0.1:2222" }]); await flush();
    assert.deepEqual(paired, ["127.0.0.1:1234"], "closed QR panel must not pair a late discovery");

    await open(); panel = panels.at(-1); pair = async () => {};
    discover = async () => [
      { name: "studio-unrelated", type: "pairing", endpoint: "127.0.0.1:3333" },
      { name: "studio-owned", type: "connect", endpoint: "127.0.0.1:4444" },
      { name: "studio-owned", type: "pairing", endpoint: "127.0.0.1:5555" },
    ];
    panel.send({ type: "qr" }); await flush();
    assert.deepEqual(paired, ["127.0.0.1:1234", "127.0.0.1:5555"]);
    assert.equal(refreshes, 1);
    assert.equal(panel.messages.at(-1).qr, undefined, "completed QR credentials must disappear");
    assert.match(panel.messages.at(-1).status, /Paired successfully/);

    const removed = Promise.withResolvers();
    pair = async value => { signal = value; await removed.promise; };
    panel.send({ type: "pair", endpoint: "127.0.0.1:1234", code: "123456" }); await flush();
    project.model = undefined; changed();
    assert.equal(panel.disposed, true); assert.equal(signal.aborted, true);
    removed.resolve(); await flush(); assert.equal(refreshes, 1);
    registration.dispose();
  `], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 20_000 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
