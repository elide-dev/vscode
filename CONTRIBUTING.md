# Contributing to elide-vscode

Thanks for your interest in improving the Elide extension for VS Code. This document covers
everything you need to build, test, and submit changes.

## Prerequisites

- [Bun](https://bun.sh) 1.3 or newer. The repo is Node-free: install and dev scripts run under Bun.
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

## Dev loop

```sh
bun install
bun run build
bun test                              # unit tests for packages/core
bun run --filter elide typecheck      # typecheck the extension package
```

To run the extension interactively, open this repo in VS Code and start the `Run Extension` launch
configuration; use `samples/ktjvm` as the workspace to open in the resulting Extension Development
Host window.

Integration tests require a real VS Code install, the `JetBrains.kotlin-server` extension, and a local
Elide install, so they are not run in CI. To run them locally:

```sh
cd packages/vscode
bun run test:integration
```

The default scenario drives `samples/ktjvm`. `ELIDE_TEST_SCENARIO=workspace` runs the Elide-workspace
scenario instead, against the `elide-workspaces-sample` checkout beside this repository or the directory
`ELIDE_WORKSPACE_SAMPLE` names:

```sh
cd packages/vscode
ELIDE_TEST_SCENARIO=workspace bun run test:integration
```

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

- [ ] `bun run build` succeeds.
- [ ] `bun run --filter elide typecheck` succeeds.
- [ ] `bun test` passes.
- [ ] Docs are updated for any user-visible change (the changelog is generated on release).
- [ ] No generated artifacts are committed (`dist/`, `*.vsix`, and `workspace.json` are gitignored —
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
3. Merging it tags `v<version>` and creates the GitHub Release, which triggers the publish job: unit tests, the
   `.vsix` published to `plugins.elide.dev` via `tools/deploy.sh`, publication to the Visual Studio Marketplace when
   the `VSCE_PAT` secret is configured, and the `.vsix` attached to the release.

The next version follows the merged commits: `fix:` bumps the patch, `feat:` the minor, and `feat!:` (or a
`BREAKING CHANGE:` footer) the major. `.release-please-manifest.json` holds the last released version.
