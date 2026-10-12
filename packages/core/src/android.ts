import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { OUTPUT_DIR } from "./elide.js";
import type { AndroidArtifact, AndroidArtifactKind } from "./manifest.js";
import { normalizePath } from "./sourceRoots.js";
import { ANDROID_LIBRARIES_DIR, ANDROID_STAGE_DIR, ARTIFACTS_DIR } from "./workspace.js";

/**
 * The Android side of an Elide build: the targets it registers, where it publishes, and how the SDK it needs is
 * located.
 *
 * Elide adds no subcommand for Android — the whole pipeline is build targets of the ordinary graph, so everything
 * here names a target `elide build` takes. The one thing the CLI does not answer is which devices are attached,
 * which is `adb`'s to say, so this module locates the SDK the same way the build does and asks `adb` directly.
 */

/** Target every other Android target waits on: it resolves the SDK and reports what is missing. */
export const ANDROID_SDK_TASK = "android-sdk";

/** Create the project's virtual device, without booting it. */
export const ANDROID_AVD_TASK = "android-avd";

/** Boot the project's virtual device and wait for `sys.boot_completed`. */
export const ANDROID_EMULATOR_TASK = "android-emulator";

/** Shut down every running emulator, through `adb emu kill`. */
export const ANDROID_EMULATOR_STOP_TASK = "android-emulator-stop";

/**
 * Explode every published `.aar` the project resolved into `.dev/android/libraries/<group>/<artifact>/<version>/`.
 *
 * One target per project rather than per artifact, and a default one: an archive's content does not depend on who
 * consumes it. Nothing else produces those directories, and a classpath names the `classes.jar` inside them.
 */
export const ANDROID_LIBRARIES_TASK = "android-libraries";

/** `--device=<serial>`: pin an Android target to one attached device or emulator. */
export const ANDROID_DEVICE_OPTION = "device";

/** `--install-sdk`: install the SDK components a target is missing, accepting their licenses. */
export const ANDROID_INSTALL_SDK_OPTION = "install-sdk";

/** `--no-window`: boot the emulator headless. */
export const ANDROID_NO_WINDOW_OPTION = "no-window";

/** Conventional resource, asset and native-library directories of an artifact that declares none. */
export const ANDROID_DEFAULT_RESOURCES = "src/main/res";
export const ANDROID_DEFAULT_ASSETS = "src/main/assets";
export const ANDROID_DEFAULT_JNI_LIBS = "src/main/jniLibs";

/** AVD the build creates and boots for a project that declares neither an AVD name nor a project name. */
export const DEFAULT_AVD_NAME = "elide-android";

/** Serial prefix `adb` gives every emulator; a physical device carries its own. */
const EMULATOR_SERIAL_PREFIX = "emulator-";

/** The only `adb devices` state that can take an install; `offline` and `unauthorized` are attached but refuse one. */
const DEVICE_STATE_READY = "device";

/** How an APK reaches a device: whatever is attached, a connected device only, or the project's own AVD. */
export type AndroidRunMode = "auto" | "device" | "emulator";

/**
 * The target that installs and launches `artifact`. `auto` takes whatever is attached and boots the emulator when
 * nothing is; `device` fails when no device is connected; `emulator` boots the project's AVD, creating it first.
 */
export function androidRunTask(artifact: string, mode: AndroidRunMode = "auto"): string {
  return mode === "auto" ? `android-run-${artifact}` : `android-run-${mode}-${artifact}`;
}

/**
 * The target that installs `artifact`, launches it waiting for a debugger, and forwards the device's JDWP socket
 * to a local port, which it announces on its output.
 */
export function androidDebugTask(artifact: string): string {
  return `android-debug-${artifact}`;
}

/** A dynamic feature stages a bundle module, not a standalone published/installable archive. */
export function androidFeatureTask(artifact: string): string {
  return `android-module-${artifact}`;
}

/** The target that mints the keystore `artifact` signs with, using the Android debug conventions. */
export function androidKeystoreTask(artifact: string): string {
  return `android-keystore-${artifact}`;
}

