/**
 * Runs inside the extension host (see runner.ts). Exercises the real chain: extension sync → workspace.json →
 * JetBrains Kotlin LSP import → hovers/diagnostics, then manifest-change resync, tasks, and JDWP debugging.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import type { ElideExtensionApi as ElideApi } from "../../src/extension.js";

const sample = process.env.ELIDE_TEST_SAMPLE!;
const log = (...a: unknown[]) => console.log("[elide-test]", ...a);

async function waitFor<T>(what: string, probe: () => Promise<T | undefined> | T | undefined, timeoutMs: number, intervalMs = 1_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function hoverText(hovers: vscode.Hover[] | undefined): string {
  return (hovers ?? [])
    .flatMap((h) => h.contents)
    .map((c) => (typeof c === "string" ? c : c.value))
    .join("\n");
}

async function hoverAt(uri: vscode.Uri, needle: string): Promise<string> {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
  const offset = doc.getText().indexOf(needle);
  assert.ok(offset >= 0, `${needle} not found in ${uri.fsPath}`);
  const pos = doc.positionAt(offset + 1);
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", uri, pos);
  return hoverText(hovers);
}

function errorsOf(uri: vscode.Uri): vscode.Diagnostic[] {
  return vscode.languages.getDiagnostics(uri).filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
}

export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "sample workspace folder open");
  assert.equal(folder.uri.fsPath, sample);
  const workspaceJson = path.join(sample, "workspace.json");

  // 1. Startup sync writes workspace.json and points the Kotlin LSP at a JDK.
  log("waiting for startup sync");
  const ws = await waitFor("workspace.json", () => (existsSync(workspaceJson) ? JSON.parse(readFileSync(workspaceJson, "utf8")) : undefined), 180_000);
  assert.deepEqual(ws.modules.map((m: { name: string }) => m.name), ["ktjvm-sample.main", "ktjvm-sample.test"]);
  assert.ok(ws.libraries.some((l: { name: string }) => l.name.includes("kotlin-stdlib:")), "stdlib library present");
  assert.ok(ws.libraries.some((l: { name: string }) => l.name.includes("kotlin-test:")), "kotlin-test library present");
  // Elide's own toolchain jars (kotlin-stdlib, kotlin-test, junit) ship without classifiers; `--with sources`
  // covers the manifest's declared Maven packages, checked on guava below.
  assert.equal(ws.sdks.length, 1);
  assert.equal(ws.sdks[0].type, "JavaSDK");
  assert.equal(ws.modules[0].contentRoots[0].sourceRoots[0].path, "<WORKSPACE>/src/main");
  // The JDK path is machine-specific: it belongs in user settings, and the teammate's absolute path committed in
  // the sample's `.vscode/settings.json` (runner.ts) must be cleared rather than honoured.
  const jdkSetting = await waitFor("jdkForSymbolResolution in user settings", () => {
    const i = vscode.workspace.getConfiguration("intellij", folder).inspect<string>("jdkForSymbolResolution");
    if (i?.workspaceValue !== undefined || i?.workspaceFolderValue !== undefined) return undefined;
    return typeof i?.globalValue === "string" && i.globalValue.length > 0 ? i.globalValue : undefined;
  }, 60_000, 500);
  assert.ok(existsSync(jdkSetting), "the JDK written to user settings exists on this machine");
  assert.ok(
    !readFileSync(path.join(sample, ".vscode", "settings.json"), "utf8").includes("jdkForSymbolResolution"),
    "no machine-specific path left in the workspace settings",
  );
  // The sample carries a checked-in `.idea/modules.xml` (runner.ts): without this pin the server's auto-detection
  // imports it through JPS and never reads workspace.json, so the hovers below would fail.
  const buildTool = await waitFor("buildTool pinned", () => vscode.workspace.getConfiguration("intellij", folder).get<string>("buildTool"), 60_000, 500);
  assert.equal(buildTool, "json", "intellij.buildTool pinned to the JSON importer");
  log("sync ok; jdk", jdkSetting);

  // 2. Kotlin LSP imports the JSON workspace: stdlib and test-scoped symbols resolve without errors.
  const mainKt = vscode.Uri.file(path.join(sample, "src", "main", "sample", "Main.kt"));
  const testKt = vscode.Uri.file(path.join(sample, "src", "test", "sample", "MainTest.kt"));
  log("waiting for Kotlin LSP hover on listOf");
  const listOfHover = await waitFor("hover on listOf", async () => {
    const t = await hoverAt(mainKt, "listOf(");
    return /listOf|kotlin\.collections/.test(t) ? t : undefined;
  }, 600_000, 3_000);
  log("hover(listOf):", listOfHover.slice(0, 200).replace(/\n/g, " "));

  const assertEqualsHover = await waitFor("hover on assertEquals", async () => {
    const t = await hoverAt(testKt, "assertEquals(");
    return /assertEquals|kotlin\.test/.test(t) ? t : undefined;
  }, 300_000, 3_000);
  log("hover(assertEquals):", assertEqualsHover.slice(0, 200).replace(/\n/g, " "));

  await waitFor("diagnostics settle", async () => {
    await new Promise((r) => setTimeout(r, 5_000));
    return true;
  }, 10_000, 100);
  assert.deepEqual(errorsOf(mainKt).map((d) => d.message), [], "no errors in Main.kt");
  assert.deepEqual(errorsOf(testKt).map((d) => d.message), [], "no errors in MainTest.kt");
  log("no diagnostics errors");

  // 3. Manifest change → automatic resync (policy: always) → new dependency resolves.
  const manifest = path.join(sample, "elide.pkl");
  appendFileSync(manifest, `\ndependencies {\n    maven {\n        packages {\n            "com.google.guava:guava:33.4.0-jre"\n        }\n    }\n}\n`);
  log("edited elide.pkl; waiting for resync with guava");
  const withGuava = await waitFor("guava in workspace.json", () => {
    const w = JSON.parse(readFileSync(workspaceJson, "utf8"));
    return w.libraries.some((l: { name: string }) => l.name.includes("com.google.guava:guava")) ? w : undefined;
  }, 300_000, 2_000);
  // `elide.install.classifiers` defaults to ["sources"], installed as `--slim --with sources`: the sources jar is
  // attached for Go to Definition and the javadoc jar the CLI would fetch by default is not downloaded.
  const guavaLib = withGuava.libraries.find((l: { name: string }) => l.name.includes("com.google.guava:guava"));
  const guavaSources: string | undefined = guavaLib.roots.find((r: { type: string }) => r.type === "SOURCES")?.path;
  assert.ok(guavaSources, "guava library has a SOURCES root");
  const guavaSourcesJar = guavaSources.replace("<WORKSPACE>", sample);
  assert.match(guavaSourcesJar, /guava-[^/]*-sources\.jar$/, "SOURCES root is the guava sources jar");
  assert.ok(existsSync(guavaSourcesJar), `${guavaSourcesJar} fetched by elide install --with sources`);
  assert.ok(!existsSync(guavaSourcesJar.replace("-sources.jar", "-javadoc.jar")), "javadoc jar not downloaded for the default classifier set");
  const guavaKt = path.join(sample, "src", "main", "sample", "Guava.kt");
  writeFileSync(guavaKt, `package sample\n\nimport com.google.common.collect.ImmutableList\n\nfun immutable(): ImmutableList<String> = ImmutableList.of("a")\n`);
  const guavaUri = vscode.Uri.file(guavaKt);
  const guavaHover = await waitFor("hover on ImmutableList", async () => {
    const t = await hoverAt(guavaUri, "ImmutableList.of");
    return /ImmutableList/.test(t) ? t : undefined;
  }, 300_000, 3_000);
  log("hover(ImmutableList):", guavaHover.slice(0, 160).replace(/\n/g, " "));
  await new Promise((r) => setTimeout(r, 5_000));
  assert.deepEqual(errorsOf(guavaUri).map((d) => d.message), [], "no errors in Guava.kt");

  // 4. Tasks.
  const tasks = await vscode.tasks.fetchTasks({ type: "elide" });
  const names = tasks.map((t) => t.name).sort();
  log("tasks:", names);
  for (const expected of ["build", "test", "install", "run"]) assert.ok(names.includes(expected), `task ${expected}`);
  const build = tasks.find((t) => t.name === "build")!;
  const runTask = (task: vscode.Task) => {
    const { promise, resolve } = Promise.withResolvers<number | undefined>();
    const d = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution.task.name === task.name) {
        d.dispose();
        resolve(e.exitCode);
      }
    });
    void vscode.tasks.executeTask(task);
    return promise;
  };
  const runBuild = () => runTask(build);
  assert.equal(await runBuild(), 0, "elide build task exit code");
  log("build task ok");

  // Invocation options: `elide.flags` and `elide.<command>.options` reach the argv of the provided tasks, and the
  // CLI accepts what is generated. An unknown option exits 2, which is what proves the options are not dropped.
  const settings = vscode.workspace.getConfiguration("elide");
  await settings.update("flags", ["ci"], vscode.ConfigurationTarget.Global);
  await settings.update("test.options", { bail: 2, reporter: "console" }, vscode.ConfigurationTarget.Global);
  const configuredTest = await waitFor(
    "test task with the configured flags",
    async () => {
      const found = (await vscode.tasks.fetchTasks({ type: "elide" })).find((t) => t.name === "test");
      const args = (found?.execution as vscode.ProcessExecution | undefined)?.args;
      return args?.includes("-f") ? found : undefined;
    },
    30_000,
  );
  assert.deepEqual(
    (configuredTest.execution as vscode.ProcessExecution).args,
    ["test", "-f", "ci", "--bail=2", "--reporter=console"],
    "settings reach the provided task's argv",
  );
  assert.equal(await runTask(configuredTest), 0, "the configured test task runs");
  await settings.update("test.options", { "definitely-not-an-option": true }, vscode.ConfigurationTarget.Global);
  const rejected = (await vscode.tasks.fetchTasks({ type: "elide" })).find((t) => t.name === "test")!;
  assert.notEqual(await runTask(rejected), 0, "the CLI sees the configured options and rejects an unknown one");
  await settings.update("flags", undefined, vscode.ConfigurationTarget.Global);
  await settings.update("test.options", undefined, vscode.ConfigurationTarget.Global);
  log("task invocation options ok");

  // 4b. Target commands: the ids code lenses and menus invoke exist, run a task for a project root, and the
  //     manifest opener resolves the single project without an argument.
  const commands = await vscode.commands.getCommands(true);
  for (const id of ["elide.run", "elide.debug", "elide.build", "elide.executeTask", "elide.openManifest", "elide.showMenu", "elide.revealLibrary"]) {
    assert.ok(commands.includes(id), `command ${id} registered`);
  }
  const runExit = await new Promise<number | undefined>((resolve) => {
    const d = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution.task.name === "run") {
        d.dispose();
        resolve(e.exitCode);
      }
    });
    void vscode.commands.executeCommand("elide.run", { root: sample, args: [] });
  });
  assert.equal(runExit, 0, "elide.run executed the run task");
  await vscode.commands.executeCommand("elide.openManifest");
  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, path.join(sample, "elide.pkl"), "elide.openManifest opened the manifest");
  log("target commands ok");

  // 4c. The status-bar menu: opening it and accepting the first entry runs a sync, which rewrites workspace.json.
  const beforeMenuSync = statSync(workspaceJson).mtimeMs;
  void vscode.commands.executeCommand("elide.showMenu");
  const quickPickShown = Promise.withResolvers<void>();
  setTimeout(quickPickShown.resolve, 1_000);
  await quickPickShown.promise;
  await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
  await waitFor("menu sync rewrote workspace.json", () => (statSync(workspaceJson).mtimeMs > beforeMenuSync ? true : undefined), 180_000, 1_000);
  log("status menu ok");

  // 4d. Problem matcher: a kotlinc error from the `build` task becomes a diagnostic on the offending file and is
  //     cleared by the next clean build. The Kotlin LSP reports the same error itself, so only markers owned by the
  //     task matcher (`source: "elide"`) count here.
  const brokenKt = path.join(sample, "src", "main", "sample", "Broken.kt");
  const brokenUri = vscode.Uri.file(brokenKt);
  writeFileSync(brokenKt, "package sample\n\nfun broken() = undefinedSymbol\n");
  assert.notEqual(await runBuild(), 0, "build fails while Broken.kt is present");
  const brokenDiag = await waitFor(
    "elide diagnostic on Broken.kt",
    () =>
      vscode.languages
        .getDiagnostics(brokenUri)
        .find((d) => d.source === "elide" && d.severity === vscode.DiagnosticSeverity.Error && d.message.includes("undefinedSymbol")),
    120_000,
  );
  // `[208ms] error: kotlinc: Unresolved reference 'undefinedSymbol'.` / `In file: src/main/sample/Broken.kt:3:16`
  assert.equal(brokenDiag.range.start.line, 2, "diagnostic on the `fun broken()` line");
  log("problem matcher diagnostic:", JSON.stringify(brokenDiag.message), `${brokenDiag.range.start.line}:${brokenDiag.range.start.character}`);
  rmSync(brokenKt);
  assert.equal(await runBuild(), 0, "build passes once Broken.kt is gone");
  await waitFor("elide diagnostics cleared", () => vscode.languages.getDiagnostics(brokenUri).every((d) => d.source !== "elide") || undefined, 60_000);
  log("problem matcher ok");

  // 4e. Code lenses: Run/Debug above `fun main()` (the sample's `jvm.main` is this file's facade class, so the
  //     entrypoint needs no argument) and on the manifest's `main = "sample.MainKt"` line.
  const mainLenses = await waitFor(
    "code lenses on Main.kt",
    async () => {
      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", mainKt);
      const elide = (lenses ?? []).filter((l) => l.command?.command.startsWith("elide."));
      return elide.length > 0 ? elide : undefined;
    },
    60_000,
    1_000,
  );
  const mainLine = (await vscode.workspace.openTextDocument(mainKt)).getText().split("\n").findIndex((l) => l.startsWith("fun main("));
  // Exactly one pair: the Kotlin LSP adds its own Run/Debug lenses on the same line, so ours carry the `with Elide`
  // suffix and must not be emitted twice themselves.
  for (const [command, title] of [["elide.run", "$(play) Run with Elide"], ["elide.debug", "$(debug-alt) Debug with Elide"]] as const) {
    const matching = mainLenses.filter((l) => l.command?.command === command);
    assert.equal(matching.length, 1, `one ${command} lens on Main.kt, got ${JSON.stringify(mainLenses.map((l) => [l.command?.command, l.command?.title]))}`);
    const lens = matching[0]!;
    assert.equal(lens.command?.title, title);
    assert.equal(lens.range.start.line, mainLine, `${command} lens on the fun main() line`);
    assert.deepEqual(lens.command?.arguments, [{ root: sample, args: [] }], `${command} lens targets the declared jvm.main`);
  }
  const manifestUri = vscode.Uri.file(manifest);
  const manifestDoc = await vscode.workspace.openTextDocument(manifestUri);
  const manifestLenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", manifestUri)) ?? [];
  const jvmMainLine = manifestDoc.getText().split("\n").findIndex((l) => l.includes('main = "sample.MainKt"'));
  const manifestRun = manifestLenses.find((l) => l.command?.command === "elide.run" && l.range.start.line === jvmMainLine);
  assert.ok(manifestRun, `elide.run lens on the jvm.main line, got ${JSON.stringify(manifestLenses.map((l) => [l.command?.command, l.range.start.line]))}`);
  assert.deepEqual(manifestRun.command?.arguments, [{ root: sample, args: [] }]);
  assert.ok(
    manifestLenses.some((l) => l.command?.command === "elide.debug" && l.range.start.line === jvmMainLine),
    "elide.debug lens on the jvm.main line",
  );
  log("code lenses ok");

  // 4f. Test explorer: static discovery maps the sample's JUnit test to an item, `runAll` drives
  //     `elide test --reporter=tap` and reports the TAP result on it, and a test added to the file is picked up.
  const extension = vscode.extensions.all.find((e) => e.id.endsWith(".elide"));
  assert.ok(extension, `elide extension found, got ${JSON.stringify(vscode.extensions.all.map((e) => e.id))}`);
  const api = await waitFor("extension test api", () => (extension.exports as ElideApi | undefined)?.tests, 60_000, 500);
  const itemId = (method: string) => `m:${sample}:sample.MainTest#${method}`;
  const green = await api.runAll();
  log("runAll:", JSON.stringify(green));
  assert.ok(green.passed.includes(itemId("testGreeting")), `testGreeting reported as passed, got ${JSON.stringify(green)}`);
  assert.deepEqual(green.failed, [], "no failures in the untouched sample");

  // `elide.test.options` applies to Test Explorer runs, but the reporter it needs is not negotiable: a configured
  // `console` reporter would leave the run without a TAP stream to map onto the items.
  await settings.update("test.options", { reporter: "console", concurrency: 2 }, vscode.ConfigurationTarget.Global);
  const configuredRun = await api.runAll();
  await settings.update("test.options", undefined, vscode.ConfigurationTarget.Global);
  assert.ok(configuredRun.passed.includes(itemId("testGreeting")), `TAP still parsed with a configured reporter, got ${JSON.stringify(configuredRun)}`);

  const testSource = readFileSync(testKt.fsPath, "utf8");
  const closing = testSource.lastIndexOf("}");
  writeFileSync(testKt.fsPath, `${testSource.slice(0, closing)}\n    @Test\n    fun failing() = assertEquals(1, 2)\n${testSource.slice(closing)}`);
  const red = await waitFor(
    "added test discovered and reported",
    async () => {
      const summary = await api.runAll();
      return summary.failed.includes(itemId("failing")) ? summary : undefined;
    },
    180_000,
    2_000,
  );
  log("runAll with the added failing test:", JSON.stringify(red));
  assert.ok(red.passed.includes(itemId("testGreeting")), "the untouched test still passes");
  writeFileSync(testKt.fsPath, testSource);
  await waitFor(
    "removed test gone from the run",
    async () => {
      const summary = await api.runAll();
      return summary.failed.length === 0 && summary.passed.includes(itemId("testGreeting")) ? summary : undefined;
    },
    180_000,
    2_000,
  );
  log("test explorer ok");

  // 4g. Sidebar: the activity-bar view focuses, the tree exposes the project with its four groups, and the lazily
  //     loaded build targets come from `elide build --inspect`.
  await vscode.commands.executeCommand("elide.projects.focus");
  const explorer = await waitFor("extension explorer api", () => (extension.exports as ElideApi | undefined)?.explorer, 30_000, 500);
  const roots = (await explorer.getChildren()) as { kind: string; label: string; root: string }[];
  assert.deepEqual(roots.map((n) => [n.kind, n.root]), [["project", sample]], "one project node");
  const groups = (await explorer.getChildren(roots[0])) as { kind: string; label: string; group: string }[];
  assert.deepEqual(groups.map((g) => g.label), ["Entrypoints", "Tasks", "Source sets", "Dependencies"]);
  const childrenOf = async (label: string) => {
    const group = groups.find((g) => g.label === label);
    assert.ok(group, `group ${label}`);
    return (await explorer.getChildren(group)) as { kind: string; label: string; args?: string[]; attached?: string }[];
  };
  const entrypoints = await childrenOf("Entrypoints");
  assert.deepEqual(entrypoints.map((n) => [n.label, n.args]), [["sample.MainKt", []]], "the manifest's jvm.main entrypoint");
  const taskNodes = await childrenOf("Tasks");
  assert.deepEqual(taskNodes.map((n) => n.label), ["build", "test", "install", "Build targets"]);
  const targets = (await explorer.getChildren(taskNodes[3])) as { kind: string; label: string; debuggable?: boolean }[];
  assert.ok(targets.length > 0 && targets.every((n) => n.kind === "buildTarget"), `elide build --inspect targets, got ${JSON.stringify(targets)}`);
  // Only targets that start a JVM declare `--debugger`, and those are the ones the tree offers a Debug action on.
  assert.deepEqual(
    targets.filter((n) => n.debuggable).map((n) => n.label).sort(),
    ["jvm-test", "run"],
    `debuggable targets, got ${JSON.stringify(targets.map((n) => [n.label, n.debuggable]))}`,
  );
  const sourceSets = await childrenOf("Source sets");
  assert.deepEqual(sourceSets.map((n) => n.label), ["main", "test"]);
  const mainRoots = (await explorer.getChildren(sourceSets[0])) as { kind: string; label: string }[];
  assert.ok(mainRoots.some((n) => n.label === path.join("src", "main")), `main source root, got ${JSON.stringify(mainRoots.map((n) => n.label))}`);
  const libraries = await childrenOf("Dependencies");
  const guavaNode = libraries.find((n) => n.label.includes("com.google.guava:guava"));
  assert.ok(guavaNode, `guava dependency node, got ${JSON.stringify(libraries.map((n) => n.label))}`);
  assert.equal(guavaNode.attached, "sources", "guava shows its attached sources jar");
  log("sidebar ok:", JSON.stringify(groups.map((g) => g.label)), `${targets.length} build targets`);

  // 4h. New Project wizard: the real `elide.newProject` command, driven end to end. The extension host shares this
  //     `vscode` module object with the extension, so the dialogs it opens are answered by standing in for the API
  //     (as step 7 does for notifications); `vscode.openFolder` is intercepted because opening the generated
  //     project would take the test's window with it.
  assert.ok(commands.includes("elide.newProject"), "elide.newProject registered");
  const wizardParent = path.join(tmpdir(), `elide-wizard-${process.pid}`);
  rmSync(wizardParent, { recursive: true, force: true });
  mkdirSync(path.join(wizardParent, "taken"), { recursive: true });
  const windowStubs: Record<string, unknown> = vscode.window;
  const commandStubs: Record<string, unknown> = vscode.commands;
  const realQuickPick = windowStubs.showQuickPick;
  const realInputBox = windowStubs.showInputBox;
  const realOpenDialog = windowStubs.showOpenDialog;
  const realExecuteCommand = vscode.commands.executeCommand;
  const prompts: string[] = [];
  let opened: vscode.Uri | undefined;
  let nameProblems: (string | undefined)[] = [];
  try {
    // The template is chosen by id; every other pick takes the first entry, which the wizard orders as the default.
    windowStubs.showQuickPick = (items: unknown, options?: vscode.QuickPickOptions) => {
      const list = items as (string | { label: string; description?: string })[];
      const chosen = list.find((i) => typeof i !== "string" && i.description === "ktjvm") ?? list[0]!;
      prompts.push(`pick ${options?.title ?? options?.placeHolder}: ${typeof chosen === "string" ? chosen : chosen.label}`);
      return Promise.resolve(chosen);
    };
    windowStubs.showOpenDialog = () => Promise.resolve([vscode.Uri.file(wizardParent)]);
    windowStubs.showInputBox = (options?: vscode.InputBoxOptions) => {
      prompts.push(`input ${options?.title ?? options?.prompt}: ${options?.value ?? ""}`);
      if (!options?.prompt?.startsWith("Project name")) return Promise.resolve(options?.value ?? "");
      nameProblems = ["", "nested/name", "taken"].map((v) => options.validateInput?.(v) as string | undefined);
      return Promise.resolve("wizard-check");
    };
    commandStubs.executeCommand = (command: string, ...args: unknown[]) => {
      if (command !== "vscode.openFolder") return realExecuteCommand.call(vscode.commands, command, ...args);
      opened = args[0] as vscode.Uri;
      return Promise.resolve(undefined);
    };
    await realExecuteCommand.call(vscode.commands, "elide.newProject");
  } finally {
    windowStubs.showQuickPick = realQuickPick;
    windowStubs.showInputBox = realInputBox;
    windowStubs.showOpenDialog = realOpenDialog;
    commandStubs.executeCommand = realExecuteCommand;
  }
  log("wizard prompts:", JSON.stringify(prompts));
  // The name is a single, new directory name: empty, separator-bearing and existing names are all rejected.
  assert.equal(nameProblems.length, 3);
  for (const problem of nameProblems) assert.equal(typeof problem, "string", `rejected name reported, got ${JSON.stringify(nameProblems)}`);
  const generated = path.join(wizardParent, "wizard-check");
  assert.equal(opened?.fsPath, generated, `the generated project is opened, prompts: ${JSON.stringify(prompts)}`);
  assert.ok(existsSync(path.join(generated, "elide.pkl")), "generated project has a manifest");
  assert.ok(existsSync(path.join(generated, "src")), "generated project has sources");
  assert.match(readFileSync(path.join(generated, "elide.pkl"), "utf8"), /wizard-check/, "the project name answer reached the manifest");
  rmSync(wizardParent, { recursive: true, force: true });
  log("new project wizard ok");

  // 4i. Walkthrough: the contributed steps open, and the markdown each step renders exists in the packaged media
  //     directory — a wrong path leaves the step body silently empty.
  const walkthroughs = extension.packageJSON.contributes.walkthroughs as { id: string; steps: { id: string; media: { markdown: string } }[] }[];
  const gettingStarted = walkthroughs.find((w) => w.id === "elide.gettingStarted");
  assert.ok(gettingStarted, `getting-started walkthrough contributed, got ${JSON.stringify(walkthroughs.map((w) => w.id))}`);
  for (const step of gettingStarted.steps) {
    assert.ok(existsSync(path.join(extension.extensionPath, step.media.markdown)), `${step.id} media ${step.media.markdown} exists`);
  }
  await vscode.commands.executeCommand("workbench.action.openWalkthrough", `${extension.id}#elide.gettingStarted`);
  log("walkthrough ok:", gettingStarted.steps.map((s) => s.id).join(", "));

  // 5. Debug: launch `elide run --debugger` — with a build flag, a CLI option and program arguments from the
  //    configuration — attach, hit a breakpoint, stop.
  const mainDoc = await vscode.workspace.openTextDocument(mainKt);
  const bpLine = mainDoc.getText().split("\n").findIndex((l) => l.includes("println(greeting"));
  assert.ok(bpLine > 0);
  vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(mainKt, new vscode.Position(bpLine, 0)))]);
  const sessionStarted = new Promise<vscode.DebugSession>((resolve) => {
    const d = vscode.debug.onDidStartDebugSession((s) => {
      if (s.type !== "elide") {
        d.dispose();
        resolve(s);
      }
    });
  });
  const started = await vscode.debug.startDebugging(folder, {
    type: "elide",
    request: "launch",
    name: "Elide: Run (debug)",
    flags: ["ci"],
    options: { verbose: true },
    args: ["--greeting", "hi"],
  });
  assert.equal(started, false, "the `elide` pseudo-session never starts itself");
  const session = await Promise.race([sessionStarted, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no attach session within 180s")), 180_000))]);
  log("attach session started:", session.type, session.name);
  const withTimeout = <T>(p: Thenable<T>, ms: number): Promise<T | undefined> =>
    Promise.race([Promise.resolve(p), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
  // VS Code sets `activeStackItem` once the adapter reports a `stopped` event and the UI selects a frame.
  const stopped = await waitFor("stopped at breakpoint", () => {
    const item = vscode.debug.activeStackItem;
    return item && item.session.id === session.id && "frameId" in item ? item : undefined;
  }, 120_000, 1_000);
  const frames = await withTimeout(session.customRequest("stackTrace", { threadId: stopped.threadId, levels: 3 }), 10_000);
  const top = frames?.stackFrames?.[0];
  log("stopped in", top?.source?.path ?? "(stack trace unavailable)", "line", top?.line);
  assert.ok(!top || String(top.source?.path ?? "").endsWith("Main.kt"), "top frame is in Main.kt");
  const ended = new Promise<void>((resolve) => {
    const d = vscode.debug.onDidTerminateDebugSession((s) => {
      if (s.id === session.id) {
        d.dispose();
        resolve();
      }
    });
  });
  await vscode.debug.stopDebugging(session);
  await ended;
  log("debug session terminated");
  vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  await waitFor("elide debuggee exit", () => {
    try {
      execSync("pgrep -f 'elide run .*--debugger|java.bin -agentlib:jdwp'", { stdio: "pipe" });
      return undefined; // still running
    } catch {
      return true; // pgrep exit 1: no matches
    }
  }, 20_000, 500);
  log("debuggee processes gone");

  // 5b. The Debug run profile of the Test Explorer: the same TAP command runs under a JDWP agent (bare
  //     `--debugger`, port 5005, banner on stdout as a `# out:` comment) and the JVM debugger attaches to it.
  //     Ordered after the launch-config session above: with this stage first, that one attached but never stopped
  //     at its breakpoint, so the session that needs breakpoints runs against a fresh debugger.
  const { promise: testDebugSession, resolve: testDebugStarted, reject: testDebugFailed } = Promise.withResolvers<vscode.DebugSession>();
  const testDebugTimer = setTimeout(() => testDebugFailed(new Error("no test attach session within 180s")), 180_000);
  const testDebugListener = vscode.debug.onDidStartDebugSession((s) => {
    if (s.name === "Elide: Test (debug)") testDebugStarted(s);
  });
  void vscode.commands.executeCommand("testing.debugAll");
  let testSession: vscode.DebugSession;
  try {
    testSession = await testDebugSession;
  } finally {
    clearTimeout(testDebugTimer);
    testDebugListener.dispose();
  }
  log("test debug session started:", testSession.type, testSession.name);
  await vscode.debug.stopDebugging(testSession);
  await waitFor("test debuggee exit", () => {
    try {
      execSync("pgrep -f 'elide test .*--debugger|java.bin -agentlib:jdwp'", { stdio: "pipe" });
      return undefined;
    } catch {
      return true;
    }
  }, 30_000, 500);
  log("debug test profile ok");

  // 5c. A `build` launch configuration debugs the build targets it lists: `--debugger` there is an option of the
  //     target task, so the configuration must name at least one. Configurations that put the target in the wrong
  //     field, or name none at all, assemble nothing and are rejected up front instead of waiting for a banner.
  const windowErrors: string[] = [];
  const errorApi: { showErrorMessage: unknown } = vscode.window;
  const realError = errorApi.showErrorMessage;
  errorApi.showErrorMessage = (message: string) => {
    windowErrors.push(message);
    return Promise.resolve(undefined);
  };
  try {
    const targetless = await vscode.debug.startDebugging(folder, { type: "elide", request: "launch", name: "Elide: Build (debug)", command: "build" });
    assert.equal(targetless, false, "a build configuration without targets starts nothing");
    const misplaced = await vscode.debug.startDebugging(folder, {
      type: "elide",
      request: "launch",
      name: "Elide: Build (debug)",
      command: "build",
      entrypoint: "jvm-test",
    });
    assert.equal(misplaced, false, "a build configuration using `entrypoint` starts nothing");
    assert.deepEqual(
      windowErrors.map((m) => (m.includes("at least one target in `targets`") ? "empty" : m.includes("list the build targets in `targets`") ? "misplaced" : m)),
      ["empty", "misplaced"],
      `both malformed build configurations are reported, got ${JSON.stringify(windowErrors)}`,
    );
  } finally {
    errorApi.showErrorMessage = realError;
  }
  const { promise: buildDebugSession, resolve: buildDebugStarted, reject: buildDebugFailed } = Promise.withResolvers<vscode.DebugSession>();
  const buildDebugTimer = setTimeout(() => buildDebugFailed(new Error("no build attach session within 180s")), 180_000);
  const buildDebugListener = vscode.debug.onDidStartDebugSession((s) => {
    if (s.name === "Elide: Build compile-kotlin-test jvm-test (debug)") buildDebugStarted(s);
  });
  let buildSession: vscode.DebugSession;
  try {
    // The sidebar's Debug action on a debuggable build target passes the same node the tree renders; a compile
    // target in front of it also covers the multi-target vector (`elide build compile-kotlin-test jvm-test
    // --debugger`). Two *debuggable* targets in one session would collide on port 5005, which is the CLI's own
    // constraint, not something the extension hides.
    void vscode.commands.executeCommand("elide.debug", { root: sample, command: "build", args: ["compile-kotlin-test", "jvm-test"] });
    buildSession = await buildDebugSession;
  } finally {
    clearTimeout(buildDebugTimer);
    buildDebugListener.dispose();
  }
  log("build target debug session started:", buildSession.type, buildSession.name);
  await vscode.debug.stopDebugging(buildSession);
  await waitFor("build debuggee exit", () => {
    try {
      execSync("pgrep -f 'elide build .*--debugger|java.bin -agentlib:jdwp'", { stdio: "pipe" });
      return undefined;
    } catch {
      return true;
    }
  }, 30_000, 500);
  log("build target debug ok");

  // 6. A bogus Elide home fails the sync and leaves the previous workspace.json untouched.
  const before = readFileSync(workspaceJson, "utf8");
  await vscode.workspace.getConfiguration("elide").update("home", "/nonexistent/elide", vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand("elide.sync");
  assert.equal(readFileSync(workspaceJson, "utf8"), before, "workspace.json untouched after failed sync");
  await vscode.workspace.getConfiguration("elide").update("home", undefined, vscode.ConfigurationTarget.Global);
  log("failed sync left workspace.json intact");

  // 7. An Elide older than the extension's minimum warns the user, and the sync still completes against it.
  const stubHome = path.join(tmpdir(), `elide-old-${process.pid}`);
  mkdirSync(path.join(stubHome, "bin"), { recursive: true });
  const realElide = execSync("command -v elide", { shell: "/bin/sh", encoding: "utf8" }).trim();
  writeFileSync(
    path.join(stubHome, "bin", "elide"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "1.4.0+stub"; exit 0; fi\nexec ${realElide} "$@"\n`,
    { mode: 0o755 },
  );
  // The extension host shares this `vscode` module object with the extension, so the notification is only
  // observable by standing in for the API while the sync runs.
  const windowApi: { showWarningMessage: unknown } = vscode.window;
  const warnings: string[] = [];
  const realWarn = windowApi.showWarningMessage;
  windowApi.showWarningMessage = (message: string) => {
    warnings.push(message);
    return Promise.resolve(undefined);
  };
  try {
    await vscode.workspace.getConfiguration("elide").update("home", stubHome, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("elide.sync");
    assert.ok(
      warnings.some((w) => w.includes("1.4.0+stub") && w.includes("1.5.0")),
      `outdated Elide warning shown, got ${JSON.stringify(warnings)}`,
    );
  } finally {
    windowApi.showWarningMessage = realWarn;
    await vscode.workspace.getConfiguration("elide").update("home", undefined, vscode.ConfigurationTarget.Global);
    rmSync(stubHome, { recursive: true, force: true });
  }
  log("outdated Elide warning ok");

  log("ALL CHECKS PASSED");
}
