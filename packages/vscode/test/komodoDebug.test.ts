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
      workspace: { registerTextDocumentContentProvider: () => disposable, workspaceFile: undefined },
      commands: { registerCommand: () => disposable },
      DebugAdapterExecutable: class { constructor(command, args, options) { Object.assign(this, { command, args, options }); } },
      Uri: { file: (fsPath) => ({ scheme: "file", fsPath }) },
      RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
    }));
    mock.module("vscode-languageclient/node", () => ({
      LanguageClient: class { state = 2; async start() {} async dispose() {} },
      State: { Running: 2, Starting: 3 },
      ResponseError: class extends Error {},
      ErrorCodes: { MethodNotFound: -32601 },
    }));
    // Load only after the child process has installed its VS Code module boundary.
    const { KomodoLanguageServer } = await import(source + "komodoLsp.ts");
    const { KomodoDebugAdapterFactory } = await import(source + "komodoDebug.ts");

    const root = mkdtempSync(path.join(tmpdir(), "komodo-debug-"));
    const launcher = path.join(root, "komodo");
    writeFileSync(launcher, "#!/bin/sh\\n");
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
    await assert.rejects(server.sync(folder, [model], { path: path.join(root, "missing") }));
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
