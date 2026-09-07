# @elide/ide-core

Editor-agnostic project model for the [Elide](https://elide.dev) build tool, extracted from the
[VS Code extension](https://github.com/elide-dev/vscode) so other editor integrations can reuse it. No editor API
is referenced anywhere in this package.

## What it does

| Module | Responsibility |
| --- | --- |
| `elide.ts` | Locate an Elide distribution (explicit home, `$ELIDE_HOME`, platform install locations, `PATH`) and run CLI commands (`manifest`, `install`, `classpath`). |
| `manifest.ts` | Decode `elide manifest` JSON into a typed manifest: source sets, Kotlin compiler options, entrypoints, JVM settings. |
| `sourceRoots.ts`, `libraries.ts` | Derive source roots and resolve classpath entries into libraries with attached `-sources.jar` / `-javadoc.jar`. |
| `jdk.ts` | Discover installed JDKs (SDKMAN, macOS, Linux, Windows locations) and pick one matching the project's `jvm.target`. |
| `model.ts` | The resulting project model: projects, modules, libraries, SDK. |
| `kotlinLsp.ts` | Emit the JSON workspace (`workspace.json`) consumed by the JetBrains Kotlin language server. |

## Usage

```ts
import { ElideCli, buildProjectModel, resolveElideDistribution, writeKotlinLspWorkspace } from "@elide/ide-core";

const distribution = resolveElideDistribution();
const cli = new ElideCli(distribution, projectRoot);
const manifest = await cli.manifest();
const model = await buildProjectModel(cli, manifest);
await writeKotlinLspWorkspace([model], workspaceRoot);
```

The package is ESM-only, built with `tsc`, and ships type declarations. It is not published to npm today; it is
consumed through the workspace by `packages/vscode`.

## Development

```bash
bun install
bun run --filter '@elide/ide-core' build
bun test
```

MIT licensed. See [LICENSE](./LICENSE).
