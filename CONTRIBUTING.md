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
- `packages/vscode` — the VS Code extension itself. Bundled with esbuild, packaged with `vsce`.
- `samples/ktjvm` — a sample Kotlin/JVM project used to exercise the extension during development and
  by the local-only integration test.
- `tools/deploy.sh` — release/deploy helper script.
- `tools/bazel` — repository-local Bazel rules (the hermetic Bun used by `bun_test`).

## Dev loop

The build is [Bazel](https://bazel.build) with [rules_js](https://github.com/aspect-build/rules_js) and
[rules_ts](https://github.com/aspect-build/rules_ts); npm dependencies come from the pnpm workspace
(`pnpm-workspace.yaml`, `pnpm-lock.yaml`).

```sh
bazel test //...                                  # build and type-check everything, package the .vsix, run unit tests
bazel test //packages/core:test                   # unit tests for packages/core only
bazel build //packages/vscode:extension           # the extension, at bazel-bin/packages/vscode
bazel build //packages/vscode:vsix                # bazel-bin/packages/vscode/elide.vsix
```

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

The local runner disables Bazel's Node filesystem symlink masking so its fixture copies dereference runfiles
links into real files; edits must never reach the checked-in samples.

The default scenario drives `samples/ktjvm`. `ELIDE_TEST_SCENARIO=workspace` runs the Elide-workspace
scenario instead, against `samples/workspace` or the directory `ELIDE_WORKSPACE_SAMPLE` names:

```sh
ELIDE_TEST_SCENARIO=workspace bazel run //packages/vscode:integration_test
```

Android diagnostics and Logcat use an independently installed Android SDK and connected devices. They work in an
ordinary source folder without `elide.pkl`; Android build/deployment and Compose preview scenarios are not supported
by the released runtime.

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
   version, derived from the commits since the last tag.
2. Amend that section in the pull request if the generated entries need polish; the merged text is what the
   Marketplace shows. Run the workflow again to fold in commits that landed after the pull request was opened.
   After any release-PR version bump, run `bazel run @npm//:sync` on its branch and commit the regenerated
   `.aspect/rules/external_repository_action_cache/` record and any `pnpm-lock.yaml` changes. The frozen npm
   lock check hashes the whole package manifest, including its version, even when dependencies are unchanged.
   Verify with `bazel run --config=ci //:gazelle.check` and `bazel test --config=ci //...`.
3. Merging it tags `v<version>` and creates the GitHub Release, which triggers the publish job: unit tests, the
   `.vsix` published to `plugins.elide.dev` via `tools/deploy.sh`, publication to the Visual Studio Marketplace when
   the `VSCE_PAT` secret is configured, and the `.vsix` attached to the release.

The next version follows the merged commits: `fix:` bumps the patch, `feat:` the minor, and `feat!:` (or a
`BREAKING CHANGE:` footer) the major. `.release-please-manifest.json` holds the last released version.
