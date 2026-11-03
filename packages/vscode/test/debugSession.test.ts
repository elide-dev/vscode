import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// Keep module mocks in a separate process so other extension unit tests see their real dependencies.
test("JDWP launch attaches once to complete stdout/stderr banners across arbitrary process chunks", () => {
  const source = new URL("../src/", import.meta.url).pathname;
  const result = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict";
    import { EventEmitter } from "node:events";
    import { PassThrough } from "node:stream";
    import * as childProcess from "node:child_process";
    import { mock } from "bun:test";
    import * as core from "@elide/ide-core";
    import { setImmediate as immediate } from "node:timers/promises";
    const source = ${JSON.stringify(source)};
    const configurations = [];
    const children = [];
    const killed = [];
    const failures = [];
    let attachError;
    let disposedListeners = 0;
    mock.module("@elide/ide-core", () => ({ ...core, killProcessTree: (pid, signal) => killed.push([pid, signal]) }));
    class VsEventEmitter {
      event = () => ({ dispose() {} });
      fire() {}
    }
    mock.module("vscode", () => ({
      EventEmitter: VsEventEmitter,
      window: {
        createTerminal: ({ pty }) => ({ show: () => pty.open() }),
        showErrorMessage: async (message) => { failures.push(message); },
      },
      debug: {
        onDidStartDebugSession: () => ({ dispose() { disposedListeners++; } }),
        startDebugging: async (_folder, configuration) => {
          if (attachError) throw attachError;
          configurations.push(configuration);
          return true;
        },
      },
    }));
    mock.module("node:child_process", () => ({ ...childProcess, spawn: () => {
      const child = new EventEmitter();
      Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 12345, exitCode: null, signalCode: null });
      children.push(child);
      return child;
    } }));
    mock.module(source + "config.js", () => ({ configuredInvocation() {}, readConfig() {} }));
    const activation = Promise.withResolvers();
    let activating = false;
    mock.module(source + "jetbrains.js", () => ({
      isJetBrainsDebugger: () => false,
      jetBrainsDebuggerType: () => "intellij_jvm",
      jetBrainsExtension: () => ({ activate: () => { activating = true; return activation.promise; } }),
      notifyKotlinSetupPending() {},
      pendingKotlinSetup: async () => undefined,
    }));
    // Dynamic loading is intentional: the mocked VS Code runtime must exist before the module loads.
    const { launchWithJdwp, resolveAttachType } = await import(source + "debug.ts");
    let resolved = false;
    const app = { name: "app", uri: { fsPath: "/app", toString: () => "file:///app" } };
    const komodoLaunches = [];
    const komodo = { komodoDebugLaunch: async (folder) => { komodoLaunches.push(folder); return { launcher: "/k/bin/komodo-lsp-k2", manifest: "/s/project.properties", javaHome: undefined }; } };
    const adapter = resolveAttachType({ debugAdapter: "intellij" }, app, komodo).then((value) => { resolved = true; return value; });
    assert.equal(activating, true, "debugging without an open Kotlin file must activate the companion");
    assert.equal(resolved, false, "the launch must wait for adapter registration");
    activation.resolve();
    assert.equal(await adapter, "intellij_jvm");
    assert.deepEqual(komodoLaunches, [], "only the komodo adapter needs Komodo's launcher");
    // Komodo's adapter is checked before any JVM starts: the folder's launcher and manifest must exist.
    assert.equal(await resolveAttachType({ debugAdapter: "komodo" }, app, komodo), "komodo-kotlin");
    assert.deepEqual(komodoLaunches, [app]);
    const failuresBefore = failures.length;
    const unavailable = { komodoDebugLaunch: async () => { throw new Error("'app' is still syncing"); } };
    assert.equal(await resolveAttachType({ debugAdapter: "komodo" }, app, unavailable), undefined);
    assert.deepEqual(failures.slice(failuresBefore), ["Elide: 'app' is still syncing"]);
    const launch = { dist: "elide", argv: [], cwd: "/app", name: "App", folder: {}, attachType: "java" };
    const ui = { log() {} };
    for (const stream of ["stdout", "stderr"]) {
      const lines = [];
      const before = configurations.length;
      const session = launchWithJdwp({ ...launch, onLine: (line, stderr) => lines.push([line, stderr]) }, ui, new Map());
      const child = children.at(-1);
      child[stream].write("Listening for trans");
      child[stream].write("port dt_socket at address: 50");
      assert.equal(configurations.length, before, "do not attach to a partial port");
      child[stream].write("05\\n");
      assert.equal(configurations.length, before + 1);
      assert.equal(configurations.at(-1).port, 5005);
      assert.deepEqual(lines[0], ["Listening for transport dt_socket at address: 5005", stream === "stderr"]);
      child[stream].write("Listening for transport dt_socket at address: 5006\\n");
      assert.equal(configurations.length, before + 1, "only one attach per process");
      child.emit("close", 0);
      assert.equal(await session.exit, 0);
    }
    // Banner detection must also work without an optional output observer.
    const before = configurations.length;
    const session = launchWithJdwp(launch, ui, new Map());
    children.at(-1).stdout.write("Listening for transport dt_socket at address: 60");
    children.at(-1).stdout.write("06\\n");
    assert.equal(configurations.length, before + 1);
    assert.equal(configurations.at(-1).port, 6006);
    children.at(-1).emit("close", 0);
    await session.exit;
    // Komodo's adapter attaches with the same shape as the JetBrains one: host, port, connect timeout, launch id.
    const komodoSession = launchWithJdwp({ ...launch, attachType: "komodo-kotlin" }, ui, new Map());
    children.at(-1).stderr.write("Listening for transport dt_socket at address: 5007\\n");
    const { __elideLaunchId, ...komodoAttach } = configurations.at(-1);
    assert.deepEqual(komodoAttach, { type: "komodo-kotlin", request: "attach", name: "App", hostName: "127.0.0.1", port: 5007, timeout: 30000 });
    assert.equal(typeof __elideLaunchId, "string");
    children.at(-1).emit("close", 0);
    await komodoSession.exit;
    // A binary that cannot start emits "error", then still "close" with a negative errno: reported once, not twice.
    const failuresBeforeSpawn = failures.length;
    const unstarted = launchWithJdwp(launch, ui, new Map());
    Object.assign(children.at(-1), { pid: undefined });
    children.at(-1).emit("error", new Error("spawn elide ENOENT"));
    children.at(-1).emit("close", -2);
    assert.equal(await unstarted.exit, null);
    assert.deepEqual(failures.slice(failuresBeforeSpawn), [], "a spawn failure is not also a debug run that exited early");
    attachError = new Error("adapter startup failed");
    const listenersBeforeFailure = disposedListeners;
    const rejected = launchWithJdwp(launch, ui, new Map());
    children.at(-1).stdout.write("Listening for transport dt_socket at address: 5005\\n");
    await immediate();
    assert.match(failures.at(-1), /adapter startup failed/);
    assert.deepEqual(killed, [[12345, "SIGTERM"]], "failed attachment must not leave its launched process waiting");
    assert.equal(disposedListeners, listenersBeforeFailure + 1, "failed attachment releases its session listener");
    children.at(-1).emit("close", 1);
    await rejected.exit;
  `], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 20_000 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

test("JDWP cancellation and same-name launches keep debugger ownership isolated", () => {
  const source = new URL("../src/", import.meta.url).pathname;
  const result = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict";
    import { EventEmitter } from "node:events";
    import { PassThrough } from "node:stream";
    import { setImmediate as immediate } from "node:timers/promises";
    import * as childProcess from "node:child_process";
    import * as core from "@elide/ide-core";
    import { mock } from "bun:test";
    const source = ${JSON.stringify(source)};
    const children = [], terminals = [], requests = [], stopped = [], failures = [], killed = [];
    const listeners = new Set();
    const sessions = new Map();
    mock.module("@elide/ide-core", () => ({ ...core, killProcessTree: (pid) => killed.push(pid) }));
    mock.module("vscode", () => ({
      EventEmitter: class { event = () => ({ dispose() {} }); fire() {} },
      window: {
        createTerminal: ({ pty }) => { terminals.push(pty); return { show() {} }; },
        showErrorMessage: async (message) => { failures.push(message); },
      },
      debug: {
        onDidStartDebugSession: (listener) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
        startDebugging: (_folder, configuration) => {
          const pending = Promise.withResolvers();
          requests.push({ configuration, ...pending });
          return pending.promise;
        },
        stopDebugging: async (session) => { stopped.push(session.id); },
      },
    }));
    mock.module("node:child_process", () => ({ ...childProcess, spawn: () => {
      const child = new EventEmitter();
      Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 100 + children.length, exitCode: null, signalCode: null });
      children.push(child);
      return child;
    } }));
    mock.module(source + "config.js", () => ({ configuredInvocation() {}, readConfig() {} }));
    mock.module(source + "jetbrains.js", () => ({ isJetBrainsDebugger() {}, jetBrainsDebuggerType() {}, jetBrainsExtension() {}, notifyKotlinSetupPending() {}, pendingKotlinSetup: async () => undefined }));
    // Load only after installing the VS Code and child-process module mocks.
    const { launchWithJdwp } = await import(source + "debug.ts");
    const launch = { dist: "elide", argv: [], cwd: "/app", name: "App", folder: {}, attachType: "java" };
    const ui = { log() {} };
    const start = () => {
      const session = launchWithJdwp(launch, ui, sessions);
      const terminal = terminals.at(-1);
      terminal.open();
      const child = children.at(-1);
      child.stdout.write("Listening for transport dt_socket at address: 5005\\n");
      return { session, child, terminal, request: requests.at(-1) };
    };
    const attach = (request, id) => {
      const session = { id, name: "App", type: "java", configuration: request.configuration };
      for (const listener of [...listeners]) listener(session);
      request.resolve(true);
    };

    // Two launches named App must not both claim the first debugger that starts.
    const first = start(), second = start();
    attach(first.request, "first");
    assert.equal(sessions.get("first"), first.child);
    attach(second.request, "second");
    assert.equal(sessions.get("second"), second.child);
    first.terminal.close();
    assert.deepEqual(killed, [first.child.pid]);
    assert.deepEqual(stopped, ["first"]);
    assert.equal(sessions.has("first"), false);
    assert.equal(sessions.get("second"), second.child);
    first.child.emit("close", null);
    second.child.emit("close", 0);
    await immediate();
    assert.equal(sessions.size, 0, "exited debuggees cannot leave stale process ownership");
    assert.deepEqual(stopped, ["first", "second"]);

    // Terminal closure can precede the asynchronous attach response.
    const pending = start();
    pending.terminal.close();
    pending.request.resolve(true);
    await immediate();
    attach(pending.request, "late");
    await immediate();
    assert.equal(sessions.size, 0);
    assert.equal(stopped.at(-1), "late", "a late debugger must not outlive the cancelled launch");
    assert.equal(listeners.size, 0);
    pending.child.emit("close", null);
    assert.equal(await pending.session.exit, null);

    // VS Code may deliver pty.open after the test run was already cancelled.
    const early = launchWithJdwp(launch, ui, sessions);
    const childCount = children.length;
    early.cancel();
    terminals.at(-1).open();
    assert.equal(children.length, childCount);
    assert.equal(await early.exit, null);

    const beforeBanner = launchWithJdwp(launch, ui, sessions);
    terminals.at(-1).open();
    terminals.at(-1).close();
    children.at(-1).emit("close", null);
    assert.equal(await beforeBanner.exit, null);
    assert.deepEqual(failures, [], "intentional termination is not a missing-JDWP failure");
  `], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 20_000 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
