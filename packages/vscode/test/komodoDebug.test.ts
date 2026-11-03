import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// Keep module mocks in a separate process so other extension unit tests see their real dependencies.
test("Komodo's adapter uses the current workspace manifest and rejects unavailable folders", () => {
  const source = new URL("../src/", import.meta.url).pathname;
  const result = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict";
    import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
    import { tmpdir } from "node:os";
    import path from "node:path";
    import { mock } from "bun:test";
    const source = ${JSON.stringify(source)};
    const disposable = { dispose() {} };
    mock.module("vscode", () => ({
      EventEmitter: class { event = () => disposable; fire() {} dispose() {} },
      window: { showWarningMessage: async () => undefined },
      workspace: { registerTextDocumentContentProvider: () => disposable, workspaceFile: undefined },
      commands: { registerCommand: () => disposable },
      DebugAdapterExecutable: class { constructor(command, args, options) { Object.assign(this, { command, args, options }); } },
      Uri: { file: (fsPath) => ({ scheme: "file", fsPath }) },
      RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
    }));
    mock.module("vscode-languageclient/node", () => ({
      LanguageClient: class {
        state = 2;
        initializeResult = { capabilities: { completionProvider: {}, hoverProvider: true, definitionProvider: true, executeCommandProvider: { commands: ["komodo.reload"] } } };
        onDidChangeState = () => disposable;
        async start() {} async dispose() {} async sendRequest() { return "reloaded"; }
      },
      State: { Stopped: 1, Running: 2, Starting: 3 }, CloseAction: { DoNotRestart: 1 }, ErrorAction: { Shutdown: 2 },
      ResponseError: class extends Error {},
      ErrorCodes: { MethodNotFound: -32601 },
    }));
    // Load only after the child process has installed its VS Code module boundary.
    const { KomodoLanguageServer } = await import(source + "komodoLsp.ts");
    const { KomodoDebugAdapterFactory } = await import(source + "komodoDebug.ts");

    const root = mkdtempSync(path.join(tmpdir(), "komodo-debug-"));
    const launcher = path.join(root, "komodo");
    const response = JSON.stringify({ type: "response", command: "initialize", request_seq: 1, success: true, body: { supportsConfigurationDoneRequest: true, supportsEvaluateForHovers: true } });
    writeFileSync(launcher, "#!" + process.execPath + "\\nprocess.stdin.once('data', () => process.stdout.write('Content-Length: " + Buffer.byteLength(response) + "' + String.fromCharCode(13,10,13,10) + " + JSON.stringify(response) + "));", { mode: 0o755 });
    const folder = { name: "app", uri: { fsPath: path.join(root, "app"), toString: () => "file://" + path.join(root, "app") } };
    const model = {
      root: folder.uri.fsPath, name: "app", elideVersion: "1.5.1", kotlin: { freeCompilerArgs: [] },
      modules: [{
        name: "app.main", sourceSet: "main", kind: "source",
        contentRoots: [{ path: folder.uri.fsPath + "/src", sourceRoots: [{ path: folder.uri.fsPath + "/src/main/kotlin", kind: "source" }], excludedPatterns: [] }],
        libraries: [], moduleDeps: [],
      }],
      libraries: [], entrypoints: [], warnings: [], members: [],
    };
    const settings = { path: launcher, javaHome: path.join(root, "jdk") };
    const server = new KomodoLanguageServer(path.join(root, "storage"), () => {});

    await assert.rejects(server.debugLaunch(folder), /needs the Komodo project manifest of 'app'/, "a folder that never synced with Komodo");
    assert.match(await server.sync(folder, [model], { path: path.join(root, "missing") }), /disabled/);
    await assert.rejects(server.debugLaunch(folder));

    assert.equal(await server.sync(folder, [model], settings), "1 modules · started");
    const launch = await server.debugLaunch(folder);
    assert.equal(launch.launcher, launcher);
    assert.equal(launch.javaHome, settings.javaHome);
    assert.ok(launch.manifest.startsWith(path.join(root, "storage", "komodo-lsp")) && launch.manifest.endsWith("project.properties"));
    assert.ok(existsSync(launch.manifest), "the manifest the server reads is the one the adapter gets");

    const factory = new KomodoDebugAdapterFactory({ komodoDebugLaunch: (f) => server.debugLaunch(f) }, () => {});
    await assert.rejects(factory.createDebugAdapterDescriptor({ workspaceFolder: undefined }), /needs a workspace folder/);

    // The last sync decides: a folder left without Kotlin projects has nothing to debug.
    await server.sync(folder, [], settings);
    await assert.rejects(server.debugLaunch(folder), /cannot start: no Elide projects/);
    server.dispose();
    rmSync(root, { recursive: true, force: true });
  `], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 20_000 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

test("developer DAP handshake rejects old and malformed adapters, accepts capabilities, and kills cancelled probes", () => {
  const source = new URL("../src/komodoDebug.ts", import.meta.url).pathname;
  const result = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict";
    import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
    import { tmpdir } from "node:os";
    import path from "node:path";
    import * as childProcess from "node:child_process";
    import { mock } from "bun:test";
    mock.module("vscode", () => ({}));
    const realSpawn = childProcess.spawn;
    let spawned;
    // Preserve the real process boundary, recording its PID so cancellation needs no filesystem notification.
    mock.module("node:child_process", () => ({ ...childProcess, spawn: (...args) => {
      spawned = realSpawn(...args);
      return spawned;
    } }));
    // The production module must load after the VS Code boundary is installed.
    const { requireKomodoDebugProtocol } = await import(${JSON.stringify(source)});
    const root = mkdtempSync(path.join(tmpdir(), "komodo-dap-probe-"));
    const launcher = path.join(root, "komodo");
    const marker = path.join(root, "pid");
    const launch = { launcher, manifest: path.join(root, "project.properties"), javaHome: undefined };
    const install = (body) => writeFileSync(launcher,
      "#!" + process.execPath + "\\nimport { renameSync, writeFileSync } from 'node:fs'; writeFileSync(" + JSON.stringify(marker + ".tmp") + ", String(process.pid)); renameSync(" + JSON.stringify(marker + ".tmp") + ", " + JSON.stringify(marker) + "); " + body,
      { mode: 0o755 });
    const response = (body) => {
      const message = JSON.stringify({ type: "response", command: "initialize", request_seq: 1, success: true, body });
      return "process.stdin.once('data', () => { process.stdout.write('Content-Length: " + Buffer.byteLength(message) + "' + String.fromCharCode(13,10,13,10)); process.stdout.write(" + JSON.stringify(message) + "); });";
    };
    try {
      install("process.exit(2);");
      await assert.rejects(requireKomodoDebugProtocol(launch), /adapter exited/);
      install(response({ supportsConfigurationDoneRequest: true }));
      await assert.rejects(requireKomodoDebugProtocol(launch), /Kotlin evaluation/);
      install("process.stdin.once('data', () => process.stdout.write('Content-Length: 1' + String.fromCharCode(13,10,13,10) + '{'));");
      await assert.rejects(requireKomodoDebugProtocol(launch), /invalid DAP JSON/);
      install("process.stdin.once('data', () => process.stdout.write('Content-Length: 1048577' + String.fromCharCode(13,10,13,10)));");
      await assert.rejects(requireKomodoDebugProtocol(launch), /invalid initialize response length/);
      install("process.stdin.once('data', () => process.stdout.write('x'.repeat(1048577)));");
      await assert.rejects(requireKomodoDebugProtocol(launch), /invalid initialize response/);
      install(response({ supportsConfigurationDoneRequest: true, supportsEvaluateForHovers: true }));
      await requireKomodoDebugProtocol(launch);
      assert.throws(() => process.kill(Number(readFileSync(marker, "utf8")), 0), /ESRCH/, "successful probe is not left running");
      install("process.stdin.resume();");
      const abort = new AbortController();
      const pending = requireKomodoDebugProtocol(launch, abort.signal);
      const pid = spawned.pid;
      assert.ok(pid, "the probe spawned a real adapter before cancellation");
      abort.abort(new Error("cancelled probe"));
      await assert.rejects(pending, /cancelled probe/);
      assert.throws(() => process.kill(pid, 0), /ESRCH/, "cancelled probe is not left running");
    } finally { rmSync(root, { recursive: true, force: true }); }
  `], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 20_000 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
