import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const source = new URL("../src/", import.meta.url).pathname;

// Exercise the real CLI transport and artifact/report readers; only editor services and distribution lookup are mocked.
const executable = `
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const root = process.cwd();
const mode = fs.readFileSync(path.join(root, "mode"), "utf8");
const artifact = process.env.ELIDE_COVERAGE_REPORT;
fs.writeFileSync(path.join(root, "invocation.json"), JSON.stringify({ artifact, pid: process.pid, argv: process.argv.slice(2) }));
if (mode === "legacy") {
  const reports = path.join(root, ".dev/reports/coverage/js");
  fs.mkdirSync(reports, { recursive: true });
  fs.writeFileSync(path.join(reports, "lcov.info"), "SF:" + path.join(root, "src/ExampleTest.kt") + "\\nDA:3,1\\nDA:4,0\\nend_of_record\\n");
} else if (mode !== "normal" && artifact) {
  const utf16 = Buffer.from(fs.readFileSync(path.join(root, "src/ExampleTest.kt"), "utf8"), "utf16le");
  const value = createHash("sha256").update(utf16.swap16()).digest("hex");
  fs.writeFileSync(artifact, JSON.stringify({ version: 1, complete: true, files: [{
    engine: "jvm", path: "src/ExampleTest.kt",
    sourceDigest: { algorithm: "sha256-utf16be", value },
    lines: [{ line: 3, covered: true }, { line: 4, covered: false }, { line: 5, covered: true, branches: { covered: 1, total: 2 } }],
  }] }));
}
if (mode === "cancelled") {
  // Written after the artifact so the parent cancels an actual in-flight coverage invocation.
  fs.writeFileSync(path.join(root, "ready"), "ready");
  // A real subprocess must stay alive until cancellation; the parent's fake clock cannot drive it.
  setInterval(() => {}, 1000);
} else {
  console.log("TAP version 13\\n1..1\\nok 1 - sample.ExampleTest > works()");
  if (mode === "gate") {
    console.error("JVM line coverage 66.7% is below the required minimum of 90.0%");
    // TestCommand.COVERAGE_BELOW_MINIMUM is 1, after publishing the artifact and passing TAP.
    process.exitCode = 1;
  }
}
`;

type Scenario = "gate" | "normal" | "legacy" | "cancelled";

