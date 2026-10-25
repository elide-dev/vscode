import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// Keep VS Code module mocks out of Bun's shared registry for the other extension tests.
test("A run that crashes after some results errors the tests it never reached with the crash text", () => {
  const source = new URL("../src/", import.meta.url).pathname;
  const result = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict";
    import { mock } from "bun:test";
    import * as core from "@elide/ide-core";
    const source = ${JSON.stringify(source)};
    const commands = new Map(), events = [];
    const collection = (owner) => {
      const items = new Map();
      return {
        get size() { return items.size; },
        add(item) { item.parent = owner; items.set(item.id, item); },
        delete(id) { items.delete(id); },
        replace(list) { items.clear(); for (const item of list) this.add(item); },
        [Symbol.iterator]: () => items.entries(),
      };
    };
    const item = (id, label, uri) => {
      const created = { id, label, uri, parent: undefined };
      created.children = collection(created);
      return created;
    };
    mock.module("@elide/ide-core", () => ({
      ...core,
      resolveElideDistribution: () => ({ bin: "elide" }),
      scanJvmTestSource: () => ({ classes: [{ binaryName: "X", line: 0, methods: [{ name: "a", line: 1 }, { name: "b", line: 2 }, { name: "c", line: 3 }] }] }),
      AndroidTestResultParser: class {
        constructor(_task, onResult, onProblem) { this.onResult = onResult; this.onProblem = onProblem; }
        accept(record) { if (record.result) this.onResult(record.result); else this.onProblem(record.problem); }
        // The run ended with a failure still waiting for its stack trace (as the real parser holds it).
        end() { this.onResult({ className: "X", method: "b", outcome: "failed" }); }
      },
      ElideCli: class {
        async run(_argv, options) {
          const handler = options.onCommand();
          handler.record({ result: { className: "X", method: "a", outcome: "passed" } });
          handler.record({ problem: "Instrumentation run failed due to 'Process crashed.'" });
          throw new Error("elide exited with 1");
        }
      },
    }));
    class Disposable { dispose() {} }
    const events$ = { dispose() {} };
    mock.module("vscode", () => ({
      tests: {
        createTestController: () => ({
          items: collection(undefined),
          createTestItem: item,
          createRunProfile: () => ({}),
          createTestRun: () => ({
            enqueued() {}, started() {}, appendOutput() {}, end() {},
            passed: (test) => events.push(["passed", test.id]),
            skipped: (test) => events.push(["skipped", test.id]),
            failed: (test) => events.push(["failed", test.id]),
            errored: (test, message) => events.push(["errored", test.id, message.message]),
          }),
          dispose() {},
        }),
      },
      TestRunProfileKind: { Run: 1 },
      TestRunRequest: class { constructor(include, exclude, profile) { this.include = include; this.exclude = exclude; this.profile = profile; } },
      TestMessage: class { constructor(message) { this.message = message; } },
      CancellationTokenSource: class { token = { isCancellationRequested: false, onCancellationRequested: () => events$ }; dispose() {} },
      RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
      Range: class {},
      Location: class {},
      Position: class {},
      Uri: { file: (fsPath) => ({ fsPath, scheme: "file" }) },
      Disposable,
      workspace: {
        textDocuments: [],
        fs: { readFile: async () => new TextEncoder().encode("class X") },
        findFiles: async () => [{ fsPath: "/app/src/X.kt", scheme: "file" }],
        saveAll: async () => true,
        createFileSystemWatcher: () => ({ onDidCreate: () => events$, onDidChange: () => events$, onDidDelete: () => events$, dispose() {} }),
        onDidChangeTextDocument: () => events$,
      },
      window: { showWarningMessage: async () => undefined },
      commands: { registerCommand: (name, run) => { commands.set(name, run); return events$; } },
    }));
    mock.module(source + "android.js", () => ({ toAndroidTarget: (value) => value }));
    mock.module(source + "androidDeploymentState.js", () => ({ androidApks: () => [{ name: "app", device: { instrumented: true }, sourceSets: ["test"] }] }));
    mock.module(source + "config.js", () => ({ readConfig: () => ({}), configuredInvocation: () => ({}) }));
    // Load only after installing the VS Code and Elide CLI module mocks.
    const { ElideAndroidTestController } = await import(source + "androidTesting.ts");
    const project = { root: "/app", folder: {}, model: { name: "app", modules: [{ sourceSet: "test", contentRoots: [{ sourceRoots: [{ kind: "test", path: "/app/src" }] }] }] } };
    const controller = new ElideAndroidTestController(
      { projects: [project], projectAt: () => project, onDidChange: () => events$ },
      { log() {} },
      { resolve: async () => ({}), readyDevice: async () => "serial" },
    );
    await commands.get("elide.androidTest")(undefined);
    assert.deepEqual(events, [
      ["passed", "a:/app:app/X#a"],
      ["failed", "a:/app:app/X#b"],
      ["errored", "a:/app:app/X#c", "Instrumentation run failed due to 'Process crashed.'\\nelide exited with 1"],
    ]);
    controller.dispose();
  `], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 20_000 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

test("Disposing the controller ends the detached android-test process of a run in flight", () => {
  const source = new URL("../src/", import.meta.url).pathname;
  const result = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict";
    import { mock } from "bun:test";
    import * as core from "@elide/ide-core";
    const source = ${JSON.stringify(source)};
    const commands = new Map(), events = [];
    const collection = (owner) => {
      const items = new Map();
      return {
        get size() { return items.size; },
        add(item) { item.parent = owner; items.set(item.id, item); },
        delete(id) { items.delete(id); },
        replace(list) { items.clear(); for (const item of list) this.add(item); },
        [Symbol.iterator]: () => items.entries(),
      };
    };
    const item = (id, label, uri) => {
      const created = { id, label, uri, parent: undefined };
      created.children = collection(created);
      return created;
    };
    const { promise: running, resolve: started } = Promise.withResolvers();
    mock.module("@elide/ide-core", () => ({
      ...core,
      resolveElideDistribution: () => ({ bin: "elide" }),
      scanJvmTestSource: () => ({ classes: [{ binaryName: "X", line: 0, methods: [{ name: "a", line: 1 }] }] }),
      ElideCli: class {
        run(_argv, options) {
          started(options.signal);
          return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason)));
        }
      },
    }));
    const events$ = { dispose() {} };
    mock.module("vscode", () => ({
      tests: {
        createTestController: () => ({
          items: collection(undefined),
          createTestItem: item,
          createRunProfile: () => ({}),
          createTestRun: () => ({
            enqueued() {}, started() {}, appendOutput() {}, end: () => events.push(["end"]),
            passed() {}, skipped() {}, failed() {},
            errored: (test) => events.push(["errored", test.id]),
          }),
          dispose() {},
        }),
      },
      TestRunProfileKind: { Run: 1 },
      TestRunRequest: class { constructor(include, exclude, profile) { this.include = include; this.exclude = exclude; this.profile = profile; } },
      TestMessage: class { constructor(message) { this.message = message; } },
      CancellationTokenSource: class { token = { isCancellationRequested: false, onCancellationRequested: () => events$ }; dispose() {} },
      RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
      Range: class {},
      Uri: { file: (fsPath) => ({ fsPath, scheme: "file" }) },
      workspace: {
        textDocuments: [],
        fs: { readFile: async () => new TextEncoder().encode("class X") },
        findFiles: async () => [{ fsPath: "/app/src/X.kt", scheme: "file" }],
        saveAll: async () => true,
        createFileSystemWatcher: () => ({ onDidCreate: () => events$, onDidChange: () => events$, onDidDelete: () => events$, dispose() {} }),
        onDidChangeTextDocument: () => events$,
      },
      window: { showWarningMessage: async () => undefined },
      commands: { registerCommand: (name, run) => { commands.set(name, run); return events$; } },
    }));
    mock.module(source + "android.js", () => ({ toAndroidTarget: (value) => value }));
    mock.module(source + "androidDeploymentState.js", () => ({ androidApks: () => [{ name: "app", device: { instrumented: true }, sourceSets: ["test"] }] }));
    mock.module(source + "config.js", () => ({ readConfig: () => ({}), configuredInvocation: () => ({}) }));
    const { ElideAndroidTestController } = await import(source + "androidTesting.ts");
    const project = { root: "/app", folder: {}, model: { name: "app", modules: [{ sourceSet: "test", contentRoots: [{ sourceRoots: [{ kind: "test", path: "/app/src" }] }] }] } };
    const controller = new ElideAndroidTestController(
      { projects: [project], projectAt: () => project, onDidChange: () => events$ },
      { log() {} },
      { resolve: async () => ({}), readyDevice: async () => "serial" },
    );
    const command = commands.get("elide.androidTest")(undefined);
    const signal = await running;
    controller.dispose();
    await command;
    assert.equal(signal.aborted, true);
    assert.deepEqual(events, [["end"]]);
  `], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 20_000 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