/**
 * Archive `elide build <artifact>` publishes: `.dev/artifacts/<name>`, where the name is the artifact's own when it
 * declares one and `<key>.apk` / `<key>.aab` / `<key>.aar` otherwise.
 */
export function androidArtifactFile(root: string, artifact: string, kind: AndroidArtifactKind, outputName?: string): string {
  if (kind === "feature") return path.join(root, OUTPUT_DIR, ANDROID_STAGE_DIR, artifact, `${artifact}.zip`);
  return path.join(root, OUTPUT_DIR, ARTIFACTS_DIR, outputName || `${artifact}.${kind}`);
}

/**
 * Obfuscation mapping a minifying artifact publishes beside its archive: `.dev/artifacts/<base>-mapping.txt`, where
 * the base is the declared output name without its extension, and the artifact key when it declares none.
 *
 * It is the only way to read a stack trace from a shrunk build, which is why the sidebar surfaces it.
 */
export function androidMappingFile(root: string, artifact: string, outputName?: string): string {
  const base = outputName ? outputName.replace(/\.[^.]+$/, "") : artifact;
  return path.join(root, OUTPUT_DIR, ARTIFACTS_DIR, `${base}-mapping.txt`);
}

/**
 * The target that publishes an artifact's obfuscation mapping.
 *
 * Separate from the target that publishes the archive: building `<artifact>` alone leaves no mapping behind, since
 * a shrink served from the cache still has to hand one over, so it is a target of its own.
 */
export function androidMappingTask(artifact: string): string {
  return `android-mapping-${artifact}`;
}

/**
 * The `classes.jar` an Android artifact stages.
 *
 * A sibling project consumes a library through this file, never through its `.aar`: the archive is what the library
 * publishes, and nothing on a classpath can read one. It is therefore what a sibling's classpath names, and it sits
 * outside the published artifacts directory.
 */
export function androidClassesJar(root: string, artifact: string): string {
  return path.join(root, OUTPUT_DIR, ANDROID_STAGE_DIR, artifact, "classes.jar");
}

/**
 * The target that links an artifact's resources and compiles the `R` class its code is written against.
 *
 * Run while a model is resolved, because `R` is generated: nothing on disk declares those identifiers, so an editor
 * that never ran it reports every `R.layout.main` as unresolved.
 */
export function androidRTask(artifact: string): string {
  return `android-r-${artifact}`;
}

/** Directory name the Android pipeline compiles each artifact's `R` classes into, under its stage directory. */
const R_CLASSES_DIR = "r-classes";

/** Compiled `R` classes of an Android artifact, which the build puts on the compile classpath as provided. */
export function androidRClasses(root: string, artifact: string): string {
  return path.join(root, OUTPUT_DIR, ANDROID_STAGE_DIR, artifact, R_CLASSES_DIR);
}

/**
 * The artifact whose `R` classes `entry` holds, when it is one of those directories.
 *
 * Named apart from a jar because the directory is per artifact and per project: a workspace with two Android
 * projects has two of them, and `r-classes` alone says nothing about which.
 */
export function androidRClassesArtifact(entry: string): string | undefined {
  const parts = normalizePath(path.resolve(entry)).split("/");
  if (parts.pop() !== R_CLASSES_DIR) return undefined;
  const artifact = parts.pop();
  return parts.pop() === ANDROID_STAGE_DIR && artifact ? artifact : undefined;
}

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

/**
 * Resource, asset and native-library directories `artifact` carries, absolute and normalized.
 *
 * A declared directory is kept whether or not it exists — the build reports it rather than silently compiling
 * nothing — while a conventional one is taken only when it is there, since an app without resources is valid.
 */
export function androidContentDirs(
  root: string,
  artifact: AndroidArtifact,
  exists: (p: string) => boolean = existsSync,
): string[] {
  const dirs: string[] = [];
  for (const [declared, conventional] of [
    [artifact.resources, ANDROID_DEFAULT_RESOURCES],
    [artifact.assets, ANDROID_DEFAULT_ASSETS],
    [artifact.jniLibs, ANDROID_DEFAULT_JNI_LIBS],
  ] as const) {
    if (declared.length > 0) dirs.push(...declared.map((dir) => normalizePath(path.resolve(root, dir))));
    else if (artifact.kind !== "feature") {
      const dir = normalizePath(path.resolve(root, conventional));
      if (exists(dir)) dirs.push(dir);
    }
  }
  return [...new Set(dirs)];
}

