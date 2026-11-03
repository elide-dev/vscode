import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// Isolate VS Code module mocks from the pure unit tests in Bun's shared module registry.
test("Android deployment preserves emulator identity and respects cancellation during adb replies", () => {
  const source = new URL("../src/", import.meta.url).pathname;
  const result = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict";
    import { mock } from "bun:test";
    import { setTimeout as sleep } from "node:timers/promises";
    const source = ${JSON.stringify(source)};
    const token = { isCancellationRequested: false };
    const errors = [];
    // A notification the user leaves open: its promise only settles once it is dismissed.
    let leaveOpen = false;
    const progress = [];
    const device = { serial: "emulator-5554", state: "device", ready: true, emulator: true };
    const project = { root: "/app", folder: {}, model: { android: { avd: "project", targets: [{ name: "app", kind: "apk", device: { runnable: true, debuggable: true, instrumented: false } }] } } };
    const workspace = { projects: [project], projectAt: (root) => root === project.root ? project : undefined, onDidChange: () => ({ dispose() {} }) };
    const writes = [];
    const state = { get() {}, async update(_key, value) { writes.push(value); } };
    mock.module("vscode", () => ({
      StatusBarAlignment: { Left: 1 }, ProgressLocation: { Notification: 1 },
      window: {
        createStatusBarItem: () => ({ hide() {}, show() {}, dispose() {} }),
        showErrorMessage: (message) => { errors.push(message); return leaveOpen ? Promise.withResolvers().promise : Promise.resolve(undefined); },
        showWarningMessage: async (message) => { errors.push(message); },
        withProgress: (_options, run) => { const shown = run({}, token); progress.push(shown); return shown; },
      },
    }));
    mock.module(source + "android.js", () => ({
      androidSdkFor: () => "/sdk", attachedDevices: async () => [device], toAndroidTarget: (value) => value, uninstallAndroidApp() {},
    }));
    mock.module(source + "config.js", () => ({ readConfig: () => ({ androidEmulatorWindow: true }) }));
    mock.module(source + "tasks.js", () => ({ executeElideTask() {}, taskExitCode() {} }));
    // Dynamic loading is intentional: the mocked VS Code runtime must exist before the module loads.
    const { AndroidDeploymentController } = await import(source + "androidDeployment.ts");
    const make = () => new AndroidDeploymentController(workspace, state);

    // Explicit serial invocations record identity too, not just devices picked through Quick Pick.
    const selected = make();
    selected.avdOf = async () => "selected";
    const deployment = await selected.resolve({ root: "/app", artifact: "app", device: device.serial });
    assert.equal(deployment.destination.avd, "selected");
    // A different AVD now owns that port: find/boot the original AVD, never install on the reused port.
    selected.avdOf = async () => "other";
    selected.bootAvd = async (_project, avd) => { assert.equal(avd, "selected"); return "emulator-5556"; };
    assert.equal(await selected.readyDevice(deployment), "emulator-5556");
    assert.deepEqual(writes.at(-1).destination, { kind: "device", serial: "emulator-5556", avd: "selected" });
    selected.dispose();

    // Cancellation while the final adb discovery is pending must not return a deployable serial.
    const onEmulator = { root: "/app", artifact: "app", destination: { kind: "emulator" } };
    const cancelled = make();
    cancelled.selected = onEmulator;
    let discoveries = 0;
    cancelled.findEmulator = async () => {
      if (++discoveries === 1) return undefined;
      token.isCancellationRequested = true;
      return device;
    };
    cancelled.bootThroughElide = async () => true;
    assert.equal(await cancelled.readyDevice({ ...onEmulator, project }), undefined);
    assert.equal(errors.length, 0, "deliberate cancellation is not a startup failure");
    cancelled.dispose();

    // SDK polling must recheck cancellation after sys.boot_completed resolves.
    token.isCancellationRequested = false;
    const sdk = make();
    sdk.findEmulator = async () => device;
    sdk.bootCompleted = async () => { token.isCancellationRequested = true; return true; };
    assert.equal(await sdk.bootThroughSdk(project, "/sdk", "other", true, true, token), false);
    sdk.dispose();

    // Disposal while checking an already booted AVD must not resurrect a deployment.
    const disposed = make();
    disposed.selected = onEmulator;
    disposed.findEmulator = async () => device;
    disposed.bootCompleted = async () => { disposed.dispose(); return true; };
    assert.equal(await disposed.readyDevice({ ...onEmulator, project }), undefined);

    // A failed startup closes its progress and ends the deployment while the user still has the error open.
    token.isCancellationRequested = false;
    leaveOpen = true;
    progress.length = 0;
    const failed = make();
    failed.selected = onEmulator;
    failed.findEmulator = async () => undefined;
    failed.bootThroughElide = async () => false;
    const settled = await Promise.race([failed.readyDevice({ ...onEmulator, project }), sleep(1_000, "pending", { ref: false })]);
    assert.equal(settled, undefined, "the deployment ends without waiting for the notification");
    assert.equal(progress.length, 1);
    assert.equal(await Promise.race([progress[0], sleep(0, "pending")]), undefined, "the startup progress closed");
    assert.match(errors.at(-1), /startup failed or exceeded two minutes/);
    failed.dispose();
  `], { encoding: "utf8", timeout: 20_000 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

test("Android deployment ignores superseded replies and removed models, never a dismissed picker or an equal model", () => {
  const source = new URL("../src/", import.meta.url).pathname;
  const result = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict";
    import { mock } from "bun:test";
    const source = ${JSON.stringify(source)};
    const devices = [
      { serial: "first", state: "device", ready: true, emulator: false },
      { serial: "second", state: "device", ready: true, emulator: false },
    ];
    let pick;
    // The modal confirmation's answer, and every warning shown.
    let confirmation;
    const warnings = [], uninstalled = [];
    mock.module("vscode", () => ({
      StatusBarAlignment: { Left: 1 },
      window: {
        createStatusBarItem: () => ({ hide() {}, show() {}, dispose() {} }),
        showErrorMessage: async () => undefined,
        showWarningMessage: async (message, options) => { warnings.push({ message, options }); return confirmation; },
        showQuickPick: (...args) => pick(...args),
      },
    }));
    mock.module(source + "android.js", () => ({
      androidSdkFor: () => "/sdk", attachedDevices: async () => devices, toAndroidTarget: (value) => value,
      uninstallAndroidApp: async (project, serial, application) => { uninstalled.push([project.root, serial, application]); },
    }));
    mock.module(source + "config.js", () => ({ readConfig: () => ({ androidEmulatorWindow: true }) }));
    mock.module(source + "tasks.js", () => ({ executeElideTask() {}, taskExitCode() {} }));
    // Load only after installing the VS Code module mocks.
    const { AndroidDeploymentController } = await import(source + "androidDeployment.ts");
    const make = () => {
      const project = { root: "/app", folder: {}, model: { android: { avd: "project", targets: [{ name: "app", kind: "apk", device: { runnable: true, debuggable: true, instrumented: false } }] } } };
      const workspace = { projects: [project], projectAt: (root) => workspace.projects.find((candidate) => candidate.root === root), onDidChange: () => ({ dispose() {} }) };
      const writes = [];
      const state = { get() {}, async update(_key, value) { writes.push(value); } };
      return { project, workspace, writes, state, controller: new AndroidDeploymentController(workspace, state) };
    };
    const target = (device) => ({ root: "/app", artifact: "app", ...(device ? { device } : {}) });

    const discovery = make();
    const reply = Promise.withResolvers();
    let calls = 0;
    discovery.controller.devices = async () => ++calls === 1 ? reply.promise : devices;
    const older = discovery.controller.resolve(target("first"));
    const newer = await discovery.controller.resolve(target("second"));
    reply.resolve(devices);
    assert.equal(await older, undefined);
    assert.equal(newer.destination.serial, "second");
    assert.equal(discovery.controller.target.destination.serial, "second");
    assert.equal(discovery.writes.length, 1);
    discovery.controller.dispose();

    const picker = make();
    const answer = Promise.withResolvers(), opened = Promise.withResolvers();
    pick = (items) => { opened.resolve(items); return answer.promise; };
    const choosing = picker.controller.resolve(target());
    const items = await opened.promise;
    await picker.controller.resolve(target("second"));
    answer.resolve(items.find((item) => item.destination.serial === "first"));
    assert.equal(await choosing, undefined);
    assert.equal(picker.controller.target.destination.serial, "second");
    picker.controller.dispose();

    const storage = make();
    const saved = Promise.withResolvers(), saving = Promise.withResolvers();
    storage.state.update = async (_key, value) => {
      storage.writes.push(value);
      if (value.destination.serial === "first") { saving.resolve(); await saved.promise; }
    };
    const earlierSave = storage.controller.resolve(target("first"));
    await saving.promise;
    await storage.controller.resolve(target("second"));
    saved.resolve();
    assert.equal(await earlierSave, undefined);
    assert.equal(storage.controller.target.destination.serial, "second", "a slow Memento completion cannot restore an old target");
    storage.controller.dispose();

    const removed = make();
    removed.controller.devices = async () => { removed.project.model = undefined; return devices; };
    assert.equal(await removed.controller.resolve(target("first")), undefined);
    assert.equal(removed.writes.length, 0);
    removed.controller.dispose();

    const booting = make();
    const emulator = { serial: "emulator-5554", state: "device", ready: true, emulator: true };
    booting.controller.devices = async () => [...devices, emulator];
    booting.controller.avdOf = async () => "selected";
    const deployment = await booting.controller.resolve(target(emulator.serial));
    booting.controller.avdOf = async () => "other";
    const boot = Promise.withResolvers(), bootStarted = Promise.withResolvers();
    booting.controller.bootAvd = async () => { bootStarted.resolve(); return boot.promise; };
    const ready = booting.controller.readyDevice(deployment);
    await bootStarted.promise;
    await booting.controller.resolve(target("second"));
    boot.resolve("emulator-5556");
    assert.equal(await ready, undefined, "a completed old boot cannot launch or replace a newer target");
    assert.equal(booting.controller.target.destination.serial, "second");
    assert.match(warnings.at(-1).message, /target changed/, "the user learns why nothing was deployed");
    booting.controller.dispose();

    // While the emulator boots, a target picker the user dismisses and a sync that rebuilds an equal model (in
    // place for a root project, as a new project for a workspace member) leave the deployment wanted.
    const kept = make();
    kept.controller.devices = async () => [...devices, emulator];
    kept.controller.avdOf = async () => "selected";
    const pinned = await kept.controller.resolve(target(emulator.serial));
    kept.controller.avdOf = async () => "other";
    const keptBoot = Promise.withResolvers(), keptStarted = Promise.withResolvers();
    kept.controller.bootAvd = async () => { keptStarted.resolve(); return keptBoot.promise; };
    const keptReady = kept.controller.readyDevice(pinned);
    await keptStarted.promise;
    pick = async () => undefined;
    await kept.controller.select();
    kept.project.model = structuredClone(kept.project.model);
    kept.workspace.projects = [{ ...kept.project, model: structuredClone(kept.project.model) }];
    warnings.length = 0;
    keptBoot.resolve("emulator-5556");
    assert.equal(await keptReady, "emulator-5556");
    assert.deepEqual(kept.controller.target.destination, { kind: "device", serial: "emulator-5556", avd: "selected" });
    assert.deepEqual(warnings, []);
    kept.controller.dispose();

    // A device row carries its tree's tools owner, the first app: Run deploys the tree's selected app on that device.
    const app = (root) => ({ root, workspaceRoot: "/ws", folder: {}, model: { android: { avd: "project", targets: [{ name: "app", kind: "apk", device: { runnable: true, debuggable: true, instrumented: false } }] } } });
    const mobile = app("/ws/mobile"), wear = app("/ws/wear");
    const tree = {
      projects: [{ root: "/ws", folder: {}, model: { members: [mobile.root, wear.root] } }, mobile, wear],
      projectAt: (root) => tree.projects.find((candidate) => candidate.root === root),
      membersOf: (root) => root === "/ws" ? [mobile, wear] : [],
      onDidChange: () => ({ dispose() {} }),
    };
    const rows = new AndroidDeploymentController(tree, { get: () => ({ root: wear.root, artifact: "app", destination: { kind: "device", serial: "first" } }), async update() {} });
    rows.devices = async () => devices;
    const onRow = await rows.resolve({ root: mobile.root, device: "second" }, "run");
    assert.equal(onRow.root, wear.root);
    assert.deepEqual(onRow.destination, { kind: "device", serial: "second" });
    assert.equal(rows.target.root, wear.root, "the selection keeps its app");
    rows.dispose();

    // Uninstall and Retry uninstalls nothing until the user confirms, naming the device, that the app's data goes.
    const removal = make();
    removal.controller.devices = async () => devices;
    const onFirst = await removal.controller.resolve(target("first"));
    confirmation = undefined;
    assert.equal(await removal.controller.uninstall(onFirst, "sample.app", "first"), false);
    assert.deepEqual(uninstalled, [], "declining the confirmation runs no adb");
    const { message, options } = warnings.at(-1);
    assert.match(message + options.detail, /first/);
    assert.match(options.detail, /data/);
    assert.equal(options.modal, true);
    confirmation = "Uninstall";
    assert.equal(await removal.controller.uninstall(onFirst, "sample.app", "first"), true);
    assert.deepEqual(uninstalled, [["/app", "first", "sample.app"]]);
    removal.controller.dispose();

    // A reboot may recycle the serial while the destructive confirmation is open. It must not erase another AVD.
    const identityRemoval = make();
    identityRemoval.controller.devices = async () => [emulator];
    let identity = "selected";
    identityRemoval.controller.avdOf = async () => identity;
    const onSelected = await identityRemoval.controller.resolve(target(emulator.serial));
    const erase = Promise.withResolvers();
    confirmation = erase.promise;
    const erasing = identityRemoval.controller.uninstall(onSelected, "sample.app", emulator.serial);
    identity = "other";
    erase.resolve("Uninstall");
    assert.equal(await erasing, false, "a confirmation cannot authorize another AVD at the same serial");
    assert.equal(uninstalled.length, 1);

    // An unanswered identity probe is not proof that this is the authorized emulator either.
    identity = undefined;
    confirmation = "Uninstall";
    assert.equal(await identityRemoval.controller.uninstall(onSelected, "sample.app", emulator.serial), false);
    assert.equal(uninstalled.length, 1);
    identity = "selected";
    assert.equal(await identityRemoval.controller.uninstall(onSelected, "sample.app", emulator.serial), true);
    assert.deepEqual(uninstalled.at(-1), ["/app", emulator.serial, "sample.app"]);
    identityRemoval.controller.dispose();
  `], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 20_000 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
