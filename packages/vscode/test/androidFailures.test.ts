import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

/** What `elide build android-run-app` printed for a sample whose debug keystore is missing (Elide 1.6.1+5e6565617). */
const KEYSTORE_FAILURE = [
  "[16.3s] ✓ [app] Assembled 'app' from 193 entries (620ms)",
  "[16.4s] error: Keystore /work/app/.dev/crypto/debug.keystore not found",
  "[16.4s] hint: Create one with: elide build android-keystore-app",
  "[16.4s] ✗ [app] android-sign-app (4ms)",
  "[16.5s] ✗ Build failed in 16.5s",
];

// Module mocks live in a separate process so other extension unit tests see their real dependencies.
function run(script: string): { status: number | null; stderr: string } {
  const source = new URL("../src/", import.meta.url).pathname;
  const result = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict";
    import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
    import os from "node:os";
    import path from "node:path";
    import { setImmediate as immediate } from "node:timers/promises";
    import { mock } from "bun:test";
    const source = ${JSON.stringify(source)};
    const KEYSTORE_FAILURE = ${JSON.stringify(KEYSTORE_FAILURE)};
    const notices = [], commands = [], shown = [];
    let pick;
    class EventEmitter {
      listeners = [];
      event = (listener) => { this.listeners.push(listener); return { dispose() {} }; };
      fire(value) { for (const listener of this.listeners) listener(value); }
    }
    const terminals = [{ name: "Task - build android-run-app", show: () => shown.push("task terminal") }];
    mock.module("vscode", () => ({
      EventEmitter,
      CustomExecution: class { constructor(callback) { this.callback = callback; } },
      ProcessExecution: class {},
      Task: class { constructor(definition, scope, name, source, execution, matchers) { Object.assign(this, { definition, scope, name, source, execution, matchers }); } },
      TaskRevealKind: { Always: 1 },
      TaskPanelKind: { Shared: 1 },
      Uri: { file: (fsPath) => ({ fsPath }) },
      tasks: { executeTask: async (task) => task },
      commands: { executeCommand: async (...args) => { commands.push(args); } },
      workspace: { workspaceFolders: [{}] },
      window: {
        terminals,
        createTerminal: ({ pty }) => ({ show: () => { shown.push("debug terminal"); pty.open(); } }),
        showErrorMessage: async (message, ...actions) => { notices.push({ level: "error", message, actions }); return pick; },
        showWarningMessage: async (message, ...actions) => { notices.push({ level: "warning", message, actions }); return pick; },
      },
      debug: { onDidStartDebugSession: () => ({ dispose() {} }) },
    }));
    mock.module(source + "config.js", () => ({ configuredInvocation: () => ({}), readConfig: () => ({ home: globalThis.elideHome }) }));
    mock.module(source + "jetbrains.js", () => ({ isJetBrainsDebugger: (type) => type === "intellij_jvm", jetBrainsDebuggerType() {}, jetBrainsExtension() {}, notifyKotlinSetupPending() {}, pendingKotlinSetup: async () => undefined }));
    const ui = { lines: [], log(line) { this.lines.push(line); } };
    const dirs = [];
    const scratch = (prefix) => { const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix))); dirs.push(dir); return dir; };
    /** A distribution whose \`elide\` prints \`lines\` on stderr, the environment's progress mode on stdout, and exits 1. */
    const fakeElide = (lines) => {
      const home = scratch("elide-home-");
      mkdirSync(path.join(home, "bin"));
      writeFileSync(path.join(home, "bin", "elide"), "#!/bin/sh\\n" + lines.map((line) => "echo '" + line + "' >&2").join("\\n") + "\\necho \\"progress=$ELIDE_PROGRESS\\"\\nexit 1\\n");
      chmodSync(path.join(home, "bin", "elide"), 0o755);
      return home;
    };
    try {
      ${script}
    } finally {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    }
  `], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 20_000 });
  expect(result.error).toBeUndefined();
  return { status: result.status, stderr: result.stderr };
}

test("a failed Android task notifies with Elide's error and hint, and offers the keystore it names", () => {
  expect(run(`
    globalThis.elideHome = fakeElide(KEYSTORE_FAILURE);
    const root = scratch("elide-app-");
    const project = { root, manifestPath: path.join(root, "elide.pkl"), folder: { uri: { fsPath: root } },
      model: { android: { targets: [{ name: "app", kind: "apk" }] } } };
    const workspace = { projects: [project] };
    // Loaded only once the VS Code mock is installed.
    const { executeAndroidTask } = await import(source + "android.ts");
    const task = await executeAndroidTask(workspace, ui, project, { args: ["android-run-app"], options: { device: "emulator-5554" } });
    assert.equal(task.name, "build android-run-app");
    assert.deepEqual(task.definition, { type: "elide", command: "build", args: ["android-run-app"], options: { device: "emulator-5554" } });
    assert.deepEqual(task.matchers, ["$elide"], "the problem matcher still reads the terminal");
    const pty = await task.execution.callback();
    const written = [];
    const closed = Promise.withResolvers();
    pty.onDidWrite((text) => written.push(text));
    pty.onDidClose((code) => closed.resolve(code));
    pick = "Create Android Signing Keystore";
    pty.open();
    assert.equal(await closed.promise, 1, "the task ends with Elide's exit code");
    await immediate();
    const output = written.join("");
    assert.match(output, /\\$ elide build android-run-app --device=emulator-5554/);
    assert.match(output, /error: Keystore \\/work\\/app\\/\\.dev\\/crypto\\/debug\\.keystore not found\\r\\n/);
    assert.match(output, /progress=plain/, "the terminal shows Elide's plain progress");
    const message = "Elide: Keystore /work/app/.dev/crypto/debug.keystore not found — hint: Create one with: elide build android-keystore-app";
    assert.deepEqual(notices, [{ level: "error", message, actions: ["Create Android Signing Keystore", "Show Terminal"] }]);
    assert.deepEqual(ui.lines, [message], "the Elide output channel gets the same line");
    assert.deepEqual(commands, [["elide.androidCreateKeystore", { root, artifact: "app" }]]);

    // Show Terminal reveals the task's own terminal, which VS Code titles with the task's name.
    pick = "Show Terminal";
    const again = await (await executeAndroidTask(workspace, ui, project, { args: ["android-run-app"] })).execution.callback();
    const ended = Promise.withResolvers();
    again.onDidClose(() => ended.resolve());
    again.open();
    await ended.promise;
    await immediate();
    assert.deepEqual(shown, ["task terminal"]);
  `)).toEqual({ status: 0, stderr: "" });
});

test("a Run whose install Android refuses for another signing key offers to uninstall that app and run again", () => {
  expect(run(`
    globalThis.elideHome = fakeElide([
      "error: adb failed with exit code 1: adb: failed to install /work/app/.dev/artifacts/app.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package sample.app signatures do not match newer version; ignoring!]",
    ]);
    const root = scratch("elide-app-");
    const project = { root, manifestPath: path.join(root, "elide.pkl"), folder: { uri: { fsPath: root } },
      model: { android: { targets: [{ name: "app", kind: "apk" }] } } };
    // Loaded only once the VS Code mock is installed.
    const { executeAndroidTask } = await import(source + "android.ts");
    const { androidFailureActions } = await import(source + "failures.ts");
    const reinstalled = [];
    const task = await executeAndroidTask({ projects: [project] }, ui, project, { args: ["android-run-app"] }, async (application) => { reinstalled.push(application); });
    const pty = await task.execution.callback();
    const closed = Promise.withResolvers();
    pty.onDidClose(() => closed.resolve());
    pick = "Uninstall and Retry";
    pty.open();
    await closed.promise;
    await immediate();
    assert.deepEqual(notices.at(-1).actions, ["Uninstall and Retry", "Show Terminal"]);
    assert.deepEqual(reinstalled, ["sample.app"], "the action uninstalls the application the failure names");
    assert.deepEqual(commands, []);

    // Without a way to run again, as for a build that installs nothing, there is nothing to offer.
    assert.deepEqual(androidFailureActions([project], { errors: 1, error: "Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Package sample.app signatures do not match]" }), []);
  `)).toEqual({ status: 0, stderr: "" });
});

test("a debug run that fails before JDWP names Elide's error, reveals its terminal and offers the fix", () => {
  expect(run(`
    globalThis.elideHome = fakeElide([]);
    // Loaded only once the VS Code mock is installed.
    const { launchWithJdwp, onDidEndDebugRun } = await import(source + "debug.ts");
    let ended = 0;
    onDidEndDebugRun(() => ended++);
    const { androidFailureActions } = await import(source + "failures.ts");
    const projects = [{ root: "/work/app", model: { android: { targets: [{ name: "bundle", kind: "aab" }, { name: "app", kind: "apk" }] } } }];
    const lines = [
      "error: app.acme.android.dev is not debuggable",
      'hint: Set android:debuggable="true" on <application> in its manifest',
    ];
    const dist = path.join(fakeElide(lines), "bin", "elide");
    const exited = (failureActions, binary = dist) => {
      const session = launchWithJdwp({ dist: binary, argv: ["build", "android-debug-dev"], cwd: os.tmpdir(), name: "Elide: Debug dev", folder: { uri: { fsPath: os.tmpdir() } },
        attachType: "java", ...(failureActions ? { failureActions } : {}) }, ui, new Map());
      return session.exit;
    };
    pick = "Show Terminal";
    shown.length = 0;
    assert.equal(await exited((failure) => androidFailureActions(projects, failure)), 1);
    await immediate();
    assert.deepEqual(notices.at(-1), { level: "error",
      message: 'Elide: app.acme.android.dev is not debuggable — hint: Set android:debuggable="true" on <application> in its manifest',
      actions: ["Show Terminal"] });
    assert.deepEqual(shown, ["debug terminal", "debug terminal"], "Show Terminal reveals the debug run's terminal");
    assert.equal(ended, 1, "the end of a debug run refreshes what the tree and code lens offer");

    // Nothing recognizable printed: the exit code is all there is.
    pick = undefined;
    assert.equal(await exited(undefined, path.join(fakeElide([]), "bin", "elide")), 1);
    await immediate();
    assert.equal(notices.at(-1).message, "Elide: the debug run exited with code 1 before opening a JDWP port.");

    // The keystore hint offers the keystore of whichever signed artifact it names, an app bundle's too.
    assert.deepEqual(androidFailureActions(projects, { errors: 1, error: "Keystore x not found", hint: "Create one with: elide build android-keystore-bundle" }),
      [{ label: "Create Android Signing Keystore", command: "elide.androidCreateKeystore", arguments: [{ root: "/work/app", artifact: "bundle" }] }]);
    assert.deepEqual(androidFailureActions(projects, { errors: 1, hint: "Create one with: elide build android-keystore-missing" }), []);
    assert.deepEqual(androidFailureActions(projects, { errors: 1, hint: "Set android:debuggable" }), []);
  `)).toEqual({ status: 0, stderr: "" });
});

test("a JetBrains debug launch from a folder opened through a symlink warns and offers its real path", () => {
  expect(run(`
    const real = scratch("elide-real-");
    const link = path.join(scratch("elide-link-"), "app");
    symlinkSync(real, link);
    const { symlinkedFolderTarget, warnSymlinkedFolder } = await import(source + "debug.ts");
    assert.equal(symlinkedFolderTarget({ uri: { fsPath: link } }), real);
    assert.equal(symlinkedFolderTarget({ uri: { fsPath: real } }), undefined);
    assert.equal(symlinkedFolderTarget({ uri: { fsPath: path.join(real, "missing") } }), undefined);
    // Debugger for Java is not known to mind; only the JetBrains debugger is warned about.
    warnSymlinkedFolder({ uri: { fsPath: link } }, "java");
    assert.equal(notices.length, 0);
    pick = "Reopen Folder at Real Path";
    warnSymlinkedFolder({ uri: { fsPath: link } }, "intellij_jvm");
    await immediate();
    assert.equal(notices.length, 1);
    assert.equal(notices[0].level, "warning");
    assert.ok(notices[0].message.includes(real) && notices[0].message.includes("breakpoints"), notices[0].message);
    assert.deepEqual(commands, [["vscode.openFolder", { fsPath: real }, { forceNewWindow: false }]]);
    warnSymlinkedFolder({ uri: { fsPath: real } }, "intellij_jvm");
    assert.equal(notices.length, 1, "a folder opened at its real path is not warned about");
  `)).toEqual({ status: 0, stderr: "" });
});
