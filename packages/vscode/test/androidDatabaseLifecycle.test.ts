import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// Separate process: VS Code mocks must not affect the rest of Bun's module registry.
test("database inspection cancels stale discovery, drops late reads and never writes after a closed confirmation", () => {
  const source = new URL("../src/", import.meta.url).pathname;
  const result = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict";
    import { mock } from "bun:test";
    import * as core from "@elide/ide-core";
    const source = ${JSON.stringify(source)};
    const commands = new Map(), sessions = [], panels = [], errors = [];
    const model = { android: { targets: [] } }, project = { root: "/app", model };
    const devices = [{ serial: "phone", state: "device", ready: true }];
    let changed, discover = async () => [{ packageName: "com.example.app", user: 10 }], confirm = async () => undefined;
    let read = async () => ({ columns: ["title"], rows: [["original"]], hasMore: false });
    const disposable = () => ({ dispose() {} });
    mock.module("@elide/ide-core", () => ({
      ...core, adbExecutable: () => process.execPath,
      listAndroidDatabasePackages: (_adb, _device, signal) => discover(signal),
      AndroidDatabaseSession: class {
        disposed = false; writes = 0; cancelled = 0;
        constructor(options) { this.options = options; sessions.push(this); }
        async databases() { return ["notes.db"]; }
        async schema() { return [{ name: "notes", type: "table", sql: "CREATE TABLE notes(title TEXT)" }]; }
        async query() { return read(); }
        async execute() { this.writes++; return { changes: 1 }; }
        dispose() { this.disposed = true; }
        cancel() { this.cancelled++; }
      },
    }));
    mock.module("vscode", () => ({
      workspace: { isTrusted: true }, ViewColumn: { Active: 1 }, QuickPickItemKind: { Separator: -1 },
      Disposable: class { constructor(dispose) { this.dispose = dispose; } },
      commands: { registerCommand: (name, callback) => { commands.set(name, callback); return disposable(); } },
      window: {
        showQuickPick: async (items) => items[0],
        showErrorMessage: async (message) => { errors.push(message); },
        showWarningMessage: (...args) => confirm(...args),
        createWebviewPanel: () => {
          let closed, receive;
          const panel = { messages: [], disposed: false, visible: true,
            webview: { onDidReceiveMessage: callback => { receive = callback; return disposable(); }, postMessage: value => { panel.messages.push(value); } },
            onDidDispose: callback => { closed = callback; return disposable(); },
            send: value => receive(value),
            dispose() { if (!this.disposed) { this.disposed = true; closed(); } },
          };
          panels.push(panel); return panel;
        },
      },
    }));
    mock.module(source + "android.js", () => ({ androidSdkFor: () => "/sdk", attachedDevices: async () => devices, toAndroidTarget: value => value }));
    const { registerAndroidDatabase } = await import(source + "androidDatabase.ts");
    const registration = registerAndroidDatabase({ projects: [project], projectAt: () => project,
      onDidChange: callback => { changed = callback; return disposable(); } }, { asAbsolutePath: name => name }, () => undefined);
    const open = () => commands.get("elide.androidDatabase")({ root: "/app", device: "phone" });
    const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

    const discovery = Promise.withResolvers(), started = Promise.withResolvers(); let signal;
    discover = async value => { signal = value; started.resolve(); return discovery.promise; };
    const pending = open(); await started.promise;
    project.model = undefined; changed();
    assert.equal(signal.aborted, true);
    project.model = model; changed(); discovery.resolve([{ packageName: "com.example.app", user: 10 }]); await pending;
    assert.equal(panels.length, 0, "late discovery must not resurrect a removed project");

    discover = async () => [{ packageName: "com.example.app", user: 10 }];
    await open(); let panel = panels.at(-1);
    assert.equal(sessions.at(-1).options.user, 10, "opening the panel pins the user whose packages were offered, not whoever is current at its first request");
    panel.send({ type: "ready" }); await flush();
    const delayed = Promise.withResolvers(); read = () => delayed.promise;
    panel.send({ type: "query", sql: "SELECT * FROM notes" }); await flush();
    const oldSession = sessions.at(-1);
    panel.send({ type: "cancel" }); await flush();
    assert.equal(oldSession.cancelled, 1, "cancel stops the helper but keeps the session");
    assert.equal(oldSession.disposed, false);
    delayed.resolve({ columns: ["title"], rows: [["stale"]], hasMore: false }); await flush();
    assert.equal(panel.messages.some(message => message.type === "result"), false, "cancelled read cannot repaint stale rows");

    const answer = Promise.withResolvers(), prompted = Promise.withResolvers();
    confirm = async () => { prompted.resolve(); return answer.promise; };
    panel.send({ type: "execute", sql: "DELETE FROM notes" }); await prompted.promise;
    panel.dispose(); answer.resolve("Execute write"); await flush();
    assert.equal(sessions.reduce((total, session) => total + session.writes, 0), 0, "closing the panel revokes a pending write confirmation");

    await open(); panel = panels.at(-1); panel.send({ type: "ready" }); await flush();
    confirm = async () => undefined;
    panel.send({ type: "execute", sql: "DELETE FROM notes" }); await flush();
    assert.equal(sessions.at(-1).writes, 0, "dismissing confirmation must not send SQL");
    confirm = async () => "Execute write";
    panel.send({ type: "execute", sql: "DELETE FROM notes" }); await flush();
    assert.equal(sessions.at(-1).writes, 1);
    assert.ok(panel.messages.some(message => message.type === "written" && message.changes === 1));

    read = async () => ({ columns: ["title"], rows: [["original"]], hasMore: false });
    panel.send({ type: "browse", name: "notes" }); await flush();
    read = async () => { throw new Error("no such column: nope"); };
    panel.send({ type: "query", sql: "SELECT nope FROM notes" }); await flush();
    read = async () => ({ columns: ["title"], rows: [["original"]], hasMore: false });
    panel.messages.length = 0;
    panel.send({ type: "refresh" }); await flush();
    assert.equal(panel.messages.some(message => message.type === "result"), false, "refresh after a failed query must not repaint the previous query's rows");

    panel.send({ type: "browse", name: "notes" }); await flush();
    const cancelledRead = Promise.withResolvers();
    read = () => cancelledRead.promise;
    panel.send({ type: "query", sql: "SELECT title FROM notes WHERE title = 'different'" }); await flush();
    panel.send({ type: "cancel" }); await flush();
    cancelledRead.resolve({ columns: ["title"], rows: [["different"]], hasMore: false }); await flush();
    read = async () => ({ columns: ["title"], rows: [["original"]], hasMore: false });
    panel.messages.length = 0;
    panel.send({ type: "refresh" }); await flush();
    assert.equal(panel.messages.some(message => message.type === "result"), false, "refresh after cancellation must not repaint an earlier query under the cancelled SQL");

    const release = { packageName: "com.example.release", user: 10, refusal: "run-as: package not debuggable: com.example.release", notDebuggable: true };
    const opened = panels.length;
    discover = async () => [release];
    await open();
    assert.equal(panels.length, opened, "a non-debuggable application is never opened");
    assert.match(errors.splice(0).join("\\n"), /None of the 1 installed applications on phone is debuggable/);
    discover = async () => [release, { packageName: "com.example.app", user: 10 }];
    await open();
    assert.equal(panels.length, opened + 1, "debuggable applications are listed first");
    assert.deepEqual(errors, []);
    panel = panels.at(-1);
    project.model = undefined; changed();
    assert.equal(panel.disposed, true);
    assert.equal(sessions.at(-1).disposed, true);
    registration.dispose();
    assert.deepEqual(errors, []);
  `], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 20_000 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
