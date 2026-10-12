# Elide for Visual Studio Code

[![CI](https://github.com/elide-dev/vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/elide-dev/vscode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

VS Code integration for the [Elide](https://elide.dev) build tool. The extension turns an `elide.pkl` project into a
model the [Kotlin LSP by JetBrains](https://marketplace.visualstudio.com/items?itemName=JetBrains.kotlin-server) can
import — resolved Maven dependencies, source roots, JDK — and adds Elide build/run/test tasks and JDWP debugging.

## Install

Until the extension is on the Marketplace, install the `.vsix` from `plugins.elide.dev` (the same worker that hosts the
IntelliJ plugin repository). The link is version-less and always resolves to the current release:

```sh
curl -LOJ "https://plugins.elide.dev/vscode/files?id=elide.elide"   # → elide-<version>.vsix
code --install-extension elide-*.vsix
```

Or in VS Code: **Extensions ▸ … ▸ Install from VSIX…**. `https://plugins.elide.dev/vscode` lists the published version
and a pinned (`&version=`) link.

## Requirements

- Elide **1.5+** installed (`~/.local/share/elide`, `$ELIDE_HOME`, or `elide` on `PATH`).
- The **Kotlin by JetBrains** extension (`JetBrains.kotlin-server`, ≥ 0.0.11). It is declared as an extension
  dependency and installed automatically; complete its one-time region / data-sharing setup so the language server
  starts.
- A JDK for symbol resolution (`$JAVA_HOME`, SDKMAN, `/Library/Java/JavaVirtualMachines`, `/usr/lib/jvm`, …). Elide's
  bundled JDK image cannot serve this role: it ships without a `release` file, which IntelliJ needs to enumerate modules.

## How it works

Opening a folder that contains `elide.pkl` runs a **sync**:

1. `elide project export` — the resolved project manifest as JSON (source sets, Kotlin compiler options,
   entrypoints). Elide 1.5 answers the same document to `elide manifest`, which 1.6 retired; the reported version
   decides which is run.
2. `elide install` — only when the lockfile (`.dev/elide.lock*.bin`) is older than the manifest.
3. `elide classpath <source set>:compile` for every compilable source set.
4. `workspace.json` is written at the workspace folder root in the Kotlin LSP's JSON workspace format (one module per
   source set, one library per jar with `-sources.jar`/`-javadoc.jar` attached when present, the selected JDK as SDK,
   Kotlin language/API level and free compiler args as kotlinc flags).
5. Two Kotlin LSP settings are maintained: `intellij.buildTool` is pinned to `json` in the workspace, and
   `intellij.jdkForSymbolResolution` is written to **user** settings. A running Kotlin LSP is then asked to reload.

`workspace.json` is a generated artifact — add it to `.gitignore`. Every `elide.pkl` under a workspace folder (outside
`.dev/` and `node_modules/`) becomes a set of modules in that folder's single `workspace.json`. A manifest nested
inside another project's directory — a vendored checkout, a sample, a fixture — is a separate build the enclosing
project does not invoke: only the outermost manifest of each tree is imported, and changes to the nested ones do not
trigger a sync.

The exception is an Elide workspace: a root manifest declaring `workspace.members` is resolved with its members, the
way the CLI builds them as one graph. `elide install` runs once at the root (the lockfile check weighs every member's
manifest), and each member's classpath is then read by the CLI invoked in that member's directory. A member's
classpath names a sibling's JAR as the path that sibling's build writes (`<member>/../<sibling>/.dev/artifacts/jar/…`);
that entry is not a library but a module dependency on the source sets the JAR packages, exported so it carries
through, which lets the Kotlin LSP resolve sibling code without building it. Once synced, every member is a project of
its own for path-keyed features (code lenses, tests, tasks, debugging), and edits to its manifest resync the workspace.

Opening a member's own directory instead of the root gives that member no siblings: the CLI still puts their JARs on
its classpath, but they are build outputs of projects the window does not hold, so the sync reports them as
unresolvable rather than inventing a library for a jar that may not exist, and offers to open the workspace root.

### Mixed-editor checkouts (`.idea`, Gradle, Maven)

The Kotlin LSP only reads `workspace.json` when no build system claims the folder first: it matches `jps`
(`.idea/modules.xml`), `gradle`, `maven`, and `bazel` before falling back to the JSON importer, and asks the user to
choose when several match. A checked-in `.idea` from a teammate on IntelliJ would therefore be imported instead of the
Elide model. Pinning `intellij.buildTool` to `json` skips detection, so `.idea` and `workspace.json` coexist: IntelliJ
ignores `workspace.json`, VS Code ignores `.idea`. The pin is skipped when the window holds a folder without an Elide
project (the setting is window-scoped and would disable that folder's Gradle/Maven import) — set it per workspace by
hand there. An explicit `intellij.buildTool` in user, workspace, or folder settings is never overwritten.

### Settings the extension writes

| Setting | Scope written | Why |
| --- | --- | --- |
| `intellij.buildTool` | workspace (`.vscode/settings.json`) | `json`; portable, correct for everyone who opens the repo in VS Code. Safe to commit. |
| `intellij.jdkForSymbolResolution` | user settings | An absolute JDK path for this machine. Committed, it breaks every other checkout: the importer rejects a `defaultSdk` that is not a directory and the whole import fails. |

A workspace or folder value of `intellij.jdkForSymbolResolution` that does not resolve on this machine (a path
committed by a teammate, or written by an older version of this extension) is cleared on sync; one that does resolve is
treated as a deliberate project override and kept. In user settings, only a value this extension wrote is updated —
anything you set by hand stays.

## Commands

| Command | Description |
| --- | --- |
| `Elide: Sync Project(s)` | Re-run the sync. |
| `Elide: Show Menu` | Quick pick with the Elide actions (what the status bar item opens). |
| `Elide: Run Elide Command…` | Pick `build`, `test`, `install`, or `run <entrypoint>` and run it as a task. |
| `Elide: Open generated Kotlin LSP workspace` | Open `workspace.json`. |
| `Elide: Show Output` | Open the `Elide` output channel (CLI output, sync log). |
| `Elide: Run Android App…` | Build an APK and install and launch it on a device or the emulator. |
| `Elide: Debug Android App…` | Build an APK, install and launch it waiting for a debugger, and attach over JDWP. |
| `Elide: Start Android Emulator`, `Elide: Stop Android Emulators`, `Elide: Create Android Virtual Device` | Drive the project's virtual device. |
| `Elide: Install Android SDK Components` | `elide build android-sdk --install-sdk`. |
| `Elide: Create Android Signing Keystore` | `elide build android-keystore-<artifact>`. |
| `Elide: Open Compose Preview` | Render Compose previews locally with Android layoutlib; refresh live while editing. No device or emulator. |
| `Elide: Show Android Logcat` | Stream device logs with application, priority and text filters. |

## Tasks

Task type `elide` with `command` (`build` \| `run` \| `test` \| `install`) and `project` (root relative to the
workspace folder). Provided tasks: `elide: build`, `elide: test`, `elide: install`, and one `elide: run …` per
manifest entrypoint (`entrypoint`, `jvm.main`, `scripts`).

The rest of the definition is the invocation:

| Field | Becomes | Example |
| --- | --- | --- |
| `args` | positional arguments of the subcommand | `["compile"]` → `elide build compile` |
| `flags` | `-f NAME[=VALUE]` build flags, read by the manifest as `build.flags` | `["release"]` → `-f release` |
| `options` | CLI options, keyed by name | `{ "no-cache": true, bail: 3 }` → `--no-cache --bail=3` |
| `programArgs` | arguments after `--` | `["--port", "8080"]` → `-- --port 8080` |
| `env` | environment variables for the Elide process | `{ "CI": "true" }` |

An option value of `true` emits the bare flag, `false` omits it, an array repeats the option (`{ limit: ["workers=4"] }`
→ `--limit=workers=4`), and anything else becomes `--name=value`; a one-character name gets a single dash. Workspace
settings supply the defaults (`elide.flags`, `elide.build.options`, `elide.run.options`, `elide.test.options`,
`elide.install.options`) and each key of a task definition overrides them — `false` cancels an inherited option.

```jsonc
{
  "type": "elide",
  "command": "test",
  "args": ["src/api"],
  "options": { "bail": 3, "test-timeout": 5000 },
  "programArgs": ["--filter", "slow"]
}
```

Every task reports through the `$elide` problem matcher, so compiler errors and warnings land in **Problems** and on
the offending line. It matches the two-line kotlinc shape Elide prints — `[212ms] error: kotlinc: <message>` followed
by `In file: <path>[:<line>[:<col>]]` — and resolves the path by searching the workspace folder (skipping `.dev`,
`.git` and `node_modules`), so relative paths reported from a project root in a subdirectory still resolve. `javac`
diagnostics interleave `symbol:`/`location:` lines between the two and are shown in the terminal only.

## Run and debug code lenses

**Run with Elide** / **Debug with Elide** appear above every `fun main(` (Kotlin, including `@JvmStatic fun main` in
an `object`) and `public static void main` in a production source root of a synced project, and **Run** / **Debug**
in `elide.pkl` on `jvm.main`, on each `entrypoint` element, on each `scripts` entry (**Run script** — a script is a
shell command line, so there is nothing to attach a debugger to) and on each `artifacts` entry (**Build**). A file
whose main class is the manifest's `jvm.main` runs as `elide run`; any other file is passed to Elide as the
entrypoint. Detection is regex-based — no Kotlin or Java parser is involved — so exotic declarations are missed; set
`elide.codeLens.enabled` to `false` to turn the lenses off.

The JetBrains Kotlin LSP contributes a second, unqualified **Run** / **Debug** pair on the same line from its own
`LSJvmRunMainCodeLensProvider`. It is a server-side feature with no setting, no registry flag and no exported client
API, so this extension cannot suppress it — hence the `with Elide` suffix. That pair launches the class through the
IntelliJ debug adapter rather than `elide run`, so it does not build first and does not see the project's compiled
output, which `workspace.json` does not carry.

## Test Explorer

JUnit tests in the **test** source roots of a synced project appear in the **Testing** view, grouped project → class
→ method, with nested classes nested. Discovery is static: the test sources of the project model are scanned for
`@Test` (and `@ParameterizedTest`, `@RepeatedTest`, `@TestFactory`, `@TestTemplate`) declarations, so the tree is
populated without compiling or running anything, and it follows edits — saved or not — through a file watcher and the
open editor's buffer. Like the code lenses, the scan is regex-based, so exotic declarations are missed.

A run executes `elide test --reporter=tap` in the project root, adding `--test-name-pattern=<pattern>` whenever the
selection is narrower than the whole project (the JVM engine full-matches that pattern against `pkg.Class#method`,
with `$` separating nested classes). `elide.flags` and `elide.test.options` apply here too, except for `reporter`,
which stays `tap` because this run parses that stream. Results are reported as the TAP stream settles: a failure's
`message` and `detail` block become the test's message, and the first stack frame naming the test's own file
positions it in the editor. A label that matches no discovered item is added under the project item, so a result is
never dropped; a run that reports no result at all (a pattern matching nothing, a compile error) marks the selected
tests errored with the CLI's stderr.

The **Debug** profile runs the same command with a bare `--debugger` and attaches `elide.debug.adapter` once the JDWP
agent announces itself. That flag takes no address on `elide test`: the agent always binds 5005, so one debug run at
a time.

## Debugging

Launch configuration type `elide`:

```jsonc
{
  "type": "elide",
  "request": "launch",
  "name": "Elide: Run (debug)",
  "entrypoint": "src/main.kt",
  "args": ["--port", "8080"],
  "flags": ["release"],
  "options": { "coverage": true }
}
```

The extension runs `elide run --debugger [flags] [options] [entrypoint] [-- args]` in a terminal, waits for the JDWP
agent's `Listening for transport dt_socket at address: <port>` line, then attaches the JetBrains JVM debugger
(`elide.debug.adapter`: `intellij`) or Debugger for Java (`java`, requires `vscjava.vscode-java-debug`). Stopping the
session terminates the Elide process. The JDWP agent always binds port 5005, so one debug session at a time.

`args` are the debugged application's own arguments; `elideArgs` adds further positional arguments to the Elide
command itself. `flags`, `options` and `env` layer over `elide.flags` and `elide.<command>.options` exactly as in a
task, and `--debugger` is always added — set `debugger` in `options` to choose its value (`dap`, `cdp`, a
`host:port` address).

`command` selects what is debugged:

| `command` | Runs | What it acts on |
| --- | --- | --- |
| `run` (default) | `elide run --debugger` | `entrypoint`: file, manifest script, or empty for `entrypoint`/`jvm.main` |
| `test` | `elide test --debugger` | the whole test run; narrow it with `"options": { "test-name-pattern": "MyTest" }` |
| `build` | `elide build <targets> --debugger` | `targets`: build targets (`run`, `jvm-test`, … — `elide build --inspect` lists them) |

On `build`, `--debugger` is an option of the target task rather than of the build itself, so the configuration must
name at least one target; one with an empty `targets` assembles nothing and is rejected before any process starts,
and `entrypoint` is refused there (it belongs to `run`). Target options go in `options` the same way. `targets` may
list several targets, but only one of them can start a JVM: the bare `--debugger` binds 5005 for each, so two
debuggable targets in one configuration collide on that port. The **Build targets** section of the Elide sidebar
offers a Debug action on every target that declares `--debugger`.

```jsonc
{
  "type": "elide",
  "request": "launch",
  "name": "Elide: Build (debug)",
  "command": "build",
  "targets": ["jvm-test"],
  "options": { "select": "class:com.example.SomeTest" }
}
```

## Android

A manifest declaring an `android` block builds for Android. Elide drives `aapt2`, `d8`, `zipalign` and `apksigner`
directly — no Gradle, no new subcommand — so every step is a build target of the ordinary graph and the extension
reaches all of them through `elide build`.

The sync reads three things beyond the usual manifest decoding:

- The `android` block (compile and minimum API level, the declared SDK, the virtual device) and every `AndroidApk` /
  `AndroidAab` / `AndroidAar` / `AndroidFeature` entry of `artifacts`, which become the project model's `android` section.
- The resource, asset and native-library directories of each artifact, added as resource roots of the source sets
  it packages. Applications and libraries fall back to existing `src/main/res`, `src/main/assets` and
  `src/main/jniLibs`; features use only their explicitly declared directories and never inherit the base app's.
- The **provided** classpath of each source set, which is where an Android build puts the platform `android.jar`
  and the generated `R` classes: the device carries the framework and the APK's own dex carries `R`, so neither is
  on the compile or runtime classpath the rest of the model is built from, and without them nothing `android.*`
  and no resource identifier resolves. `R` is listed only once the target that compiles it has run, so a sync that
  does not find it runs `elide build android-r-<artifact>` first.

An application consuming a workspace sibling's Android library reads that library's **staged** `classes.jar`
(`<lib>/.dev/android/<artifact>/classes.jar`), never its published `.aar`. That path is recognized the same way a
sibling JAR under `.dev/artifacts/` is, so the application's modules depend on the library's modules and navigation
crosses the project boundary without requiring a published AAR. Annotation processors may run during sync to
make generated declarations available.

A **published** `.aar` is a dependency rather than a sibling's output. Elide unpacks each one into
`.dev/android/libraries/<group>/<artifact>/<version>/` and puts the `classes.jar` inside it on the classpath, so
the extension names the library by the coordinate that path spells out and attaches the `-sources.jar` of the
archive from the Maven repository — the same library the jar of a non-Android dependency would be. Resolving a
classpath does not unpack anything, so a sync that finds a directory missing runs `elide build android-libraries`
once before building the model; without it the language server would be handed jars that are not there.

The SDK is located the way a build locates it: `android.sdk` in the manifest, then `$ANDROID_HOME`, then
`$ANDROID_SDK_ROOT`, then the platform's own install location (`~/Library/Android/sdk`, `~/Android/Sdk`,
`%LOCALAPPDATA%\Android\Sdk`). `elide.android.sdk` overrides it for extension-side device listing and logcat.
A build reports a missing SDK itself; `Elide: Install Android SDK Components`
runs `elide build android-sdk --install-sdk`, which is how the component licenses are accepted.

The sidebar's **Android** section lists the artifacts, the devices `adb devices` reports (serial, and whether it is
an emulator or in a state that cannot take an install), and the project-wide device targets:

| Action | Invocation |
| --- | --- |
| Run an APK | `elide build android-run-<artifact>`, plus `--device=<serial>` when a device is picked, or `android-run-emulator-<artifact>` for the project's AVD. With nothing attached the plain target runs, which boots the emulator itself. |
| Debug an APK | `elide build android-debug-<artifact>`, which installs it, launches it waiting for a debugger and forwards its JDWP socket; the extension attaches to the port the target announces. The APK must carry `android:debuggable="true"` — nothing injects it, and the target reports an APK that does not. |
| Build an APK, AAB or AAR | `elide build <artifact>` → `.dev/artifacts/<name>.apk` / `.aab` / `.aar` |
| Build a dynamic-feature module | `elide build android-module-<feature>` → `.dev/android/<feature>/<feature>.zip`; build its owning AAB to publish the application. |
| Open the R8 mapping | A `minify = true` artifact gets a mapping row beside it, which opens `.dev/artifacts/<name>-mapping.txt` — publishing it with `elide build android-mapping-<artifact>` when it is not there, since building the artifact alone does not — the only way to read a stack trace from a shrunk build. |
| Start / stop the emulator | `elide build android-emulator` (`--no-window` when `elide.android.emulatorWindow` is off), `elide build android-emulator-stop` |
| Create the AVD | `elide build android-avd` |
| Create the signing keystore | `elide build android-keystore-<artifact>` |

Unit tests of an Android project are plain JVM tests and run in the Test Explorer as usual.

### Compose component preview

**Elide: Open Compose Preview** renders locally using Google's standalone Compose renderer and Android layoutlib.
It requires no device, emulator, Android Studio installation, signing keystore, or debuggable APK. The extension
builds JVM classes and linked Android resources, not DEX or an installable application.

Enable `kotlin.features.compose`, include Compose `ui-tooling`, sync, and open a Kotlin file containing
`@Preview` / `@Composable` functions. The gallery renders the file's compiled previews, including annotation
configuration, member functions, multi-preview annotations and `@PreviewParameter` providers. Kotlin/Java edits,
including unsaved changes, use persistent incremental compilers and renderers. Resource/configuration saves
rebuild the resource context; library previews use a consuming workspace application.

The themed gallery retains its last good images through compilation errors and swaps decoded updates without
blanking the canvas. Enable **Inspect** for measured layout outlines; select a component and open its source,
including workspace-library call sites. Source navigation pauses while the displayed preview is out of date.

The first preview downloads a pinned, SHA-256-verified renderer/runtime from Google Maven into extension storage.
Subsequent previews reuse it offline. A matching-architecture JDK 17+ is required; supported extension hosts are
macOS arm64/x64, Linux x64 and Windows x64. These are rendered snapshots, not interactive device mirroring or
in-process Live Edit. See [the extension guide](packages/vscode/README.md#compose-component-preview) for setup
and runtime limitations.

### Dagger and Hilt

The experimental Elide `feat/android` branch supports kapt and Hilt Android entry-point transformation.
Declare processors in `dependencies.maven.processors`, use a managed/external Kotlin toolchain with kapt,
and enable `android.hilt` for Hilt. Sync discovers the project's actual compile targets, generates processor
sources and imports the Java/kapt output roots without importing kapt stubs. Workspace AARs retain generated
components and Hilt aggregation metadata, allowing application bindings to come from sibling libraries.

Hilt bindings owned by dynamically delivered code cannot be installed into the base component; use Dagger
component dependencies against an entry point exposed by the base app.

### Multi-module apps and dynamic features

Use workspace `AndroidAar` projects for reusable libraries. Inside the application project, an `AndroidAab`
lists its `features`; each `AndroidFeature` identifies that AAB through `base`, owns disjoint source sets, and
can declare `featureDependencies`. The sidebar shows the owning base, delivery mode and feature dependencies.
Features are buildable modules, not independently runnable APKs.

Delivery is `on-demand` by default or `install-time`. Install-time features remain removable splits, preserving
their identity when another feature depends on them. Elide packages base/shared classes once and gives each
feature its own resources, assets and dex. Install an AAB through bundletool or Play; the APK Run/Debug commands
do not perform Play delivery. These capabilities require the experimental `feat/android` Elide branch.

### Logcat

**Elide: Show Android Logcat** selects a device, an application ID (blank means all apps), a minimum priority,
and an optional case-insensitive literal text filter. The Android tree and device context menu expose it too.
Each project owns an output channel and adb stream. **Filter**, **Stop**, and **Restart Android Logcat** control
the stream; **Clear Android Logcat Output** clears only the editor, not the device's shared log buffers.
Restart and filter changes replay available device logs. Package filtering uses the installed UID, surviving
process restarts and including secondary processes and any apps sharing that UID. It requires `logcat --uid`.
Streams stop when their project is removed or the extension closes.


## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `elide.home` | `""` | Distribution root containing `bin/elide`. |
| `elide.jdk.home` | `""` | JDK for symbol resolution; else `jvm.javaHome`, `$JAVA_HOME`, installed JDKs matching `jvm.target`. |
| `elide.sync.onStartup` | `true` | Sync when the workspace opens. |
| `elide.sync.onManifestChange` | `"prompt"` | `always` / `prompt` / `never` when `elide.pkl` changes, or when the lockfile's resolved dependencies do. Every `elide` invocation rewrites `.dev/elide.lock*.bin`, so rewrites with unchanged content are ignored. |
| `elide.kotlinLsp.writeWorkspaceJson` | `true` | Write `<folder>/workspace.json`. |
| `elide.install.classifiers` | `["sources"]` | Classifiers installed for declared Maven packages (`sources`, `docs`); empty installs classes only. Elide's own Kotlin/JUnit jars have none. |
| `elide.flags` | `[]` | `-f NAME[=VALUE]` build flags for every invocation, sync included; changing them marks the model stale. |
| `elide.build.options` | `{}` | Default options for `elide build`, e.g. `{ "no-cache": true }`. |
| `elide.run.options` | `{}` | Default options for `elide run`. |
| `elide.test.options` | `{}` | Default options for `elide test`; Test Explorer runs use them too, except `reporter`. |
| `elide.install.options` | `{}` | Default options for the `elide install` task. |
| `elide.codeLens.enabled` | `true` | Show the Run/Debug code lenses described above. |
| `elide.debug.adapter` | `"intellij"` | `intellij` or `java`. |
| `elide.android.sdk` | `""` | SDK root the device list is read from; empty resolves the one a build would use. |
| `elide.android.emulatorWindow` | `true` | Boot the emulator with a window; off passes `--no-window`. |

## Repository layout

- `packages/core` — `@elide/ide-core`: editor-agnostic library (Elide discovery, CLI runner, manifest decoding, project
  model, `workspace.json` emitter). No VS Code dependency; reusable by other TypeScript-based editor integrations.
- `packages/vscode` — the extension; its `CHANGELOG.md` is the release history shown on the Marketplace, generated
  from commit subjects by [release-please](https://github.com/googleapis/release-please) when a release is cut.
- `samples/ktjvm` — Kotlin/JVM sample used by the integration test.
- `tools/deploy.sh` — packaging and publication to `plugins.elide.dev`.

## Development

```bash
bun install
bun run build                       # core (tsc) + extension (esbuild)
bun test                            # core unit tests
cd packages/vscode && bun run test:integration   # drives real VS Code + Kotlin LSP against samples/ktjvm
```

The integration test requires VS Code at `/Applications/Visual Studio Code.app`, `JetBrains.kotlin-server` installed
in `~/.vscode/extensions`, `elide` installed, and network access (it adds Guava to the sample). Press F5 in this repo to
run the extension against `samples/ktjvm`.

## Contributing

Issues and pull requests are welcome. [`CONTRIBUTING.md`](CONTRIBUTING.md) covers the dev loop, the commit convention
(Conventional Commits, enforced on pull requests), and the release process; participation is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in
[`SECURITY.md`](SECURITY.md) — not in a public issue.

## License

MIT — see [`LICENSE`](LICENSE).
