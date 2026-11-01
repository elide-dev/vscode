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
  `elide test --reporter=tap` with live results, failure messages and stack-trace locations. **Run with Coverage**
  shows the run's LCOV and JaCoCo XML reports in the editor's coverage gutter and Test Coverage view.
- **Elide sidebar.** An activity-bar view with each project's entrypoints, tasks, build targets (`elide build
  --inspect`), source sets and dependencies; run, debug, build and sync straight from the tree.
- **Activity.** The sidebar's **Activity** view lists every sync live: manifest reads, dependency installation,
  classpath resolution and workspace writes, plus the commands and tasks reported in Elide's text output.
  Each step has its duration and output; skipped tasks include their reason. Rows open timestamped logs in an
  editor, and running operations can be cancelled. The status bar names the current step and elapsed time.
- **New project wizard.** `Elide: New Project…` lists the templates of the installed CLI (`elide init --templates`),
  asks for the parameters that template declares, generates the project and opens it.
- **Android SDK tools.** Inspect an independently installed SDK and connected devices, and stream Logcat with
  application, priority and text filters and clickable Kotlin/Java source frames. No Elide Android model is required.
- **Compose editor analysis.** Compose runtime dependencies or declared Kotlin Compose compiler plugins enable
  the Kotlin LSP's matching compiler plugin and suppress `FunctionName` warnings only on `@Composable` functions.
- **Debugging.** Launch `elide run --debugger` and attach with breakpoints in Kotlin and Java, or build a
  Native Image artifact and debug the binary it produced under GDB.

## Requirements

| | |
| --- | --- |
| [Elide](https://elide.dev) **1.5+** | Found via `elide.home`, `$ELIDE_HOME`, the platform install locations, or `PATH`. **1.6.1+** resolves a project's classpaths in one call; older releases sync with one call per classpath. |
| **Kotlin by JetBrains** (`JetBrains.kotlin-server`, ≥ 0.0.11) | Installed automatically as a companion extension. Complete its one-time region / data-sharing prompt for Kotlin/Java analysis and JVM debugging. |
| A JDK | `$JAVA_HOME`, SDKMAN, `/Library/Java/JavaVirtualMachines`, `/usr/lib/jvm`, or `elide.jdk.home`. Elide's bundled JDK image cannot be used for symbol resolution: it ships without a `release` file. |
| An Android SDK, for device tools only | `elide.android.sdk`, `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, or the conventional SDK location on this platform. Install the SDK independently. |

Elide activates independently of the Kotlin language server: sync, build and environment diagnostics
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
| `Elide: Show Activity` | Reveal the **Activity** view: syncs, step by step, with durations. |
| `Elide: Open Activity Log` | Open the latest operation's output, with timestamps, in an editor. |
| `Elide: Check Android Environment` | Inspect the installed SDK, platform-tools and connected devices, without requiring sync. |
| `Elide: Show Android Logcat` | Open a filtered device log stream; Filter, Clear, Stop and Restart commands manage it. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `elide.home` | `""` | Distribution root containing `bin/elide`. |
| `elide.jdk.home` | `""` | JDK for symbol resolution; else `jvm.javaHome`, `$JAVA_HOME`, installed JDKs matching `jvm.target`. |
| `elide.sync.onStartup` | `true` | Sync when the workspace opens. |
| `elide.sync.onManifestChange` | `"prompt"` | `always` / `prompt` / `never` when `elide.pkl`, a local Pkl module it imports, amends or extends, or the lockfile changes. |
| `elide.sync.showProgressNotification` | `true` | Show a notification with the step in progress and a Cancel button while a sync runs for more than two seconds. |
| `elide.kotlinLsp.writeWorkspaceJson` | `true` | Write `<folder>/workspace.json`. |
| `elide.install.classifiers` | `["sources"]` | Classifiers installed for declared Maven packages (`sources`, `docs`); empty installs classes only. Elide's own Kotlin/JUnit jars have none. |
| `elide.flags` | `[]` | `-f NAME[=VALUE]` build flags for every Elide invocation, project sync included. |
| `elide.build.options`, `elide.run.options`, `elide.test.options`, `elide.install.options` | `{}` | Default CLI options per command. |
| `elide.debug.adapter` | `"intellij"` | Attach with the JetBrains JVM debugger (`intellij`) or Debugger for Java (`java`). |
| `elide.debug.nativeMiMode` | `"auto"` | Debugger an `elide-native` session drives: `gdb`, `lldb`, or `auto` (a GDB on `PATH`, else LLDB on macOS). |
| `elide.debug.miDebuggerPath` | `""` | `gdb` / `lldb-mi` binary for `elide-native` sessions; empty resolves `gdb` on `PATH`. |
| `elide.android.sdk` | `""` | SDK root for diagnostics and Logcat; empty uses environment and conventional SDK locations. |

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

