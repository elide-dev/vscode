# Elide for Visual Studio Code

[![CI](https://github.com/elide-dev/vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/elide-dev/vscode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/elide-dev/vscode/blob/main/LICENSE)

VS Code integration for the [Elide](https://elide.dev) build tool. Any folder containing an `elide.pkl` manifest
becomes a real project: resolved dependencies and source roots are handed to a Kotlin language server — the
[JetBrains Kotlin LSP](https://marketplace.visualstudio.com/items?itemName=JetBrains.kotlin-server) by default, or
the experimental native Komodo language server installed on demand by Elide (`elide.kotlinLsp.server`) — and Elide's build, run,
test, and debug commands are available from the editor.

## Features

- **Project sync.** Opening a folder with `elide.pkl` resolves the manifest, installs dependencies when the lockfile is
  stale, and reads the compile classpath of every source set. Modern Elide's resolved source export supplies
  conventional roots such as `src/main/kotlin` for all members in one call, while retaining explicit selectors.
  Manifests nested inside another project (vendored checkouts, samples) are separate builds and are not imported,
  unless that project declares them as workspace members.
- **Multi-project workspaces.** A manifest declaring `workspace.members` is synced as one build: a single install at
  the root, then every member's own source sets, classpath and JDK. A member consuming a sibling's artifact with
  `project("name")` depends on the sibling's modules, along with any siblings that artifact brings in the way Elide
  resolves the classpath, so code intelligence works across the workspace without first publishing those artifacts. Each member
  is also a project of its own in the sidebar (nested under the root), the Test Explorer, tasks, code lenses and
  debug configurations. Editing any member's manifest reloads the workspace. `Elide: Add Workspace Member…` generates
  a new member from a template and declares it in the root's manifest as it stands when the wizard finishes — edits
  made meanwhile, unsaved ones in an open editor included, are kept and saved with it, and the declaration can be
  undone in that editor; opening a member's directory on its own offers to open the workspace root instead, since
  only the root resolves the siblings it depends on.
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
- **Activity.** The sidebar's **Activity** view lists every sync and Compose preview build of the window, live
  while it runs: each step (reading the manifest, installing dependencies, resolving classpaths, generating
  resources, writing `workspace.json`), the `elide` commands it ran, and the build tasks those reported, each with
  its duration and share of the whole; a task Elide skipped is listed with the reason, such as `Up to date`, since its
  check takes time too. With Elide 1.6.1 or newer, tasks appear as they start, with the progress they
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
  Compose component previews render locally without a device or emulator, as layoutlib snapshots or, with the
  experimental Komodo engine, as live cards, and refresh while editing. Logcat streams have
  application, priority and text filters. Dagger/Hilt generated sources are included in editor synchronization.
- **Debugging.** Launch `elide run --debugger` and attach with breakpoints in Kotlin and Java, debug an Android
  application on the device it was installed on, or build a Native Image artifact and debug the binary it produced
  under GDB.

## Requirements

| | |
| --- | --- |
| [Elide](https://elide.dev) **1.5+** | Found via `elide.home`, `$ELIDE_HOME`, the platform install locations, or `PATH`. **1.6.1+** reports live task progress and resolves a project's classpaths in one call; older releases sync with one call per classpath and show tasks once they finish. |
| **Kotlin by JetBrains** (`JetBrains.kotlin-server`, ≥ 0.0.11), for the default language server | Install it from the Marketplace and complete its region/data-sharing prompt. Not needed with Komodo, which requires an Elide release supporting on-demand component resolution. |
| A JDK | `$JAVA_HOME`, SDKMAN, `/Library/Java/JavaVirtualMachines`, `/usr/lib/jvm`, or `elide.jdk.home`. Elide's bundled JDK image cannot be used for symbol resolution: it ships without a `release` file. |
| An Android SDK, for Android projects | `android.sdk` in the manifest, `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, or where the SDK installs itself on this platform. `Elide: Install Android SDK Components` installs what a build is missing. |

Elide activates independently of the Kotlin language server: sync, build, layoutlib previews and environment diagnostics
remain available while it starts or if it is unavailable. Komodo-dependent features require compatible live native services. Opening an Elide Kotlin or Java source document starts
the JetBrains companion when its folder uses it, including Java-first projects. The extension contributes the
`kotlin` language itself (`.kt`, `.kts`: comments, brackets, indentation, a TextMate grammar), so Kotlin files are
highlighted without the JetBrains extension.

The extension needs a trusted workspace and a local filesystem — syncing runs the workspace's Elide CLI.

## Getting started

1. Open a folder containing `elide.pkl`. While it syncs, the status bar names the step in progress and the time
   so far; a sync that takes more than a couple of seconds also shows a cancellable notification. Click the status
   bar item for the Elide actions, or open the **Activity** view to see where a sync's time went. When Elide rejects
   the manifest, the notification carries its message and location, and the error is marked in `elide.pkl` (or the
   local Pkl module it is in) until the next successful sync.
2. Open a Kotlin or Java file. Once the Kotlin LSP has imported the generated `workspace.json`, completion and
   navigation resolve against the project's dependencies.
3. Open the **Elide** view in the activity bar to run entrypoints, tasks and build targets, or press F5 with an
   `elide` launch configuration to debug. `Elide: Run Elide Command…` does the same from the command palette.

   The **Get started with Elide** walkthrough (Help → Get Started) covers the same ground step by step.

Sync writes one file into the project: the generated `workspace.json` at the folder root, which is the only place
the Kotlin LSP imports it from without a project setting. In a Git clone where it would show up as untracked, the
extension offers once to add it to that clone's `.git/info/exclude` (never committed; nothing is written unless you
accept); add it to `.gitignore` instead to cover every clone.

## Commands

| Command | Description |
| --- | --- |
| `Elide: Sync Project(s)` | Re-run the sync. |
| `Elide: Show Menu` | Quick pick with the Elide actions (what the status bar item opens). |
| `Elide: Run Elide Command…` | Pick `build`, `test`, `install` or `run <entrypoint>` and run it as a task, or run, debug or test an Android APK on the deployment target. |
| `Elide: New Project…` | Create a project from an Elide template in a directory you pick. |
| `Elide: Add Workspace Member…` | Create a project inside an existing one and declare it in `workspace.members`. |
| `Elide: Open Generated Kotlin LSP Workspace` | Open the generated `workspace.json`. |
| `Elide: Show Output` | Open the `Elide` output channel. |
| `Elide: Show Activity` | Reveal the **Activity** view: syncs and preview builds, step by step, with durations. |
| `Elide: Open Activity Log` | Open the latest operation's output, with timestamps, in an editor. |
| `Elide: Select Android Deployment Target…` | Choose the remembered project, APK and device shared by Run and Debug. |
| `Elide: Check Android Environment` | Inspect local tools and device readiness, including before sync succeeds; select a finding for fixes. |
| `Elide: Refresh Android Devices` | Refresh devices without a project resync. |
| `Elide: Pair Android Device over Wi-Fi…` | Pair with a QR or six-digit code; discover wireless devices or connect an already-paired device by address. |
| `Elide: Run Android App…` | Build an APK and install and launch it on a device or the emulator. |
| `Elide: Debug Android App…` | Build an APK, install and launch it waiting for a debugger, and attach over JDWP. |
| `Elide: Run Android Instrumented Tests…` | Install a test APK on the deployment target's device and run its instrumented tests, with results in the Test Explorer. |
| `Elide: Start Android Emulator` / `Elide: Stop Android Emulator` | Boot the project's AVD, or shut it down; a device row's **Stop** stops that emulator only. |
| `Elide: Create Android Virtual Device` | Create the AVD `android.device` declares, without booting it. |
| `Elide: Install Android SDK Components` | Install the SDK components the pipeline is missing (`--install-sdk` accepts their licenses). |
| `Elide: Create Android Signing Keystore` | Mint the keystore an APK or app bundle signs with, using the Android debug conventions. |
| `Elide: Open Compose Preview` | Render the Kotlin file's Compose previews beside the source: layoutlib snapshots by default, live cards with the experimental Komodo engine. |
| `Elide: Copy Compose Preview MCP Server Configuration` | Copy the JSON an MCP client needs to reach this window's [Compose preview tools for agents](#compose-previews-for-ai-agents-mcp) (URL and access token). |
| `Elide: Close Agent Compose Preview Sessions` | Cancel in-flight agent renders and end live sessions agents left open; the preview panel resumes. |
| `Elide: Show Android Logcat` | Open a filtered device log stream; Filter, Clear, Stop and Restart commands manage it. |
| `Elide: Explore Android Databases` | Browse and query a debuggable app's Room / SQLite databases on a connected device. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `elide.home` | `""` | Distribution root containing `bin/elide`. |
| `elide.jdk.home` | `""` | JDK for symbol resolution; else `jvm.javaHome`, `$JAVA_HOME`, installed JDKs matching `jvm.target`. |
| `elide.sync.onStartup` | `true` | Sync when the workspace opens, or when the folder is added to it. |
| `elide.sync.onManifestChange` | `"prompt"` | `always` / `prompt` / `never` when `elide.pkl`, a local Pkl module it imports, amends or extends, or the lockfile changes. |
| `elide.sync.showProgressNotification` | `true` | Show a notification with the step in progress and a Cancel button while a sync runs for more than two seconds. |
| `elide.kotlinLsp.writeWorkspaceJson` | `true` | Write `<folder>/workspace.json` for the JetBrains server; never for a Komodo folder. |
| `elide.kotlinLsp.server` | `"jetbrains"` | `komodo` (experimental) replaces the JetBrains server for the folder with Komodo's native language server. See below. |
| `elide.kotlinLsp.komodo.path` | `""` | Absolute executable override for a developer build. Empty delegates to Elide's resolver; no bundled/PATH search. Invalid overrides are never replaced. |
| `elide.kotlinLsp.komodo.pluginDirectory` | `""` | Developer compiler-plugin override. Empty uses the managed bundle's directory or an explicit developer executable's own plugins. |
| `elide.kotlinLsp.komodo.javaHome` | `""` | Developer JDK input override. Empty uses Elide's resolved JDK inputs; an explicit developer executable instead inherits `JAVA_HOME`. |
| `elide.kotlinLsp.komodo.maxHeap` | `""` | Native heap cap (`768m`, `1g`); empty leaves Komodo's default. |
| `elide.install.classifiers` | `["sources"]` | Classifiers installed for declared Maven packages (`sources`, `docs`), by sync and the `install` task (`--slim --with …`); empty installs classes only. Elide's own Kotlin/JUnit jars have none. |
| `elide.flags` | `[]` | `-f NAME[=VALUE]` build flags for every Elide invocation, project sync included. |
| `elide.build.options`, `elide.run.options`, `elide.test.options`, `elide.install.options` | `{}` | Default CLI options per command. |
| `elide.debug.adapter` | `"intellij"` | Attach with the JetBrains JVM debugger (`intellij`), Debugger for Java (`java`) or Komodo's Kotlin debugger (`komodo`). Unset, a Komodo folder uses `komodo`. |
| `elide.debug.nativeMiMode` | `"auto"` | Debugger an `elide-native` session drives: `gdb`, `lldb`, or `auto` (a GDB on `PATH`, else LLDB on macOS). |
| `elide.debug.miDebuggerPath` | `""` | `gdb` / `lldb-mi` binary for `elide-native` sessions; empty resolves `gdb` on `PATH`. |
| `elide.codeLens.enabled` | `true` | Run/Debug code lenses above JVM `main` functions and on entrypoints, scripts and artifacts in `elide.pkl`. |
| `elide.android.sdk` | `""` | SDK root the device list is read from; empty resolves the one the build would use. |
| `elide.android.emulatorWindow` | `true` | Boot the emulator with a window; off passes `--no-window`. |
| `elide.android.composePreview.prewarm` | `true` | Start the Compose preview backend when a file with `@Preview` functions is focused. |
| `elide.android.composePreview.keepAliveMinutes` | `10` | Minutes an unused Compose preview backend stays warm; `0` stops it with its panel. |
| `elide.android.composePreview.engine` | `"layoutlib"` | `komodo` (experimental) renders live cards inside the workspace's Komodo language server: unsaved Kotlin edits, clicks, keyboard input, compile errors in Problems, and **Inspect** for runtime layout bounds. Requires `elide.kotlinLsp.server` = `komodo`; no fallback to `layoutlib`. See [Komodo Compose preview engine](#komodo-compose-preview-engine-experimental). |
| `elide.android.composePreview.mcp.enabled` | `true` | Serve the Compose preview to AI agents over MCP (loopback HTTP, token-protected). See [Compose previews for AI agents](#compose-previews-for-ai-agents-mcp). |

In a multi-root workspace each folder can set its own value of every setting except
`elide.sync.showProgressNotification`, `elide.android.emulatorWindow` and the `elide.android.composePreview.*`
settings, which apply to the whole window, and `elide.kotlinLsp.komodo.*`, read for the window: it runs one Komodo
server.

The extension also maintains two Kotlin LSP settings, and explicit values you set by hand are never overwritten:

- `intellij.buildTool` is pinned to `json` in workspace settings, which creates `.vscode/settings.json`, only when the
  folder also holds another build's files (`pom.xml`, `build.gradle[.kts]`, `settings.gradle[.kts]`, `.idea`,
  `MODULE.bazel`, `WORKSPACE[.bazel]`) that the server's auto-detection would import instead of `workspace.json`.
- `intellij.jdkForSymbolResolution` is the project JDK's real path (symlinks such as SDKMAN's `current` resolved),
  written to user settings only, since a committed absolute path breaks other checkouts. The server reads one JDK
  for the window: in a multi-root window it is that of the first folder whose projects it imports.

### Komodo language server (experimental)

Komodo is an optional native Kotlin language server, debugger and live Compose preview engine managed by Elide. It is
opt-in; the JetBrains Kotlin LSP stays the default. To use it, set:

```jsonc
"elide.kotlinLsp.server": "komodo",               // per folder: Kotlin language server and debugger
"elide.android.composePreview.engine": "komodo"   // optional, window-wide: live Compose previews
```

Leave executable, plugin and JDK overrides empty for managed use. The selected Elide CLI runs
`elide komodo resolve --json` without downloading or installing anything. If Komodo is missing, choose
**Install Komodo** from the notification, or run **Elide: Install Komodo** from the Command Palette.
That explicit action runs Elide's installer with progress and cancellation, resolves the installed identity,
and resyncs Komodo folders. Declining or failing installation leaves the feature unavailable; it never changes
engines. Ordinary Elide installs and default JetBrains/layoutlib use do not acquire Komodo.
Older Elide versions remain usable for existing features but need an upgrade for managed Komodo.
Elide validates supported platforms, compatible protocols, JDK inputs and trusted artifact checksums.

Missing, incompatible or failed Komodo disables its native analysis and debugger at runtime: Activity reports a
`disabled` detail, while the rest of project sync succeeds and the resolved models remain usable for builds.
The extension stops stale native services and debug sessions, withdraws Komodo debug actions, and blocks new
dependent operations. Preferences are never rewritten, no replacement engine is selected, and nothing downloads
without **Install Komodo**. Fix the component or explicit override and sync again; installing or changing its
settings also rechecks availability without a window reload.

Compatibility uses Elide's schema/protocol metadata and the live LSP initialize response, followed by a successful
project reload. Developer overrides also negotiate DAP initialization before enabling debugging. An executable
file or version banner alone is not proof of compatibility; no guessed version cutoff is used. A `komodo.project`
load error disables native services just like a failed start or reload. Managed preview protocol/capability metadata
is retained for preview consumers, independently of native analysis/debug compatibility.

With `elide.kotlinLsp.server` set to `komodo`, `komodo` is the folder's Kotlin language server. Each sync writes a
Komodo project manifest into the extension's storage (nothing in the project: no `workspace.json`) and starts the
server, or makes it reload the manifest without a restart. One server serves the whole window: every Komodo
folder's projects go into one manifest. The server keeps one analysis session over the folders' source sets and
workspace members, unsaved text included. A rejected server start or reload disables native services in Activity;
it does not fail unrelated sync steps, discard resolved build models or report `reloaded`. When ready, the server answers:

- diagnostics of the compiler and its extended checkers (pulled per file: the edited file first), quick fixes
  (missing imports, overrides, types, Compose annotations…), organize imports and generated members;
- completion with auto-import and snippets, signature help, hover with KDoc, inlay hints;
- Go to Definition / Type Definition / Implementation (into Java sources such as Room's kapt output too), Find
  References, highlights, rename across modules (and `package` updates when a file moves), call and type hierarchies,
  "N references" / "N implementations" code lenses, document and workspace symbols, folding and selection ranges;
- formatting with ktfmt (document, range, on type);
- semantic tokens, with `composable` (a `@Composable` function or call), `extension` and `mutable` modifiers. The
  extension colours composable calls green by default (`editor.semanticTokenColorCustomizations`, rule
  `function.composable:kotlin`; your own value of that setting replaces it), and maps the modifiers to TextMate
  scopes (`entity.name.function.composable.kotlin`, …) for themes that style them.

Navigation keeps working while a file has errors. A library declaration opens read-only from its `-sources.jar`
(`elide.install.classifiers` installs them for declared Maven packages), or as signatures rendered from the class
files when there are none; these documents have `komodo-library:` URIs and are served by the server
(`komodo/libraryContent`), never synchronized with it. Library items of a type or call hierarchy carry `jar:` URIs that
VS Code cannot open.

**Runtime.** `komodo` is a native executable: it does not start a JVM, and it ships its libraries and compiler plugins
beside it in its managed component bundle; keep that directory together. It compiles with its own pinned Kotlin
compiler and applies its bundled Compose and kotlinx.serialization plugins to modules whose classpath has their
runtime (`elide.kotlinLsp.komodo.pluginDirectory` overrides them); `elide.kotlinLsp.komodo.maxHeap` caps its heap.
Missing components offer an explicit installation action; invalid developer overrides must be fixed or cleared.

**Coexistence with the JetBrains extension.** The JetBrains extension is not required and no longer installed with
this one. A Komodo folder gets no `workspace.json` and never starts the JetBrains server, but the JetBrains extension
activates itself on any Kotlin file when it is enabled, and then both servers analyze the folder (errors and
completions twice); the extension says so once and offers to show the JetBrains extension, so you can disable it for
the workspace. Both extensions contribute the `kotlin` language and a `source.kotlin` grammar: VS Code merges the
language contributions, and with both installed (JetBrains.kotlin-server 0.0.13, VS Code 1.142) it applies this
extension's grammar; semantic tokens from either server are drawn on top of it.

**Debugging.** The JetBrains debugger runs inside the JetBrains server, so a Komodo folder attaches with Komodo's own
Kotlin debugger (debug type `komodo-kotlin`) unless `elide.debug.adapter` says otherwise. It is served by the same
executable as the language server (`komodo --dap`, with the folder's Komodo project manifest and JDK inputs) and
maps the JVM's source paths (`pkg/File.kt`) to the manifest's source roots, so line breakpoints bind in Kotlin and Java
files, with conditions, hit counts and log points; it breaks on caught and uncaught exceptions, shows stack and
variables (which it can set), evaluates expressions and steps. Debugging needs the folder's sync to have written the
manifest: a launch before that says so instead of starting Elide. The JetBrains extension is not needed for any of it.
On Android, binding asks only the project's own classes for source mappings, so the first breakpoint stops about a
second after attach.
`elide.debug.adapter` = `java` attaches with Debugger for Java instead, which cannot bind line breakpoints in Kotlin
files (it maps a breakpoint to a class by parsing the file as Java). A `komodo-kotlin` configuration of your own can
also attach to any JDWP port (`hostName`, `port`, `timeout`, `sourceRoots`) or launch a main class (`mainClass`,
`classPaths`, `vmArgs`, `args`, `cwd`, `env`, `javaHome`) in a Komodo folder.

A folder opened through a symlinked path is not matched to the manifest's paths.

### Komodo Compose preview engine (experimental)

With `elide.android.composePreview.engine` set to `komodo` (and the folder on Komodo's language server), **Elide:
Open Compose Preview** renders every card live inside that same `komodo` process, compiled from the language
server's own analysis: no separate preview compiler or renderer JVM. It uses the same verified layoutlib runtime the
`layoutlib` engine downloads on first use. Unsaved Kotlin edits of the
previewed file and the files it uses reach the cards as you type; clicks run their handlers; `@PreviewParameter`
providers expand into one card per value; compile errors appear in the Problems view and on the cards, which recover
once the code compiles again. A card Komodo cannot render says why. There is no fallback to the `layoutlib` engine:
a `komodo` too old for the engine says so. The project's resources and library classes come from the last Elide
build, which the panel runs as with `layoutlib`; Java and resource changes need a save. A save that rebuilds the
project starts a new session over the new build's classes.

Missing or incompatible Komodo automatically disables native previews **at runtime**, leaving engine and language
server settings unchanged. Opening a panel, prewarming and MCP rendering check availability before project builds or
compiler/runtime preparation; a native session also validates its protocol handshake before those operations.
Availability loss closes native panels, cancels pending renders and retires live agent sessions and idle native
backends, so obsolete frames or queued interactions cannot be returned. Layoutlib previews and ordinary project
builds remain independent. There is no automatic Komodo download or renderer fallback.

A protocol/capability incompatibility stays disabled rather than retrying builds on each edit. Use **Elide: Install
Komodo**, fix the executable/configuration or sync to recheck it. Once compatible, reopen the panel or render a new
agent session without reloading the window; old session IDs are intentionally retired.

**Inspect** outlines each card's composable calls (`Text`, `Column`, your own composables) by their measured runtime
layouts; select them by pointer or arrow keys, read their size and image-pixel position, and choose **Open source**,
double-click or press Enter to open the call in the file Komodo compiled. Only calls located in the project's sources
are offered; library internals are omitted. Bounds and call sites follow each frame through edits and recovery,
including calls an edit above them moved. The **Parent** control selects the enclosing call by containment of
measured bounds. Calls inside another workspace module come from Elide's build of it and are located only when that
build recorded Compose source information, which Elide does for modules a debug Android app (`release = false`)
uses and leaves out of release builds. Rebuild after switching; calls without a location still show their bounds.

**Keyboard input.** Click or Tab to a live card's canvas to focus it, then type into its Compose controls. Only that
card receives keys (with Shift/Ctrl/Alt/Meta and repeat): text input, Backspace/Delete, arrows, Enter, and Tab between
Compose controls. Press **F6** or **Shift+F6** (VS Code's **Focus Next/Previous Part**) or click outside the canvas to
leave; Escape still reaches Compose. Leaving the canvas or window, switching cards, enabling **Inspect**, or closing
the panel releases held keys. IME composition and clipboard paste are not supported, and only characters Android's
hardware-key input can represent can be typed.

Known limits: the project's own Kotlin compiler arguments and compiler plugin versions are not applied (Komodo's
pinned Kotlin and bundled plugins are), and code Komodo cannot compile yet shows as "the program does not compile"
with Komodo's message.

## Tasks and debugging

Task type `elide` takes `command` (`build` | `run` | `test` | `install`), `project` (project root relative to the
workspace folder) and the invocation itself: `args` (positional arguments), `flags` (`-f NAME[=VALUE]` build flags),
`options` (CLI options as a name/value object), `programArgs` (arguments after `--`) and `env`. Workspace defaults
come from `elide.flags` and `elide.build.options` / `elide.run.options` / `elide.test.options` /
`elide.install.options`; a definition overrides them per key. The `install` task also takes `elide.install.classifiers`
as its `slim` and `with` options, so it fetches what sync does.

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

The session VS Code shows is that attach, so a configuration's `postDebugTask` runs when it ends. `preLaunchTask`
is not run for `elide` and `elide-android` configurations that start Elide: VS Code runs it only for a configuration
that it launches itself, and these hand over to the attach session once Elide listens. Run such a task before the
launch. An `elide-android` configuration with `port` builds nothing, and runs both tasks around its attach.

A JetBrains debug session analyzes the program with the workspace the Kotlin language server holds when the session
starts, for as long as it runs: one started before the server has imported `workspace.json` skips breakpoints, and
one started while it is still indexing cannot evaluate expressions. Every Elide debug session — launch
configurations, build-target and code-lens Debug, Test Explorer Debug and Android debugging — therefore attaches
only once the server has imported the project and finished indexing; the Elide process waits meanwhile, and a
notification with **Cancel** shows when that takes longer than a moment. Cancelling ends the launch.

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
| An `AndroidApk` artifact | `elide build <artifact>` to package it; **Run** installs and launches it with `elide build android-run-<artifact>`, pinned to the picked device with `--device=<serial>`; **Debug** does the same through `android-debug-<artifact>` and attaches over JDWP, for a debuggable APK (see below); **Run Instrumented Tests** runs `android-test-<artifact>` on the deployment target for an APK carrying instrumentation (`instrumentation` in `elide.pkl`, or `<instrumentation>` in its manifest). Each action is offered only when Elide lists its target: none is listed for an APK Elide cannot install, such as an unsigned one, whose row and code lens then only build it. |
| An `AndroidAab` artifact | `elide build <artifact>`, which publishes `.dev/artifacts/<artifact>.aab`. |
| An `AndroidAar` artifact | `elide build <artifact>`, which publishes `.dev/artifacts/<artifact>.aar`. |
| An `AndroidFeature` module | `elide build android-module-<feature>`, staging `.dev/android/<feature>/<feature>.zip`. Its row identifies the base bundle, delivery mode and required features; build the owning AAB to publish it. |
| The mapping of a minifying artifact | A row beside an artifact with `minify = true`, which opens the `.dev/artifacts/<name>-mapping.txt` R8 published, publishing it with `android-mapping-<artifact>` first when it is not there: without it a stack trace from a shrunk build cannot be read. |
| **Devices** | `adb devices` of the resolved SDK; a row in the `device` state runs an APK of that workspace on that serial — the active file's app, else the selected one, else its first — and an emulator's row stops that emulator (`android-emulator-stop --device=<serial>`). |
| **Start emulator** / **Stop emulator** / **Create AVD** | `android-emulator` (with `--no-window` when `elide.android.emulatorWindow` is off), `android-emulator-stop`, `android-avd`. **Stop emulator** stops the emulator running the project's AVD and leaves every other emulator running. |
| **Install Android SDK components** | `android-sdk --install-sdk`, shown when no SDK was found. |

Every other Android step — `android-resources-*`, `android-link-*`, `android-dex-*`, `android-r8-*`,
`android-sign-*`, `android-bundle-*` — is listed under **Build targets** like any other target of the project. A
target there that installs onto a device (it takes `--device`: `android-run-*`, `android-debug-*`, `android-test-*`)
runs on the deployment target's device, resolved as **Run** resolves it, rather than on whichever device Elide would
pick. Targets Elide gives no description, its internal ones, are grouped under **Other targets**.

A published `.aar` dependency appears under **Dependencies** named by its coordinate, with the sources of the
archive attached: Elide unpacks each one into `.dev/android/libraries/<group>/<artifact>/<version>/` and compiles
against the `classes.jar` inside it, and a sync unpacks what is missing so symbols resolve before the first build.

Two more entries appear there for an Android project: the **Android API `<level>` platform** (the `android.jar`
every Android source compiles against) and the **Android resources of `<artifact>`** (the generated `R`). Neither
is on the compile classpath — the device carries the framework and the APK's dex carries `R` — so a sync reads
them from the provided classpath, and generates the `R` classes it does not find with `android-r-<artifact>`.
Classes left on disk that Elide's build state no longer records (state lost, or a build stopped mid-way) are
generated again the same way rather than left out.

An Android application is debugged on the device: an `elide-android` launch configuration builds the APK, installs
it, launches it waiting for a debugger and attaches to the JDWP socket the target forwards. The APK has to be
debuggable — `android:debuggable="true"` on `<application>` of the merged manifest. Newer Elide releases add it to a
`release = false` build, as Gradle does, and list `android-debug-<artifact>` only for an APK that ends up
debuggable; older Elide builds with Android support add nothing and list it anyway. Debug is therefore also withheld for an
APK whose manifest sets `android:debuggable="false"`, and for one whose latest build staged a merged manifest
(`.dev/android/<artifact>/AndroidManifest.xml`) without `android:debuggable="true"`, until the source manifest
changes. Unit tests of an Android project are plain JVM tests and run in the Test Explorer as usual.

Instrumented tests run on a device. An `AndroidApk` carrying instrumentation is a test APK: one declaring
`instrumentation` in `elide.pkl`, or an `<instrumentation>` element in its manifest, and for which Elide lists
`android-test-<artifact>`. Its tests, found in the source sets it packages, appear in the Test Explorer under
**Elide Android Instrumented Tests**. Running them —
from there, the APK's row or code lens, or **Elide: Run Android Instrumented Tests…** — installs the APK on the
deployment target's device with `elide build android-test-<artifact> --device=<serial>`, narrowed to the selected
classes and methods with `--tests`, and reports each test's pass, failure (with its stack trace) or skip. There is
no Debug profile: the target attaches no debugger.
Excluding every selected test runs nothing: it never falls back to the whole APK. Cancelling preparation or
closing the extension prevents a late device reply from starting a test process.

A failed Android Run, Build (APK or app bundle) or Debug says why in a notification: Elide's first error and its
hint, also logged to the Elide output channel, with **Show Terminal** for the whole output. When the hint names a
missing keystore (`Create one with: elide build android-keystore-<artifact>`), the notification offers **Create
Android Signing Keystore**. When a Run or Debug cannot install because the app on the device is signed with another
key (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`, as after a new debug keystore), it offers **Uninstall and Retry**: after a
confirmation naming the device, since uninstalling erases the app's data there, it runs `adb uninstall` for that
application ID and the same Run or Debug again. For a pinned AVD, the extension rechecks its identity after
confirmation and refuses deletion if the serial now belongs to another AVD or its identity cannot be read.
These tasks run in a terminal the extension feeds, with Elide's plain-text progress (`ELIDE_PROGRESS=plain`);
the `$elide` problem matcher reads it as before.

For Android workspaces, Elide starts the JetBrains Kotlin server with synchronous JDI metadata queries. In
JetBrains Kotlin 0.0.13, a cold asynchronous renderer-selection future can remain pending after a Kotlin expression
has already evaluated, leaving even a string literal or `this.getPackageName()` waiting for its presentation.
The compatibility default changes metadata transport, not expression evaluation or its timeout; synchronous
queries can be slower on high-latency device connections. It is inherited through the JetBrains launcher's
`IJ_JAVA_OPTIONS` in this VS Code window only, like the Compose plugin path, without writing user/workspace JVM
settings. An explicit `-Ddebugger.async.jdi=…` in inherited launcher options or `intellij.additionalJvmArgs`
takes precedence. Sync restarts an already-running server when needed, and Android attach waits for the new
daemon's debugger to initialize. The inherited options are restored when the last Android project leaves the
window or Elide deactivates.

The JetBrains Kotlin debugger cannot bind breakpoints in a folder opened through a symlink (macOS `/tmp` is
`/private/tmp`): it resolves each breakpoint by the path VS Code sends, logs `Could not find virtual file for
path`, and the breakpoint silently never binds. Every JVM and Android debug launch from such a folder warns and
offers **Reopen Folder at Real Path**.

#### Wireless pairing

Use **Elide: Pair Android Device over Wi-Fi…** from the Command Palette or Elide menu, or **Pair device over
Wi-Fi** in a synced project's Android tree. Requires Android 11+, current SDK Platform-Tools and the device
and extension host on the same reachable network. No USB cable or Android Studio installation is required.

- Enable **Developer options → Wireless debugging** on the device.
- **QR code:** generate a code in the panel, then use the device's **Pair device with QR code** scanner.
- **Six-digit code:** open **Pair device with pairing code** on the device, refresh discovery, select its address
  (or enter it manually), and enter the six-digit code.
- ADB normally connects automatically. If it does not, use **Connect an already-paired device** with the
  **IP address & port** from the main Wireless debugging screen, not the pairing dialog's port.
- Refresh Android Devices if necessary, then **Select Android Deployment Target…** for Run and Debug.
  Wireless devices also work with the existing Logcat and database pickers; pairing never replaces a pinned target.

QR discovery expires after two minutes and requires mDNS. Manual pairing/connection addresses work when
mDNS is blocked; VPNs, firewalls or guest-network isolation can still prevent connections. With Remote SSH
or containers, ADB runs on the extension host and needs network access to the device from there.
`elide.android.sdk` overrides the project's SDK for this tooling. Legacy unencrypted `adb tcpip` is not enabled.

Codes are neither saved nor logged and reach ADB through stdin, not process arguments. Cancel or close the
panel to stop its operations and discard the QR code. This cannot undo pairing already accepted by the device;
choose **Forget** under **Paired devices** on the phone to revoke the workstation's access.

#### Deployment target and environment

The device status-bar item and **Select Android Deployment Target…** choose the project, APK and destination
shared by Run and Debug. The selection persists in workspace state. Explicit tree/code-lens targets override it;
otherwise a runnable app owning the active file takes precedence over the remembered app. Library files do not
accidentally turn their library into a deployment target.

Each deployment validates the artifact against the synced model — Run needs the `android-run-<artifact>` target Elide
lists for it, Debug `android-debug-<artifact>` — and checks fresh adb state. If the selected
physical device is disconnected, offline or unauthorized, deployment stops rather than silently choosing another
device. A selected emulator that is not running is booted first: the target remembers the AVD it ran, finds it
again by that identity (its serial may change), and re-pins the new serial. A ready serial reused by another AVD
does not count as the selected emulator. Run and Debug save dirty file-backed documents before building and stop
if saving fails. Emulator startup identifies the exact AVD, is cancellable and bounded, and rejects ambiguous
instances; cancellation during an adb readiness check prevents deployment. Android launch configurations also
validate their target; `flags`, `options` and `env` layer over workspace defaults, with the selected device taking precedence.
Late picker, device-discovery and emulator-startup replies are discarded when a newer selection supersedes them.
A Run or Debug whose emulator is still starting goes on through a dismissed target picker or a sync; when another
target is selected meanwhile, it deploys nothing and says so.

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

This section describes the default `layoutlib` engine (`elide.android.composePreview.engine`). The experimental
live engine is described under [Komodo Compose preview engine](#komodo-compose-preview-engine-experimental).

Requires an Elide build with Android support (currently the internal release's distribution; not yet in a public
Elide release) with persistent compiler workers,
transactional incremental compilation, `--warm-incremental`, `--report-abi`, recorded `kotlinc.args`/`javac.args`,
and `kotlinc.toolchain.json`. Kapt modules additionally need `kapt.args` and `kapt.generated.json`.
These versioned records identify the actual compiler and processor inputs; rebuild after upgrading Elide.
An Android SDK is required for compilation/resource linking, with a JDK 17+ matching the extension
host's architecture. **No device, emulator, Android Studio, signing keystore, debuggable application or
`PreviewActivity` is required.**

1. Set `kotlin.features.compose = true`.
2. Include Compose `ui-tooling` (for example `androidx.compose.ui:ui-tooling-android:aar:1.7.8`) and the Compose
   libraries your component uses, with Google's Maven repository configured. `ui-tooling-preview` alone supplies
   annotations, not the renderer's Compose adapter. Keep tooling dependencies out of production artifacts.
3. Declare an `AndroidApk` artifact as the resource context. The preview builds only its resource/R-class targets
   and the relevant JVM compilation targets; it does not package, sign, install or launch that APK.
4. Sync, open a Kotlin file with `@Preview` functions and invoke **Elide: Open Compose Preview** from the Command
   Palette or editor title. The editor-title button appears only on Kotlin files that declare previews (annotations
   whose name contains `Preview`, multi-preview annotations included) and that an Android application of the
   workspace packages; on a file without them the command says so instead of building. Run while the folder's first
   sync is still running, it waits for that sync (cancellable) and reports the sync's error if it fails. Run again
   for the file already previewed, it brings that panel forward rather than building again.
   The resource context is chosen automatically: the `AndroidApk` that packages the file's source set, or else the
   nearest application depending on its workspace library; equally near applications go by workspace and artifact
   declaration order. The panel follows the previewed file when it, or a folder containing it, is renamed or moved,
   and reopens after **Developer: Reload Window**.

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
Rendering errors expose diagnostics on the affected card while retaining its last successful image. A card's
**Details** show the exception and its stack trace once, with frames in the project's sources linked to the line the
preview compiled.

Kotlin/Java changes refresh live, including unsaved editor buffers. Persistent compiler workers incrementally
compile private source snapshots; persistent layoutlib workers render the new classes. The gallery keeps its
previous images while updating, publishes only the latest edit, and reports elapsed time from change detection
through webview paint. Compiler failures retain the gallery, scroll position and selection, with diagnostics in
**Details** rather than replacing the images. Fresh PNGs decode before publication; unchanged pixels are reused.
Preview compilation does not overwrite workspace sources or build outputs. Concurrent requests sharing a backend
render their own source snapshot, even when another request publishes new classes while they wait.
Each renderer JVM holds layoutlib and the application's classes, several hundred MB, so a backend runs about one per
four previews of the gallery it renders, at most four and half the host's available CPUs. A larger gallery starts
more in the background, joining the next render; JVMs a smaller gallery leaves idle stop after a minute.
Source ownership follows the synced manifest's source selections. Adding the first Java source
to a source set without recorded Java compiler inputs requires a save and full rebuild.

Room and other kapt processors can share the preview's module. The worker uses the build's exact managed
Kotlin compiler classpath or external Kotlin installation, including version-matched Compose/kapt plugins.
Live compilation first uses a private copy of the last generated sources and paints with *verifying annotation
processing…*. The project's warm Kotlin worker also generates stubs from the same unsaved source snapshot. Unchanged stubs
and processing inputs confirm the paint without rerunning processors; changed declarations, handwritten Java,
or processing dependencies run kapt, replace generated sources/resources, recompile, and repaint.
The first verification of a compiler session runs processing to establish an authoritative baseline.
Processor errors remain visible and never confirm or persist a stale gallery. Only confirmed galleries are
stored, so reverting a schema edit or invalid query can reuse the previous gallery.

Generated files are not editable live inputs. Absolute/path-named processor options, including Room's
`room.schemaLocation`, are redirected to private copies; preview processing never updates the project's schema
exports. Processors must declare their inputs through the compiler classpath or those options: arbitrary
undeclared filesystem/network inputs cannot be tracked. Hilt Android bytecode transformation is a separate
build step and still requires saving and rebuilding; it is not silently skipped during live compilation.

Opening a preview builds JVM classes and linked resources, but does not wait for that build to paint:

- **Prewarm.** Focusing a Kotlin file with `@Preview` functions in a trusted, synced Android project starts the
  renderer JVMs and compiler workers in the background and renders that file from the last build's classes, so
  **Elide: Open Compose Preview** typically paints in well under a second. The status bar shows the warm-up and its
  current phase; a large project's first one can take a minute. Opening the preview meanwhile joins it rather than
  starting another. Prewarming never builds and never downloads the renderer runtime; it is off when
  `elide.android.composePreview.prewarm` is disabled. A prewarm that fails is reported in the `Elide` output channel.
- **Keep-alive.** Closing the panel keeps its renderer and warm compilers for
  `elide.android.composePreview.keepAliveMinutes` (default 10; `0` stops them with the panel). Reopening reuses them.
  The backend holds several GB of memory while warm; at most one unused backend is kept.
- **Build outputs as the first generation.** When the last build's classes match the current sources, they are
  displayed directly instead of waiting for a cold compile. Before confirming readiness for live edits, the backend
  initializes one instrumented private baseline for the app and its workspace libraries, then verifies processing
  against those final dependencies while initializing their renderer. Initialization belongs to that private
  classpath: rendering an earlier build candidate does not warm its replacement. Cached pixels skip rendering
  disposable seeded classes. Workspace members compiling with managed Compose or the compiler plugins bundled with
  Elide share one compiler worker, which also runs their kapt; custom plugins retain project-local workers. The
  initial pixels remain visible throughout initialization.
- **Stored galleries.** Each gallery is stored under its exact inputs (build fingerprint, source text, renderer,
  JDK and published instrumentation provenance), so reopening an unchanged file, even after restarting VS Code,
  or undoing an edit paints immediately. A cold backend can replay an instrumented gallery while initializing. A
  gallery with a failed card is neither stored nor replayed: it renders again.

Until the build finishes, the status reads *verifying build…*; if the build changes resources, dependencies or
compiler settings, the gallery re-renders. A build that changes only input content (linked resources, R classes,
libraries) keeps the warm compiler: unchanged classes re-render against the new resources at once, and members
whose classpath changed recompile incrementally. Only changed compiler records or toolchains start a new compiler,
which initializes again. Reverting such a change reuses its stored gallery once the build confirms it. Saving
`.xml` or `.pkl` files, changing the project model, or pressing **Rebuild** performs that build again. Opening a
preview does not save unsaved editor buffers, whatever
`task.saveBeforeRun` says: the build runs as a background process rather than a VS Code task and supplies the disk
baseline, then the live compiler applies the editor snapshot. A first preview of a project that was
never built, or whose sources changed since its last build without a prewarmed backend, waits for the build
and a cold renderer.

Elide records canonical paths; a workspace opened through a symlink (such as macOS `/tmp`) previews the same
files. A build record that names another checkout or generated files that no longer exist, as the build cache
can restore, is reported as stale with **Rebuild without cache**, which rebuilds the preview inputs with
`--no-cache` to rewrite it.

A failed or cancelled build leaves the gallery unverified; the next refresh retries build/resource preparation
before confirming it. **Cancel** on the preview's **Activity** row stops whichever step runs, from the runtime
download to compiler preparation, and **Rebuild** during a build stops that build and starts a new one. Closing the
panel stops its build and prevents pending runtime preparation from starting another build after the panel closes.
Backend shutdown cancels its workers and waits for pending setup/compilation cleanup before removing temporary
files; a later window removes the temporary workspace of a window that closed, reloaded or crashed first. Renderer
failures retain the originating diagnostic rather than a sibling worker's shutdown error.

While the preview builds, the status line names the tasks Elide has finished so far, the most recent one with its
duration, and counts the build's elapsed time. **Build log** opens the build's output inside the panel as it
arrives; **Open in editor** shows the complete log with timestamps, and **Timing** reveals the build in the
**Activity** view; the `Elide` output channel receives the same output. A failed build or live compile shows its
first compiler error, with file and line, in the status line and the complete compiler output under **Details**; a
failed build's errors are also listed in the Problems view until the next preview build or until the panel closes.
Once a gallery paints, the status line breaks its time down by phase (build, compile, render). Builds do not steal
editor focus.

The gallery follows VS Code's light, dark and high-contrast themes. **Fit** constrains images to their cards;
toggle it for actual pixel size.

**Inspect**, in the toolbar, overlays Compose's measured layout bounds and adds an inspector below each card (the
`layoutlib` engine's inspection is described here; the Komodo engine's is above); with it
off, cards show only the image and its size, and one line above the gallery points to it. Click a component to
select it, then choose **Open source**,
double-click, or press Enter to navigate to its call site, including calls in workspace libraries. The component
picker and **Parent** control select enclosing components. With a preview focused, arrow keys cycle components,
Home/End select the first/last, and Alt+Up selects an enclosing component.

Inspection uses real tooling bounds and compiler UTF-16 source ranges, not image recognition or guessed source
matches. Only locations uniquely resolved in the preview's compiler inputs are selectable; dependency internals
and ambiguous source files are omitted. Bounds are rectangular measured layouts, not arbitrary painted contours.
Private preview compilation enables Compose source information without changing the application's build.
**Inspect** requests instrumented app and workspace-library classes even for saved sources; it never treats an
image-only build gallery as an inspected render. Outlines may arrive after the initial cached/build image while
the compiler initializes. Unsupported bytecode post-processing is reported rather than silently claiming bounds.
Source navigation pauses during edits or failed builds so retained images cannot open stale source ranges.

These are design-time snapshots, not interactive animation/click simulation or in-process Live Edit. Each render
loads fresh project classes into the retained rendering runtime. Components requiring device services, application initialization or unsupported native libraries
need preview-specific sample data, as with other layoutlib-based tools. Workspace trust is required: previews
execute project code in a local JVM, not a security sandbox.

For editor analysis, sync passes the Compose compiler plugin shipped with the installed JetBrains Kotlin LSP,
not the build compiler's potentially incompatible plugin. If it is missing, update/install that extension and
sync again; Elide's output channel identifies the missing plugin.

The Kotlin LSP's `FunctionName` inspection ("Function name should start with a lowercase letter") is suppressed on
`@Composable` functions, as in Android Studio. For Compose projects, sync builds a small language-server plugin
against the installed JetBrains Kotlin LSP (cached in Elide's global storage), lists it as `-Dplugin.path` in the
server's inherited `IJ_JAVA_OPTIONS` for this window only — the path is local to this machine and VS Code profile,
so it is never written to settings, and entries earlier releases wrote to the user setting `intellij.additionalJvmArgs`
are removed — and relaunches the server once so it applies. A `-Dplugin.path` of your own in
`intellij.additionalJvmArgs` comes later and replaces it; the Elide output channel then names the entry to add.
If opening a source file has already started companion activation, sync waits for that activation before requesting
the relaunch, so the first server cannot keep outdated plugin arguments. With no open source file, activation
remains lazy. Other functions with capitalized names are still reported.

#### Compose previews for AI agents (MCP)

The extension serves the Compose preview to AI agents as [MCP](https://modelcontextprotocol.io) tools, so an agent
can look at the UI it writes. The server is a Streamable HTTP endpoint on `127.0.0.1`, protected by a bearer token
kept per workspace (port and token stay the same across reloads when the port is free). VS Code's own agents (chat
agent mode) find it as **Elide Compose Preview** in the MCP server list; agents started in the integrated terminal
read `ELIDE_COMPOSE_PREVIEW_MCP_URL` and `ELIDE_COMPOSE_PREVIEW_MCP_TOKEN`; for any other client, **Elide: Copy
Compose Preview MCP Server Configuration** copies an `mcpServers` entry with both (for example
`claude mcp add --transport http elide-compose-preview "$ELIDE_COMPOSE_PREVIEW_MCP_URL" --header "Authorization:
Bearer $ELIDE_COMPOSE_PREVIEW_MCP_TOKEN"`). `elide.android.composePreview.mcp.enabled` turns it off. Rendering runs
the project's code, as the preview panel does: the tools refuse to run in an untrusted workspace.
Malformed HTTP request targets receive HTTP 400 without interrupting other requests. Closing the extension clears
its terminal URL/token contributions, including when startup is still persisting the server's port.
Native render/refresh/interact operations follow the same availability checks as the panel. Losing compatible Komodo
cancels native requests and closes their sessions, but does not shut down this MCP server: composable listing and
layoutlib rendering still work. Recovery requires a new native render, not reuse of a retired session ID.

| Tool | What it does |
| --- | --- |
| `compose_preview_render` | Renders up to 12 composables and returns each card's PNG and layout tree. `live: true` keeps a session open. |
| `compose_preview_interact` | Taps, long presses, drags, scrolls and types into a live card; returns its settled frame and layout. |
| `compose_preview_refresh` | Renders a session again from the current source, after the agent edited it. |
| `compose_preview_close` | Ends a live session. |
| `compose_preview_list` | Lists a file's or the workspace's top-level composables with their parameters and references. |

An agent names a composable by **code reference** (`package.Function`, `Function`, or `path/to/File.kt#Function`,
optionally `:line` for an overload), never by pasting code, and it does not need a `@Preview`: the extension
generates a public wrapper that calls it and appends it to the composable's own file **for the preview compile
only** — it is never saved, and with the Komodo engine the language server never sees it (Komodo applies it to its
buffer for that compile alone). Because the wrapper lives in the same file, private composables, the file's imports
and extension receivers (`ColumnScope`, `RowScope`, `BoxScope`, hosted in a `Column`, `Row` or `Box`) work.
Parameters without defaults get placeholders where the type allows (strings, numbers, booleans, `Modifier`, colors,
`Dp`, collections, nullable types, `Unit`-returning lambdas); the agent passes others, or better values, as Kotlin
expressions in `arguments`, which compile in that file. A configuration (`widthDp`, `heightDp`, `darkTheme`,
`fontScale`, `locale`, `device`, `backgroundColor`, `showSystemUi`, `apiLevel`; `showBackground` defaults to on) and a
`theme` composable to wrap each one in are optional. A composable that already has `@Preview` and is given neither
renders its own preview configurations. A compile error in a wrapper is reported with the wrapper's numbered lines.

Each card's layout is a tree of composable calls with their bounds in image pixels and their call sites
(`file:line:column`), as the preview's **Inspect** locates them; actions can target a node of it (`n3`) instead of
coordinates. The tools use the configured `elide.android.composePreview.engine`: `layoutlib` renders snapshots
(sessions only refresh), `komodo` renders live cards in the workspace's Komodo language server and needs a Komodo
that supports session appendices. Komodo hosts one preview session per window: while an agent renders, or keeps a
live session open, the preview panel's cards show that they are paused and resume when it ends (**Elide: Close Agent
Compose Preview Sessions**, or ten minutes unused); opening the panel meanwhile waits the same way. The close
command also cancels renders still opening a session, so a late result cannot leave a new live session behind.
One-shot renders keep the agent's Komodo session warm between calls; the panel takes it over whenever it previews. A render uses the
last build's resources and classes for code outside the previewed files, building first when the project was never
built; `rebuild: true` builds before rendering (after resource changes). Progress and failures show in the **Activity**
view and the `Elide` output channel.

#### Dagger and Hilt

Requires an Elide build with Android support. Put `dagger-compiler` or `hilt-compiler` in
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
does not download on-demand splits. Requires an Elide build with Android support.

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
A new, restarted or refiltered stream requests records since the application's current process start when it is
running, otherwise since the sampled device clock. Application filtering uses the installed UID, so it follows
process restarts and secondary processes; apps sharing that UID also share the filtered logs.
On Android 12+ it uses `logcat --uid`; on Android 7–11 it follows only the app's running main process (`--pid`), so restart logcat after the app restarts. Removing the project or its Android model, or closing the extension,
stops its adb clients and invalidates pending discovery/filter replies, including application discovery before
its picker opens. Stop also cancels a pending restart.

The startup header is not a device-side readiness acknowledgement. Android 16 emulator qualification found
immediate startup records missing from timestamp-filtered live streams but present in later dumps, including
with direct adb. For startup diagnosis, retain `adb -s <serial> logcat -d -v threadtime` output as well; the
extension does not mask that boundary with an arbitrary delay.

Ctrl/Cmd-click an application stack frame to open its Kotlin/Java source line, including workspace-library
frames, nested classes and Kotlin file facades. Resolution uses the synced source roots, package and filename;
unknown/native frames, out-of-range lines and ambiguous same-package filenames remain unlinked. Source-index
caches are invalidated when projects or source files change. Obfuscated release traces still need their R8
mapping; the links do not retrace obfuscated names.

#### Room / SQLite database explorer (experimental)

**Elide: Explore Android Databases** opens a connected app's on-disk Room / SQLite databases. It is also available
from the Elide menu and as **Explore databases** in the Android tree and in Android/device context menus. Choose an installed application;
the deployment target's device is preferred, and an unavailable selected device never silently falls back to another.

Requires a trusted, synced Android project, Android 8.0 / API 26+, and a debuggable app with working `adb run-as`.
Launch the app and exercise the screen that creates its database before inspecting it. The picker lists installed
third-party apps for the foreground Android user; apps `run-as` refuses (release or otherwise non-debuggable builds)
are listed apart with its reason and cannot be opened. The selection retains that user: switching profiles
while the picker is open requires selecting the application again, before any database access.

The panel provides:

- Database and schema browsing, including tables, views, indexes and trigger SQL.
- 100-row pages, read-only SQL queries, exact 64-bit integers, NULLs and Base64 BLOBs.
- Manual refresh and optional 2 / 5 second refresh while visible. Refresh re-runs the last successful read without
  overwriting an edited SQL draft. Failed or cancelled queries clear that read; Refresh then updates only the catalog
  until another query succeeds. Pages are independent reads; add `ORDER BY` for predictable paging.
- **Execute write…**, requiring confirmation of the app/database/device and statement. Each write is a transaction
  with foreign keys enabled. Cancel stops pending work; a cancelled in-flight write may already have committed,
  so refresh before retrying.

The bundled helper uses Android's SQLite APIs directly on the live files, including committed WAL contents.
It does not require root, a device `sqlite3` binary, app instrumentation or database copies. Removing the project
or closing the panel cancels its requests and attempts to remove the temporary helper from the app cache.
If Android clears the cached helper, the next helper start reinstalls it within the same panel/session.

Unlike Android Studio's in-process inspector, these external writes **do not invalidate Room observers**. Re-query
or reopen the relevant app screen to see changes. Only SQLite files under the app's credential-protected
`databases/` directory are discovered; in-memory, encrypted, device-protected and custom-location databases are
not supported. Changing the foreground Android user requires reopening the explorer.

Each request uses a fresh connection; temporary tables and other connection-local state are not retained.
SQL is one statement per request. Query supports `SELECT`, `WITH` and `EXPLAIN`; writes support
`INSERT`, `UPDATE`, `DELETE`, `REPLACE`, `CREATE`, `ALTER`, `DROP` and `WITH`. No `PRAGMA`, `ATTACH`, transaction control,
maintenance commands or compound `CREATE TRIGGER` bodies. Results are limited to 4 MiB, 256 columns and 256 KiB
per text/BLOB cell; the panel reports oversized results rather than truncating them. Change counts include trigger
and foreign-key effects. On API 26–27, writes preserve WAL but Android may normalize a non-WAL journal mode to DELETE.


## Links

- [Repository, full documentation, and issues](https://github.com/elide-dev/vscode)
- [Changelog](https://github.com/elide-dev/vscode/blob/main/packages/vscode/CHANGELOG.md)
- [Elide documentation](https://docs.elide.dev)

Licensed under the [MIT license](https://github.com/elide-dev/vscode/blob/main/LICENSE).
