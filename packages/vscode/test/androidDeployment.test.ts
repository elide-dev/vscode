import { describe, expect, test } from "bun:test";
import type { AndroidDevice, AndroidDeviceTargets } from "@elide/ide-core";
import {
  androidApks, androidAvdToBoot, androidDeviceProblem, androidEmulatorOwners, androidToolsProject, deployableApks, hasAndroidProjects,
  preferredAndroidProject, restoredAndroidTarget,
} from "../src/androidDeploymentState.js";
import type { ElideProject } from "../src/projects.js";

const SIGNED: AndroidDeviceTargets = { runnable: true, debuggable: true, instrumented: false };

function project(root: string, kind = "apk", device: AndroidDeviceTargets | undefined = kind === "apk" ? SIGNED : undefined): ElideProject {
  return { root, model: { android: { targets: [{ name: "app", kind, ...(device ? { device } : {}) }] } } } as ElideProject;
}

const phone: AndroidDevice = { serial: "phone", state: "device", ready: true, emulator: false };

describe("Android deployment decisions", () => {
  test("restores an exact project, APK, and device rather than substituting another serial", () => {
    const selected = { root: "/app", artifact: "release", destination: { kind: "device", serial: "phone" } };
    expect(restoredAndroidTarget(selected)).toEqual(selected);
    expect(restoredAndroidTarget({ root: "/app", artifact: "debug", destination: { kind: "emulator" } })).toEqual({
      root: "/app", artifact: "debug", destination: { kind: "emulator" },
    });
    const emulator = { root: "/app", artifact: "debug", destination: { kind: "device", serial: "emulator-5554", avd: "pixel" } };
    expect(restoredAndroidTarget(emulator)).toEqual(emulator);
  });

  test("rejects malformed persisted state instead of letting adb implicitly choose a target", () => {
    for (const value of [undefined, null, "phone", {}, { root: "/app", artifact: "app" },
      { root: "/app", artifact: "app", destination: null },
      { root: "/app", artifact: "app", destination: 1 },
      { root: "/app", artifact: "app", destination: { kind: "device", serial: "" } },
      { root: "/app", artifact: 1, destination: { kind: "emulator" } },
    ]) expect(restoredAndroidTarget(value)).toBeUndefined();
  });

  test("a ready alternative cannot validate a disconnected remembered device", () => {
    expect(androidDeviceProblem([phone], "old")).toBe("disconnected");
    expect(androidDeviceProblem([], "phone")).toBe("disconnected");
    expect(androidDeviceProblem([phone], "phone")).toBeUndefined();
  });

  test("offline and unauthorized devices remain unavailable even beside a ready phone", () => {
    for (const state of ["offline", "unauthorized", "bootloader"]) {
      expect(androidDeviceProblem([phone, { serial: "old", state, ready: false, emulator: false }], "old")).toBe(state);
    }
  });

  test("a stopped pinned emulator boots its own AVD, a physical device is never booted", () => {
    const pinned = { serial: "emulator-5554", avd: "pixel" };
    expect(androidAvdToBoot([], pinned, "project")).toBe("pixel");
    expect(androidAvdToBoot([{ serial: "emulator-5554", state: "offline", ready: false, emulator: true }], pinned, "project")).toBe("pixel");
    expect(androidAvdToBoot([{ serial: "emulator-5554", state: "device", ready: true, emulator: true }], pinned, "project", "pixel")).toBeUndefined();
    expect(androidAvdToBoot([], { serial: "emulator-5556" }, "project")).toBe("project");
    expect(androidAvdToBoot([phone], { serial: "old" }, "project")).toBeUndefined();
    expect(androidAvdToBoot([{ serial: "old", state: "unauthorized", ready: false, emulator: false }], { serial: "old" }, "project")).toBeUndefined();
  });

  test("a reused emulator serial cannot substitute another AVD for the selected one", () => {
    const ready: AndroidDevice = { serial: "emulator-5554", state: "device", ready: true, emulator: true };
    const pinned = { serial: ready.serial, avd: "selected" };
    expect(androidAvdToBoot([ready], pinned, "project", "other")).toBe("selected");
    expect(androidAvdToBoot([ready], pinned, "project", undefined)).toBe("selected");
    expect(androidAvdToBoot([ready], pinned, "project", "selected")).toBeUndefined();
    expect(androidAvdToBoot([ready], { serial: ready.serial }, "project")).toBeUndefined();
  });

  test("APKs are re-read from the live model, not restored artifact names or library outputs", () => {
    const app = project("/app");
    expect(androidApks(app).some((apk) => apk.name === "app")).toBe(true);
    expect(androidApks(app).some((apk) => apk.name === "removed")).toBe(false);
    app.model!.android!.targets.length = 0;
    expect(androidApks(app)).toEqual([]);
    expect(androidApks(project("/library", "aar"))).toEqual([]);
    expect(androidApks({ root: "/unsynced" } as ElideProject)).toEqual([]);
  });

  test("an active runnable app outranks a different remembered project", () => {
    const first = project("/first");
    const second = project("/second");
    expect(preferredAndroidProject([first, second], second, first.root)).toBe(second);
    expect(preferredAndroidProject([first, second], undefined, first.root)).toBe(first);
  });

  test("an active Android library never traps deployment selection", () => {
    const app = project("/app");
    const library = project("/library", "aar");
    expect(preferredAndroidProject([app, library], library, app.root)).toBe(app);
    expect(preferredAndroidProject([app, library], library, undefined)).toBeUndefined();
    expect(preferredAndroidProject([app, library], undefined, library.root)).toBeUndefined();
  });

  test("an APK is deployed only for what Elide lists a target for", () => {
    const unsigned = project("/unsigned", "apk", { runnable: false, debuggable: false, instrumented: false });
    expect(androidApks(unsigned).map((apk) => apk.name)).toEqual(["app"]);
    expect(deployableApks(unsigned)).toEqual([]);
    expect(deployableApks(unsigned, "run")).toEqual([]);
    const release = project("/release", "apk", { runnable: true, debuggable: false, instrumented: false });
    expect(deployableApks(release, "run").map((apk) => apk.name)).toEqual(["app"]);
    expect(deployableApks(release, "debug")).toEqual([]);
    const tests = project("/tests", "apk", { runnable: false, debuggable: false, instrumented: true });
    expect(deployableApks(tests).map((apk) => apk.name)).toEqual(["app"]);
    expect(deployableApks(tests, "test").map((apk) => apk.name)).toEqual(["app"]);
    // A model synced before Elide listed device targets offers none.
    expect(deployableApks({ root: "/old", model: { android: { targets: [{ name: "app", kind: "apk" }] } } } as ElideProject)).toEqual([]);
  });

  test("an active app that cannot do what was asked does not outrank the remembered one that can", () => {
    const release = project("/release", "apk", { runnable: true, debuggable: false, instrumented: false });
    const debug = project("/debug");
    expect(preferredAndroidProject([release, debug], release, debug.root, "debug")).toBe(debug);
    expect(preferredAndroidProject([release, debug], release, debug.root, "run")).toBe(release);
    expect(preferredAndroidProject([release], release, undefined, "debug")).toBeUndefined();
  });

  test("removed remembered projects require a new choice, not the first unrelated app", () => {
    expect(preferredAndroidProject([project("/other")], undefined, "/removed")).toBeUndefined();
  });
});

