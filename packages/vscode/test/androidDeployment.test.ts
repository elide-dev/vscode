import { describe, expect, test } from "bun:test";
import type { AndroidDevice } from "@elide/ide-core";
import { androidApks, androidAvdToBoot, androidDeviceProblem, preferredAndroidProject, restoredAndroidTarget } from "../src/androidDeploymentState.js";
import type { ElideProject } from "../src/projects.js";

function project(root: string, kind = "apk"): ElideProject {
  return { root, model: { android: { targets: [{ name: "app", kind }] } } } as ElideProject;
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
    expect(androidAvdToBoot([{ serial: "emulator-5554", state: "device", ready: true, emulator: true }], pinned, "project")).toBeUndefined();
    expect(androidAvdToBoot([], { serial: "emulator-5556" }, "project")).toBe("project");
    expect(androidAvdToBoot([phone], { serial: "old" }, "project")).toBeUndefined();
    expect(androidAvdToBoot([{ serial: "old", state: "unauthorized", ready: false, emulator: false }], { serial: "old" }, "project")).toBeUndefined();
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

  test("removed remembered projects require a new choice, not the first unrelated app", () => {
    expect(preferredAndroidProject([project("/other")], undefined, "/removed")).toBeUndefined();
  });
});
