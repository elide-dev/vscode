import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

test("Kotlin launch settings survive lazy activation and in-flight companion startup", () => {
  const source = new URL("../src/jetbrains.ts", import.meta.url).pathname;
  const result = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict";
    import { createHash } from "node:crypto";
    import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
    import os from "node:os";
    import path from "node:path";
    import { mock } from "bun:test";
    const directory = mkdtempSync(path.join(os.tmpdir(), "elide-lsp-relaunch-"));
    const root = "/workspace/android";
    const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
    // JetBrains.kotlin-server 0.0.13 published here; 0.0.27 publishes under a directory named by its version.
    const legacy = path.join(directory, "intellij-lsp-servers", hash + ".port");
    const port = path.join(directory, "intellij-lsp-servers", "0.0.27", hash + ".port");
    let commands = 0;
    const documents = [];
    const activation = Promise.withResolvers();
    let activating = false;
    const extension = { isActive: false, packageJSON: { version: "0.0.27" }, activate: async () => {
      activating = true;
      await activation.promise;
      extension.isActive = true;
      writeFileSync(port, "late startup port");
    } };
    const executed = [];
    mock.module("node:os", () => ({ default: { ...os, tmpdir: () => directory } }));
    mock.module("vscode", () => ({
      extensions: { getExtension: () => extension },
      workspace: { workspaceFolders: [{ uri: { fsPath: root } }], textDocuments: documents },
      commands: {
        getCommands: async () => { commands++; return ["jetbrains.kotlin.restartLsp"]; },
        executeCommand: async (command) => {
          assert.equal(existsSync(port) || existsSync(legacy), false, "restart must not reconnect to the just-started stale daemon");
          executed.push(command);
        },
      },
    }));
    // Lazy activation and a stale shared-daemon port must be installed before loading the module.
    const { reloadKotlinLsp } = await import(${JSON.stringify(source)});
    try {
      mkdirSync(path.dirname(port), { recursive: true });
      writeFileSync(port, "12345");
      writeFileSync(legacy, "12345");
      await reloadKotlinLsp(false);
      assert.equal(existsSync(port) && existsSync(legacy), true, "ordinary workspace reload preserves shared server discovery");
      await reloadKotlinLsp(true);
      assert.equal(existsSync(port) || existsSync(legacy), false, "first Kotlin document must not reuse a daemon with old launch settings");
      assert.equal(commands, 0, "do not activate the companion or invoke commands before it is ready");
      documents.push({ uri: { scheme: "file" }, languageId: "kotlin" });
      const restarted = reloadKotlinLsp(true);
      assert.equal(activating, true);
      assert.deepEqual(executed, []);
      activation.resolve();
      assert.equal(await restarted, "jetbrains.kotlin.restartLsp");
      assert.deepEqual(executed, ["jetbrains.kotlin.restartLsp"]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  `], { encoding: "utf8", timeout: 10_000 });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
});

test("Kotlin server plugin options are window-local, preserve quoting, and restore inherited options", () => {
  const source = new URL("../src/jetbrains.ts", import.meta.url).pathname;
  const result = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict";
    import { mock } from "bun:test";
    mock.module("vscode", () => ({}));
    // Load only after the child process has installed its VS Code module boundary.
    const { KotlinLspEnvironment } = await import(${JSON.stringify(source)});
    const original = "-Xmx3g '-Dlabel=a b'";
    // Elide's Compose plugin rides along in the same window-local options, quoted as the companion quotes its own.
    const plugin = "/Users/u/Library/Application Support/Code/User/globalStorage/elide.elide/kotlin-lsp-plugin/abc/elide";
    const compose = { IJ_JAVA_OPTIONS: original };
    const withPlugin = new KotlinLspEnvironment(compose);
    assert.equal(withPlugin.configure({ plugin }), true);
    assert.equal(compose.IJ_JAVA_OPTIONS, original + ' "-Dplugin.path=' + plugin + '"');
    assert.equal(withPlugin.configure({ plugin }), false);
    assert.equal(withPlugin.configure({}), true, "closing the last Compose project drops the plugin");
    assert.equal(compose.IJ_JAVA_OPTIONS, original);
    const plain = {};
    const unquoted = new KotlinLspEnvironment(plain);
    unquoted.configure({ plugin: "/opt/elide/plugin" });
    assert.equal(plain.IJ_JAVA_OPTIONS, "-Dplugin.path=/opt/elide/plugin");
    unquoted.dispose();
    assert.equal("IJ_JAVA_OPTIONS" in plain, false);
  `], { encoding: "utf8", timeout: 10_000 });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
});

test("attach readiness waits for fresh daemon discovery and initialized debugger commands", () => {
  const source = new URL("../src/jetbrains.ts", import.meta.url).pathname;
  const result = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict";
    import { createHash } from "node:crypto";
    import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
    import os from "node:os";
    import path from "node:path";
    import { mock } from "bun:test";
    const directory = mkdtempSync(path.join(os.tmpdir(), "elide-android-lsp-ready-"));
    const root = "/workspace/android";
    const port = path.join(directory, "intellij-lsp-servers", "0.0.27", createHash("sha256").update(root).digest("hex").slice(0, 16) + ".port");
    let initialized = false;
    let restarted = false;
    const poll = Promise.withResolvers();
    globalThis.setTimeout = (callback, milliseconds) => {
      if (milliseconds === 100) poll.resolve(callback);
      return 0;
    };
    mock.module("node:os", () => ({ default: { ...os, tmpdir: () => directory } }));
    mock.module("vscode", () => ({
      extensions: { getExtension: () => ({ isActive: true, packageJSON: { version: "0.0.27" } }) },
      workspace: { workspaceFolders: [{ uri: { fsPath: root } }], textDocuments: [] },
      commands: {
        getCommands: async () => ["jetbrains.kotlin.restartLsp", ...(initialized ? ["start_debug_server"] : [])],
        executeCommand: async () => {
          assert.equal(existsSync(port), false);
          restarted = true;
          writeFileSync(port, "32123");
        },
      },
    }));
    // Load after registering mocked platform modules and the deterministic polling clock.
    const { reloadKotlinLsp } = await import(${JSON.stringify(source)});
    try {
      mkdirSync(path.dirname(port), { recursive: true });
      writeFileSync(port, "12345");
      let finished = false;
      const ready = reloadKotlinLsp(true, true).then(() => { finished = true; });
      const tick = await poll.promise;
      assert.equal(restarted, true);
      assert.equal(finished, false, "a fresh port alone does not mean the debugger client has initialized");
      initialized = true;
      tick();
      await ready;
      assert.equal(finished, true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  `], { encoding: "utf8", timeout: 10_000 });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
});