function runScenario(scenario: Scenario): void {
  // Keep VS Code module mocks out of Bun's shared registry for other extension tests.
  const result = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict";
    import * as fs from "node:fs";
    import path from "node:path";
    import os from "node:os";
    import { setTimeout as delay } from "node:timers/promises";
    import { mock } from "bun:test";
    import * as core from "@elide/ide-core";
    const source = ${JSON.stringify(source)};
    const scenario = ${JSON.stringify(scenario)};
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "elide-coverage-test-")));
    const file = path.join(root, "src/ExampleTest.kt");
    const bin = path.join(root, "elide");
    const events = [], published = [], output = [], cancellations = [];
    let controller;
    const disposable = { dispose() {} };
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
    class CancellationTokenSource {
      listeners = new Set();
      token = {
        isCancellationRequested: false,
        onCancellationRequested: (callback) => {
          this.listeners.add(callback);
          return { dispose: () => this.listeners.delete(callback) };
        },
      };
      constructor() { cancellations.push(this); }
      cancel() { this.token.isCancellationRequested = true; for (const callback of this.listeners) callback(); }
      dispose() { this.listeners.clear(); }
    }
    mock.module("@elide/ide-core", () => ({ ...core, resolveElideDistribution: () => ({ bin, home: root }) }));
    mock.module("vscode", () => ({
      tests: {
        createTestController: () => ({
          items: collection(undefined), createTestItem: item,
          createRunProfile: (label, kind) => ({ label, kind }),
          createTestRun: () => ({
            enqueued() {}, started() {}, end() {},
            appendOutput: (text) => output.push(text),
            passed: (test) => events.push(["passed", test.id]),
            skipped: (test) => events.push(["skipped", test.id]),
            failed: (test) => events.push(["failed", test.id]),
            errored: (test, message) => events.push(["errored", test.id, message.message]),
            addCoverage: (coverage) => published.push(coverage),
          }),
          dispose() {},
        }),
      },
      CancellationTokenSource,
      TestRunProfileKind: { Run: 1, Debug: 2, Coverage: 3 },
      TestRunRequest: class { constructor(include, exclude, profile) { Object.assign(this, { include, exclude, profile }); } },
      TestMessage: class { constructor(message) { this.message = message; } },
      RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
      Range: class {},
      Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
      BranchCoverage: class { constructor(executed) { this.executed = executed; } },
      StatementCoverage: class { constructor(executed, location, branches) { Object.assign(this, { executed, location, branches }); } },
      FileCoverage: class {
        static fromDetails(uri, details) {
          return {
            uri, details,
            statementCoverage: { covered: details.filter((d) => d.executed === true || d.executed > 0).length, total: details.length },
          };
        }
      },
      Uri: { file: (fsPath) => ({ fsPath, scheme: "file" }) },
      workspace: {
        textDocuments: [],
        fs: { readFile: async (uri) => fs.promises.readFile(uri.fsPath) },
        findFiles: async (pattern) => {
          assert.equal(pattern.base.fsPath, path.join(root, "src"));
          assert.ok(fs.statSync(file).isFile());
          return [{ fsPath: file, scheme: "file" }];
        },
        createFileSystemWatcher: () => ({ onDidCreate: () => disposable, onDidChange: () => disposable, onDidDelete: () => disposable, dispose() {} }),
        onDidChangeTextDocument: () => disposable,
      },
    }));
    mock.module(source + "config.js", () => ({
      readConfig: () => ({}),
      configuredInvocation: () => scenario === "gate" ? { env: { ELIDE_COVERAGE_REPORT: path.join(root, "must-not-be-used.json") } } : {},
    }));
    mock.module(source + "debug.js", () => ({ launchWithJdwp() {}, resolveAttachType() {} }));
    mock.module(source + "jetbrains.js", () => ({ isJetBrainsDebugger: () => false }));
    const invocation = () => JSON.parse(fs.readFileSync(path.join(root, "invocation.json"), "utf8"));
    const assertCleaned = (artifact) => {
      assert.equal(typeof artifact, "string", "coverage CLI must receive a private artifact destination");
      assert.equal(path.isAbsolute(artifact), true);
      assert.equal(fs.existsSync(artifact), false, "artifact must be removed after the run");
      assert.equal(fs.existsSync(path.dirname(artifact)), false, "private coverage directory must be removed too");
    };
    try {
      fs.mkdirSync(path.dirname(file));
      fs.writeFileSync(file, "package sample\\nimport org.junit.jupiter.api.Test\\nclass ExampleTest {\\n  // Unicode source: \\u03bb \\ud83d\\ude00\\n  @Test fun works() {}\\n}\\n");
      fs.writeFileSync(bin, "#!" + process.execPath + "\\n" + ${JSON.stringify(executable)}, { mode: 0o755 });
      fs.writeFileSync(path.join(root, "mode"), scenario);
      // Import after installing editor mocks: static import would capture the real VS Code module.
      const { ElideTestController } = await import(source + "testing.ts");
      const project = { root, folder: {}, model: { name: "app", modules: [{ kind: "test", contentRoots: [{ path: root, sourceRoots: [{ kind: "test", path: path.join(root, "src") }] }] }] } };
      controller = new ElideTestController(
        { projects: [project], projectAt: (value) => value === root ? project : undefined, membersOf: () => [], onDidChange: () => disposable },
        { log() {} }, new Map(),
      );
      const pending = controller.runAll({ coverage: scenario !== "normal" });
      if (scenario === "cancelled") {
        const deadline = Date.now() + 5000;
        // Poll persistent child-process state; fake timers cannot advance another process's filesystem writes.
        while (!fs.existsSync(path.join(root, "ready"))) {
          assert.ok(Date.now() < deadline, "coverage executable did not become ready");
          await delay(10);
        }
        const running = invocation();
        assert.ok(fs.existsSync(running.artifact));
        cancellations.at(-1).cancel();
        const summary = await pending;
        assertCleaned(running.artifact);
        assert.throws(() => process.kill(running.pid, 0), "cancelled CLI must have exited");
        assert.deepEqual(summary.failed, []);
        assert.deepEqual(summary.errored, []);
        assert.deepEqual(published, []);
      } else {
        const summary = await pending;
        const method = "m:" + root + ":sample.ExampleTest#works";
        assert.deepEqual(summary.passed, [method], "passing TAP must match the test discovered from disk");
        assert.deepEqual(summary.failed, []);
        assert.deepEqual(summary.skipped, []);
        if (scenario === "normal") {
          assert.equal(invocation().artifact, undefined, "ordinary runs must not request a coverage artifact");
          assert.equal(summary.coverage, undefined);
          assert.deepEqual(summary.errored, []);
          assert.deepEqual(published, []);
        } else {
          const first = invocation().artifact;
          assertCleaned(first);
          assert.deepEqual(summary.coverage, { [file]: { covered: scenario === "gate" ? 2 : 1, total: scenario === "gate" ? 3 : 2 } });
          assert.equal(published.length, 1, "publish coverage without requiring JaCoCo XML");
          assert.equal(published[0].uri.fsPath, file);
          if (scenario === "gate") {
            assert.deepEqual(summary.errored, ["p:" + root], "unmet minimum errors the project, not its passing test");
            assert.equal(events.some((e) => e[0] === "errored" && e[1] === method), false);
            assert.match(events.find((e) => e[0] === "errored")[2], /minimum|coverage|exited/i);
            assert.equal(fs.existsSync(path.join(root, "must-not-be-used.json")), false, "artifact env overrides configured invocation env");
            assert.equal(fs.existsSync(path.join(root, ".dev")), false, "fixture deliberately produces no XML or legacy coverage reports");
            assert.deepEqual(published[0].details[2].branches.map((b) => b.executed), [1, 0]);
            const again = await controller.runAll({ coverage: true });
            const second = invocation().artifact;
            assert.notEqual(second, first, "coverage runs must not reuse artifact destinations");
            assertCleaned(second);
            assert.deepEqual(again.coverage, summary.coverage);
            assert.deepEqual(again.errored, ["p:" + root]);
          } else {
            assert.deepEqual(summary.errored, [], "old CLI can ignore the artifact variable and publish LCOV instead");
          }
        }
      }
    } finally {
      controller?.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  `], {
    cwd: new URL("..", import.meta.url).pathname,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "ELIDE_COVERAGE_REPORT")),
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
}

test("Coverage minimum failure publishes version 1 coverage without XML, preserves passing tests, and cleans isolated artifacts", () => runScenario("gate"));
test("Ordinary test runs do not request coverage artifacts", () => runScenario("normal"));
test("Coverage falls back to legacy LCOV when an older CLI ignores the artifact destination", () => runScenario("legacy"));
test("Cancelling a coverage run terminates its CLI and removes the private artifact directory", () => runScenario("cancelled"));
