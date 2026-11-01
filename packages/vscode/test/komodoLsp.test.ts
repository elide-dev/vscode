import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

/** Runs `body` in a child Bun with `vscode` and the language client mocked, `komodoLsp.ts` imported as `komodo`. */
function run(body: string, setup = ""): { status: number | null; stderr: string } {
  const source = new URL("../src/komodoLsp.ts", import.meta.url).pathname;
  const result = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict";
    import { mock } from "bun:test";
    const editorDocuments = [];
    const clients = [];
    mock.module("vscode", () => ({
      workspace: { textDocuments: editorDocuments, registerTextDocumentContentProvider: () => ({ dispose() {} }) },
      commands: { registerCommand: () => ({ dispose() {} }) },
      Uri: { file: (fsPath) => ({ scheme: "file", fsPath }) },
      RelativePattern: class { constructor(base, pattern) { this.baseUri = base; this.pattern = pattern; } },
    }));
    mock.module("vscode-languageclient/node", () => ({
      LanguageClient: class {
        constructor() { clients.push(this); }
        async start() {}
        async dispose() {}
      },
      State: { Running: 2, Starting: 3 }, ResponseError: class extends Error {}, ErrorCodes: { MethodNotFound: -32601 }
    }));
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
