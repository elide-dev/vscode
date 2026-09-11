# Elide for Visual Studio Code

[![CI](https://github.com/elide-dev/vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/elide-dev/vscode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

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
`.dev/` and `node_modules/`) becomes a set of modules in that folder's single `workspace.json`. A manifest nested
inside another project's directory — a vendored checkout, a sample, a fixture — is a separate build the enclosing
project does not invoke: only the outermost manifest of each tree is imported, and changes to the nested ones do not
trigger a sync.

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
| `Elide: Sync Project(s)` | Re-run the sync. |
| `Elide: Show Menu` | Quick pick with the Elide actions (what the status bar item opens). |
| `Elide: Run Elide Command…` | Pick `build`, `test`, `install`, or `run <entrypoint>` and run it as a task. |
| `Elide: Open generated Kotlin LSP workspace` | Open `workspace.json`. |
| `Elide: Show Output` | Open the `Elide` output channel (CLI output, sync log). |

## Tasks

Task type `elide` with `command` (`build` \| `run` \| `test` \| `install`), optional `args`, and `project` (root relative
to the workspace folder). Provided tasks: `elide: build`, `elide: test`, `elide: install`, and one `elide: run …` per
manifest entrypoint (`entrypoint`, `jvm.main`, `scripts`).

Every task reports through the `$elide` problem matcher, so compiler errors and warnings land in **Problems** and on
the offending line. It matches the two-line kotlinc shape Elide prints — `[212ms] error: kotlinc: <message>` followed
by `In file: <path>[:<line>[:<col>]]` — and resolves the path by searching the workspace folder (skipping `.dev`,
`.git` and `node_modules`), so relative paths reported from a project root in a subdirectory still resolve. `javac`
diagnostics interleave `symbol:`/`location:` lines between the two and are shown in the terminal only.

## Run and debug code lenses

**Run with Elide** / **Debug with Elide** appear above every `fun main(` (Kotlin, including `@JvmStatic fun main` in
an `object`) and `public static void main` in a production source root of a synced project, and **Run** / **Debug**
in `elide.pkl` on `jvm.main`, on each `entrypoint` element, on each `scripts` entry (**Run script** — a script is a
shell command line, so there is nothing to attach a debugger to) and on each `artifacts` entry (**Build**). A file
whose main class is the manifest's `jvm.main` runs as `elide run`; any other file is passed to Elide as the
entrypoint. Detection is regex-based — no Kotlin or Java parser is involved — so exotic declarations are missed; set
`elide.codeLens.enabled` to `false` to turn the lenses off.

The JetBrains Kotlin LSP contributes a second, unqualified **Run** / **Debug** pair on the same line from its own
`LSJvmRunMainCodeLensProvider`. It is a server-side feature with no setting, no registry flag and no exported client
API, so this extension cannot suppress it — hence the `with Elide` suffix. That pair launches the class through the
IntelliJ debug adapter rather than `elide run`, so it does not build first and does not see the project's compiled
output, which `workspace.json` does not carry.

## Test Explorer

JUnit tests in the **test** source roots of a synced project appear in the **Testing** view, grouped project → class
→ method, with nested classes nested. Discovery is static: the test sources of the project model are scanned for
`@Test` (and `@ParameterizedTest`, `@RepeatedTest`, `@TestFactory`, `@TestTemplate`) declarations, so the tree is
populated without compiling or running anything, and it follows edits — saved or not — through a file watcher and the
open editor's buffer. Like the code lenses, the scan is regex-based, so exotic declarations are missed.

A run executes `elide test --reporter=tap` in the project root, adding `-t <pattern>` whenever the selection is
narrower than the whole project (the JVM engine full-matches that pattern against `pkg.Class#method`, with `$`
separating nested classes). Results are reported as the TAP stream settles: a failure's `message` and `detail` block
become the test's message, and the first stack frame naming the test's own file positions it in the editor. A label
that matches no discovered item is added under the project item, so a result is never dropped; a run that reports no
result at all (a pattern matching nothing, a compile error) marks the selected tests errored with the CLI's stderr.

The **Debug** profile runs the same command with a bare `--debugger` and attaches `elide.debug.adapter` once the JDWP
agent announces itself. That flag takes no address on `elide test`: the agent always binds 5005, so one debug run at
a time.

## Debugging

Launch configuration type `elide`:

```jsonc
{ "type": "elide", "request": "launch", "name": "Elide: Run (debug)", "entrypoint": "src/main.kt", "args": [] }
```

The extension runs `elide run --debugger [entrypoint] [-- args]` in a terminal, waits for the JDWP agent's
`Listening for transport dt_socket at address: <port>` line, then attaches the JetBrains JVM debugger
(`elide.debug.adapter`: `intellij`) or Debugger for Java (`java`, requires `vscjava.vscode-java-debug`). Stopping the
session terminates the Elide process. The JDWP agent always binds port 5005, so one debug session at a time.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `elide.home` | `""` | Distribution root containing `bin/elide`. |
| `elide.jdk.home` | `""` | JDK for symbol resolution; else `jvm.javaHome`, `$JAVA_HOME`, installed JDKs matching `jvm.target`. |
| `elide.sync.onStartup` | `true` | Sync when the workspace opens. |
| `elide.sync.onManifestChange` | `"prompt"` | `always` / `prompt` / `never` when `elide.pkl` or the lockfile changes. |
| `elide.kotlinLsp.writeWorkspaceJson` | `true` | Write `<folder>/workspace.json`. |
| `elide.install.classifiers` | `["sources"]` | Classifiers installed for declared Maven packages (`sources`, `docs`); empty installs classes only. Elide's own Kotlin/JUnit jars have none. |
| `elide.codeLens.enabled` | `true` | Show the Run/Debug code lenses described above. |
| `elide.debug.adapter` | `"intellij"` | `intellij` or `java`. |

## Repository layout

- `packages/core` — `@elide/ide-core`: editor-agnostic library (Elide discovery, CLI runner, manifest decoding, project
  model, `workspace.json` emitter). No VS Code dependency; reusable by other TypeScript-based editor integrations.
- `packages/vscode` — the extension; its `CHANGELOG.md` is the release history shown on the Marketplace.
- `samples/ktjvm` — Kotlin/JVM sample used by the integration test.
- `tools/deploy.sh` — packaging and publication to `plugins.elide.dev`.

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

## Contributing

Issues and pull requests are welcome. [`CONTRIBUTING.md`](CONTRIBUTING.md) covers the dev loop, the commit convention
(Conventional Commits, enforced on pull requests), and the release process; participation is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in
[`SECURITY.md`](SECURITY.md) — not in a public issue.

## License

MIT — see [`LICENSE`](LICENSE).
