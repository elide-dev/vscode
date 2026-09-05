# Elide for Visual Studio Code

VS Code integration for the [Elide](https://elide.dev) build tool. The extension turns an `elide.pkl` project into a
model the [Kotlin LSP by JetBrains](https://marketplace.visualstudio.com/items?itemName=JetBrains.kotlin-server) can
import — resolved Maven dependencies, source roots, JDK — and adds Elide build/run/test tasks and JDWP debugging.

## Install

Until the extension is on the Marketplace, install the `.vsix` from `plugins.elide.dev` (the same worker that hosts the
IntelliJ plugin repository). The link is version-less and always resolves to the current release:

```sh
curl -LOJ "https://plugins.elide.dev/vscode/files?id=elide.elide"   # → elide-<version>.vsix
code --install-extension elide-*.vsix
```

Or in VS Code: **Extensions ▸ … ▸ Install from VSIX…**. `https://plugins.elide.dev/vscode` lists the published version
and a pinned (`&version=`) link.

## Releasing

Push a `vX.Y.Z` tag matching `packages/vscode/package.json`'s `version`. The `Release` workflow runs `tools/deploy.sh`
— package, presigned R2 upload, metadata upsert against `plugins.elide.dev` — and attaches the `.vsix` to a GitHub
release. It needs the `ELIDE_PLUGINS_KEY` secret and the `ELIDE_PLUGINS_URL` variable, exactly like `elide-intellij`.
Running `tools/deploy.sh` by hand works too with those two set in the environment.

## Requirements

- Elide **1.5+** installed (`~/.local/share/elide`, `$ELIDE_HOME`, or `elide` on `PATH`).
- The **Kotlin by JetBrains** extension (`JetBrains.kotlin-server`, ≥ 0.0.11). It is declared as an extension
  dependency and installed automatically; complete its one-time region / data-sharing setup so the language server
  starts.
- A JDK for symbol resolution (`$JAVA_HOME`, SDKMAN, `/Library/Java/JavaVirtualMachines`, `/usr/lib/jvm`, …). Elide's
  bundled JDK image cannot serve this role: it ships without a `release` file, which IntelliJ needs to enumerate modules.

## How it works

Opening a folder that contains `elide.pkl` runs a **sync**:

1. `elide manifest` — the resolved project manifest as JSON (source sets, Kotlin compiler options, entrypoints).
2. `elide install` — only when the lockfile (`.dev/elide.lock*.bin`) is older than the manifest.
3. `elide classpath <source set>:compile` for every compilable source set.
4. `workspace.json` is written at the workspace folder root in the Kotlin LSP's JSON workspace format (one module per
   source set, one library per jar with `-sources.jar`/`-javadoc.jar` attached when present, the selected JDK as SDK,
   Kotlin language/API level and free compiler args as kotlinc flags).
5. Two Kotlin LSP settings are maintained: `intellij.buildTool` is pinned to `json` in the workspace, and
   `intellij.jdkForSymbolResolution` is written to **user** settings. A running Kotlin LSP is then asked to reload.

`workspace.json` is a generated artifact — add it to `.gitignore`. Every `elide.pkl` under a workspace folder (outside
`.dev/` and `node_modules/`) becomes a set of modules in that folder's single `workspace.json`.

### Mixed-editor checkouts (`.idea`, Gradle, Maven)

The Kotlin LSP only reads `workspace.json` when no build system claims the folder first: it matches `jps`
(`.idea/modules.xml`), `gradle`, `maven`, and `bazel` before falling back to the JSON importer, and asks the user to
choose when several match. A checked-in `.idea` from a teammate on IntelliJ would therefore be imported instead of the
Elide model. Pinning `intellij.buildTool` to `json` skips detection, so `.idea` and `workspace.json` coexist: IntelliJ
ignores `workspace.json`, VS Code ignores `.idea`. The pin is skipped when the window holds a folder without an Elide
project (the setting is window-scoped and would disable that folder's Gradle/Maven import) — set it per workspace by
hand there. An explicit `intellij.buildTool` in user, workspace, or folder settings is never overwritten.

### Settings the extension writes

| Setting | Scope written | Why |
| --- | --- | --- |
| `intellij.buildTool` | workspace (`.vscode/settings.json`) | `json`; portable, correct for everyone who opens the repo in VS Code. Safe to commit. |
| `intellij.jdkForSymbolResolution` | user settings | An absolute JDK path for this machine. Committed, it breaks every other checkout: the importer rejects a `defaultSdk` that is not a directory and the whole import fails. |

A workspace or folder value of `intellij.jdkForSymbolResolution` that does not resolve on this machine (a path
committed by a teammate, or written by an older version of this extension) is cleared on sync; one that does resolve is
treated as a deliberate project override and kept. In user settings, only a value this extension wrote is updated —
anything you set by hand stays.

## Commands

| Command | Description |
| --- | --- |
| `Elide: Sync Project(s)` | Re-run the sync (status bar item does the same). |
| `Elide: Run Elide Command…` | Pick `build`, `test`, `install`, or `run <entrypoint>` and run it as a task. |
| `Elide: Open generated Kotlin LSP workspace` | Open `workspace.json`. |
| `Elide: Show Output` | Open the `Elide` output channel (CLI output, sync log). |

## Tasks

Task type `elide` with `command` (`build` \| `run` \| `test` \| `install`), optional `args`, and `project` (root relative
to the workspace folder). Provided tasks: `elide: build`, `elide: test`, `elide: install`, and one `elide: run …` per
manifest entrypoint (`entrypoint`, `jvm.main`, `scripts`).

## Debugging

Launch configuration type `elide`:

```jsonc
{ "type": "elide", "request": "launch", "name": "Elide: Run (debug)", "entrypoint": "src/main.kt", "args": [] }
```

The extension runs `elide run --debugger [entrypoint] [-- args]` in a terminal, waits for the JDWP agent's
`Listening for transport dt_socket at address: <port>` line, then attaches the JetBrains JVM debugger
(`elide.debug.adapter`: `intellij`) or Debugger for Java (`java`, requires `vscjava.vscode-java-debug`). Stopping the
session terminates the Elide process. `elide test` does not accept `--debugger`, so tests are run, not debugged.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `elide.home` | `""` | Distribution root containing `bin/elide`. |
| `elide.jdk.home` | `""` | JDK for symbol resolution; else `jvm.javaHome`, `$JAVA_HOME`, installed JDKs matching `jvm.target`. |
| `elide.sync.onStartup` | `true` | Sync when the workspace opens. |
| `elide.sync.onManifestChange` | `"prompt"` | `always` / `prompt` / `never` when `elide.pkl` or the lockfile changes. |
| `elide.kotlinLsp.writeWorkspaceJson` | `true` | Write `<folder>/workspace.json`. |
| `elide.debug.adapter` | `"intellij"` | `intellij` or `java`. |

## Repository layout

- `packages/core` — `@elide/ide-core`: editor-agnostic library (Elide discovery, CLI runner, manifest decoding, project
  model, `workspace.json` emitter). No VS Code dependency; reusable by other TypeScript-based editor integrations.
- `packages/vscode` — the extension.
- `samples/ktjvm` — Kotlin/JVM sample used by the integration test.

## Development

```bash
bun install
bun run build                       # core (tsc) + extension (esbuild)
bun test                            # core unit tests
cd packages/vscode && bun run test:integration   # drives real VS Code + Kotlin LSP against samples/ktjvm
```

The integration test requires VS Code at `/Applications/Visual Studio Code.app`, `JetBrains.kotlin-server` installed
in `~/.vscode/extensions`, `elide` installed, and network access (it adds Guava to the sample). Press F5 in this repo to
run the extension against `samples/ktjvm`.
