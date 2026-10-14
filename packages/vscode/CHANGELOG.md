# Changelog

All notable changes to the Elide extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A persistent Android deployment target shared by Run and Debug, visible in the status bar and selectable from
  the sidebar or command palette. Deployments validate the APK and current device state; disconnected physical
  devices never silently fall back to another device, while a selected emulator that is not running is booted
  automatically (by AVD identity) before Run or Debug. Dirty file-backed documents are saved before building.
- **Check Android Environment**: cancellable, read-only diagnostics for Elide, JDK, SDK, compile SDK, devices,
  optional emulator/AVD, Kotlin extension and APK declarations, with explicit remediation actions. Available even
  before sync succeeds; unresolved declarations remain unknown and SDK licenses are never accepted by inspection.
- Clickable Kotlin/Java application stack frames in Android Logcat, resolving across synced workspace source
  roots. Ambiguous, native, unknown and out-of-range frames remain unlinked.
- **Refresh Android Devices**, device refresh after Elide tasks, and Android actions in the Elide menu and
  getting-started walkthrough.
- An **Activity** view in the Elide sidebar recording each sync and Compose preview build of the window as it runs:
  its steps, every `elide` command they ran and the build tasks Elide reported finishing, each with its duration and
  share of the whole. Rows open the step's output, with timestamps, in an editor; running operations can be cancelled.
- Sync progress that stays visible: the status bar names the step in progress with the elapsed time, a sync running
  longer than two seconds shows a cancellable notification (`elide.sync.showProgressNotification`), the status bar
  tooltip and the `Elide` output channel break the last sync down by step, and a failed sync names the step that
  failed and offers its log.
- Compose preview builds report their progress in the panel: finished tasks, the latest task's duration and an
  elapsed-time counter on the status line, a live **Build log** drawer, the compiler errors of a failed build under
  **Details**, and a per-phase time breakdown (build, compile, render) once the gallery paints. The first-run renderer
  download reports bytes received.
- Android Logcat output channels with device selection, application UID, priority and literal-text filters,
  and clear, stop and restart commands. Clearing the editor output leaves the device's shared log buffer intact.
  **Show Android Logcat** starts without confirming filters: it streams the deployed (or only) application, read from
  the built APK so renamed application IDs match, and reopens a running stream instead of restarting it. Records are
  aligned into time, PID-TID, tag, priority and message columns, multi-line messages and stack traces are indented
  under one header, and priorities, tags, exceptions, application versus framework frames, URLs and strings are
  color-coded through the theme.
- Host-side Compose previews using Google's standalone renderer and Android layoutlib, with no device, emulator,
  Android Studio, APK installation or signing requirement. Includes verified runtime downloads, compiled annotation
  discovery, preview configurations/multi-previews/parameter providers, overloaded preview functions, a preview gallery,
  live unsaved Kotlin/Java updates, warmed persistent incremental compilers and renderers, detection-to-paint timing, and
  correct Compose compiler configuration for the Kotlin LSP. Opening a preview paints without waiting for its build:
  focusing a preview file prewarms the renderer and compilers (`elide.android.composePreview.prewarm`), closed
  panels keep them warm (`elide.android.composePreview.keepAliveMinutes`), the last build's classes stand in for the
  cold first compile, and galleries are stored by their exact inputs for instant reopen.
- Compose layout inspection with real measured component outlines, source navigation across workspace modules,
  keyboard selection and enclosing-component controls. A theme-aware preview toolbar, responsive cards,
  fit/actual-size controls and a diagnostics drawer replace the plain gallery controls. Compilation and rendering
  failures retain last-good images; decoded updates preserve unchanged image elements and scroll position,
  and stale source locations cannot navigate.
- Android app bundles and dynamic-feature modules in the project model and sidebar, including delivery mode,
  base/feature relationships, module build targets and isolated feature source/resource roots.
- Dagger/Hilt editor support: run available annotation-processing compile targets during sync and import
  generated Java/kapt sources across workspace libraries without exposing kapt stubs.
- Live build progress from Elide 1.6.1's progress records (`ELIDE_PROGRESS=json`): the Activity view shows each
  build task while it runs, with the progress it and its steps report, and the status bar and sync notification say
  what Elide is doing now and how many of the build's tasks are done (`Resolving Maven dependencies: 40% (1/3)`).
  Compiler diagnostics from these records carry absolute locations. Older releases keep the text-based view.

### Changed

- Kotlin by JetBrains is installed as a companion extension instead of a hard activation dependency. Elide's CLI
  features remain available independently of language-server startup; Kotlin and Java source documents activate
  the companion on demand, including Java-first projects.
