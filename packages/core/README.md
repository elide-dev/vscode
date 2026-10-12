# @elide/ide-core

Editor-agnostic project model for the [Elide](https://elide.dev) build tool, extracted from the
[VS Code extension](https://github.com/elide-dev/vscode) so other editor integrations can reuse it. No editor API
is referenced anywhere in this package.

## What it does

| Module | Responsibility |
| --- | --- |
| `elide.ts` | Locate an Elide distribution (explicit home, `$ELIDE_HOME`, platform install locations, `PATH`) and run CLI commands (`project export` / `manifest`, `install`, `classpath`, `build`). |
| `manifest.ts` | Decode the exported project JSON into a typed manifest: source sets, Kotlin compiler options, entrypoints, JVM settings. |
| `sourceRoots.ts`, `libraries.ts` | Derive source roots and resolve classpath entries into libraries with attached `-sources.jar` / `-javadoc.jar`. |
| `jdk.ts` | Discover installed JDKs (SDKMAN, macOS, Linux, Windows locations) and pick one matching the project's `jvm.target`. |
| `model.ts` | The resulting project model: projects, modules, libraries, SDK. |
| `workspace.ts` | Elide workspaces: members declared by a manifest, sibling artifacts on a member's classpath and the source sets behind them. |
| `pkl.ts` | Read and edit `elide.pkl` as text, for what the exported project model cannot answer (artifact source positions, the workspace above a folder). |
| `kotlinLsp.ts` | Emit the JSON workspace (`workspace.json`) consumed by the JetBrains Kotlin language server. |
| `android.ts` | Android build targets, published and staged artifact paths, SDK resolution (`android.sdk`, `ANDROID_HOME`, the conventional location) and the attached devices `adb` reports. |
| `androidLogcat.ts` | Abortable adb log streams, application UID resolution, priority and literal-text filtering, and explicit stop/restart lifecycle. |
| `composeInputs.ts` | Host Compose preview build targets and postbuild JVM/runtime inputs: declared source-set/workspace closure, linked resources and merged-manifest namespace, without dexing or packaging an app. |

## Usage

```ts
import { ElideCli, buildProjectModels, resolveElideDistribution, writeKotlinLspWorkspace } from "@elide/ide-core";

const distribution = resolveElideDistribution();
const cli = new ElideCli(distribution, projectRoot);
const manifest = await cli.manifest();
// The project first, then the members its manifest declares when it is the root of an Elide workspace.
const models = await buildProjectModels(cli, manifest);
await writeKotlinLspWorkspace(models, workspaceRoot);
```

For Compose projects, pass `{ composeCompilerPlugin: "/absolute/path/to/the/language-server/compose-plugin.jar" }`
as the third argument to `writeKotlinLspWorkspace`. It must match the language server's compiler, not necessarily
the project's build compiler. The VSCode adapter resolves the installed JetBrains extension's bundled plugin.
Models expose `kotlin.compose`; processor/Hilt projects generate and import actual Java/kapt sources during sync.

The package is ESM-only, built with `tsc`, and ships type declarations. It is not published to npm today; it is
consumed through the workspace by `packages/vscode`.

## Development

```bash
bun install
bun run --filter '@elide/ide-core' build
bun test
```

MIT licensed. See [LICENSE](./LICENSE).
