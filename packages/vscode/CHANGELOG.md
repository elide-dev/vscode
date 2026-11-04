# Changelog

All notable changes to the Elide extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Workspace member strings in `elide.pkl` link to the member's manifest and support Go to Definition.
  Hover shows the project's name and description when the member is already loaded and synced.
  Navigation follows unsaved edits without triggering project loading or synchronization.

## [0.8.0](https://github.com/elide-dev/vscode/compare/v0.7.0...v0.8.0) (2026-11-03)


### Added

* **android:** add device tools and shared live Compose previews ([#30](https://github.com/elide-dev/vscode/issues/30)) ([5e96538](https://github.com/elide-dev/vscode/commit/5e96538d1ef4d756ba043bca645a33c6fb98ef7f))
* **editor:** integrate native Kotlin services and improve project workflows ([#29](https://github.com/elide-dev/vscode/issues/29)) ([d5741dc](https://github.com/elide-dev/vscode/commit/d5741dc17d551459f3651a46951169187147f462))
* **editor:** support Elide build extension authoring and self-build projects ([#31](https://github.com/elide-dev/vscode/issues/31)) ([021ac1c](https://github.com/elide-dev/vscode/commit/021ac1c327cea66200514086529e683c8248b0ff))
* organize sidebar targets with pinned and frequent shortcuts ([#32](https://github.com/elide-dev/vscode/issues/32)) ([0098221](https://github.com/elide-dev/vscode/commit/00982213f8b4a96bb910ad51f8b8976d83556572))

## [0.7.0](https://github.com/elide-dev/vscode/compare/v0.6.1...v0.7.0) (2026-11-01)

### Added

- **Android SDK diagnostics:** **Check Android Environment** inspects an independently installed SDK,
  platform-tools and connected devices. Works without `elide.pkl` or a successful sync; never installs
  components or accepts licenses.
- **Android Logcat:** connected-device selection, aligned and theme-colored output, application UID,
  priority and literal-text filters, and clear, stop and restart commands. Streams initially show all
  applications; filters accept an application ID manually or read it from an existing APK, including
  renamed IDs. Showing a running stream reveals it without restarting. Clearing output leaves the
  device's shared log buffer intact.
- **Logcat source navigation:** clickable Kotlin/Java application stack frames across synced source
  roots and ordinary unsynced workspace folders. Ambiguous, native, unknown and out-of-range frames
  remain unlinked.
- **Compose editor analysis:** detect Compose runtime dependencies or Kotlin compiler-plugin declarations,
  use the JetBrains language server's matching Compose compiler plugin, and suppress `FunctionName`
  warnings only on `@Composable` functions. Other capitalized function names remain reported.
- **Activity view:** inspect sync steps, CLI commands and tasks reported in Elide's ordinary text output,
  with durations, skipped-task reasons and timestamped logs. Cancel running operations from their rows.
- **Visible sync status:** current step and elapsed time in the status bar, a cancellable notification
  for longer syncs, timing breakdowns, and an actionable log when a step fails.

### Changed

- Resolve workspace projects and member manifests concurrently; use batched JSON classpath queries
  where supported, retaining individual-query compatibility for older Elide releases.
- Install Kotlin by JetBrains as a companion rather than a hard activation dependency. Elide CLI
  features remain available independently; Kotlin and Java source documents activate the companion.
- Keep sync output focused on commands, human-readable CLI output, exit status and durations instead
  of echoing exported project models and classpaths.
- Migrate build, type-checking, unit tests and VSIX packaging to Bazel and pnpm.
- Update extension and activity-bar icons to the Elide block mark.
- Limit this release to released-runtime capabilities. Android build/deployment/debug/emulator
  workflows, generated Android/Hilt editor models, Compose previews (including Komodo), and structured
  progress-record integration are not included.

### Fixed

- Preserve manifest edits made during or immediately after sync, mark the model stale and resync
  according to policy, and reinstall dependencies even if an intervening command rewrote the lockfile.
- Watch local Pkl modules imported, amended or extended by manifests, including modules outside the
  workspace, and reinstall dependencies when those inputs change.
- Include legitimate package directories named `build`, `out`, `dist` or `generated` in Logcat source
  navigation beneath declared source roots.
- Keep integration smoke edits in temporary fixture copies, disable updates to shared extensions, and
  use short macOS scratch paths without overriding `TMPDIR`.


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