- The `Elide` output channel no longer echoes the exported project model and resolved classpaths during sync; it shows
  each command line, the output Elide prints for a person, and each command's exit status and duration.
- Syncs resolve each project's classpaths with one `elide classpath --json` per project on Elide 1.6.1 and newer,
  instead of one process per source set and usage. Older releases are still asked one query at a time. An Android
  project whose `R` classes are already generated has its platform classpath answered by the same process.
- The projects of a workspace resolve concurrently once its dependencies are installed, and member manifests are
  read concurrently. What their classpaths need built first (unpacking Android libraries, generating `R`) is built
  by one `elide build` at the workspace root; builds never overlap. The Activity view shows each project as a step of
  its own.
- Compose preview build terminals run with `ELIDE_PROGRESS=plain`, so the terminal, the panel's Build log and its
  status line name each task as it starts.
- Compose previews choose their Android resource context automatically instead of asking: the application packaging
  the previewed file's source set, or the nearest one depending on its workspace library. Focusing a library's
  preview file in a workspace with several applications now prewarms too.

### Fixed

- Android debug launches use the same validated deployment selection as Run, resolve the project's emulator by
  AVD identity, and honor launch-configuration build flags, options and environment variables.
- Environment checks use the Android platform jar from the resolved classpath, including minor-version SDK
  directories, and flag symlinked workspace paths that prevent JetBrains source breakpoints from resolving.
- Logcat source navigation includes legitimate package directories named `build`, `out`, `dist` or `generated`
  beneath the declared source roots.
