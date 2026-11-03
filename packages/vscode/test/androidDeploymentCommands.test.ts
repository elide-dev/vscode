import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// Module mocks live in a separate process so other extension unit tests see their real dependencies.
function run(script: string): { status: number | null; stderr: string } {
  const source = new URL("../src/", import.meta.url).pathname;
  const result = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict";
    import { mock } from "bun:test";
    const source = ${JSON.stringify(source)};
    ${script}
  `], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 20_000 });
  expect(result.error).toBeUndefined();
  return { status: result.status, stderr: result.stderr };
}

const APK = "{ name: 'app', kind: 'apk', device: { runnable: true, debuggable: true, instrumented: false } }";

test("Run on the project emulator boots it headless when the emulator window is off, and Debug names a root project", () => {
  expect(run(`
    const started = [], tasks = [];
    mock.module("vscode", () => ({
      workspace: { saveAll: async () => true },
      debug: { startDebugging: async (folder, config) => { started.push(config); return true; } },
    }));
    mock.module(source + "config.js", () => ({ readConfig: () => ({ androidEmulatorWindow: false }) }));
    mock.module(source + "tasks.js", () => ({
      executeElideTask() {}, taskExitCode() {},
      executeReportedElideTask: async (_workspace, _project, command, invocation) => { tasks.push({ command, invocation }); },
    }));
    mock.module(source + "androidDebug.js", () => ({ ELIDE_ANDROID_DEBUG_TYPE: "elide-android" }));
    // Loaded only once the VS Code mock is installed.
    const { debugAndroid, runAndroid } = await import(source + "android.ts");
    const project = { root: "/work/app", folder: { uri: { fsPath: "/work/app" } }, model: { android: { avd: "project", targets: [${APK}] } } };
    const workspace = { projects: [project] };
    const deployments = (destination) => ({ resolve: async () => ({ root: project.root, artifact: "app", destination, project }) });

    await runAndroid(workspace, {}, deployments({ kind: "emulator" }), undefined);
    assert.deepEqual(tasks, [{ command: "build", invocation: { args: ["android-run-emulator-app"], options: { "no-window": true } } }]);

    // The project at the folder root is named too, so the configuration cannot pick a member declaring the same APK.
    await debugAndroid(workspace, deployments({ kind: "device", serial: "phone" }), undefined);
    assert.deepEqual(started, [{ type: "elide-android", request: "launch", name: "Elide: Debug app", artifact: "app", device: "phone", project: "." }]);
  `)).toEqual({ status: 0, stderr: "" });
});

test("an elide-android configuration naming an APK no synced project declares says so without opening a picker", () => {
  expect(run(`
    const errors = [];
    mock.module("vscode", () => ({
      workspace: { workspaceFolders: [] },
      window: {
        showErrorMessage: async (message) => { errors.push(message); },
        showQuickPick: async () => { throw new Error("no project to pick from"); },
      },
    }));
    mock.module(source + "config.js", () => ({ configuredInvocation: () => ({}), readConfig: () => ({}) }));
    mock.module(source + "debug.js", () => ({ launchWithJdwp() {}, resolveAttachType: async () => "java", warnSymlinkedFolder() {} }));
    mock.module(source + "jetbrains.js", () => ({ isJetBrainsDebugger: () => false }));
    // Loaded only once the VS Code mock is installed.
    const { ElideAndroidDebugConfigurationProvider } = await import(source + "androidDebug.ts");
    const folder = { uri: { fsPath: "/work" } };
    const app = { root: "/work/app", folder, model: { android: { targets: [${APK}] } } };
    const workspace = { projectsIn: () => [app], projectAt: () => app };
    const provider = new ElideAndroidDebugConfigurationProvider(workspace, { log() {} }, new Map(), { target: undefined });
    const config = { type: "elide-android", request: "launch", name: "Debug", artifact: "ap" };
    assert.equal(await provider.resolveDebugConfigurationWithSubstitutedVariables(folder, config), undefined);
    assert.deepEqual(errors, ["Elide: 'ap' is not an Android APK in any synced project in this folder."]);
  `)).toEqual({ status: 0, stderr: "" });
});
