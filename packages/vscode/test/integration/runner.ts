/**
 * Launches the locally installed VS Code with this extension under development, the installed JetBrains Kotlin
 * extension, and the `samples/ktjvm` project, then runs `./index.ts` inside the extension host.
 *
 * `ELIDE_TEST_SCENARIO=workspace` opens a copy of the Elide workspace sample instead — `samples/workspace`, or the
 * directory `ELIDE_WORKSPACE_SAMPLE` names — and runs the checks of
 * `./workspace.ts` against it.
 *
 * `ELIDE_TEST_SCENARIO=compose` opens the `elide-android-sample` checkout beside this repository (or
 * `ELIDE_ANDROID_SAMPLE`) in place — its build records absolute paths, so a copy would not reuse them — and runs
 * `./compose.ts`. That sample must have been built once with an Android-capable Elide. The Compose renderer
 * runtime is reused from the regular VS Code profile when present, otherwise downloaded.
 *
 * `ELIDE_TEST_SCENARIO=android` opens a clean copy (no `.dev`, so nothing prebuilt) of `ELIDE_ANDROID_APP_SAMPLE`
 * and runs `./android.ts`: sync, build the APK, and install and launch it on the attached device or a headless
 * emulator. Set `ELIDE_ANDROID_APP_MEMBER`, `ELIDE_ANDROID_APP_ARTIFACT`, and `ELIDE_ANDROID_APP_ID` for that app.
 *
 * Prerequisites: VS Code at /Applications/Visual Studio Code.app, `JetBrains.kotlin-server` installed in
 * ~/.vscode/extensions, `elide` installed. Usage: `bazel run //packages/vscode:integration_test`.
 *
 * Bazel runs the bundle of this file from the target's runfiles, which mirror the repository: the extension (manifest,
 * `dist/extension.js`, `dist-test/index.js`) two levels up, `samples/ktjvm` and `samples/workspace` under the runfiles
 * root.
 *
 * `ELIDE_TEST_SCENARIO=komodo` opens a copy of `samples/ktjvm` with `elide.kotlinLsp.server` set to `komodo` and the
 * JetBrains extension disabled. `ELIDE_KOMODO_LSP` names its native executable, `ELIDE_KOMODO_PLUGINS` optionally
 * its compiler plugin directory, and `ELIDE_KOMODO_JAVA_HOME` the JDK resolution inputs.
 * `ELIDE_TEST_SCENARIO=komodo-debug` debugs the same sample through Komodo's debug adapter.
 *
 * `ELIDE_TEST_HOME` runs the scenario against another Elide distribution, such as a local build's
 * `.dev/artifacts/dist/current`, through the `elide.home` setting: the extension host does not see an `ELIDE_HOME`
 * set in the shell that starts the run.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { runTests } from "@vscode/test-electron";

const here = path.dirname(new URL(import.meta.url).pathname);
const runfilesExtension = path.resolve(here, "..", "..");
const runfilesRoot = path.resolve(runfilesExtension, "..", "..");
// Runfiles are links into the output tree, and Node loads `dist/extension.js` at its real path: VS Code must know the
// extension at that path too, or it attributes the extension's `vscode` API to no extension, and the calls that check
// their caller's manifest (registering the `komodo-kotlin` debug adapter factory) fail.
const extensionDevelopmentPath = path.dirname(realpathSync(path.join(runfilesExtension, "package.json")));
const extensionTestsPath = path.resolve(extensionDevelopmentPath, "dist-test", "index.js");

const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE ?? "/Applications/Visual Studio Code.app/Contents/MacOS/Code";

const scenarios = ["workspace", "compose", "android", "komodo", "komodo-debug"] as const;
const scenario = scenarios.find((name) => name === process.env.ELIDE_TEST_SCENARIO) ?? "ktjvm";
/** Komodo's scenarios: the folder on Komodo's language server, every other extension disabled. */
const komodo = scenario === "komodo" || scenario === "komodo-debug";
if (scenario === "android") {
  const missing = ["ELIDE_ANDROID_APP_SAMPLE", "ELIDE_ANDROID_APP_MEMBER", "ELIDE_ANDROID_APP_ARTIFACT", "ELIDE_ANDROID_APP_ID"]
    .filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Android verification requires an explicit fixture; set ${missing.join(", ")}`);
}

// The user's extensions dir is reused as-is; Komodo's scenarios disable other extensions for this instance.
const extensionsDir = path.join(homedir(), ".vscode", "extensions");
if (!komodo && !readdirSync(extensionsDir).some((d) => d.startsWith("jetbrains.kotlin-server-"))) throw new Error(`JetBrains.kotlin-server is not installed in ${extensionsDir}`);

// Keep macOS IPC paths short without overriding TMPDIR: the Kotlin client and JVM must agree on their port-file directory.
const scratchRoot = process.platform === "darwin" ? "/tmp" : tmpdir();
const userDataDir = mkdtempSync(path.join(scratchRoot, "elide-vscode-user-"));
mkdirSync(path.join(userDataDir, "User"), { recursive: true });
writeFileSync(
  path.join(userDataDir, "User", "settings.json"),
  JSON.stringify(
    {
      "elide.sync.onManifestChange": "always",
      // JetBrains extension setup wizard (region + data sharing) must be complete for the server to start.
      "intellij.region": "europe",
      "intellij.dataSharing": "none",
      "security.workspace.trust.enabled": false,
      "update.mode": "none",
      // The extensions dir is the user's, shared with their own VS Code and with runs from other worktrees: never
      // rewrite it from a test instance.
      "extensions.autoUpdate": false,
      "extensions.autoCheckUpdates": false,
      "telemetry.telemetryLevel": "off",
      // An emulator the test boots runs headless.
      ...(scenario === "android" ? { "elide.android.emulatorWindow": false } : {}),
      ...(komodo ? {
        "elide.kotlinLsp.server": "komodo",
        ...(process.env.ELIDE_KOMODO_LSP ? { "elide.kotlinLsp.komodo.path": process.env.ELIDE_KOMODO_LSP } : {}),
        ...(process.env.ELIDE_KOMODO_PLUGINS ? { "elide.kotlinLsp.komodo.pluginDirectory": process.env.ELIDE_KOMODO_PLUGINS } : {}),
        ...(process.env.ELIDE_KOMODO_JAVA_HOME ? { "elide.kotlinLsp.komodo.javaHome": process.env.ELIDE_KOMODO_JAVA_HOME } : {}),
        "files.autoSave": "off",
        ...(process.env.ELIDE_KOMODO_TRACE ? { "elide.komodo.trace.server": "messages" } : {}),
      } : {}),
      ...(process.env.ELIDE_TEST_HOME ? { "elide.home": process.env.ELIDE_TEST_HOME } : {}),
    },
    null,
    2,
  ),
);

// Work on a scratch copy of the sample so the test can mutate elide.pkl freely; the compose sample stays in place.
const sample = scenario === "compose"
  ? composeSampleDirectory()
  : mkdtempSync(path.join(realpathSync(scratchRoot), `elide-${scenario}-`));
if (scenario === "workspace") prepareWorkspaceSample();
else if (scenario === "compose") prepareComposeSample();
else if (scenario === "android") prepareAndroidSample();
else if (komodo) copyFiles(path.join(runfilesRoot, "samples", "ktjvm"), sample);
else prepareKtjvmSample();

function composeSampleDirectory(): string {
  // `bazel run` names the checkout it was started from; the sample sits beside it.
  const checkout = process.env.BUILD_WORKSPACE_DIRECTORY;
  const source = process.env.ELIDE_ANDROID_SAMPLE ?? (checkout && path.resolve(checkout, "..", "elide-android-sample"));
  if (!source) throw new Error("no Elide Android sample; set ELIDE_ANDROID_SAMPLE");
  return path.resolve(source);
}

function prepareComposeSample(): void {
  if (!existsSync(path.join(sample, "app", ".dev", "jvm"))) throw new Error(`no built Elide Android sample at ${sample}; set ELIDE_ANDROID_SAMPLE`);
  const runtime = path.join(homedir(), "Library", "Application Support", "Code", "User", "globalStorage", "elide.elide", "compose-runtime");
  if (existsSync(runtime)) cpSync(runtime, path.join(userDataDir, "User", "globalStorage", "elide.elide", "compose-runtime"), { recursive: true });
}

function prepareAndroidSample(): void {
  const source = path.resolve(process.env.ELIDE_ANDROID_APP_SAMPLE!);
  if (!existsSync(path.join(source, "elide.pkl"))) throw new Error(`no Elide Android application at ${source}; set ELIDE_ANDROID_APP_SAMPLE`);
  // Build outputs, editor state and the generated workspace.json would stand in for what the sync and build produce.
  const skipped = new Set([".dev", ".git", ".idea", ".vscode", "node_modules", "workspace.json"]);
  copyFiles(source, sample, skipped);
}

function prepareWorkspaceSample(): void {
  const source = process.env.ELIDE_WORKSPACE_SAMPLE ?? path.join(runfilesRoot, "samples", "workspace");
  if (!existsSync(path.join(source, "elide.pkl"))) throw new Error(`no Elide workspace sample at ${source}; set ELIDE_WORKSPACE_SAMPLE`);
  // Build outputs, IDE state and a previously generated workspace.json would stand in for what the sync must produce.
  copyFiles(source, sample, new Set([".dev", ".idea", "workspace.json"]));
}

/**
 * Copies `source` into `target` as regular files, leaving out entries named in `skipped`. Runfiles are symlinks into the
 * source tree, and `cpSync` keeps nested ones as links even with `dereference`: the suite's edits would land in the
 * repository.
 */
function copyFiles(source: string, target: string, skipped: ReadonlySet<string> = new Set()): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source)) {
    if (skipped.has(entry)) continue;
    const from = path.join(source, entry);
    if (statSync(from).isDirectory()) copyFiles(from, path.join(target, entry), skipped);
    else copyFileSync(from, path.join(target, entry));
  }
}

function prepareKtjvmSample(): void {
  copyFiles(path.join(runfilesRoot, "samples", "ktjvm"), sample);

  // The manifest takes its dependency versions from a local module: editing only that module must resync (index.ts 3b).
  const manifest = path.join(sample, "elide.pkl");
  writeFileSync(manifest, readFileSync(manifest, "utf8").replace(`import "elide:Sources.pkl" as Sources\n`, `$&import "versions.pkl"\n`));
  writeFileSync(path.join(sample, "versions.pkl"), `guava = "33.4.0-jre"\n`);

  // A vendored checkout with its own manifest, nested inside the project: a separate build the sample never invokes,
  // so it must not appear in workspace.json (the module assertion in index.ts covers it).
  mkdirSync(path.join(sample, "vendored", "src", "main", "nested"), { recursive: true });
  writeFileSync(path.join(sample, "vendored", "src", "main", "nested", "Nested.kt"), "package nested\n\nfun vendored() = 1\n");
  writeFileSync(
    path.join(sample, "vendored", "elide.pkl"),
    `amends "elide:project.pkl"
import "elide:Sources.pkl" as Sources

name = "vendored-sample"

sources {
    ["main"] = new Sources.SourceSetSpec {
        paths {
            "src/main/**/*.kt"
        }
    }
}
`,
  );

  // A checked-in `.idea` (team members on IntelliJ) must not divert the Kotlin LSP away from workspace.json: the
  // server's auto-detection picks JPS whenever `.idea/modules.xml` exists, so the extension has to pin the importer.
  mkdirSync(path.join(sample, ".idea", "modules"), { recursive: true });
  writeFileSync(
    path.join(sample, ".idea", "modules.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="ProjectModuleManager">
    <modules>
      <module fileurl="file://$PROJECT_DIR$/.idea/modules/ktjvm-sample.iml" filepath="$PROJECT_DIR$/.idea/modules/ktjvm-sample.iml" />
    </modules>
  </component>
</project>
`,
  );
  writeFileSync(
    path.join(sample, ".idea", "modules", "ktjvm-sample.iml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<module type="JAVA_MODULE" version="4">
  <component name="NewModuleRootManager" inherit-compiler-output="true">
    <exclude-output />
    <content url="file://$MODULE_DIR$/../.." />
    <orderEntry type="inheritedJdk" />
    <orderEntry type="sourceFolder" forTests="false" />
  </component>
</module>
`,
  );

  // A committed `.vscode/settings.json` from a teammate: the absolute JDK path does not exist here, and the JSON
  // importer rejects it outright, so the extension must clear it instead of honouring it.
  mkdirSync(path.join(sample, ".vscode"), { recursive: true });
  writeFileSync(
    path.join(sample, ".vscode", "settings.json"),
    `${JSON.stringify({ "intellij.jdkForSymbolResolution": "/nonexistent/teammate-jdk-21" }, null, 2)}\n`,
  );
}

try {
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath,
    // Webview paint confirmations use requestAnimationFrame, which Chromium suspends in occluded windows.
    launchArgs: [sample, "--extensions-dir", extensionsDir, "--user-data-dir", userDataDir, "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes",
      ...(scenario === "compose" ? ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"] : []),
      ...(komodo && !process.env.ELIDE_KOMODO_COEXIST ? ["--disable-extensions"] : [])],
    extensionTestsEnv: { ELIDE_TEST_SAMPLE: sample, ELIDE_TEST_SCENARIO: scenario },
  });
} finally {
  if (!process.env.KEEP_TEST_DIRS) {
    rmSync(userDataDir, { recursive: true, force: true });
    if (scenario !== "compose") rmSync(sample, { recursive: true, force: true });
  } else {
    console.log("kept", { userDataDir, sample });
  }
}
