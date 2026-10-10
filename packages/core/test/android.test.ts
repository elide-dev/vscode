import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  androidArtifactFile,
  androidClassesJar,
  androidContentDirs,
  androidDebugTask,
  androidKeystoreTask,
  androidMappingFile,
  androidPlatformApiLevel,
  androidRClasses,
  androidRClassesArtifact,
  androidRunTask,
  androidSdkRoot,
  decodeManifest,
  explodedAndroidLibrary,
  isAndroidAab,
  isAndroidAar,
  isAndroidApk,
  isAndroidArtifact,
  parseAdbDevices,
  parseManifestArtifacts,
  type AndroidArtifact,
} from "../src/index.js";

/** The single-module APK fixture of Elide's own smoke suite, trimmed to what the parser reads. */
const APP_MANIFEST = `amends "elide:project.pkl"

import "elide:Android.pkl" as Android

name = "android-app-smoke"

android {
  compileSdk = 36
  minSdk = 30
}

artifacts {
  ["app"] = new Android.AndroidApk {
    name = "smoke.apk"
    release = false
    placeholders {
      ["appLabel"] = "SmokeLabel"
    }
    signing {
      keystore = ".dev/crypto/smoke.keystore"
    }
  }
  ["ui"] = new Android.AndroidAar {}
  ["bundle"] = new Android.AndroidAab {}
}
`;

describe("Android artifacts in manifest text", () => {
  const artifacts = parseManifestArtifacts(APP_MANIFEST);

  test("the Pkl class of each entry tells an APK from a bundle and an AAR", () => {
    expect(artifacts.map((a) => [a.name, a.type])).toEqual([
      ["app", "AndroidApk"],
      ["ui", "AndroidAar"],
      ["bundle", "AndroidAab"],
    ]);
    expect(artifacts.filter(isAndroidApk).map((a) => a.name)).toEqual(["app"]);
    expect(artifacts.filter(isAndroidAar).map((a) => a.name)).toEqual(["ui"]);
    expect(artifacts.filter(isAndroidAab).map((a) => a.name)).toEqual(["bundle"]);
    expect(artifacts.every(isAndroidArtifact)).toBe(true);
  });

  test("the output name of an entry overrides the one Elide derives", () => {
    expect(artifacts[0]?.outputName).toBe("smoke.apk");
    expect(artifacts[1]?.outputName).toBeUndefined();
  });

  test("a mapping entry of a nested block is not an artifact of its own", () => {
    // `placeholders` keys are spelled exactly like an `artifacts` entry, two levels below the block.
    expect(artifacts.map((a) => a.name)).not.toContain("appLabel");
  });
});

describe("decoded Android manifest", () => {
  const manifest = decodeManifest(
    JSON.stringify({
      name: "android-library-smoke",
      android: { compileSdk: 36, minSdk: 30, device: { avd: "smoke", abi: "x86_64" } },
      artifacts: {
        app: { "@type": "elide.android.AndroidApk", name: "smoke.apk", release: false },
        minified: { "@type": "elide.android.AndroidApk", name: "smoke-minified.apk", minify: true },
        shrunk: { "@type": "elide.android.AndroidApk", minify: true },
        ui: { "@type": "elide.android.AndroidAar", resources: ["res"] },
        native: { "@type": "elide.android.AndroidApk", jniLibs: ["libs/arm64"] },
        bundle: { "@type": "elide.android.AndroidAab" },
        jar: { "@type": "elide.jvm.Jar" },
      },
    }),
  );

  test("the android block carries the SDK levels and the virtual device", () => {
    expect(manifest.android).toEqual({
      compileSdk: 36,
      minSdk: 30,
      device: { avd: "smoke", abi: "x86_64", deviceProfile: "pixel_6" },
    });
  });

  test("Android artifacts decode beside the JAR ones, each keyed by what it publishes", () => {
    expect(Object.keys(manifest.androidTargets)).toEqual(["app", "minified", "shrunk", "ui", "native", "bundle"]);
    expect(manifest.androidTargets.app?.kind).toBe("apk");
    expect(manifest.androidTargets.app?.name).toBe("smoke.apk");
    expect(manifest.androidTargets.ui).toEqual({
      kind: "aar",
      sources: [],
      manifestFile: "src/main/AndroidManifest.xml",
      resources: ["res"],
      assets: [],
      jniLibs: [],
      minify: false,
    });
    expect(manifest.androidTargets.native?.jniLibs).toEqual(["libs/arm64"]);
    expect(manifest.androidTargets.bundle?.kind).toBe("aab");
    expect(Object.keys(manifest.jars)).toEqual(["jar"]);
  });

  test("an artifact minifies only when it says so", () => {
    expect(manifest.androidTargets.app?.minify).toBe(false);
    expect(manifest.androidTargets.minified?.minify).toBe(true);
    expect(manifest.androidTargets.shrunk?.minify).toBe(true);
  });

  test("a project declaring no android block decodes none", () => {
    expect(decodeManifest(`{"name":"plain"}`).android).toBeUndefined();
    expect(decodeManifest(`{"name":"plain"}`).androidTargets).toEqual({});
  });

  test("an android block without the required compile level is not one the CLI would accept", () => {
    expect(decodeManifest(`{"android":{"minSdk":30}}`).android).toBeUndefined();
  });
});

