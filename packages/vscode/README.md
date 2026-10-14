# Elide for Visual Studio Code

[![CI](https://github.com/elide-dev/vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/elide-dev/vscode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/elide-dev/vscode/blob/main/LICENSE)

VS Code integration for the [Elide](https://elide.dev) build tool. Any folder containing an `elide.pkl` manifest
becomes a real project: resolved dependencies and source roots are handed to the
[Kotlin language server by JetBrains](https://marketplace.visualstudio.com/items?itemName=JetBrains.kotlin-server), and
Elide's build, run, test, and debug commands are available from the editor.

## Features

- **Project sync.** Opening a folder with `elide.pkl` resolves the manifest, installs dependencies when the lockfile is
  stale, and reads the compile classpath of every source set. Manifests nested inside another project (vendored
  checkouts, samples) are separate builds and are not imported, unless that project declares them as workspace
  members.
- **Multi-project workspaces.** A manifest declaring `workspace.members` is synced as one build: a single install at
  the root, then every member's own source sets, classpath and JDK. A member consuming a sibling's artifact with
  `project("name")` depends on the sibling's modules, along with any siblings that artifact brings in the way Elide
  resolves the classpath, so code intelligence works across the workspace without first publishing those artifacts. Each member
  is also a project of its own in the sidebar (nested under the root), the Test Explorer, tasks, code lenses and
  debug configurations. Editing any member's manifest reloads the workspace. `Elide: Add Workspace Member…` generates
  a new member from a template and declares it in the root's manifest; opening a member's directory on its own
  offers to open the workspace root instead, since only the root resolves the siblings it depends on.
- **Kotlin/Java code intelligence.** The project model is written as a `workspace.json` the Kotlin LSP imports —
  modules per source set, libraries with attached sources and javadoc, the selected JDK, and the manifest's Kotlin
  compiler options.
- **Mixed-editor checkouts.** A repository can carry both an IntelliJ `.idea` directory and the generated
  `workspace.json`; each editor uses its own.
- **Tasks.** `elide build`, `elide test`, `elide install`, and one run task per manifest entrypoint.
- **Test Explorer.** JUnit tests of the project's test source roots in the **Testing** view, run and debugged through
  `elide test --reporter=tap` with live results, failure messages and stack-trace locations.
- **Elide sidebar.** An activity-bar view with each project's entrypoints, tasks, build targets (`elide build
  --inspect`), source sets and dependencies; run, debug, build and sync straight from the tree.
- **Activity.** The sidebar's **Activity** view lists every sync and Compose preview build of the window, live
  while it runs: each step (reading the manifest, installing dependencies, resolving classpaths, generating
  resources, writing `workspace.json`), the `elide` commands it ran, and the build tasks those reported, each with
  its duration and share of the whole. With Elide 1.6.1 or newer, tasks appear as they start, with the progress they
  report, and the status bar says what Elide is doing and how many of the build's tasks are done. Any row opens its
  output, with timestamps, in an editor; a running operation can be cancelled from the row. The status bar tooltip
  shows where the last sync's time went, and the `Elide` output channel ends each sync with the same breakdown.
- **New project wizard.** `Elide: New Project…` lists the templates of the installed CLI (`elide init --templates`),
  asks for the parameters that template declares, generates the project and opens it.
- **Android projects.** A manifest declaring an `android` block gets an **Android** section in the sidebar: its APKs,
  AABs, AARs and dynamic features, the devices and emulators `adb` reports, and emulator, AVD and SDK-install targets.
  `res/` and `assets/` of each artifact become resource roots of the source sets it packages, and a sibling Android
  library's classes are resolved as a module dependency rather than an opaque jar, so navigation works across an
  application and the libraries it consumes. Running an APK installs and launches it on a device you pick.
  Compose component previews render locally with layoutlib, without a device or emulator, and refresh while editing. Logcat streams have
  application, priority and text filters. Dagger/Hilt generated sources are included in editor synchronization.
- **Debugging.** Launch `elide run --debugger` and attach with breakpoints in Kotlin and Java, debug an Android
  application on the device it was installed on, or build a Native Image artifact and debug the binary it produced
  under GDB.

## Requirements

| | |
| --- | --- |
| [Elide](https://elide.dev) **1.5+** | Found via `elide.home`, `$ELIDE_HOME`, the platform install locations, or `PATH`. **1.6.1+** reports live task progress and resolves a project's classpaths in one call; older releases sync with one call per classpath and show tasks once they finish. |
| **Kotlin by JetBrains** (`JetBrains.kotlin-server`, ≥ 0.0.11) | Installed automatically as a companion extension. Complete its one-time region / data-sharing prompt for Kotlin/Java analysis and JVM debugging. |
| A JDK | `$JAVA_HOME`, SDKMAN, `/Library/Java/JavaVirtualMachines`, `/usr/lib/jvm`, or `elide.jdk.home`. Elide's bundled JDK image cannot be used for symbol resolution: it ships without a `release` file. |
| An Android SDK, for Android projects | `android.sdk` in the manifest, `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, or where the SDK installs itself on this platform. `Elide: Install Android SDK Components` installs what a build is missing. |

Elide activates independently of the Kotlin language server: sync, build, previews and environment diagnostics
remain available while it starts or if it is unavailable. Opening an Elide Kotlin or Java source document starts
the companion when needed, including Java-first projects.

The extension needs a trusted workspace and a local filesystem — syncing runs the workspace's Elide CLI.

## Getting started

1. Open a folder containing `elide.pkl`. While it syncs, the status bar names the step in progress and the time
   so far; a sync that takes more than a couple of seconds also shows a cancellable notification. Click the status
   bar item for the Elide actions, or open the **Activity** view to see where a sync's time went.
2. Open a Kotlin or Java file. Once the Kotlin LSP has imported the generated `workspace.json`, completion and
   navigation resolve against the project's dependencies.
3. Open the **Elide** view in the activity bar to run entrypoints, tasks and build targets, or press F5 with an
   `elide` launch configuration to debug. `Elide: Run Elide Command…` does the same from the command palette.

   The **Get started with Elide** walkthrough (Help → Get Started) covers the same ground step by step.

`workspace.json` is a generated artifact — add it to `.gitignore`.

## Commands

| Command | Description |
| --- | --- |
| `Elide: Sync Project(s)` | Re-run the sync. |
| `Elide: Show Menu` | Quick pick with the Elide actions (what the status bar item opens). |
| `Elide: Run Elide Command…` | Pick `build`, `test`, `install`, or `run <entrypoint>` and run it as a task. |
| `Elide: New Project…` | Create a project from an Elide template in a directory you pick. |
| `Elide: Add Workspace Member…` | Create a project inside an existing one and declare it in `workspace.members`. |
| `Elide: Open generated Kotlin LSP workspace` | Open the generated `workspace.json`. |
| `Elide: Show Output` | Open the `Elide` output channel. |
| `Elide: Show Activity` | Reveal the **Activity** view: syncs and preview builds, step by step, with durations. |
| `Elide: Open Activity Log` | Open the latest operation's output, with timestamps, in an editor. |
| `Elide: Select Android Deployment Target…` | Choose the remembered project, APK and device shared by Run and Debug. |
| `Elide: Check Android Environment` | Inspect local tools and device readiness, including before sync succeeds; select a finding for fixes. |
| `Elide: Refresh Android Devices` | Refresh devices without a project resync. |
| `Elide: Run Android App…` | Build an APK and install and launch it on a device or the emulator. |
| `Elide: Debug Android App…` | Build an APK, install and launch it waiting for a debugger, and attach over JDWP. |
| `Elide: Start Android Emulator` / `Elide: Stop Android Emulators` | Boot the project's AVD, or shut running emulators down. |
| `Elide: Create Android Virtual Device` | Create the AVD `android.device` declares, without booting it. |
| `Elide: Install Android SDK Components` | Install the SDK components the pipeline is missing (`--install-sdk` accepts their licenses). |
| `Elide: Create Android Signing Keystore` | Mint the keystore an APK signs with, using the Android debug conventions. |
| `Elide: Open Compose Preview` | Render the Kotlin file's Compose previews beside the source using host-side layoutlib. |
| `Elide: Show Android Logcat` | Open a filtered device log stream; Filter, Clear, Stop and Restart commands manage it. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `elide.home` | `""` | Distribution root containing `bin/elide`. |
| `elide.jdk.home` | `""` | JDK for symbol resolution; else `jvm.javaHome`, `$JAVA_HOME`, installed JDKs matching `jvm.target`. |
| `elide.sync.onStartup` | `true` | Sync when the workspace opens. |
| `elide.sync.onManifestChange` | `"prompt"` | `always` / `prompt` / `never` when `elide.pkl` or the lockfile changes. |
| `elide.sync.showProgressNotification` | `true` | Show a notification with the step in progress and a Cancel button while a sync runs for more than two seconds. |
| `elide.kotlinLsp.writeWorkspaceJson` | `true` | Write `<folder>/workspace.json`. |
| `elide.install.classifiers` | `["sources"]` | Classifiers installed for declared Maven packages (`sources`, `docs`); empty installs classes only. Elide's own Kotlin/JUnit jars have none. |
| `elide.flags` | `[]` | `-f NAME[=VALUE]` build flags for every Elide invocation, project sync included. |
| `elide.build.options`, `elide.run.options`, `elide.test.options`, `elide.install.options` | `{}` | Default CLI options per command. |
| `elide.debug.adapter` | `"intellij"` | Attach with the JetBrains JVM debugger (`intellij`) or Debugger for Java (`java`). |
| `elide.debug.nativeMiMode` | `"auto"` | Debugger an `elide-native` session drives: `gdb`, `lldb`, or `auto` (a GDB on `PATH`, else LLDB on macOS). |
| `elide.debug.miDebuggerPath` | `""` | `gdb` / `lldb-mi` binary for `elide-native` sessions; empty resolves `gdb` on `PATH`. |
| `elide.android.sdk` | `""` | SDK root the device list is read from; empty resolves the one the build would use. |
| `elide.android.emulatorWindow` | `true` | Boot the emulator with a window; off passes `--no-window`. |
| `elide.android.composePreview.prewarm` | `true` | Start the Compose preview backend when a file with `@Preview` functions is focused. |
| `elide.android.composePreview.keepAliveMinutes` | `10` | Minutes an unused Compose preview backend stays warm; `0` stops it with its panel. |

The extension also maintains two Kotlin LSP settings: `intellij.buildTool` (pinned to `json` in workspace settings) and
`intellij.jdkForSymbolResolution` (an absolute path, written to user settings only). Explicit values you set by hand
are never overwritten.

## Tasks and debugging

Task type `elide` takes `command` (`build` | `run` | `test` | `install`), `project` (project root relative to the
workspace folder) and the invocation itself: `args` (positional arguments), `flags` (`-f NAME[=VALUE]` build flags),
`options` (CLI options as a name/value object), `programArgs` (arguments after `--`) and `env`. Workspace defaults
come from `elide.flags` and `elide.build.options` / `elide.run.options` / `elide.test.options` /
`elide.install.options`; a definition overrides them per key.

```jsonc
{ "type": "elide", "command": "test", "args": ["src/api"], "options": { "bail": 3 } }
```

Launch configurations use type `elide` and take the same fields, with `args` reserved for the debugged
application's own arguments and `elideArgs` for positional arguments of the Elide command:

```jsonc
{ "type": "elide", "request": "launch", "name": "Elide: Run (debug)", "entrypoint": "src/main.kt", "args": [], "options": { "coverage": true } }
```

The extension runs `elide run --debugger`, waits for the JDWP listener, and attaches the configured debug adapter;
ending the session stops the Elide process. The JDWP agent binds port 5005 by default, so one debug session at a
time. `"command": "test"` debugs `elide test` instead, and `"command": "build"` debugs the build targets listed in
`targets` (`run`, `jvm-test`, … — `elide build --inspect` lists them); the Elide sidebar offers a Debug action on
every build target that supports it.

### Native Image

Launch type `elide-native` builds a Native Image artifact and debugs the binary it produced. `artifact` is the key of
its entry in the `artifacts` block of `elide.pkl`; `program` debugs a binary directly, `build: false` skips the
build, and `args`, `cwd`, `env`, `stopAtEntry` and `project` apply to the debugged program.

```jsonc
{ "type": "elide-native", "request": "launch", "name": "Elide: Debug Native Image", "artifact": "bin", "args": [] }
```

The binary is handed to the **C/C++** extension (`ms-vscode.cpptools`), which drives GDB; the extension offers to
install it when it is missing. The session points the debugger at the source cache GraalVM writes next to the image
and loads the `gdb-debughelpers.py` that comes with it, so Java objects, arrays and strings print as such.

Source-level debugging needs the image to carry debug info, which comes from the manifest — Elide passes an
artifact's `options.flags` straight to `native-image`:

```pkl
["bin"] = new NativeImage.NativeImage {
    from { "jar" }
    entrypoint = "sample.MainKt"
    options {
        flags {
            "-g"
            "-O0"
        }
    }
}
```

GraalVM only emits that debug info on Linux; elsewhere `-g` copies the GDB helpers but produces no DWARF and no
source cache, so breakpoints do not bind and the session warns about it. Machine-level stepping still works.

### Android

Elide builds Android applications and libraries without Gradle: every step is an ordinary build target. The
**Android** section of the sidebar lists what the manifest publishes and runs the targets behind it:

| Row | Target |
| --- | --- |
| An `AndroidApk` artifact | `elide build <artifact>` to package it; **Run** installs and launches it with `elide build android-run-<artifact>`, pinned to the picked device with `--device=<serial>`; **Debug** does the same through `android-debug-<artifact>` and attaches over JDWP. |
| An `AndroidAab` artifact | `elide build <artifact>`, which publishes `.dev/artifacts/<artifact>.aab`. |
| An `AndroidAar` artifact | `elide build <artifact>`, which publishes `.dev/artifacts/<artifact>.aar`. |
| An `AndroidFeature` module | `elide build android-module-<feature>`, staging `.dev/android/<feature>/<feature>.zip`. Its row identifies the base bundle, delivery mode and required features; build the owning AAB to publish it. |
| The mapping of a minifying artifact | A row beside an artifact with `minify = true`, which opens the `.dev/artifacts/<name>-mapping.txt` R8 published, publishing it with `android-mapping-<artifact>` first when it is not there: without it a stack trace from a shrunk build cannot be read. |
| **Devices** | `adb devices` of the resolved SDK; a row in the `device` state runs the project's APK on that serial. |
| **Start emulator** / **Stop emulators** / **Create AVD** | `android-emulator` (with `--no-window` when `elide.android.emulatorWindow` is off), `android-emulator-stop`, `android-avd`. |
| **Install Android SDK components** | `android-sdk --install-sdk`, shown when no SDK was found. |

Every other Android step — `android-resources-*`, `android-link-*`, `android-dex-*`, `android-r8-*`,
`android-sign-*`, `android-bundle-*` — is listed under **Build targets** like any other target of the project.

A published `.aar` dependency appears under **Dependencies** named by its coordinate, with the sources of the
archive attached: Elide unpacks each one into `.dev/android/libraries/<group>/<artifact>/<version>/` and compiles
against the `classes.jar` inside it, and a sync unpacks what is missing so symbols resolve before the first build.

Two more entries appear there for an Android project: the **Android API `<level>` platform** (the `android.jar`
every Android source compiles against) and the **Android resources of `<artifact>`** (the generated `R`). Neither
is on the compile classpath — the device carries the framework and the APK's dex carries `R` — so a sync reads
them from the provided classpath, and generates the `R` classes it does not find with `android-r-<artifact>`.

An Android application is debugged on the device: an `elide-android` launch configuration builds the APK, installs
it, launches it waiting for a debugger and attaches to the JDWP socket the target forwards. The APK has to be
debuggable — `android:debuggable="true"` on `<application>`, which nothing in the build injects — and the target
says so and stops when it is not. Unit tests of an Android project are plain JVM tests and run in the Test Explorer
as usual.

#### Deployment target and environment

The device status-bar item and **Select Android Deployment Target…** choose the project, APK and destination
shared by Run and Debug. The selection persists in workspace state. Explicit tree/code-lens targets override it;
otherwise a runnable app owning the active file takes precedence over the remembered app. Library files do not
accidentally turn their library into a deployment target.

Each deployment validates the artifact against the synced model and checks fresh adb state. If the selected
device is disconnected, offline or unauthorized, deployment stops rather than silently choosing another device.
Run and Debug save dirty file-backed documents before building and stop if saving fails. Project-emulator Debug
identifies the exact AVD, boots it when necessary with cancellable bounded startup, and rejects ambiguous
instances. Android launch configurations also validate their target; `flags`, `options` and `env` layer over
workspace defaults, with the selected device taking precedence.

**Check Android Environment** works before a successful sync. It reports Elide, JDK, SDK/platform-tools,
connected devices and Kotlin extension availability; synced declarations additionally enable compile-SDK,
AVD and APK checks. Unknown declarations are not invented, and an optional missing emulator does not block
physical-device development. Select a finding for concrete settings, sync, output or SDK/device actions.
Inspection performs no build, dependency installation or license acceptance. The full report goes to **Elide
Output**. Find it in the command palette, Elide menu, Android tree or project context menu.
Symlinked workspace paths are flagged because JetBrains source breakpoints can report “Source file not found”;
the finding offers to open the canonical folder in a new window.

Device rows refresh after Elide tasks or **Refresh Android Devices**, without background adb polling.

#### Compose component preview

Requires the experimental Elide `feat/android` branch with persistent compiler workers,
transactional incremental compilation, `--warm-incremental`, `--report-abi`, and recorded `kotlinc.args`/`javac.args`,
an Android SDK for compilation/resource linking, and a JDK 17+ matching the extension
host's architecture. **No device, emulator, Android Studio, signing keystore, debuggable application or
`PreviewActivity` is required.**

1. Set `kotlin.features.compose = true`.
2. Include Compose `ui-tooling` (for example `androidx.compose.ui:ui-tooling-android:aar:1.7.8`) and the Compose
   libraries your component uses, with Google's Maven repository configured. `ui-tooling-preview` alone supplies
   annotations, not the renderer's Compose adapter. Keep tooling dependencies out of production artifacts.
3. Declare an `AndroidApk` artifact as the resource context. The preview builds only its resource/R-class targets
   and the relevant JVM compilation targets; it does not package, sign, install or launch that APK.
4. Sync, open a Kotlin file and invoke **Elide: Open Compose Preview** from the Command Palette or editor title.
   The resource context is chosen automatically: the `AndroidApk` that packages the file's source set, or else the
   nearest application depending on its workspace library; equally near applications go by workspace and artifact
   declaration order.

The extension uses [Google's standalone Compose renderer](https://android.googlesource.com/platform/tools/base/+/HEAD/standalone-render/compose-cli/README.md)
and layoutlib—the host rendering engine used by Android Studio—not a JavaScript approximation.
The first preview downloads `compose-preview-renderer:0.0.1-alpha16` and `layoutlib:16.1.0-jdk17` with its platform
runtime/resources from `dl.google.com`; SHA-256 pins verify each artifact before installation. Downloads and upstream
licenses are retained in the extension's global storage. A completed installation is reused without network access.
Supported extension hosts: **macOS arm64/x64, Linux x64, Windows x64**. Unsupported host architectures report an
error rather than falling back to a device.

Discovery reads compiled annotations, so constant annotation values, repeated `@Preview`, member functions,
multi-preview meta-annotations and `@PreviewParameter` providers reach the renderer. The gallery displays each
configuration/provider value, respecting options such as dimensions, background, locale, font scale and UI mode.
Rendering errors expose diagnostics on the affected card while retaining its last successful image.

Kotlin/Java changes refresh live, including unsaved editor buffers. Persistent compiler workers incrementally
compile private source snapshots; persistent layoutlib workers render the new classes. The gallery keeps its
previous images while updating, publishes only the latest edit, and reports elapsed time from change detection
through webview paint. Compiler failures retain the gallery, scroll position and selection, with diagnostics in
**Details** rather than replacing the images. Fresh PNGs decode before publication; unchanged pixels are reused.
Preview compilation does not overwrite workspace sources or build outputs.
Large galleries use up to six renderer JVMs, limited to half the host's available CPUs.
Source ownership follows the synced manifest's source selections. Adding the first Java source
to a source set without recorded Java compiler inputs requires a save and full rebuild.

Opening a preview builds JVM classes and linked resources, but does not wait for that build to paint:

- **Prewarm.** Focusing a Kotlin file with `@Preview` functions in a trusted, synced Android project starts the
  renderer JVMs and compiler workers in the background and renders that file from the last build's classes, so
  **Elide: Open Compose Preview** typically paints in well under a second. Prewarming never builds and never
  downloads the renderer runtime; it is off when `elide.android.composePreview.prewarm` is disabled.
- **Keep-alive.** Closing the panel keeps its renderer and warm compilers for
  `elide.android.composePreview.keepAliveMinutes` (default 10; `0` stops them with the panel). Reopening reuses them.
  The backend holds several GB of memory while warm; at most one unused backend is kept.
- **Build outputs as the first generation.** When the last build's classes match the current sources, they are
  displayed directly instead of a cold compile; the incremental compiler warms in the background afterwards,
  adding source information for layout inspection without delaying the first image.
- **Stored galleries.** Each gallery is stored under its exact inputs (build fingerprint, source text, renderer and
  JDK), so reopening an unchanged file, even after restarting VS Code, or undoing an edit paints immediately.

Until the build finishes, the status reads *verifying build…*; if the build changes resources, dependencies or
compiler settings, the gallery re-renders. Saving `.xml` or `.pkl` files, changing the project model, or pressing
**Rebuild** performs that build again. Projects using generated annotation-processor sources require a save
and full rebuild; unsaved changes show a save prompt and retain the last successful preview. A first preview of a
project that was never built, or whose sources changed since its last build without a prewarmed backend, waits
for the build and a cold renderer.

While the preview builds, the status line names the tasks Elide has finished so far, the most recent one with its
duration, and counts the build's elapsed time. **Build log** opens the build's output inside the panel as it
arrives; **Open in editor** shows the complete log with timestamps, and **Timing** reveals the build in the
**Activity** view. A failed build quotes the compiler errors under **Details** and lists them in the Problems view.
Once a gallery paints, the status line breaks its time down by phase (build, compile, render). Builds do not steal
editor focus; the build's task terminal stays available in the Terminal panel.

The gallery follows VS Code's light, dark and high-contrast themes. **Fit** constrains images to their cards;
toggle it for actual pixel size.

**Inspect** overlays Compose's measured layout bounds. Click a component to select it, then choose **Open source**,
double-click, or press Enter to navigate to its call site, including calls in workspace libraries. The component
picker and **Parent** control select enclosing components. With a preview focused, arrow keys cycle components,
Home/End select the first/last, and Alt+Up selects an enclosing component.

Inspection uses real tooling bounds and compiler UTF-16 source ranges, not image recognition or guessed source
matches. Only locations uniquely resolved in the preview's compiler inputs are selectable; dependency internals
and ambiguous source files are omitted. Bounds are rectangular measured layouts, not arbitrary painted contours.
Private preview compilation enables Compose source information without changing the application's build.
When displaying last-build classes, outlines may arrive after the background compiler warms.
Source navigation pauses during edits or failed builds so retained images cannot open stale source ranges.

These are design-time snapshots, not interactive animation/click simulation or in-process Live Edit. Each render
loads fresh project classes into the retained rendering runtime. Components requiring device services, application initialization or unsupported native libraries
need preview-specific sample data, as with other layoutlib-based tools. Workspace trust is required: previews
execute project code in a local JVM, not a security sandbox.

For editor analysis, sync passes the Compose compiler plugin shipped with the installed JetBrains Kotlin LSP,
not the build compiler's potentially incompatible plugin. If it is missing, update/install that extension and
sync again; Elide's output channel identifies the missing plugin.

#### Dagger and Hilt

Use the experimental Elide `feat/android` branch. Put `dagger-compiler` or `hilt-compiler` in
`dependencies.maven.processors`, keeping its version aligned with the runtime dependency. Kotlin processing
requires a managed Kotlin toolchain or an external distribution containing kapt; it is not KSP execution.
Set `android.hilt = true` for Hilt's Android superclass/lifecycle transformation; plain Dagger needs no Hilt flag.

Sync runs available `compile-java-<sourceSet>` targets for processor/Hilt projects, including Kotlin's kapt
pass, then imports `.dev/jvm/generated-sources/<sourceSet>/java` and `/kapt`. Empty source sets do not request
nonexistent compile targets. Kapt stubs are excluded. Source changes regenerate these declarations on the next
build/sync. A failed generation is reported as a synchronization warning rather than hidden.

Workspace libraries containing Hilt bindings also need the processor. Their generated classes and aggregation
metadata are available to the consuming application. Dynamically delivered code uses Dagger component
dependencies against the base app's Hilt entry points, not feature-owned bindings in the base component.

#### Multi-module applications and dynamic features

Reusable Android libraries remain workspace projects publishing `AndroidAar` artifacts; sync connects their
source modules to consuming apps. Dynamic features are separate source sets **inside the app project**:

- Add their artifact names to the base `AndroidAab.features`.
- Declare each as `AndroidFeature`, with `base` naming that AAB, a `title` resource in the base,
  its own `sources` and `manifestFile`, and explicit resource/asset/native-library directories.
- Use `delivery = "install-time"` or the default `"on-demand"`. For feature-to-feature dependencies, declare
  `featureDependencies` and matching source-set `dependsOn` edges to the base and required features.

The base and features must have disjoint source sets and distinct manifest packages for their `R` namespaces.
The base owns shared Maven/workspace libraries; feature dex and resources stay in their own bundle modules.
Install-time features remain removable splits so dependent features can reference them. Install the AAB with
bundletool or Play Feature Delivery: a feature module is not a standalone runnable APK, and APK Run/Debug
does not download on-demand splits. Requires the experimental `feat/android` Elide branch.

#### Logcat

**Elide: Show Android Logcat** (also in the Android tree and device context menu) streams the SDK's real
`adb logcat` into an output channel per project, without asking to confirm filters. The project is the application
you are editing, else the Android deployment target's; the device and application are the deployment target's, else
the only ready device and the application the project builds. The application ID is read from the built APK, so a
renamed variant (`--rename-manifest-package`) matches what is installed. When several variants exist and none is the
deployment target, the one installed on the device is used; only a genuinely ambiguous project, device or
application is offered as a choice. A new stream shows Info and above; showing a running stream again reveals it
without restarting.

Each record is aligned into time, PID-TID, tag, priority and message columns; lines continuing the same record
(stack traces, multi-line messages) are indented under one header. The theme colors priorities (errors, warnings,
info, debug), tags, exception names, `Caused by:` headings, application frames against dimmed framework frames,
URLs and quoted strings.

**Filter Android Logcat**, **Stop Android Logcat**, and **Restart Android Logcat** control that stream.
**Clear Android Logcat Output** clears only the editor channel, never the device's shared log buffers.
Restarting or changing filters replays the device's available buffer. Application filtering uses the installed
UID, so it follows process restarts and secondary processes; apps sharing that UID also share the filtered logs.
The device must support `logcat --uid`. Removing the project or closing the extension stops its adb clients.

Ctrl/Cmd-click an application stack frame to open its Kotlin/Java source line, including workspace-library
frames, nested classes and Kotlin file facades. Resolution uses the synced source roots, package and filename;
unknown/native frames, out-of-range lines and ambiguous same-package filenames remain unlinked. Source-index
caches are invalidated when projects or source files change. Obfuscated release traces still need their R8
mapping; the links do not retrace obfuscated names.


## Links

- [Repository, full documentation, and issues](https://github.com/elide-dev/vscode)
- [Changelog](https://github.com/elide-dev/vscode/blob/main/packages/vscode/CHANGELOG.md)
- [Elide documentation](https://docs.elide.dev)

Licensed under the [MIT license](https://github.com/elide-dev/vscode/blob/main/LICENSE).
