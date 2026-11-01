import { describe, expect, test } from "bun:test";
import { adbExecutable, androidPlatformApiLevel, androidSdkRoot, isEmulatorSerial, parseAdbDevices } from "../src/index.js";

describe("standalone SDK tools", () => {
  test("adb is addressed through the SDK, including the Windows executable suffix", () => {
    expect(adbExecutable("/opt/sdk", "linux")).toBe("/opt/sdk/platform-tools/adb");
    expect(adbExecutable("/opt/sdk", "darwin")).toBe("/opt/sdk/platform-tools/adb");
    expect(adbExecutable("/opt/sdk", "win32").replace(/\\/g, "/")).toBe("/opt/sdk/platform-tools/adb.exe");
  });

  test("emulator serial recognition does not require project deployment metadata", () => {
    expect(isEmulatorSerial("emulator-5554")).toBe(true);
    expect(isEmulatorSerial("R58M30ABCDE")).toBe(false);
  });
});

describe("provided classpath entries", () => {
  test("the platform jar names the API level it belongs to, which its file name never does", () => {
    expect(androidPlatformApiLevel("/opt/android-sdk/platforms/android-36/android.jar")).toBe("36");
    expect(androidPlatformApiLevel("/opt/android-sdk/platforms/android-TiramisuPrivacySandbox/android.jar")).toBe("TiramisuPrivacySandbox");
    expect(androidPlatformApiLevel("/opt/android-sdk/platforms/android-36/uiautomator.jar")).toBeUndefined();
    expect(androidPlatformApiLevel("/p/.dev/dependencies/m2/com/example/android/1.0/android.jar")).toBeUndefined();
  });
});

describe("androidSdkRoot", () => {
  const isDirectory = (dirs: string[]) => (p: string) => dirs.includes(p);

  test("ANDROID_HOME is preferred over ANDROID_SDK_ROOT, and both over the conventional location", () => {
    const dirs = isDirectory(["/opt/home", "/opt/legacy", "/u/Library/Android/sdk"]);
    expect(androidSdkRoot({ env: { ANDROID_HOME: "/opt/home", ANDROID_SDK_ROOT: "/opt/legacy" }, isDirectory: dirs })).toBe("/opt/home");
    expect(androidSdkRoot({ env: { ANDROID_SDK_ROOT: "/opt/legacy" }, isDirectory: dirs })).toBe("/opt/legacy");
    expect(androidSdkRoot({ env: {}, homeDir: "/u", platform: "darwin", isDirectory: dirs })).toBe("/u/Library/Android/sdk");
  });

  test("the conventional location follows the host", () => {
    const linux = androidSdkRoot({ env: {}, homeDir: "/home/u", platform: "linux", isDirectory: isDirectory(["/home/u/Android/Sdk"]) });
    expect(linux).toBe("/home/u/Android/Sdk");
    const windows = androidSdkRoot({
      env: { LOCALAPPDATA: "C:/Users/u/AppData/Local" },
      homeDir: "C:/Users/u",
      platform: "win32",
      isDirectory: isDirectory(["C:/Users/u/AppData/Local/Android/Sdk"]),
    });
    expect(normalizeWindows(windows)).toBe("C:/Users/u/AppData/Local/Android/Sdk");
  });

  test("nothing installed resolves to nothing", () => {
    expect(androidSdkRoot({ env: {}, homeDir: "/u", platform: "darwin", isDirectory: () => false })).toBeUndefined();
  });
});

/** `path.join` uses the host separator, which the Windows case asserts across. */
const normalizeWindows = (p: string | undefined) => p?.replace(/\\/g, "/");

describe("parseAdbDevices", () => {
  test("the header and the daemon's chatter carry no device", () => {
    const text = [
      "* daemon not running; starting now at tcp:5037",
      "* daemon started successfully",
      "List of devices attached",
      "emulator-5554\tdevice",
      "R58M30ABCDE\tunauthorized",
      "4c1a0f2b\toffline",
      "",
    ].join("\n");
    expect(parseAdbDevices(text)).toEqual([
      { serial: "emulator-5554", state: "device", emulator: true, ready: true },
      { serial: "R58M30ABCDE", state: "unauthorized", emulator: false, ready: false },
      { serial: "4c1a0f2b", state: "offline", emulator: false, ready: false },
    ]);
  });

  test("no device attached yields none", () => {
    expect(parseAdbDevices("List of devices attached\n\n")).toEqual([]);
  });
});
