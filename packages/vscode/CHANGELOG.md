# Changelog

All notable changes to the Elide extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0](https://github.com/elide-dev/vscode/compare/v0.6.1...v0.7.0) (2026-11-01)


### Added

* adopt Elide's structured progress records ([97aca17](https://github.com/elide-dev/vscode/commit/97aca17dbaacd7d249bd7b0aaf0144424a9b2d4d))
* **android:** boot a stopped emulator target before Run and Debug ([f7c3e45](https://github.com/elide-dev/vscode/commit/f7c3e457f527c41e0a362758c7838c31488800b3))
* **android:** streamline deployment, diagnostics, and source navigation ([d9ed147](https://github.com/elide-dev/vscode/commit/d9ed147fd217d7ca3579e390f7afadb98b4e114b))
* **core:** format logcat records and read APK application IDs ([ba487cd](https://github.com/elide-dev/vscode/commit/ba487cdffdc337aae974b7585f07b8b54a544fad))
* **vscode:** automatic Compose preview resource context ([bedce8c](https://github.com/elide-dev/vscode/commit/bedce8c46116b4175c9bfb5756e83e688e947041))
* **vscode:** color-coded, aligned logcat without filter prompts ([c943fdc](https://github.com/elide-dev/vscode/commit/c943fdc570111679e60362484bc130f54ee43c16))
* **vscode:** Komodo engine hosts Android cards on layoutlib, with live input ([bb993df](https://github.com/elide-dev/vscode/commit/bb993df1747f16721860b70026f6a30ea2cb87de))
* **vscode:** opt-in Komodo engine for the Compose preview, with per-card fallback ([83d5d21](https://github.com/elide-dev/vscode/commit/83d5d21bb6e675dd798ca49c8b8455739bb95b2d))
* **vscode:** suppress FunctionName on @Composable functions ([178a46b](https://github.com/elide-dev/vscode/commit/178a46bf14793fe6b4ba5d392c5fd2f4d3714293))


### Fixed

* remove integrations requiring unreleased runtime features ([d2c1760](https://github.com/elide-dev/vscode/commit/d2c1760e93a63785253cbae4794e6dc9cc993e2c))
* **sync:** keep skipped tasks, honor mid-sync manifest edits and imported modules ([e6961fc](https://github.com/elide-dev/vscode/commit/e6961fcc74900cdb83d3b29631482a86417790a3))
* **sync:** regenerate R classes the build no longer records ([ee9302d](https://github.com/elide-dev/vscode/commit/ee9302df0b48770fa2f1bf61150fe5e77d58a35b))
* **sync:** watch the local Pkl modules manifests import ([e8dfc4f](https://github.com/elide-dev/vscode/commit/e8dfc4fc22ec6f1fd350bd010034ec358979daf3))


### Changed

* **sync:** resolve workspace projects concurrently, batch platform queries ([2454de3](https://github.com/elide-dev/vscode/commit/2454de3b95c71fa12366be3665cf96a68b6b3941))

## [Unreleased]

### Added

- Compose projects: the Kotlin LSP no longer warns that `@Composable` function names should start with a lowercase
  letter. Sync loads a small Elide plugin into the language server (`-Dplugin.path` in `intellij.additionalJvmArgs`)
  and relaunches it once; other capitalized function names are still reported.
- **Check Android Environment**: cancellable, read-only diagnostics for an independently installed SDK,
  platform-tools and connected devices. Works without `elide.pkl` or a successful sync and never installs
  components or accepts licenses.
- Clickable Kotlin/Java application stack frames in Android Logcat, resolving across synced source roots and
  ordinary unsynced workspace folders. Ambiguous, native, unknown and out-of-range frames remain unlinked.
- An **Activity** view in the Elide sidebar recording each sync as it runs:
  its steps, every `elide` command they ran and the build tasks Elide reported finishing, each with its duration and
  share of the whole. Rows open the step's output, with timestamps, in an editor; running operations can be cancelled.
- Sync progress that stays visible: the status bar names the step in progress with the elapsed time, a sync running
  longer than two seconds shows a cancellable notification (`elide.sync.showProgressNotification`), the status bar
  tooltip and the `Elide` output channel break the last sync down by step, and a failed sync names the step that
  failed and offers its log.
- Android Logcat output channels with device selection, application UID, priority and literal-text filters,
  and clear, stop and restart commands. Clearing the editor output leaves the device's shared log buffer intact.
  **Show Android Logcat** selects a connected device and streams all applications. Filters accept an application ID
  manually or read it from an existing APK, including renamed IDs. Showing a running stream reveals it without restarting. Records are
  aligned into time, PID-TID, tag, priority and message columns, multi-line messages and stack traces are indented
  under one header, and priorities, tags, exceptions, application versus framework frames, URLs and strings are
  color-coded through the theme.

### Changed

- Updated the extension and activity-bar icons to the Elide block mark, with the gradient SVG source included.

- Kotlin by JetBrains is installed as a companion extension instead of a hard activation dependency. Elide's CLI
  features remain available independently of language-server startup; Kotlin and Java source documents activate
  the companion on demand, including Java-first projects.
- The `Elide` output channel no longer echoes the exported project model and resolved classpaths during sync; it shows
  each command line, the output Elide prints for a person, and each command's exit status and duration.
- Syncs resolve each project's classpaths with one `elide classpath --json` per project on Elide 1.6.1 and newer,
  instead of one process per source set and usage. Older releases are still asked one query at a time.
- The projects of a workspace resolve concurrently once dependencies are installed, and member manifests are
  read concurrently. The Activity view shows each project as a step of its own.
- The Activity view keeps the build tasks Elide skipped as steps of their own, with the reason (`Up to date`, `From
  cache`) and, on Elide releases that report it, the time their up-to-date check took. Listing the build's tasks
  (`elide build --inspect`) is a sync step of its own instead of counting towards reading the member manifests.
- Removed unreleased-runtime integrations: Android build/deployment/debug/emulator workflows, generated Android
  and annotation-processor editor models, Compose previews and structured progress records. The full implementation
  remains recoverable from `archive/pre-runtime-compat-20261101` (commit `91770cc`).

### Fixed

- Logcat source navigation includes legitimate package directories named `build`, `out`, `dist` or `generated`
  beneath the declared source roots.
- Editor smoke runs disable updates to the shared extensions directory and keep macOS scratch paths short without
  overriding `TMPDIR`, so the Kotlin client and JVM agree on the daemon port-file location.
- The local Bazel integration runner resolves runfiles symlinks before copying mutable samples, so test edits stay
  in the temporary workspace instead of reaching the source checkout.
- A manifest edit made while a sync runs, or within three seconds after one ends, is no longer ignored: the folder is
  marked out of date (and re-synced when `elide.sync.onManifestChange` is `always`) instead of the sync's success
  clearing it, and the next sync installs dependencies even when another `elide` command, such as the interrupted
  sync's own, rewrote the lockfile after the edit.
- A sync installs dependencies when a Pkl module a manifest imports, amends or extends (such as a shared
  `versions.pkl`) changed since the last install, not only when a manifest itself did. Editing such a module, even
  one outside the workspace folder, also marks the project out of date and applies `elide.sync.onManifestChange`, as
  an `elide.pkl` edit does.

## [0.6.1](https://github.com/elide-dev/vscode/compare/v0.6.0...v0.6.1) (2026-10-13)


### Fixed

* point at the kotlin extension's first-run setup instead of a reload failure ([#21](https://github.com/elide-dev/vscode/issues/21)) ([de66dbf](https://github.com/elide-dev/vscode/commit/de66dbf2e0ab1c7ccc6eaf811bae45eac9bc2b27))

## [0.6.0](https://github.com/elide-dev/vscode/compare/v0.5.0...v0.6.0) (2026-10-13)


### Added

* run tests with coverage and show it in the editor ([#19](https://github.com/elide-dev/vscode/issues/19)) ([7746bd2](https://github.com/elide-dev/vscode/commit/7746bd2fd6a9a4007521bd6b51aaa2b29ede9402))


### Fixed

* sync with elide project export, falling back to elide manifest ([#18](https://github.com/elide-dev/vscode/issues/18)) ([409a569](https://github.com/elide-dev/vscode/commit/409a569d4b4a075455d63e7353e0a1226370585d))

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
