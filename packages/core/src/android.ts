import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { normalizePath } from "./sourceRoots.js";

/** Serial prefix `adb` gives every emulator; a physical device carries its own. */
const EMULATOR_SERIAL_PREFIX = "emulator-";

/** Whether `serial` names an emulator, which holds even after it disappeared from `adb devices`. */
export function isEmulatorSerial(serial: string): boolean {
  return serial.startsWith(EMULATOR_SERIAL_PREFIX);
}

/** The only `adb devices` state that can take an install; `offline` and `unauthorized` are attached but refuse one. */
const DEVICE_STATE_READY = "device";

/**
 * The API level of the Android platform jar `entry` names, when it is one: `<sdk>/platforms/android-36/android.jar`.
 *
 * The jar is the framework every Android source compiles against, and it carries no Maven coordinate, so it is
 * named from the platform it belongs to rather than from its file name, which is `android.jar` in every SDK.
 */
export function androidPlatformApiLevel(entry: string): string | undefined {
  const match = /\/platforms\/android-([^/]+)\/android\.jar$/.exec(normalizePath(path.resolve(entry)));
  return match?.[1];
}

/** Environment and conventional locations to inspect for an installed Android SDK. */
export interface AndroidSdkLookup {
  env?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
  platform?: NodeJS.Platform;
  isDirectory?: (p: string) => boolean;
}

function isDirectorySync(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where Android Studio and `sdkmanager` install an SDK when nothing says otherwise. Checked last, so a machine with
 * a working Android Studio needs no `ANDROID_HOME` for the SDK to be found.
 */
function conventionalSdkRoots(home: string, platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>): string[] {
  if (platform === "darwin") return [path.join(home, "Library", "Android", "sdk")];
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    return [
      ...(local ? [path.join(local, "Android", "Sdk")] : []),
      path.join(home, "AppData", "Local", "Android", "Sdk"),
    ];
  }
  return [path.join(home, "Android", "Sdk")];
}

/** Locate an installed SDK from ANDROID_HOME, ANDROID_SDK_ROOT, or Android Studio's conventional location. */
export function androidSdkRoot(lookup: AndroidSdkLookup = {}): string | undefined {
  const isDirectory = lookup.isDirectory ?? isDirectorySync;
  const env = lookup.env ?? process.env;
  for (const variable of ["ANDROID_HOME", "ANDROID_SDK_ROOT"]) {
    const value = env[variable];
    if (value && value.length > 0 && isDirectory(value)) return normalizePath(path.resolve(value));
  }
  const home = lookup.homeDir ?? os.homedir();
  if (!home) return undefined;
  const found = conventionalSdkRoots(home, lookup.platform ?? process.platform, env).find(isDirectory);
  return found ? normalizePath(found) : undefined;
}

/** `adb` of an installed SDK; the SDK puts nothing on `PATH`, so it is always addressed by absolute path. */
export function adbExecutable(sdkRoot: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(sdkRoot, "platform-tools", platform === "win32" ? "adb.exe" : "adb");
}

/** One device or emulator `adb devices` reported. */
export interface AndroidDevice {
  /** Serial number passed to `adb -s`. */
  serial: string;
  /** `device`, `offline`, `unauthorized`, `bootloader`, … */
  state: string;
  /** Whether adb reports an emulator serial. */
  emulator: boolean;
  /** Whether the device is ready for adb commands. */
  ready: boolean;
}

/**
 * Devices `adb devices` listed, in the order it printed them.
 *
 * The first line is a header (`List of devices attached`) and every other one is `<serial>\t<state>`; anything else
 * — the daemon's startup chatter, blank lines — carries no device and is dropped.
 */
export function parseAdbDevices(text: string): AndroidDevice[] {
  const devices: AndroidDevice[] = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split("\t");
    if (parts.length !== 2) continue;
    const serial = parts[0]?.trim() ?? "";
    const state = parts[1]?.trim() ?? "";
    if (serial.length === 0 || state.length === 0) continue;
    devices.push({ serial, state, emulator: isEmulatorSerial(serial), ready: state === DEVICE_STATE_READY });
  }
  return devices;
}

const run = promisify(execFile);

/** Attached devices, undefined without platform-tools, or an empty list when adb fails. */
export async function listAndroidDevices(sdkRoot: string, signal?: AbortSignal): Promise<AndroidDevice[] | undefined> {
  const adb = adbExecutable(sdkRoot);
  if (!existsSync(adb)) return undefined;
  try {
    const { stdout } = await run(adb, ["devices"], { signal, encoding: "utf8" });
    return parseAdbDevices(stdout);
  } catch {
    return [];
  }
}
