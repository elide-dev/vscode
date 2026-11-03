# Contributing to elide-vscode

Thanks for your interest in improving the Elide extension for VS Code. This document covers
everything you need to build, test, and submit changes.

## Prerequisites

- [Bazelisk](https://github.com/bazelbuild/bazelisk), installed as `bazel`. It runs the Bazel version pinned in
  `.bazelversion`, and Bazel fetches every other tool at a pinned version (Node.js, pnpm, TypeScript, esbuild, Bun,
  vsce): nothing else needs to be installed to build and test.
- VS Code 1.105 or newer, if you want to run the extension itself (via the `Run Extension` launch
  configuration).
- For manual/integration testing: [Elide](https://elide.dev) 1.5 or newer installed locally, and the
  `JetBrains.kotlin-server` VS Code extension (provides the Kotlin language server).

## Repository layout

- `packages/core` — `@elide/ide-core`, an editor-agnostic library consumed by the extension. Built
  with `tsc`; unit-tested with `bun test`.
- `packages/vscode` — the VS Code extension itself. Bundled with esbuild, packaged with `vsce`; unit-tested with
  `bun test`.
- `samples/ktjvm` — a sample Kotlin/JVM project used to exercise the extension during development and
  by the local-only integration test.
- `samples/workspace` — an Elide workspace for the integration test's `workspace` scenario.
- `tools/deploy.sh` — release/deploy helper script.
- `tools/build-database-inspector.ts` — rebuilds the Android database inspector's DEX (see below).
- `tools/bazel` — repository-local Bazel rules (the hermetic Bun used by `bun_test`).

## Dev loop

The build is [Bazel](https://bazel.build) with [rules_js](https://github.com/aspect-build/rules_js) and
[rules_ts](https://github.com/aspect-build/rules_ts); npm dependencies come from the pnpm workspace
(`pnpm-workspace.yaml`, `pnpm-lock.yaml`).

```sh
bazel test //...                                  # build and type-check everything, package the .vsix, run unit tests
bazel test //packages/core:test                   # unit tests for packages/core only
bazel test //packages/vscode:test                 # unit tests for packages/vscode only
bazel build //packages/vscode:extension           # the extension, at bazel-bin/packages/vscode
bazel build //packages/vscode:vsix                # bazel-bin/packages/vscode/elide.vsix
```

Unit tests, including Komodo session and Android process-lifecycle coverage, use local protocol
stand-ins and fake executables; they do not require Komodo, Elide, an Android SDK or a device.
Keep these tests enabled in CI. Subprocess readiness checks observe persistent marker contents,
not directory-watch notifications, which can be coalesced before a marker write completes.
Cancellation checks observe actual child-process exit, not a signal-handler marker: a forcibly
terminated child cannot write one.
Tests requiring real optional components belong in the explicitly invoked integration scenarios below.

Outputs land in `bazel-bin/`, never in the source tree. To run the extension interactively, open this repo in VS Code
and start the `Run Extension` launch configuration: it builds `//packages/vscode:extension` and opens `samples/ktjvm`
in an Extension Development Host loading `bazel-bin/packages/vscode`.

For editor support (the TypeScript language service needs `node_modules`), install the workspace with the pinned
pnpm: `bazel run -- @pnpm//:pnpm --dir "$PWD" install`. Bazel itself never reads those `node_modules`. No build is
needed for the editor to see `@elide/ide-core`: `packages/vscode/tsconfig.json` references the `packages/core`
project, so the language service reads its sources in place of the `dist/` outputs that only exist in `bazel-bin`.

### Dependencies and BUILD files

- Add or bump an npm dependency in the package's `package.json`; the next Bazel build re-locks `pnpm-lock.yaml` and
  stops, asking to be run again. Commit the lockfile together with `.aspect/rules/external_repository_action_cache/`;
  CI fails on a stale lockfile.
- `BUILD.bazel` files are maintained by [Gazelle](https://github.com/aspect-build/aspect-gazelle): after adding,
  removing or re-importing source files, run `bazel run //:gazelle`. CI runs `bazel run //:gazelle.check`. Gazelle
  leaves the targets it does not generate (bundles, tests, the `.vsix`) alone; those are maintained by hand.
- Tool versions live in `MODULE.bazel` (Node.js, esbuild, rulesets), `tools/bazel/bun/extensions.bzl` (Bun),
  `package.json` (`packageManager` for pnpm, `typescript`) and `.bazelversion`.

### Working in several worktrees

Concurrent builds in separate `git worktree`s are safe. Bazel keys each checkout's output base, server and
`bazel-*` symlinks by the checkout's path, and nothing is written to the source tree, so worktrees share no mutable
build state. They do share two content-addressed caches that tolerate concurrent writers: Bazel's repository cache
(downloads) and the disk cache at `~/.cache/bazel-disk/elide-vscode` (action outputs, capped at 10 GB), so a fresh
worktree reuses whatever another one already built. Per-worktree flags go in a gitignored `user.bazelrc`.

Each worktree keeps its own Bazel server (idle for up to three hours) and output base: run `bazel shutdown` in a
worktree you are done with, and `bazel clean --expunge` before removing it to free its output base.

### Integration tests

Integration tests require a real VS Code install, the `JetBrains.kotlin-server` extension, and a local
Elide install, so they are not run in CI. To run them locally:

```sh
bazel run //packages/vscode:integration_test
```

Every run works on its own temporary copy of the sample and its own VS Code user data directory, so runs from
different worktrees can overlap. They share the installed extensions in `~/.vscode/extensions`; test instances run
with extension auto-update off so they leave that directory alone.

The default scenario drives `samples/ktjvm`. `ELIDE_TEST_SCENARIO=workspace` runs the Elide-workspace
scenario instead, against `samples/workspace` or the directory `ELIDE_WORKSPACE_SAMPLE` names:

```sh
ELIDE_TEST_SCENARIO=workspace bazel run //packages/vscode:integration_test
```

`ELIDE_TEST_SCENARIO=build-extension` opens `samples/build-extension` with third-party extensions
disabled. It exercises the built-in TypeScript service before sync (inferred and configured TS
projects, JSDoc JS, task/tool completion, invalid-option diagnostics, snippets and non-Elide
isolation), manifest links, real task execution, archive Build lenses, and task-list refresh after
saved additions/removals. Select a build-extension-capable Elide distribution explicitly:

```sh
ELIDE_TEST_SCENARIO=build-extension \
ELIDE_TEST_HOME=/path/to/extension-capable-elide \
bazel run //packages/vscode:integration_test
```

The TypeScript plugin sources and canonical API snapshot live in
`packages/vscode/media/typescript`; Bazel packages them under
`node_modules/elide-build-typescript-plugin` because tsserver only accepts plugin package names.
The snapshot's pinned upstream source and any local backports are recorded in its `package.json`;
update it with the canonical `packages/types/build.d.ts` from Elide, preserving its license and
retaining backports not yet present upstream. Language-service unit regressions use the real
pinned `ts.server.ProjectService` and the packaged plugin loader.

To run the scenario against the shipped files instead of the development output tree, first build
`//packages/vscode:vsix`, then set `ELIDE_TEST_VSIX="$PWD/bazel-bin/packages/vscode/elide.vsix"`
on the same integration invocation. The runner extracts that archive into a temporary extension
directory, copies the test bundle beneath it so VS Code attributes both to the same extension,
and removes the directory afterward. Shipped assets remain unchanged. This local-only path requires
`unzip`. The JVM scenario preserves `ELIDE_TEST_HOME` across temporary runtime-override checks.

`packages/vscode/package-vsix.cjs` retains the pinned vsce manifest/README/license processing and
secret checks, but explicitly includes the unbundled TypeScript plugin: vsce's no-dependencies
traversal skips root `node_modules` regardless of `.vscodeignore`. Keep the packaged smoke in the
verification loop when upgrading vsce or changing plugin packaging.

`ELIDE_TEST_SCENARIO=komodo` drives `samples/ktjvm` through Komodo's language server instead of the JetBrains one,
with every installed extension disabled (as on a machine without the JetBrains extension), and exercises each
capability the server advertises through VS Code's provider commands, logging `PASS`/`FAIL`/`SKIP` per check and a
count. It also exercises repeated reloads with unsaved declarations, CodeLens after declaration edits/reverts, and
native-service disabled activity reporting/recovery without failing project sync. By default the extension asks the selected Elide CLI to resolve its
managed Komodo component, including its compiler plugins and JDK inputs. Install it explicitly with
`elide komodo install --yes --json` or **Elide: Install Komodo**; ordinary activation and sync never install it.
An older CLI reports an upgrade requirement, without changing the selected language server.
For an unpublished local candidate, explicitly authorize the producer's development catalog with
`ELIDE_COMPONENTS_HOME=/absolute/temp/components elide komodo install --catalog /absolute/catalog.json --yes --json`.
Set `ELIDE_TEST_COMPONENTS_HOME` to that same absolute store when launching integration scenarios.
The runner forwards it to the extension host; omit executable/JDK overrides to exercise managed resolution.
For developer builds only, `ELIDE_KOMODO_LSP` names an absolute executable in an intact native bundle,
`ELIDE_KOMODO_JAVA_HOME` its JDK inputs, and `ELIDE_KOMODO_PLUGINS` its compiler plugin directory.
Build the standalone bundle in Komodo; do not copy it into an Elide distribution.
`ELIDE_KOMODO_SAMPLE=android` opens
the built Elide Android sample beside this repository (or `ELIDE_ANDROID_SAMPLE`) in place instead (Compose, workspace
members, Room's kapt output); its files are only edited unsaved and checked unchanged at the end.
`ELIDE_KOMODO_TRACE=1` records the protocol in the `Elide: Komodo` output channel's log, and `ELIDE_KOMODO_COEXIST=1`
keeps the JetBrains extension enabled and logs which `kotlin` grammar VS Code applies:

```sh
ELIDE_TEST_SCENARIO=komodo ELIDE_KOMODO_SAMPLE=android \
ELIDE_TEST_HOME="${ELIDE_TEST_HOME:?set to an Elide distribution with managed Komodo support}" \
bazel run //packages/vscode:integration_test
```

`ELIDE_TEST_SCENARIO=self-build` opens Elide's self-build checkout in place, with third-party
extensions disabled. It checks synchronization (including processor-source generation), native
reference/implementation CodeLenses, full/range semantic highlighting with KDoc, diagnostics,
cross-module and library navigation, unsaved edit/revert recovery, task discovery, and build-extension
TypeScript authoring. Sync updates generated artifacts; editor source edits are unsaved, reverted,
and checked against disk. Use an Elide build that recognizes `kotlin.annotationProcessing` and a
Komodo image with the Java PSI message bundles, platform registry defaults, and KDoc resolver
reflection registrations:

```sh
ELIDE_TEST_SCENARIO=self-build \
ELIDE_SELF_BUILD_ROOT="$HOME/workspaces/elide" \
ELIDE_TEST_HOME=/path/to/compatible-elide \
bazel run //packages/vscode:integration_test
```

`ELIDE_TEST_SCENARIO=compose-komodo` opens the Compose sample (as `compose` does, below) with the `komodo` preview
engine and checks that every card renders live in the language server process, with no JVM child.

`ELIDE_TEST_SCENARIO=compose-agent` opens the same Compose sample and drives the Compose preview MCP tools over HTTP, as an
agent does: composables without `@Preview` (placeholders, arguments, a private one), an existing preview, reference and
wrapper compile errors, and a live session that follows an unsaved edit. `ELIDE_COMPOSE_ENGINE=komodo` selects the
`komodo` engine (and Komodo's language server, as `compose-komodo` does), adding taps and typing into the live card and the
preview panel's pause while the agent's session is open; it needs a Komodo with session appendices. The sample's files are
only edited unsaved and checked unchanged at the end.

`ELIDE_TEST_SCENARIO=komodo-debug` takes the same `ELIDE_KOMODO_*` variables and debugs a copy of `samples/ktjvm`
through Komodo's debug adapter (`komodo --dap`): `Elide: Run (debug)` stops at a Kotlin line breakpoint, reads
a local, evaluates, steps and runs the program to its end.

`ELIDE_TEST_SCENARIO=komodo-android-debug` exercises the real `elide-android` launch provider with Komodo's
`komodo-kotlin` adapter on a ready, disposable emulator. It uses a clean copy of `elide-android-sample`, creates
its debug signing key, and lets the launch build/install/start the APK; no prebuilt APK or changes to the original
sample are needed. It checks the forwarded JDWP socket's device and PID, a Kotlin `onCreate` breakpoint in the
copied source, locals/evaluation, stepping from the DAO assignment to `setContent`, and continuation into a
focused Activity window. It then detaches and removes only the app it installed, leaving the emulator running.
The application ID must match the sample manifest and must **not** already be installed on that emulator;
the scenario refuses to overwrite an existing installation.
The scenario reports attach-to-breakpoint time and fails a first stop slower than 30 s: before Komodo limited its
loaded-class scan to the project's packages, ART's ~30,000 framework classes took about a minute to bind through adb.
It is a correctness bound, not a debugger latency benchmark.

Install Android SDK platform/build tools for API 36, boot a dedicated API 36 emulator headlessly, wait for boot
completion, and dismiss its keyguard before starting. Select an Android-capable Elide distribution using
`ELIDE_TEST_HOME`; explicitly install Komodo through that CLI before running. Developer-only builds may use
`ELIDE_KOMODO_LSP` and `ELIDE_KOMODO_JAVA_HOME` as above. Other installed extensions are disabled. With `emulator-5580` already ready:

```sh
ELIDE_TEST_SCENARIO=komodo-android-debug \
ELIDE_TEST_HOME="${ELIDE_TEST_HOME:?set to an Android-capable Elide distribution with Komodo}" \
ELIDE_ANDROID_APP_SAMPLE="$HOME/workspaces/elide-android-sample" \
ELIDE_ANDROID_APP_MEMBER=app \
ELIDE_ANDROID_APP_ARTIFACT=app \
ELIDE_ANDROID_APP_ID=sample.app \
ELIDE_ANDROID_DEVICE=emulator-5580 \
bazel run //packages/vscode:integration_test
```

`ANDROID_HOME` or `ANDROID_SDK_ROOT` must identify that SDK. `KEEP_TEST_DIRS=1` retains the copied workspace,
generated APK, and isolated VS Code logs for diagnosis; it does not retain the app on the emulator. Do not run
two instances against the same emulator/application ID at once.

Android app verification has no default fixture. Select an Elide Android application explicitly, including its
workspace-relative member directory, APK artifact name, and application ID:

```sh
ELIDE_TEST_SCENARIO=android \
ELIDE_ANDROID_APP_SAMPLE=/path/to/android-workspace \
ELIDE_ANDROID_APP_MEMBER=app \
ELIDE_ANDROID_APP_ARTIFACT=app-debug \
ELIDE_ANDROID_APP_ID=com.example.app \
bazel run //packages/vscode:integration_test
```

The runner builds a clean temporary copy, creates the configured debug signing key through **Create Android
Signing Keystore**, then builds, installs and launches the APK on an attached device or headless emulator.
The fixture must declare a disposable debug keystore under `.dev` inside its copied workspace; `.dev` and the
keys it contains are not copied. Use a dedicated application ID that is not already installed with another key.
The scenario does not uninstall an existing application or delete its data to bypass a signing mismatch.
Compose verification separately uses `ELIDE_TEST_SCENARIO=compose` with `ELIDE_ANDROID_SAMPLE` pointing to a built
Compose sample; its default is the sibling `elide-android-sample` checkout. Leave its VS Code window unminimized
while it runs: the scenario times paints by the preview's `requestAnimationFrame` acknowledgements, which Chromium
suspends in a minimized window (`timed out waiting for first paint`) and can delay when the window is activated or
deactivated mid-step (an optimistic paint acknowledged only after confirmation).

Run latency scenarios without concurrent builds or other preview scenarios. The 1,500 ms optimistic-paint checks
remain distinct from annotation-processing confirmation, which can take several seconds. Record a timing miss
and the surrounding load rather than increasing the bound or treating a later functional pass as a performance fix.

### Android database inspector helper

`packages/vscode/media/database/inspector.dex` ships with the extension; the Bazel build does not require an Android
SDK or compile Java. After changing `DatabaseInspector.java`, rebuild and include the dex, running the helper on the
pinned Bun (it writes next to its source, so pass the script's absolute path):

```sh
bazel run //tools/bazel/bun -- "$PWD/tools/build-database-inspector.ts"
```

Requires a JDK and an Android SDK platform API 28+ with build-tools/d8. Set `ANDROID_HOME` or `ANDROID_SDK_ROOT`
when the SDK is not in a conventional location. `ANDROID_DATABASE_PLATFORM` (for example `android-36`) and
`ANDROID_DATABASE_BUILD_TOOLS` (for example `37.0.0`) pin the build inputs; pin the JDK too for reproducibility.
The helper targets device API 26+. Keep the source and generated dex together when updating the protocol.

For device smoke verification, use an isolated debuggable app with a file-backed SQLite/Room database in WAL mode.
Verify paging, NULL/BLOB/64-bit values, live app commits after opening the panel, read-only rejection of writes,
confirmed writes and foreign-key rollback, cancellation and disconnects. Do not run destructive SQL against a
developer's existing app data. Unit tests cover transport/lifecycle boundaries; they do not replace device or
real-webview verification.

## Code style

- Formatting and whitespace rules are defined in `.editorconfig` (2-space indent, LF line endings,
  final newline on every file). Configure your editor to respect it.
- The codebase is TypeScript in strict mode. Keep new code strictly typed; avoid `any` unless there is
  no reasonable alternative.
- There is no linter or formatter configured in this repo (no ESLint/Prettier/Biome) — match the style
  of the surrounding code by hand.
- Keep changes small and focused. Prefer several small, reviewable commits/PRs over one large one.

## Commit convention

Commits must follow [Conventional Commits](https://www.conventionalcommits.org/). This is enforced on
pull requests by the `commitlint` GitHub Actions workflow using
`@commitlint/config-conventional`. Allowed types:

- `feat` — a new feature
- `fix` — a bug fix
- `docs` — documentation-only changes
- `refactor` — code change that neither fixes a bug nor adds a feature
- `test` — adding or correcting tests
- `chore` — maintenance work that doesn't fit the other types
- `ci` — changes to CI configuration
- `build` — changes to the build system or dependencies
- `perf` — a performance improvement
- `style` — changes that do not affect the meaning of the code (whitespace, formatting, etc.)
- `revert` — reverts a previous commit

Commit subjects are the changelog: `packages/vscode/CHANGELOG.md` is generated from them by release-please, so write
each subject as the entry you want users to read on the Marketplace.

## Pull request checklist

Before opening a PR, confirm:

- [ ] `bazel test //...` passes (build, type-check, packaging and unit tests).
- [ ] `bazel run //:gazelle.check` passes (BUILD files up to date).
- [ ] Docs are updated for any user-visible change (the changelog is generated on release).
- [ ] No generated artifacts are committed (`dist/`, `*.vsix`, `bazel-*`, and `workspace.json` are gitignored —
      make sure your diff doesn't reintroduce them).

## Reporting problems

File bugs and feature requests through the [issue templates](https://github.com/elide-dev/vscode/issues/new/choose).
Security vulnerabilities go through the private process in [`SECURITY.md`](SECURITY.md), never a public issue.
Participation in this project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Release process

Releases are cut on demand by maintainers, driven by
[release-please](https://github.com/googleapis/release-please):

1. Run the **Release** workflow from the Actions tab. It opens or refreshes a release pull request that bumps
   `.version` and `packages/vscode/package.json` and adds the `packages/vscode/CHANGELOG.md` section for the next
   version, derived from the commits since the last tag. For each created or updated release PR, the workflow
   runs `bazel run @npm//:sync` on its branch and commits any changed `pnpm-lock.yaml` and
   `.aspect/rules/external_repository_action_cache/` files back to that branch.
2. Amend that section in the pull request if the generated entries need polish; the merged text is what the
   Marketplace shows. Run the workflow again to fold in commits that landed after the pull request was opened.
   Wait for **Synchronize Release Lock** and CI on the resulting PR head to pass before merging. The frozen npm
   lock check hashes the whole package manifest, including its version, even when dependencies are unchanged;
   build and publish retain frozen-lock verification. Local equivalents are
   `bazel run --config=ci //:gazelle.check` and `bazel test --config=ci //...`.
3. Merging it tags `v<version>` and creates the GitHub Release, which triggers the publish job: unit tests, the
   `.vsix` published to `plugins.elide.dev` via `tools/deploy.sh`, publication to the Visual Studio Marketplace when
   the `VSCE_PAT` secret is configured, and the `.vsix` attached to the release.

The next version follows the merged commits: `fix:` bumps the patch, `feat:` the minor, and `feat!:` (or a
`BREAKING CHANGE:` footer) the major. `.release-please-manifest.json` holds the last released version.

Configure `RELEASE_PLEASE_TOKEN` with a PAT allowed to update repository contents and pull requests. Both
release-please and the lock-metadata push use it so the resulting PR commits trigger CI. The workflow falls back
to `GITHUB_TOKEN` if it is absent, but GitHub suppresses workflows triggered by that token's writes.

### Recovering the already-tagged v0.8.0 release

The original `v0.8.0` tag contains stale npm action-cache metadata. Rerunning its failed publish job still checks
out that stale record; do not move or recreate the tag. Build its source in a detached worktree, regenerating only
the lock metadata locally, then upload the verified archive to the existing release:

```sh
git worktree add --detach ../elide-vscode-v0.8.0 v0.8.0
cd ../elide-vscode-v0.8.0
bazel run @npm//:sync
bazel run --config=ci //:gazelle.check
bazel test --config=ci //...
mkdir -p dist
cp bazel-bin/packages/vscode/elide.vsix dist/elide-0.8.0.vsix
gh release upload v0.8.0 dist/elide-0.8.0.vsix --clobber
```

The upload requires maintainer authorization; no commit, push, or retag is needed for this recovery.