/** A published `.aar` the build resolved and exploded, as the `classes.jar` inside it names the archive. */
export interface ExplodedAndroidLibrary {
  /** Project root whose build exploded the archive. */
  root: string;
  /** Maven coordinate the archive resolved from, `group:artifact:version`; a classifier folds into the artifact. */
  coordinate: string;
  /** Group, artifact and version separately, which is also the archive's layout in the Maven repository. */
  group: string;
  artifact: string;
  version: string;
}

/** `/.dev/android/libraries/`: the only directory a published archive is exploded into. */
const EXPLODED_LIBRARIES_MARKER = `/${OUTPUT_DIR}/${ANDROID_STAGE_DIR}/${ANDROID_LIBRARIES_DIR}/`;

/**
 * The archive `entry` was exploded from, when it is a path below a project's exploded-library directory.
 *
 * A published `.aar` is not a classpath entry — no compiler reads one — so the build substitutes the `classes.jar`
 * of the directory it unpacked the archive into. That path carries the coordinate, which is what names the library
 * and where its sources are, and nothing else does: every such entry is otherwise just a `classes.jar`.
 */
export function explodedAndroidLibrary(entry: string): ExplodedAndroidLibrary | undefined {
  const normalized = normalizePath(path.resolve(entry));
  const marker = normalized.lastIndexOf(EXPLODED_LIBRARIES_MARKER);
  if (marker < 0) return undefined;
  const parts = normalized.slice(marker + EXPLODED_LIBRARIES_MARKER.length).split("/");
  // `<group…>/<artifact>/<version>/<file>`: the group is every segment the other three leave over.
  if (parts.length < 4) return undefined;
  const version = parts[parts.length - 2] ?? "";
  const artifact = parts[parts.length - 3] ?? "";
  const group = parts.slice(0, -3).join(".");
  if (!group || !artifact || !version) return undefined;
  return { root: normalized.slice(0, marker), coordinate: `${group}:${artifact}:${version}`, group, artifact, version };
}

/** Where to look for an installed Android SDK, in the order the build looks. */
export interface AndroidSdkLookup {
  /** `android.sdk` of the manifest, read against {@link projectRoot}. */
  declared?: string;
  projectRoot?: string;
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

/**
 * The SDK root an Elide build of this project would use: the manifest's `android.sdk`, else `ANDROID_HOME`, else
 * `ANDROID_SDK_ROOT`, else where the SDK installs itself on this host.
 *
 * A declared path that is not a directory resolves to nothing rather than falling through, so a project naming the
 * wrong SDK is reported as such instead of silently building against another one.
 */
export function androidSdkRoot(lookup: AndroidSdkLookup = {}): string | undefined {
  const isDirectory = lookup.isDirectory ?? isDirectorySync;
  const env = lookup.env ?? process.env;
  if (lookup.declared && lookup.declared.length > 0) {
    const declared = path.resolve(lookup.projectRoot ?? process.cwd(), lookup.declared);
    return isDirectory(declared) ? normalizePath(declared) : undefined;
  }
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
  /** Serial number, which is what `--device` and `adb -s` take. */
  serial: string;
  /** `device`, `offline`, `unauthorized`, `bootloader`, … */
  state: string;
  /** Whether this is an emulator this project's targets can also boot and stop. */
  emulator: boolean;
  /** Whether the device can take an install: only the `device` state can. */
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
    devices.push({ serial, state, emulator: serial.startsWith(EMULATOR_SERIAL_PREFIX), ready: state === DEVICE_STATE_READY });
  }
  return devices;
}

const run = promisify(execFile);

/**
 * Devices attached to the SDK's `adb`, or `undefined` when there is no `adb` to ask — an SDK that was never
 * installed, or one installed without `platform-tools`. An `adb` that fails yields no devices rather than throwing:
 * the daemon failing to start is a reason to offer the emulator, not to fail the caller.
 */
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
