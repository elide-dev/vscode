# Changelog

All notable changes to the Elide extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