- Compose previews render the library versions the APK ships. When workspace members resolve a library at different
  versions, the newest is used (Maven ordering, a tie going to the application's own copy), as Elide dexes it, instead
  of the application's older transitive copy. Previews of a workspace library compiled against a newer version, such
  as Material 3, no longer fail with `NoSuchMethodError`.
- A Compose preview rebuild started within half a second of the previous build finishing is no longer reported as
  "stopped" without running: it waits for the previous run's terminal to close instead of being handed that run.
- Editor smoke runs disable updates to the shared extensions directory and keep macOS scratch paths short without
  overriding `TMPDIR`, so the Kotlin client and JVM agree on the daemon port-file location.

## [0.5.0](https://github.com/elide-dev/vscode/compare/v0.4.0...v0.5.0) (2026-09-24)


### Added

* Support for Elide multi-project workspaces. ([#11](https://github.com/elide-dev/vscode/issues/11)) ([d2e968d](https://github.com/elide-dev/vscode/commit/d2e968d172b306c1c2b343b33a717a61460169cb))

## [0.4.0](https://github.com/elide-dev/vscode/compare/v0.3.1...v0.4.0) (2026-09-17)


### Added

* Native Image run/debug actions ([d67922f](https://github.com/elide-dev/vscode/commit/d67922f69b6329d6c76f033be2ac20cb37607a0c))

## [0.3.1]

### Added

- `Run` for Native Image artifacts: builds the artifact, then runs the binary it produced
  (`.dev/artifacts/native-image/<image>`) as a task of its own. Offered as a code lens on the artifact in `elide.pkl`
  and as an inline action on its sidebar build-target row, alongside the `Debug` of the same pair an entrypoint
  carries. Library images and other artifact types keep `Build` alone.
- Native Image debugging: launch type `elide-native` builds a Native Image artifact and debugs the binary it
  produced through the C/C++ extension's GDB/LLDB adapter. The session points the debugger at the source cache
  (`set directories`) and loads GraalVM's `gdb-debughelpers.py` so Java objects, arrays and strings print as such.
  Offered as a `Debug` code lens on the artifact in `elide.pkl` and as an inline action on its sidebar build-target
  row. An image built without `-g` still starts a session, with a warning naming the flag to add.
- `elide.debug.nativeMiMode` (`auto` | `gdb` | `lldb`) and `elide.debug.miDebuggerPath` select the debugger
  `elide-native` sessions drive. `auto` takes a GDB when one is on `PATH`, else LLDB on macOS.

### Fixed

- Running an entrypoint, a build or the tests no longer asks to reload the project.

## [0.3.0] - 2026-09-11

### Added

- Elide sidebar: an activity-bar view listing every project with its entrypoints, tasks, build targets
  (`elide build --inspect`, loaded on first expansion), source sets and dependencies. Rows carry inline Run, Debug,
  Build, Sync and Open-manifest actions; dependencies can be revealed in the OS file manager. A welcome view covers
  the no-project case.
- `Elide: New Project…`: a wizard over `elide init` listing the templates reported by
  `elide init --templates --json`, prompting for template parameters and optional blocks, generating the project in a
  chosen directory and opening it. Available from the palette, the Elide view title bar, the empty-workspace welcome
  view and the Elide menu.
- A `Get started with Elide` walkthrough: install the CLI, open or create a project, sync with the Kotlin LSP, run and
  debug, run tests.
- Invocation control for tasks and launch configurations: `flags` (`-f NAME[=VALUE]`), `options` (subcommand CLI
  options as a name/value object), `programArgs` (arguments after `--`), `env` and `args` (positional arguments).
  Launch configurations additionally take `command` (`run`, `test` or `build`) and `elideArgs`.
- Debugging build targets: a launch configuration with `command: "build"` runs `elide build <targets> --debugger` and
  attaches, with targets in `targets` and task options in `options`. Sidebar build-target rows gained a Debug action
  for every target that declares `--debugger`; a build configuration with no target is rejected with a message.
- Workspace defaults `elide.flags` (applied to every invocation, project sync included) and `elide.build.options`,
  `elide.run.options`, `elide.test.options`, `elide.install.options`. Tasks and launch configurations override them
  per key, and a `false` value cancels an inherited option. Test Explorer runs honour `elide.test.options` except for
  `reporter`, which stays `tap`.

## [0.2.0] - 2026-09-11

### Added

- `Elide: Show Menu`: a quick pick with sync, run, test, manifest, workspace and output actions. The status bar item
  opens it, shows the project name for a single-project window, and lists the last sync failure first.
- `elide.install.classifiers` (default `["sources"]`): classifier jars installed for the manifest's declared Maven
  packages.
- A warning when the resolved Elide CLI is older than 1.5.0, shown once per distribution; the release is logged to the
  output channel on every sync.
- Run/Debug code lenses: `Run with Elide`/`Debug with Elide` above JVM `main` functions in a project's production
  sources, and `Run`/`Debug` on `jvm.main`, `entrypoint` and `scripts` elements plus `Build` on `artifacts` elements in
  `elide.pkl`. Toggle with `elide.codeLens.enabled`.
- Test Explorer for JUnit tests in the project's test source roots: discovery scans the test sources without
  compiling and follows unsaved edits; runs use `elide test --reporter=tap`, for the whole project or with
  `--test-name-pattern=<pattern>`. Failures carry the assertion message, the stack trace and a location. The Debug
  profile runs under a JDWP agent and attaches `elide.debug.adapter`.
- The `$elide` problem matcher on every `elide` task: kotlinc errors and warnings become diagnostics on the reported
  file and line.
- Commands `Elide: Run Entrypoint`, `Elide: Debug Entrypoint`, `Elide: Build Artifact`, `Elide: Run Task` and
  `Elide: Open elide.pkl`, invoked with a project root and argument vector.

## [0.1.1] - 2026-09-10

### Changed

- Manifests nested inside another Elide project are no longer imported as projects: only the outermost `elide.pkl` of
  each directory tree is synced, and edits to nested manifests no longer mark the folder out of date. Deleting an
  enclosing manifest promotes the manifests it was shadowing.

## [0.1.0] - 2026-09-06

First release.

### Added

- **Project sync** for any workspace folder containing `elide.pkl`: `elide manifest` for the resolved project model,
  `elide install` when the lockfile is stale, and `elide classpath <source set>:compile` for every compilable source
  set.
- **Kotlin LSP integration**: a generated `workspace.json` at the workspace folder root in the JSON workspace format
  read by `JetBrains.kotlin-server` — one module per source set, one library per jar with `-sources.jar` /
  `-javadoc.jar` attached, the selected JDK as SDK, and Kotlin language/API level plus free compiler args as kotlinc
  flags.
- **Mixed-editor support**: `intellij.buildTool` pinned to `json` in workspace settings, and
  `intellij.jdkForSymbolResolution` written to user settings.
- **Tasks** (`elide` task type): `build`, `test`, `install`, and one `run` task per manifest entrypoint
  (`entrypoint`, `jvm.main`, `scripts`).
- **Debugging** (`elide` debug type): runs `elide run --debugger`, waits for the JDWP listener, and attaches either the
  JetBrains JVM debugger or Debugger for Java (`elide.debug.adapter`).
- **Commands**: `Elide: Sync Project(s)`, `Elide: Run Elide Command…`, `Elide: Open generated Kotlin LSP workspace`,
  `Elide: Show Output`, plus a status bar item reflecting sync state.
- **Settings**: `elide.home`, `elide.jdk.home`, `elide.sync.onStartup`, `elide.sync.onManifestChange`,
  `elide.kotlinLsp.writeWorkspaceJson`, `elide.debug.adapter`.

[0.3.1]: https://github.com/elide-dev/vscode/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/elide-dev/vscode/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/elide-dev/vscode/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/elide-dev/vscode/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/elide-dev/vscode/releases/tag/v0.1.0
