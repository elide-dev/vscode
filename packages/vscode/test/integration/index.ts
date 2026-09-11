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
  const runBuild = () => {
    const { promise, resolve } = Promise.withResolvers<number | undefined>();
    const d = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution.task.name === "build") {
        d.dispose();
        resolve(e.exitCode);
      }
    });
    void vscode.tasks.executeTask(build);
    return promise;
  };
  assert.equal(await runBuild(), 0, "elide build task exit code");
  log("build task ok");

  // 4b. Target commands: the ids code lenses and menus invoke exist, run a task for a project root, and the
  //     manifest opener resolves the single project without an argument.
  const commands = await vscode.commands.getCommands(true);
  for (const id of ["elide.run", "elide.debug", "elide.build", "elide.executeTask", "elide.openManifest", "elide.showMenu"]) {
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

  // 5. Debug: launch `elide run --debugger`, attach, hit a breakpoint, stop.
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
  const started = await vscode.debug.startDebugging(folder, { type: "elide", request: "launch", name: "Elide: Run (debug)" });
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
      execSync("pgrep -f 'elide run --debugger|java.bin -agentlib:jdwp'", { stdio: "pipe" });
      return undefined; // still running
    } catch {
      return true; // pgrep exit 1: no matches
    }
  }, 20_000, 500);
  log("debuggee processes gone");

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