### Android SDK tools

Android application builds, deployment, emulator management, Compose previews and generated Android/Hilt editor
models depend on unreleased runtime capabilities and are not included.

**Check Android Environment** inspects the installed SDK, platform-tools and connected-device state. It works in
an ordinary source folder without `elide.pkl`, never installs SDK components or accepts licenses, and writes the
full report to **Elide Output**.

### Compose editor analysis

For editor analysis, sync passes the Compose compiler plugin shipped with the installed JetBrains Kotlin LSP,
not the build compiler's potentially incompatible plugin. If it is missing, update/install that extension and
sync again; Elide's output channel identifies the missing plugin.

The Kotlin LSP's `FunctionName` inspection ("Function name should start with a lowercase letter") is suppressed on
`@Composable` functions, as in Android Studio. For Compose projects, sync builds a small language-server plugin
against the installed JetBrains Kotlin LSP (cached in Elide's global storage), lists it as `-Dplugin.path` in the
user setting `intellij.additionalJvmArgs` (other entries are kept) and relaunches the server once so it applies.
Other functions with capitalized names are still reported.

### Logcat

**Show Android Logcat** selects an open workspace folder and a connected device, then streams all applications at
Info and above. No `elide.pkl` or successful sync is required. **Filter Android Logcat** accepts a manually entered
application ID or reads one from an existing APK, including renamed application IDs. Showing a running stream
reveals it without restarting.

Each record is aligned into time, PID-TID, tag, priority and message columns; lines continuing the same record
(stack traces, multi-line messages) are indented under one header. The theme colors priorities (errors, warnings,
info, debug), tags, exception names, `Caused by:` headings, application frames against dimmed framework frames,
URLs and quoted strings.

**Filter Android Logcat**, **Stop Android Logcat**, and **Restart Android Logcat** control that stream.
**Clear Android Logcat Output** clears only the editor channel, never the device's shared log buffers.
Restarting or changing filters replays the device's available buffer. Application filtering uses the installed
UID, so it follows process restarts and secondary processes; apps sharing that UID also share the filtered logs.
The device must support `logcat --uid`. Removing the workspace folder or closing the extension stops its adb clients.

Ctrl/Cmd-click an application stack frame to open its Kotlin/Java source line, including workspace-library
frames, nested classes and Kotlin file facades. Resolution uses synced roots and ordinary unsynced workspace folders, package and filename;
unknown/native frames, out-of-range lines and ambiguous same-package filenames remain unlinked. Source-index
caches are invalidated when projects or source files change. Obfuscated release traces still need their R8
mapping; the links do not retrace obfuscated names.


## Links

- [Repository, full documentation, and issues](https://github.com/elide-dev/vscode)
- [Changelog](https://github.com/elide-dev/vscode/blob/main/packages/vscode/CHANGELOG.md)
- [Elide documentation](https://docs.elide.dev)

Licensed under the [MIT license](https://github.com/elide-dev/vscode/blob/main/LICENSE).
