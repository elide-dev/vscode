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
  checkouts, samples) are separate builds and are not imported.
- **Kotlin/Java code intelligence.** The project model is written as a `workspace.json` the Kotlin LSP imports —
  modules per source set, libraries with attached sources and javadoc, the selected JDK, and the manifest's Kotlin
  compiler options.
- **Mixed-editor checkouts.** A repository can carry both an IntelliJ `.idea` directory and the generated
  `workspace.json`; each editor uses its own.
- **Tasks.** `elide build`, `elide test`, `elide install`, and one run task per manifest entrypoint.
- **Debugging.** Launch `elide run --debugger` and attach with breakpoints in Kotlin and Java.

## Requirements

| | |
| --- | --- |
| [Elide](https://elide.dev) **1.5+** | Found via `elide.home`, `$ELIDE_HOME`, the platform install locations, or `PATH`. |
| **Kotlin by JetBrains** (`JetBrains.kotlin-server`, ≥ 0.0.11) | Installed automatically as an extension dependency. Complete its one-time region / data-sharing prompt so the server starts. |
| A JDK | `$JAVA_HOME`, SDKMAN, `/Library/Java/JavaVirtualMachines`, `/usr/lib/jvm`, or `elide.jdk.home`. Elide's bundled JDK image cannot be used for symbol resolution: it ships without a `release` file. |

The extension needs a trusted workspace and a local filesystem — syncing runs the workspace's Elide CLI.

## Getting started

1. Open a folder containing `elide.pkl`. The status bar shows the project name and sync progress; click it for the
   Elide actions, or run `Elide: Show Output` for the CLI log.
2. Open a Kotlin or Java file. Once the Kotlin LSP has imported the generated `workspace.json`, completion and
   navigation resolve against the project's dependencies.
3. Run `Elide: Run Elide Command…`, or press F5 with an `elide` launch configuration to debug.

`workspace.json` is a generated artifact — add it to `.gitignore`.

## Commands

| Command | Description |
| --- | --- |
| `Elide: Sync Project(s)` | Re-run the sync. |
| `Elide: Show Menu` | Quick pick with the Elide actions (what the status bar item opens). |
| `Elide: Run Elide Command…` | Pick `build`, `test`, `install`, or `run <entrypoint>` and run it as a task. |
| `Elide: Open generated Kotlin LSP workspace` | Open the generated `workspace.json`. |
| `Elide: Show Output` | Open the `Elide` output channel. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `elide.home` | `""` | Distribution root containing `bin/elide`. |
| `elide.jdk.home` | `""` | JDK for symbol resolution; else `jvm.javaHome`, `$JAVA_HOME`, installed JDKs matching `jvm.target`. |
| `elide.sync.onStartup` | `true` | Sync when the workspace opens. |
| `elide.sync.onManifestChange` | `"prompt"` | `always` / `prompt` / `never` when `elide.pkl` or the lockfile changes. |
| `elide.kotlinLsp.writeWorkspaceJson` | `true` | Write `<folder>/workspace.json`. |
| `elide.install.classifiers` | `["sources"]` | Classifiers installed for declared Maven packages (`sources`, `docs`); empty installs classes only. Elide's own Kotlin/JUnit jars have none. |
| `elide.debug.adapter` | `"intellij"` | Attach with the JetBrains JVM debugger (`intellij`) or Debugger for Java (`java`). |

The extension also maintains two Kotlin LSP settings: `intellij.buildTool` (pinned to `json` in workspace settings) and
`intellij.jdkForSymbolResolution` (an absolute path, written to user settings only). Explicit values you set by hand
are never overwritten.

## Tasks and debugging

Task type `elide` takes `command` (`build` | `run` | `test` | `install`), optional `args`, and `project` (project root
relative to the workspace folder). Launch configurations use type `elide`:

```jsonc
{ "type": "elide", "request": "launch", "name": "Elide: Run (debug)", "entrypoint": "src/main.kt", "args": [] }
```

The extension runs `elide run --debugger`, waits for the JDWP listener, and attaches the configured debug adapter;
ending the session stops the Elide process. The JDWP agent always binds port 5005, so one debug session at a time.

## Links

- [Repository, full documentation, and issues](https://github.com/elide-dev/vscode)
- [Changelog](https://github.com/elide-dev/vscode/blob/main/packages/vscode/CHANGELOG.md)
- [Elide documentation](https://docs.elide.dev)

Licensed under the [MIT license](https://github.com/elide-dev/vscode/blob/main/LICENSE).
