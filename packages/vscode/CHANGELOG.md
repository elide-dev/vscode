# Changelog

All notable changes to the Elide extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `Elide: Show Menu` — a quick pick with sync, run, test, manifest, workspace and output actions. The status bar item
  opens it instead of syncing directly, shows the project name when the window holds a single Elide project, and
  offers the last sync failure as the first entry.
- `elide.install.classifiers` (default `["sources"]`): the classifier jars installed for the manifest's declared
  Maven packages, so Go to Definition opens library sources. Changing the setting forces a re-install.
- A warning when the resolved Elide CLI is older than 1.5.0, shown once per distribution; the release is logged to
  the output channel on every sync.
- **Run/Debug code lenses**: `Run with Elide`/`Debug with Elide` above JVM `main` functions in a project's production
  sources — the suffix keeps them apart from the Kotlin LSP's own, unsuppressible `Run`/`Debug` pair, which launches
  through the IntelliJ debug adapter instead of `elide run` — and `Run`/`Debug` on `jvm.main`, `entrypoint` elements,
  `scripts` entries (Run) and `artifacts` entries (Build) in `elide.pkl`. Toggle with `elide.codeLens.enabled`.
- **Test Explorer** for JUnit tests in the project's test source roots: the tree is discovered by scanning the test
  sources (no compilation), follows unsaved edits, and runs `elide test --reporter=tap` — the whole project, or
  `--test-name-pattern=<pattern>` for a narrower selection. Failures carry the assertion message, the stack trace,
  and a location taken from the first frame in the test's own file. The Debug profile runs the same command under a
  JDWP agent and attaches `elide.debug.adapter`.
- **Elide sidebar**: an activity-bar view listing every project with its entrypoints, tasks, build targets
  (`elide build --inspect`, loaded on first expansion), source sets and dependencies. Rows carry inline Run, Debug,
  Build, Sync and Open-manifest actions; a dependency can be revealed in the OS file manager. With no project in the
  workspace the view shows what to do instead.
- The `$elide` problem matcher on every `elide` task: kotlinc errors and warnings become diagnostics on the reported
  file and line, resolved by searching the workspace folder.
- Commands `Elide: Run Entrypoint`, `Elide: Debug Entrypoint`, `Elide: Build Artifact`, `Elide: Run Task` and
  `Elide: Open elide.pkl`, invoked with a project root and argument vector by the code lenses and menus.
- **`Elide: New Project…`**: a wizard over `elide init` — it lists the templates the installed CLI reports
  (`elide init --templates --json`), asks for each template parameter with the CLI's own validation, asks which
  optional blocks to include, generates the project in a directory you pick and opens it. Reachable from the
  palette, the Elide view's title bar, the empty-workspace welcome view and the Elide menu.
- A **Get started with Elide** walkthrough: install the CLI, open or create a project, sync with the Kotlin LSP,
  run and debug, run tests.
- **Full invocation control** for tasks and launch configurations: `flags` (`-f NAME[=VALUE]` build flags),
  `options` (any CLI option of the subcommand, as a name/value object), `programArgs` (arguments after `--`, for the
  application `elide run` starts) and `env`, with `args` as the subcommand's positional arguments. Launch
  configurations additionally take `command` (`run`, `test` or `build`) and `elideArgs` for positional arguments.
- **Debugging build targets**: a launch configuration with `command: "build"` runs `elide build <targets> --debugger`
  and attaches, with the targets listed in `targets` and their task options in `options`. The sidebar's **Build
  targets** rows gained a Debug action for every target that declares `--debugger`, and a build configuration with
  no target is rejected with a message instead of waiting for an agent that never starts.
- Workspace defaults for those invocations: `elide.flags` (applied to every invocation, project sync included, so
  the resolved model matches the flags the build sees) and `elide.build.options`, `elide.run.options`,
  `elide.test.options`, `elide.install.options`. A task or launch configuration overrides them per key, and a `false`
  value cancels an inherited option. Test Explorer runs honour `elide.test.options` except for `reporter`, which
  stays `tap`.

### Changed

- Manifests nested inside another Elide project (vendored checkouts, samples, fixtures) are no longer imported as
  projects: only the outermost `elide.pkl` of each directory tree is synced, and edits to nested manifests no longer
  mark the folder out of date. Deleting an enclosing manifest promotes the manifests it was shadowing.

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
- **Mixed-editor support**: `intellij.buildTool` is pinned to `json` in workspace settings so a checked-in `.idea`
  directory and the Elide model can coexist, and `intellij.jdkForSymbolResolution` is written to user settings so no
  machine-specific path is committed.
- **Tasks** (`elide` task type): `build`, `test`, `install`, and one `run` task per manifest entrypoint
  (`entrypoint`, `jvm.main`, `scripts`).
- **Debugging** (`elide` debug type): runs `elide run --debugger`, waits for the JDWP listener, and attaches either the
  JetBrains JVM debugger or Debugger for Java (`elide.debug.adapter`).
- **Commands**: `Elide: Sync Project(s)`, `Elide: Run Elide Command…`, `Elide: Open generated Kotlin LSP workspace`,
  `Elide: Show Output`, plus a status bar item reflecting sync state.
- **Settings**: `elide.home`, `elide.jdk.home`, `elide.sync.onStartup`, `elide.sync.onManifestChange`,
  `elide.kotlinLsp.writeWorkspaceJson`, `elide.debug.adapter`.

[Unreleased]: https://github.com/elide-dev/vscode/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/elide-dev/vscode/releases/tag/v0.1.0
