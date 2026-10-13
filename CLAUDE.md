# elide-vscode

Commands, layout and test prerequisites are in `CONTRIBUTING.md`. These are the gotchas it does not cover.

## JetBrains Kotlin extension (`JetBrains.kotlin-server`)

- Its bundled `out/dist/extension.js.map` has `sourcesContent`. Read those sources before guessing how its commands, settings or DAP behave.
- Until its first-run setup is done (`intellij.region` and `intellij.dataSharing` user values set to anything other than `not_set`, plus terms accepted in its private state), it activates but registers no `jetbrains.kotlin.*` server commands and no debug adapter. Test profiles must set both settings (see `test/integration/runner.ts`). `pendingKotlinSetup()` in `src/jetbrains.ts` detects this state.
- Its index lives under the VS Code user-data-dir (`workspaceStorage/*/JetBrains.kotlin-server`), so a fresh profile always starts with a cold index. A debug session attached while it is still indexing renders `List` fields as "Cannot find source class for java.util.List".
- An `intellij_jvm` **attach** session cannot evaluate expressions ("Class not found: kotlin/Unit"), because the attach request carries no classpath and the server builds no module scope. "Debug with Elide" has to attach. This is upstream (Kotlin/kotlin-lsp#289), not our launch config.

## Debugging the debugger

- Register a `vscode.debug.registerDebugAdapterTrackerFactory("*", …)` tracker in an extension test to log raw DAP traffic. The first `variables` reply says "Collecting data…" and the real values arrive after `invalidated` events, so request again before asserting.
- Under Xvfb, run the downloaded Linux build (`@vscode/test-electron`'s `downloadAndUnzipVSCode`) with `--extensions-dir` pointing at a directory that contains a symlink to the installed Kotlin extension. That avoids copying its 1.2 GB.

## Releases

- Squash merges with conventional, lower-case headers. commitlint caps body lines at 100 characters.
- `gh workflow run release.yml --ref main` makes release-please open or refresh the release PR (push runs only tag). Merging that PR publishes the .vsix to `plugins.elide.dev` and attaches it to the GitHub release.
