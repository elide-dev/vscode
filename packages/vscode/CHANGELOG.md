# Changelog

All notable changes to the Elide extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

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
