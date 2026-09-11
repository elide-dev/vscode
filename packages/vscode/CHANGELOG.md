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
- The `$elide` problem matcher on every `elide` task: kotlinc errors and warnings become diagnostics on the reported
  file and line, resolved by searching the workspace folder.
- Commands `Elide: Run Entrypoint`, `Elide: Debug Entrypoint`, `Elide: Build Artifact`, `Elide: Run Task` and
  `Elide: Open elide.pkl`, invoked with a project root and argument vector by the code lenses and menus.

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