describe("Android UI gating", () => {
  const jvm = { root: "/jvm", model: { name: "jvm" } } as unknown as ElideProject;
  const unsynced = { root: "/new" } as ElideProject;
  const withAvd = (root: string, kind: string, avd: string) =>
    ({ root, model: { android: { avd, targets: [{ name: root.slice(1), kind, device: SIGNED }] } } }) as unknown as ElideProject;

  test("Android commands show only once a synced project declares an android block, library or application", () => {
    expect(hasAndroidProjects([])).toBe(false);
    expect(hasAndroidProjects([jvm, unsynced])).toBe(false);
    expect(hasAndroidProjects([jvm, project("/lib", "aar")])).toBe(true);
  });

  test("a workspace tree's devices and tools act for its first application, else its first Android project", () => {
    const library = project("/model", "aar");
    const app = project("/app");
    expect(androidToolsProject([jvm, library, app])).toBe(app);
    expect(androidToolsProject([jvm, library])).toBe(library);
    expect(androidToolsProject([jvm, unsynced])).toBeUndefined();
  });

  test("emulator rows belong to applications, one per AVD, never to a library", () => {
    const libraries = [withAvd("/model", "aar", "model"), withAvd("/ui", "aar", "ui")];
    const dev = withAvd("/dev", "apk", "pixel");
    const tests = withAvd("/tests", "apk", "pixel");
    const tablet = withAvd("/tablet", "apk", "tablet");
    expect(androidEmulatorOwners(libraries)).toEqual([]);
    expect(androidEmulatorOwners([...libraries, dev, tests, tablet])).toEqual([{ avd: "pixel", project: dev }, { avd: "tablet", project: tablet }]);
  });
});