describe("android build targets", () => {
  test("each run mode names a target of its own", () => {
    expect(androidRunTask("app")).toBe("android-run-app");
    expect(androidRunTask("app", "device")).toBe("android-run-device-app");
    expect(androidRunTask("app", "emulator")).toBe("android-run-emulator-app");
    expect(androidKeystoreTask("app")).toBe("android-keystore-app");
    expect(androidDebugTask("app")).toBe("android-debug-app");
  });
});

describe("android output paths", () => {
  test("an artifact publishes under its declared name, else its key plus the extension of its kind", () => {
    expect(androidArtifactFile("/p", "app", "apk", "smoke.apk")).toBe(path.join("/p", ".dev", "artifacts", "smoke.apk"));
    expect(androidArtifactFile("/p", "app", "apk")).toBe(path.join("/p", ".dev", "artifacts", "app.apk"));
    expect(androidArtifactFile("/p", "ui", "aar")).toBe(path.join("/p", ".dev", "artifacts", "ui.aar"));
    expect(androidArtifactFile("/p", "bundle", "aab")).toBe(path.join("/p", ".dev", "artifacts", "bundle.aab"));
  });

  test("a minifying artifact publishes its mapping beside the archive, under the same base name", () => {
    expect(androidMappingFile("/p", "app", "smoke-minified.apk")).toBe(path.join("/p", ".dev", "artifacts", "smoke-minified-mapping.txt"));
    expect(androidMappingFile("/p", "app")).toBe(path.join("/p", ".dev", "artifacts", "app-mapping.txt"));
  });

  test("the staged classes jar a sibling compiles against sits outside the published artifacts", () => {
    expect(androidClassesJar("/p", "ui")).toBe(path.join("/p", ".dev", "android", "ui", "classes.jar"));
  });
});

describe("androidContentDirs", () => {
  const target: AndroidArtifact = {
    kind: "apk",
    sources: [],
    manifestFile: "src/main/AndroidManifest.xml",
    resources: [],
    assets: [],
    jniLibs: [],
    minify: false,
  };

  test("a declared directory is kept whether or not it exists", () => {
    const dirs = androidContentDirs("/p", { ...target, resources: ["res", "extra-res"], assets: ["assets"], jniLibs: ["jni"] }, () => false);
    expect(dirs).toEqual(["/p/res", "/p/extra-res", "/p/assets", "/p/jni"]);
  });

  test("a conventional directory is taken only when it is there", () => {
    expect(androidContentDirs("/p", target, () => true)).toEqual(["/p/src/main/res", "/p/src/main/assets", "/p/src/main/jniLibs"]);
    expect(androidContentDirs("/p", target, (dir) => dir.endsWith("/res"))).toEqual(["/p/src/main/res"]);
    expect(androidContentDirs("/p", target, () => false)).toEqual([]);
  });
});

describe("explodedAndroidLibrary", () => {
  test("a classpath entry below the exploded-library directory carries the coordinate it resolved from", () => {
    expect(explodedAndroidLibrary("/p/.dev/android/libraries/androidx/core/core/1.13.0/classes.jar")).toEqual({
      root: "/p",
      coordinate: "androidx.core:core:1.13.0",
      group: "androidx.core",
      artifact: "core",
      version: "1.13.0",
    });
  });

  test("an artifact's own staging directory is not an exploded library", () => {
    expect(explodedAndroidLibrary("/p/.dev/android/ui/classes.jar")).toBeUndefined();
    expect(explodedAndroidLibrary("/p/.dev/artifacts/ui.aar")).toBeUndefined();
    expect(explodedAndroidLibrary("/p/.dev/android/libraries/core/classes.jar")).toBeUndefined();
  });
});

describe("provided classpath entries", () => {
  test("the R classes of an artifact are told apart from anything else under its staging directory", () => {
    expect(androidRClassesArtifact("/p/.dev/android/app/r-classes")).toBe("app");
    expect(androidRClassesArtifact(androidRClasses("/p", "bundle"))).toBe("bundle");
    expect(androidRClassesArtifact("/p/.dev/android/app/generated")).toBeUndefined();
    expect(androidRClassesArtifact("/p/.dev/android/libraries/androidx.core/core/1.13.0/r-classes")).toBeUndefined();
  });

  test("the platform jar names the API level it belongs to, which its file name never does", () => {
    expect(androidPlatformApiLevel("/opt/android-sdk/platforms/android-36/android.jar")).toBe("36");
    expect(androidPlatformApiLevel("/opt/android-sdk/platforms/android-TiramisuPrivacySandbox/android.jar")).toBe("TiramisuPrivacySandbox");
    expect(androidPlatformApiLevel("/opt/android-sdk/platforms/android-36/uiautomator.jar")).toBeUndefined();
    expect(androidPlatformApiLevel("/p/.dev/dependencies/m2/com/example/android/1.0/android.jar")).toBeUndefined();
  });
});

describe("androidSdkRoot", () => {
  const isDirectory = (dirs: string[]) => (p: string) => dirs.includes(p);

  test("a declared root is read against the project and wins over the environment", () => {
    const root = androidSdkRoot({
      declared: "vendor/sdk",
      projectRoot: "/p",
      env: { ANDROID_HOME: "/opt/android" },
      isDirectory: isDirectory(["/p/vendor/sdk", "/opt/android"]),
    });
    expect(root).toBe("/p/vendor/sdk");
  });

  test("a declared root that is not a directory resolves to nothing rather than falling through", () => {
    const root = androidSdkRoot({
      declared: "vendor/sdk",
      projectRoot: "/p",
      env: { ANDROID_HOME: "/opt/android" },
      isDirectory: isDirectory(["/opt/android"]),
    });
    expect(root).toBeUndefined();
  });

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
