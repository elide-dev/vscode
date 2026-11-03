import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// Keep VS Code module mocks out of Bun's shared registry for the other extension tests.
test("Running a project with excluded tests runs a pattern of the included ones and reports no excluded result", () => {
  const source = new URL("../src/", import.meta.url).pathname;
  const result = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict";
    import { mock } from "bun:test";
    import * as core from "@elide/ide-core";
    const source = ${JSON.stringify(source)};
    const events = [], runs = [];
    const { promise: ended, resolve: end } = Promise.withResolvers();
    let handler;
    const collection = (owner) => {
      const items = new Map();
      return {
        get size() { return items.size; },
        get: (id) => items.get(id),
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
      scanJvmTestSource: () => ({ classes: [{ binaryName: "X", simpleName: "X", line: 0, methods: [{ name: "a", line: 1 }, { name: "b", line: 2 }, { name: "c", line: 3 }] }] }),
      ElideCli: class {
        async run(argv, options) {
          runs.push(argv);
          // Even a result the pattern should have left out is not reported.
          for (const [n, m] of ["a", "b", "c"].entries()) options.onLine("ok " + (n + 1) + " - X > " + m + "()", false);
        }
      },
    }));
    const events$ = { dispose() {} };
    mock.module("vscode", () => ({
      tests: {
        createTestController: () => ({
          items: collection(undefined),
          createTestItem: item,
          createRunProfile: (_label, _kind, run) => { handler ??= run; return {}; },
          createTestRun: () => ({
            enqueued() {}, appendOutput() {}, end,
            started: (test) => events.push(["started", test.id]),
            passed: (test) => events.push(["passed", test.id]),
            skipped: (test) => events.push(["skipped", test.id]),
            failed: (test) => events.push(["failed", test.id]),
            errored: (test) => events.push(["errored", test.id]),
          }),
          dispose() {},
        }),
      },
      TestRunProfileKind: { Run: 1, Debug: 2, Coverage: 3 },
      TestRunRequest: class { constructor(include, exclude, profile) { this.include = include; this.exclude = exclude; this.profile = profile; } },
      TestMessage: class { constructor(message) { this.message = message; } },
      RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
      Range: class {},
      Uri: { file: (fsPath) => ({ fsPath, scheme: "file" }) },
      workspace: {
        textDocuments: [],
        fs: { readFile: async () => new TextEncoder().encode("class X") },
        findFiles: async () => [{ fsPath: "/app/src/X.kt", scheme: "file" }],
        createFileSystemWatcher: () => ({ onDidCreate: () => events$, onDidChange: () => events$, onDidDelete: () => events$, dispose() {} }),
        onDidChangeTextDocument: () => events$,
      },
    }));
    mock.module(source + "config.js", () => ({ readConfig: () => ({}), configuredInvocation: () => ({}) }));
    mock.module(source + "debug.js", () => ({ launchWithJdwp() {}, resolveAttachType() {} }));
    mock.module(source + "jetbrains.js", () => ({ isJetBrainsDebugger: () => false }));
    // Load only after installing the VS Code and Elide CLI module mocks.
    const { ElideTestController } = await import(source + "testing.ts");
    const project = { root: "/app", folder: {}, model: { name: "app", modules: [{ kind: "test", contentRoots: [{ path: "/app", sourceRoots: [{ kind: "test", path: "/app/src" }] }] }] } };
    const controller = new ElideTestController(
      { projects: [project], projectAt: () => project, membersOf: () => [], onDidChange: () => events$ },
      { log() {} },
      new Map(),
    );
    await controller.refreshAll();
    const projectItem = controller.controller.items.get("p:/app");
    const excluded = projectItem.children.get("c:/app:X").children.get("m:/app:X#b");
    assert.ok(excluded);
    handler({ include: [projectItem], exclude: [excluded], profile: { kind: 1 } }, { isCancellationRequested: false, onCancellationRequested: () => events$ });
    await ended;
    const pattern = core.jvmTestNamePattern([{ binaryName: "X", method: "a" }, { binaryName: "X", method: "c" }]);
    assert.equal(runs.length, 1);
    assert.ok(runs[0].includes(pattern) || runs[0].some((arg) => arg.endsWith("=" + pattern)), runs[0].join(" "));
    assert.deepEqual(events, [["passed", "m:/app:X#a"], ["passed", "m:/app:X#c"]]);
    controller.dispose();
  `], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 20_000 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
