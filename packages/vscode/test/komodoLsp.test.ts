import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

/** Runs `body` in a child Bun with `vscode` and the language client mocked, `komodoLsp.ts` imported as `komodo`. */
function run(body: string, setup = ""): { status: number | null; stderr: string } {
  const source = new URL("../src/komodoLsp.ts", import.meta.url).pathname;
  const debug = new URL("../src/komodoDebug.ts", import.meta.url).pathname;
  const result = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict";
    import { mock } from "bun:test";
    const editorDocuments = [];
    const clients = [];
    class Emitter {
      listeners = new Set();
      event = (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
      fire(value) { for (const listener of [...this.listeners]) listener(value); }
      dispose() { this.listeners.clear(); }
    }
    let startFailure, reloadFailure, startWait, dapFailure, resolutionFailure;
    let capabilities = { completionProvider: {}, definitionProvider: true, hoverProvider: true, executeCommandProvider: { commands: ["komodo.reload"] } };
    const previewFolder = { uri: { fsPath: "/work/app", toString: () => "file:///work/app" }, name: "app", index: 0 };
    let identity = { executable: process.execPath, bundle: "/komodo", protocol: { lsp: 1, dap: 1, preview: 2 }, capabilities: ["lsp", "dap", "preview"] };
    mock.module("vscode", () => ({
      EventEmitter: Emitter,
      workspace: { textDocuments: editorDocuments, getWorkspaceFolder: () => previewFolder, registerTextDocumentContentProvider: () => ({ dispose() {} }) },
      commands: { registerCommand: () => ({ dispose() {} }) },
      Uri: { file: (fsPath) => ({ scheme: "file", fsPath }) },
      RelativePattern: class { constructor(base, pattern) { this.baseUri = base; this.pattern = pattern; } },
      window: { showWarningMessage: async () => undefined },
    }));
    mock.module("vscode-languageclient/node", () => ({
      LanguageClient: class {
        state = 1;
        changes = new Emitter();
        onDidChangeState = this.changes.event;
        initializeResult = { capabilities };
        constructor(_id, _name, _server, options) { this.options = options; clients.push(this); }
        async start() { if (startWait) await startWait; if (startFailure) throw startFailure; this.state = 2; }
        async sendRequest() { if (reloadFailure) throw reloadFailure; return "reloaded"; }
        async dispose() { this.disposed = true; this.state = 1; }
      },
      State: { Stopped: 1, Running: 2, Starting: 3 }, CloseAction: { DoNotRestart: 1 }, ErrorAction: { Shutdown: 2 },
    }));
    mock.module(${JSON.stringify(debug)}, () => ({ requireKomodoDebugProtocol: async () => { if (dapFailure) throw dapFailure; } }));
    ${setup}
    // Load only after the child process has installed its VS Code module boundary.
    const komodo = await import(${JSON.stringify(source)});
    ${body}
  `], { encoding: "utf8", timeout: 10_000 });
  return { status: result.status, stderr: result.stderr };
}

test("compiler plugins come from a configured directory, versioned or not, embeddable or not, never a sources jar", () => {
  expect(run(`
    const need = { compose: true, serialization: true };
    // Komodo's installDist: one unversioned jar per plugin.
    const dist = komodo.komodoPluginArguments(need, "/komodo/plugins", () => ["kotlin-compose-compiler-plugin.jar"]);
    assert.deepEqual(dist, { args: ["--plugin", "compose=/komodo/plugins/kotlin-compose-compiler-plugin.jar"], missing: ["kotlinx-serialization"] });
    // A Maven-style directory: the newest version, not the sources jar, and not another plugin sharing the prefix.
    const maven = komodo.komodoPluginArguments(need, "/m2", () => [
      "kotlin-serialization-compiler-plugin-embeddable-2.5.0-Beta1-sources.jar",
      "kotlin-serialization-compiler-plugin-embeddable-2.4.0.jar",
      "kotlin-serialization-compiler-plugin-embeddable-2.5.0-Beta1.jar",
      "kotlin-compose-compiler-plugin-embeddable2.jar",
    ]);
    assert.deepEqual(maven, { args: ["--plugin", "kotlinx-serialization=/m2/kotlin-serialization-compiler-plugin-embeddable-2.5.0-Beta1.jar"], missing: ["compose"] });
    assert.deepEqual(komodo.komodoPluginArguments({ compose: false, serialization: false }, "/m2", () => []), { args: [], missing: [] });
    // No directory: the server applies the plugins its own distribution ships.
    assert.deepEqual(komodo.komodoPluginArguments(need, undefined), { args: [], missing: [] });
  `)).toEqual({ status: 0, stderr: "" });
});

test("the client sees only Kotlin files on disk under the Komodo folders, glob characters in their paths included", () => {
  expect(run(`
    const selector = komodo.komodoDocumentSelector(["/work/app[v2]", "/work/{core}"]);
    // The folder is the literal base of each pattern, never part of the glob.
    assert.deepEqual(selector.map(({ scheme, pattern }) => ({ scheme, base: pattern.baseUri.fsPath, glob: pattern.pattern })), [
      { scheme: "file", base: "/work/app[v2]", glob: "**/*.kt" },
      { scheme: "file", base: "/work/{core}", glob: "**/*.kt" },
    ]);
  `)).toEqual({ status: 0, stderr: "" });
});


test("preview sessions require protocol 2 and report old servers instead of falling back", () => {
  expect(run(`
    const server = Object.create(komodo.KomodoLanguageServer.prototype);
    const requests = [];
    let answer = { protocol: 2, port: 12345, token: "secret", pid: 42 };
    server.clientFor = async (file) => {
      assert.equal(file, "/workspace/Original.kt");
      return { uri: "file:///workspace/Original.kt", client: {
        sendRequest: async (method, params) => { requests.push({ method, params }); return answer; }
      } };
    };
    assert.deepEqual(await server.previewSession("/workspace/Original.kt"), answer);
    assert.deepEqual(requests, [{ method: "komodo/preview/open", params: { textDocument: { uri: "file:///workspace/Original.kt" } } }]);
    for (const invalid of [undefined, { ...answer, protocol: 1 }, { ...answer, port: 0 }, { ...answer, token: "" }, { ...answer, token: "bad\\nline" }]) {
      answer = invalid;
      await assert.rejects(server.previewSession("/workspace/Original.kt"), /invalid preview session/);
    }
    // Import after the harness installs its mocked language-client boundary.
    const { ResponseError } = await import("vscode-languageclient/node");
    server.clientFor = async () => ({ uri: "file:///workspace/Original.kt", client: {
      sendRequest: async () => { const error = new ResponseError("missing"); error.code = -32601; throw error; }
    } });
    await assert.rejects(server.previewSession("/workspace/Original.kt"), /too old for the Komodo preview engine.*there is no fallback/);
  `)).toEqual({ status: 0, stderr: "" });
});

test("preview sync awaits the same client with original URIs and current buffer versions", () => {
  expect(run(`
    const server = Object.create(komodo.KomodoLanguageServer.prototype);
    const original = "/workspace/Original.kt";
    editorDocuments.push(
      { uri: { scheme: "file", fsPath: original, toString: () => "file://" + original }, version: 7, getText: () => "unsaved newest" },
      { uri: { scheme: "file", fsPath: "/other.kt", toString: () => "file:///other.kt" }, version: 2, getText: () => "unrelated" }
    );
    const entered = Promise.withResolvers();
    let completed = false;
    const pending = Promise.withResolvers();
    server.clientFor = async (file) => {
      assert.equal(file, original);
      return { client: { sendRequest: async (method, params) => {
        assert.equal(method, "komodo/preview/sync");
        assert.deepEqual(params, { documents: [{ uri: "file://" + original, version: 7, text: "unsaved newest" }] });
        entered.resolve();
        await pending.promise;
      } } };
    };
    const syncing = server.syncPreview([original]).then(() => { completed = true; });
    await entered.promise;
    assert.equal(completed, false);
    pending.resolve(null);
    await syncing;
    assert.equal(completed, true);
  `)).toEqual({ status: 0, stderr: "" });
});

test("a client restarting its crashed server is stopped once it is up, and disposed so it never restarts one again", () => {
  expect(run(`
    const server = Object.create(komodo.KomodoLanguageServer.prototype);
    server.log = (message) => { throw new Error(message); };
    const calls = [];
    let state = 3;
    const up = Promise.withResolvers();
    const asked = Promise.withResolvers();
    server.running = { launch: "", client: {
      get state() { return state; },
      start: () => { calls.push("start"); asked.resolve(); return up.promise; },
      dispose: async () => { calls.push(state === 2 ? "dispose running" : "dispose starting"); },
    } };
    const stopping = server.stop();
    await asked.promise;
    assert.deepEqual(calls, ["start"]);
    state = 2;
    up.resolve();
    await stopping;
    assert.deepEqual(calls, ["start", "dispose running"]);
    assert.equal(server.client, undefined);
  `)).toEqual({ status: 0, stderr: "" });
});

test("disposing rejects queued syncs and does not accept later syncs", () => {
  expect(run(`
    const server = new komodo.KomodoLanguageServer("/tmp/elide-komodo-test", () => {});
    const folder = { uri: { fsPath: "/work/app", toString: () => "file:///work/app" }, name: "app", index: 0 };
    const calls = [];
    server.apply = async () => { calls.push("apply"); return "started"; };
    const pending = server.sync(folder, [{ root: "/work/app" }], {});
    server.dispose();
    await assert.rejects(pending, /disposed/);
    await assert.rejects(server.sync(folder, [{ root: "/work/app" }], {}), /disposed/);
    assert.deepEqual(calls, []);
    assert.equal(server.client, undefined);
  `)).toEqual({ status: 0, stderr: "" });
});

test("disposing while the manifest is written cannot start a late server", () => {
  expect(run(`
    const server = new komodo.KomodoLanguageServer("/tmp/elide-komodo-test", () => {});
    const folder = { uri: { fsPath: "/work/app", toString: () => "file:///work/app" }, name: "app", index: 0 };
    const pending = server.sync(folder, [{ root: "/work/app" }], { path: process.execPath });
    await writing.promise;
    server.dispose();
    written.resolve({ skipped: [], plugins: { compose: false, serialization: false }, modules: [{}] });
    await assert.rejects(pending, /disposed/);
    assert.deepEqual(clients, []);
    assert.equal(server.client, undefined);
  `, `
    const writing = Promise.withResolvers();
    const written = Promise.withResolvers();
    // Capture the real exports before installing the partial module-loading boundary.
    const core = await import("@elide/ide-core");
    mock.module("@elide/ide-core", () => ({
      ...core,
      writeKomodoProject: async () => { writing.resolve(); return written.promise; }
    }));
  `)).toEqual({ status: 0, stderr: "" });
});

test("disposing during replacement shutdown prevents the replacement from starting", () => {
  expect(run(`
    const server = new komodo.KomodoLanguageServer("/tmp/elide-komodo-test", () => {});
    const folder = { uri: { fsPath: "/work/app", toString: () => "file:///work/app" }, name: "app", index: 0 };
    const stopping = Promise.withResolvers();
    const stopped = Promise.withResolvers();
    server.running = { launch: "old", client: {
      state: 2,
      dispose: async () => { stopping.resolve(); await stopped.promise; }
    } };
    const pending = server.sync(folder, [{ root: "/work/app" }], { path: process.execPath });
    await stopping.promise;
    server.dispose();
    stopped.resolve();
    await assert.rejects(pending, /disposed/);
    assert.deepEqual(clients, []);
    assert.equal(server.client, undefined);
  `, `
    // Capture the real exports before installing the partial module-loading boundary.
    const core = await import("@elide/ide-core");
    mock.module("@elide/ide-core", () => ({
      ...core,
      writeKomodoProject: async () => ({ skipped: [], plugins: { compose: false, serialization: false }, modules: [{}] })
    }));
  `)).toEqual({ status: 0, stderr: "" });
});

const lifecycleSetup = `
  const core = await import("@elide/ide-core");
  mock.module("@elide/ide-core", () => ({ ...core,
    writeKomodoProject: async () => ({ skipped: [], plugins: { compose: false, serialization: false }, modules: [{}] })
  }));
  const distribution = await import(new URL("../src/komodoDistribution.ts", ${JSON.stringify(import.meta.url)}).pathname);
  mock.module(new URL("../src/komodoDistribution.ts", ${JSON.stringify(import.meta.url)}).pathname, () => ({ ...distribution,
    resolveKomodo: async () => { if (resolutionFailure) throw resolutionFailure; return identity; }
  }));
`;

test("availability retires live native consumers on missing, incompatible, failed start/reload and recovers by sync", () => {
  expect(run(`
    const server = new komodo.KomodoLanguageServer("/tmp/elide-komodo-test", () => {});
    const events = [];
    server.onDidChangeAvailability(() => events.push(server.available));
    const sync = () => server.sync(previewFolder, [{ root: "/work/app" }], {});
    assert.match(await sync(), /started/);
    assert.equal(server.available, true);
    await server.debugLaunch(previewFolder);
    await server.requirePreview("/work/app/Screen.kt");
    for (const status of ["missing", "incompatible", "upgrade"]) {
      const previous = server.client;
      resolutionFailure = new distribution.KomodoResolutionError(status, "component " + status);
      const pending = sync();
      assert.equal(server.available, false, "withdraw before async resolution");
      assert.match(await pending, /disabled/);
      assert.equal(previous.disposed, true);
      assert.equal(server.client, undefined);
      await assert.rejects(server.debugLaunch(previewFolder), new RegExp(status));
      await assert.rejects(server.requirePreview("/work/app/Screen.kt"), new RegExp(status));
      resolutionFailure = undefined;
      assert.match(await sync(), /started/);
      assert.equal(server.available, true);
    }
    reloadFailure = new Error("reload failed");
    const previous = server.client;
    assert.match(await sync(), /disabled.*reload failed/);
    assert.equal(previous.disposed, true);
    await assert.rejects(server.debugLaunch(previewFolder), /reload failed/);
    reloadFailure = undefined;
    startFailure = new Error("start failed");
    assert.match(await sync(), /disabled.*start failed/);
    assert.equal(server.client, undefined);
    startFailure = undefined;
    assert.match(await sync(), /started/);
    assert.equal(server.available, true);
    assert.ok(events.includes(false) && events.at(-1) === true);
    server.dispose();
  `, lifecycleSetup)).toEqual({ status: 0, stderr: "" });
});

test("old explicit servers cannot expose DAP targets before real native service readiness", () => {
  expect(run(`
    identity = { executable: process.execPath, bundle: "/developer" };
    const server = new komodo.KomodoLanguageServer("/tmp/elide-komodo-test", () => {});
    const sync = () => server.sync(previewFolder, [{ root: "/work/app" }], {});
    capabilities = { executeCommandProvider: { commands: ["komodo.reload"] } };
    assert.match(await sync(), /disabled.*initialize response/);
    await assert.rejects(server.debugLaunch(previewFolder), /initialize response/);
    capabilities = { completionProvider: {}, definitionProvider: true, hoverProvider: true, executeCommandProvider: { commands: ["komodo.reload"] } };
    dapFailure = new Error("old executable has no DAP initialize support");
    assert.match(await sync(), /disabled.*DAP initialize/);
    await assert.rejects(server.debugLaunch(previewFolder), /DAP initialize/);
    dapFailure = undefined;
    const ready = Promise.withResolvers();
    startWait = ready.promise;
    const pending = sync();
    assert.equal(server.available, false);
    ready.resolve();
    assert.match(await pending, /started/);
    await server.debugLaunch(previewFolder);
    assert.equal(server.available, true);
    server.dispose();
  `, lifecycleSetup)).toEqual({ status: 0, stderr: "" });
});

test("project-load diagnostics and unexpected stop disable dependents until successful sync", () => {
  expect(run(`
    const server = new komodo.KomodoLanguageServer("/tmp/elide-komodo-test", () => {});
    const sync = () => server.sync(previewFolder, [{ root: "/work/app" }], {});
    await sync();
    let previous = server.client;
    previous.options.middleware.handleDiagnostics({}, [{ code: "komodo.project", message: "cannot load source root" }], () => {});
    assert.equal(server.available, false);
    await assert.rejects(server.debugLaunch(previewFolder), /cannot load source root/);
    assert.equal(previous.disposed, true);
    await sync();
    previous = server.client;
    previous.state = 1;
    previous.changes.fire({ newState: 1 });
    assert.equal(server.available, false);
    await assert.rejects(server.requirePreview("/work/app/Screen.kt"), /stopped/);
    assert.equal(previous.disposed, true);
    await sync();
    assert.equal(server.available, true);
    server.dispose();
  `, lifecycleSetup)).toEqual({ status: 0, stderr: "" });
});

test("managed preview compatibility and session failures gate previews only and recover on sync", () => {
  expect(run(`
    const server = new komodo.KomodoLanguageServer("/tmp/elide-komodo-test", () => {});
    const sync = () => server.sync(previewFolder, [{ root: "/work/app" }], {});
    for (const protocol of [undefined, 1, 3, "2"]) {
      identity.protocol.preview = protocol;
      await sync();
      assert.equal(server.available, true, "native LSP and DAP still usable");
      await server.debugLaunch(previewFolder);
      assert.equal(server.previewAvailable, false);
      await assert.rejects(server.requirePreview("/work/app/Screen.kt"), /preview protocol 2/);
    }
    identity.protocol.preview = 2;
    identity.capabilities = ["lsp", "dap"];
    await sync();
    await assert.rejects(server.requirePreview("/work/app/Screen.kt"), /preview protocol 2/);
    identity.capabilities.push("preview");
    await sync();
    assert.equal(server.previewAvailable, true);
    server.rejectPreview("renderer protocol incompatible");
    assert.equal(server.available, true);
    assert.equal(server.previewAvailable, false);
    await assert.rejects(server.requirePreview("/work/app/Screen.kt"), /renderer protocol incompatible/);
    await sync();
    await server.requirePreview("/work/app/Screen.kt");
    assert.equal(server.previewAvailable, true);
    server.dispose();
  `, lifecycleSetup)).toEqual({ status: 0, stderr: "" });
});
