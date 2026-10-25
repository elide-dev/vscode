import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// Keep VS Code module mocks out of Bun's shared registry for the other extension tests.
test("Logcat cancels discovery and stale filters when the Android model or stream disappears", () => {
  const source = new URL("../src/", import.meta.url).pathname;
  const result = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict";
    import { mock } from "bun:test";
    import * as core from "@elide/ide-core";
    const source = ${JSON.stringify(source)};
    const commands = new Map(), streams = [], outputs = [], errors = [];
    const model = { android: { targets: [] } };
    const project = { root: "/app", model };
    const devices = [{ serial: "phone", state: "device", ready: true, emulator: false }];
    let discover = async () => devices;
    let input = async () => "";
    let changed;
    mock.module("@elide/ide-core", () => ({
      ...core,
      adbExecutable: () => process.execPath,
      listAndroidDevices: (_sdk, signal) => discover(signal),
      AndroidLogcatSession: class {
        active = false;
        disposed = false;
        starts = 0;
        constructor() { streams.push(this); }
        async start(options) {
          if (this.disposed) throw new Error("The logcat session has been disposed.");
          this.starts++;
          this.device = options.device;
          this.active = true;
        }
        stop() { this.active = false; }
        dispose() { this.disposed = true; this.stop(); }
      },
    }));
    mock.module("vscode", () => ({
      workspace: { isTrusted: true },
      Disposable: class { constructor(dispose) { this.dispose = dispose; } },
      window: {
        createOutputChannel: () => {
          const output = { disposed: false, appendLine() {}, show() {}, dispose() { this.disposed = true; } };
          outputs.push(output);
          return output;
        },
        showInputBox: (...args) => input(...args),
        showQuickPick: async (items) => items[0],
        showErrorMessage: async (message) => { errors.push(message); },
      },
      commands: { registerCommand: (name, run) => { commands.set(name, run); return { dispose() {} }; } },
    }));
    mock.module(source + "android.js", () => ({ androidSdkFor: () => "/sdk", toAndroidTarget: (value) => value }));
    mock.module(source + "androidStackLinks.js", () => ({ ANDROID_LOGCAT_LANGUAGE: "logcat", registerAndroidStackLinks: () => ({ dispose() {} }) }));
    // Load only after installing the VS Code and logcat-session module mocks.
    const { registerAndroidLogcat } = await import(source + "androidLogcat.ts");
    const registration = registerAndroidLogcat({
      projects: [project], projectAt: () => project,
      onDidChange: (listener) => { changed = listener; return { dispose() {} }; },
    }, () => undefined);
    const target = { root: "/app", device: "phone" };

    const response = Promise.withResolvers(), requested = Promise.withResolvers();
    let signal;
    discover = async (value) => { signal = value; requested.resolve(); return response.promise; };
    const opening = commands.get("elide.androidLogcat")(target);
    await requested.promise;
    project.model = undefined;
    changed();
    assert.equal(signal.aborted, true, "losing the Android model must terminate in-flight adb discovery");
    response.resolve(devices);
    await opening;
    assert.equal(streams.length, 0, "a late adb reply cannot start logcat for a removed Android model");
    assert.equal(outputs.length, 0);

    project.model = model;
    discover = async () => devices;
    await commands.get("elide.androidLogcat")(target);
    const view = streams.at(-1);
    assert.equal(view.active, true);
    const answer = Promise.withResolvers(), editing = Promise.withResolvers();
    let inputCalls = 0;
    input = async () => {
      if (++inputCalls === 1) { editing.resolve(); return answer.promise; }
      return "";
    };
    const filtering = commands.get("elide.androidLogcatFilter")(target);
    await editing.promise;
    project.model = undefined;
    changed();
    project.model = model;
    changed();
    answer.resolve("com.example.app");
    await filtering;
    assert.equal(view.disposed, true);
    assert.equal(view.starts, 1, "a late filter cannot resurrect its disposed stream even if the model returns");
    assert.deepEqual(errors, []);

    await commands.get("elide.androidLogcat")(target);
    const active = streams.at(-1);
    const restartReply = Promise.withResolvers(), restarting = Promise.withResolvers();
    discover = async (value) => { signal = value; restarting.resolve(); return restartReply.promise; };
    const restart = commands.get("elide.androidLogcatRestart")(target);
    await restarting.promise;
    await commands.get("elide.androidLogcatStop")(target);
    assert.equal(signal.aborted, true);
    assert.equal(active.active, false);
    restartReply.resolve(devices);
    await restart;
    assert.equal(active.starts, 1, "stopping during discovery must not restart the stream afterward");
    discover = async () => [{ serial: "phone:5556", state: "device", ready: true, emulator: false }];
    await commands.get("elide.androidLogcatRestart")(target);
    assert.equal(active.device, "phone:5556", "Restart follows the device to its new serial");
    registration.dispose();
    assert.equal(outputs.every((output) => output.disposed), true);
    assert.deepEqual(errors, []);
  `], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 20_000 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

test("Logcat cancels installed-package discovery on disposal or model removal without opening a late picker", () => {
  const source = new URL("../src/", import.meta.url).pathname;
  const result = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict";
    import { mock } from "bun:test";
    import * as core from "@elide/ide-core";
    const source = ${JSON.stringify(source)};
    const commands = new Map(), errors = [];
    const model = { android: { targets: ["first", "second"].map(name => ({
      name, kind: "apk", output: name + ".apk", manifestFile: "com.example." + name,
    })) } };
    const project = { root: "/app", model };
    let changed, started, release, options, picks = 0, outputs = 0;
    const disposable = () => ({ dispose() {} });
    mock.module("node:child_process", () => ({
      execFile: (_adb, _args, value, callback) => {
        options = value;
        release = () => callback(null, "", "");
        value.signal?.addEventListener("abort", () => callback(Object.assign(new Error("Cancelled"), { name: "AbortError" })), { once: true });
        started.resolve();
        return {};
      },
    }));
    mock.module("node:fs/promises", () => ({ readFile: async file => '<manifest package="' + file + '"/>' }));
    mock.module("yauzl", () => ({ open: (_file, _options, callback) => callback(new Error("not built")) }));
    mock.module("@elide/ide-core", () => ({
      ...core, adbExecutable: () => process.execPath,
      listAndroidDevices: async () => [{ serial: "phone", state: "device", ready: true }],
      AndroidLogcatSession: class { constructor() { throw new Error("Unexpected stream"); } },
    }));
    mock.module("vscode", () => ({
      workspace: { isTrusted: true },
      Disposable: class { constructor(dispose) { this.dispose = dispose; } },
      window: {
        createOutputChannel: () => { outputs++; throw new Error("Unexpected output"); },
        showQuickPick: async items => { picks++; return items[0]; },
        showErrorMessage: async message => { errors.push(message); },
      },
      commands: { registerCommand: (name, run) => { commands.set(name, run); return disposable(); } },
    }));
    mock.module(source + "android.js", () => ({ androidSdkFor: () => "/sdk", toAndroidTarget: value => value }));
    mock.module(source + "androidStackLinks.js", () => ({ ANDROID_LOGCAT_LANGUAGE: "logcat", registerAndroidStackLinks: disposable }));
    // Load after the process/VS Code mocks; a static import would capture the real module dependencies.
    const { registerAndroidLogcat } = await import(source + "androidLogcat.ts");
    for (const reason of ["dispose", "model"]) {
      project.model = model;
      const registration = registerAndroidLogcat({
        projects: [project], projectAt: () => project,
        onDidChange: listener => { changed = listener; return disposable(); },
      }, () => undefined);
      started = Promise.withResolvers();
      const opening = commands.get("elide.androidLogcat")({ root: "/app", device: "phone" });
      await started.promise;
      if (reason === "dispose") registration.dispose();
      else { project.model = undefined; changed(); }
      assert.equal(options.signal?.aborted, true, reason + " cancels package discovery, not just device discovery");
      assert.equal(options.killSignal, "SIGKILL", "read-only discovery must reap a SIGTERM-resistant adb");
      release();
      await opening;
      assert.equal(picks, 0, "cancelled discovery must not open an application picker");
      assert.equal(outputs, 0);
      assert.deepEqual(errors, []);
      registration.dispose();
    }
  `], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 20_000 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
