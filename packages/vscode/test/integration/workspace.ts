/**
 * The `workspace` scenario (see runner.ts), on the `logstat` workspace sample: `model` ← `parser`, `report` ← `cli`,
 * related through `project("…")` references. Checks that the sync models every member and the dependencies between
 * them — transitive ones included — that the Kotlin LSP resolves sibling code from `cli`, and that the sidebar, code
 * lenses, tests and manifest watchers work per member.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { ElideExtensionApi as ElideApi } from "../../src/extension.js";
import { errorsOf, hoverAt, log, waitFor } from "./helpers.js";

interface WorkspaceJson {
  modules: { name: string; dependencies: { type: string; name?: string; scope?: string; isExported?: boolean }[] }[];
  libraries: { name: string; roots: { path: string }[] }[];
}

type Node = { kind: string; label: string; root: string; member?: boolean; group?: string; args?: string[] };

const MEMBERS = ["model", "parser", "report", "cli"];

export async function runWorkspaceScenario(): Promise<void> {
  const sample = process.env.ELIDE_TEST_SAMPLE!;
  const member = (name: string) => path.join(sample, name);
  const workspaceJson = path.join(sample, "workspace.json");
  const readWorkspace = (): WorkspaceJson | undefined => (existsSync(workspaceJson) ? JSON.parse(readFileSync(workspaceJson, "utf8")) : undefined);
  const moduleDeps = (ws: WorkspaceJson, module: string) =>
    ws.modules.find((m) => m.name === module)!.dependencies.filter((d) => d.type === "module");

  // 1. One sync resolves the root and every member; `project("…")` references become module dependencies, and so do
  //    the siblings an artifact brings with it.
  log("waiting for startup sync");
  const ws = await waitFor("workspace.json with the members", () => {
    const json = readWorkspace();
    return json?.modules.some((m) => m.name === "cli.main") ? json : undefined;
  }, 300_000);
  assert.deepEqual(
    ws.modules.map((m) => m.name),
    ["logstat", ...MEMBERS].flatMap((p) => [`${p}.main`, `${p}.test`]),
  );
  const exported = (name: string, scope: string) => ({ type: "module", name, scope, isExported: true, isTestJar: false });
  assert.deepEqual(moduleDeps(ws, "parser.main"), [exported("model.main", "compile")], "parser.main depends on model");
  assert.deepEqual(
    new Set(moduleDeps(ws, "cli.main").map((d) => JSON.stringify(d))),
    new Set(["parser.main", "model.main", "report.main"].map((m) => JSON.stringify(exported(m, "compile")))),
    "cli.main depends on parser and report, and on model which their JARs carry",
  );
  assert.ok(
    moduleDeps(ws, "cli.test").some((d) => d.name === "report.main" && d.scope === "test"),
    "cli.test sees report at test scope",
  );
  assert.deepEqual(
    ws.libraries.filter((l) => l.roots.some((r) => r.path.includes("/.dev/artifacts/"))).map((l) => l.name),
    [],
    "a sibling's JAR is never a library",
  );
  log("sync ok");

  // 2. The Kotlin LSP resolves sibling code from `cli` through the module dependencies, without anything built:
  //    `parser` directly, and `model` (the type `parseFile` returns) through it.
  const commandKt = vscode.Uri.file(path.join(member("cli"), "src", "main", "kotlin", "logstat", "cli", "Command.kt"));
  const mainKt = vscode.Uri.file(path.join(member("cli"), "src", "main", "kotlin", "logstat", "cli", "Main.kt"));
  const testKt = vscode.Uri.file(path.join(member("cli"), "src", "test", "kotlin", "logstat", "cli", "CliTest.kt"));
  log("waiting for Kotlin LSP hover on parseFile");
  const parseFileHover = await waitFor("hover on parseFile", async () => {
    const text = await hoverAt(commandKt, "parseFile(");
    return /parseFile/.test(text) && /LogFile/.test(text) ? text : undefined;
  }, 600_000, 3_000);
  log("hover(parseFile):", parseFileHover.slice(0, 200).replace(/\n/g, " "));
  const summaryHover = await waitFor("hover on Reports.summary", async () => {
    const text = await hoverAt(commandKt, "summary(logFile");
    return /summary/.test(text) ? text : undefined;
  }, 120_000, 3_000);
  log("hover(Reports.summary):", summaryHover.slice(0, 200).replace(/\n/g, " "));
  await new Promise((r) => setTimeout(r, 5_000));
  for (const uri of [commandKt, testKt]) {
    assert.deepEqual(errorsOf(uri).map((d) => d.message), [], `no errors in ${path.basename(uri.fsPath)}`);
  }

  // 3. Code lenses on a member's sources run in that member, not in the root enclosing it. The command needs the
  //    document loaded.
  await vscode.workspace.openTextDocument(mainKt);
  const lenses = await waitFor("code lenses on cli's main", async () => {
    const found = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", mainKt);
    return found?.some((l) => l.command?.command === "elide.run") ? found : undefined;
  }, 30_000, 1_000);
  const run = lenses.find((l) => l.command?.command === "elide.run")!;
  assert.equal((run.command!.arguments![0] as { root: string }).root, member("cli"), "the run lens targets the cli member");
  log("code lenses ok");

  // 4. Sidebar: the workspace is one top-level project, its members nested under it; a member's build targets are
  //    its own, named without the project scope the listing qualifies them with.
  const extension = vscode.extensions.all.find((e) => e.id.endsWith(".elide"));
  assert.ok(extension, "elide extension found");
  const explorer = await waitFor("extension explorer api", () => (extension.exports as ElideApi | undefined)?.explorer, 30_000, 500);
  const roots = (await explorer.getChildren()) as Node[];
  assert.deepEqual(roots.map((n) => [n.kind, n.label, n.root]), [["project", "logstat", sample]], "the workspace is one top-level project");
  const members = ((await explorer.getChildren(roots[0])) as Node[]).filter((n) => n.kind === "project");
  assert.deepEqual(
    members.map((n) => [n.label, n.root, n.member]),
    MEMBERS.map((name) => [name, member(name), true]),
    "members nested in declaration order",
  );
  // A section with nothing under it is left out: the root runs no entrypoint of its own, while `cli` declares a main
  // class. Build targets are read once for the whole workspace and listed per project.
  const rootGroups = ((await explorer.getChildren(roots[0])) as Node[]).filter((n) => n.kind === "group");
  assert.deepEqual(rootGroups.map((g) => g.group), ["tasks", "sourceSets", "dependencies"], "the root offers no entrypoints section");
  const cliGroups = (await explorer.getChildren(members[3])) as Node[];
  assert.deepEqual(
    cliGroups.filter((n) => n.kind === "group").map((g) => g.group),
    ["entrypoints", "tasks", "sourceSets", "dependencies"],
    "a member shows every section it has",
  );
  const tasks = (await explorer.getChildren(cliGroups.find((g) => g.group === "tasks"))) as Node[];
  const targets = (await explorer.getChildren(tasks.find((t) => t.group === "buildTargets"))) as Node[];
  const labels = targets.map((t) => t.label);
  assert.ok(labels.includes("cli") && labels.includes("run"), `cli's own targets listed, got ${JSON.stringify(labels)}`);
  assert.ok(labels.every((l) => !l.includes(":")), `labels carry no project scope, got ${JSON.stringify(labels)}`);
  assert.ok(targets.every((t) => t.root === member("cli") && t.args?.[0] === t.label), "targets run in cli under their own name");
  log("sidebar ok");

  // 5. Test explorer: each member's tests are discovered under that member. `elide test` at the root runs the whole
  //    workspace, so running everything is one invocation there, reporting on the members' items — each test once.
  const tests = await waitFor("extension test api", () => (extension.exports as ElideApi | undefined)?.tests, 30_000, 500);
  const summary = await waitFor("every member's tests discovered and passing", async () => {
    const result = await tests.runAll();
    return ["parser", "report", "cli"].every((m) => result.passed.some((id) => id.startsWith(`m:${member(m)}:`))) ? result : undefined;
  }, 300_000, 2_000);
  log("tests:", JSON.stringify(summary));
  assert.deepEqual([summary.failed, summary.skipped, summary.errored], [[], [], []], "no failures");
  assert.equal(summary.passed.length, 17, "every test of the workspace reported");
  assert.equal(new Set(summary.passed).size, summary.passed.length, "each test reported once");
  assert.ok(summary.passed.every((id) => id.startsWith("m:") && MEMBERS.some((m) => id.startsWith(`m:${member(m)}:`))), "every result on its member's own item");
  log("tests ok");

  // 6. Editing a member's manifest re-resolves the workspace (policy: always); what `report` now declares reaches its
  //    model, and `cli`'s through report's JAR.
  const reportManifest = path.join(member("report"), "elide.pkl");
  const manifest = readFileSync(reportManifest, "utf8");
  const pinned = `"org.apache.commons:commons-lang3"`;
  assert.ok(manifest.includes(pinned), "report declares commons-lang3");
  writeFileSync(reportManifest, manifest.replace(pinned, `${pinned}\n      "com.google.code.gson:gson:2.11.0"`));
  log("edited report/elide.pkl; waiting for resync with gson");
  const withGson = await waitFor("gson in workspace.json", () => {
    const json = readWorkspace();
    return json?.libraries.some((l) => l.name.includes("com.google.code.gson:gson:")) ? json : undefined;
  }, 300_000, 2_000);
  const gson = withGson.libraries.find((l) => l.name.includes("com.google.code.gson:gson:"))!.name;
  for (const module of ["report.main", "cli.main"]) {
    assert.ok(
      withGson.modules.find((m) => m.name === module)!.dependencies.some((d) => d.type === "library" && d.name === gson),
      `${module} sees gson`,
    );
  }
  log("member manifest resync ok");

  // 7. `Elide: Add Workspace Member…` generates a project inside the root and declares it there. The extension host
  //    shares this `vscode` module object with the extension, so its prompts are answered by standing in for the API.
  const windowStubs: Record<string, unknown> = vscode.window;
  const realQuickPick = windowStubs.showQuickPick;
  const realInputBox = windowStubs.showInputBox;
  const prompts: string[] = [];
  let nameProblems: (string | undefined)[] = [];
  try {
    windowStubs.showQuickPick = (items: unknown, options?: vscode.QuickPickOptions) => {
      const list = items as (string | { label: string; description?: string })[];
      const chosen = list.find((i) => typeof i !== "string" && i.description === "java") ?? list[0]!;
      prompts.push(`pick ${options?.title ?? options?.placeHolder}: ${typeof chosen === "string" ? chosen : chosen.label}`);
      return Promise.resolve(chosen);
    };
    windowStubs.showInputBox = (options?: vscode.InputBoxOptions) => {
      prompts.push(`input ${options?.title ?? options?.prompt}: ${options?.value ?? ""}`);
      if (!options?.prompt?.startsWith("Member name")) return Promise.resolve(options?.value ?? "");
      // A member already declared, a name Elide cannot take as a project scope, and an existing directory.
      nameProblems = ["cli", "two words", "data"].map((v) => options.validateInput?.(v) as string | undefined);
      return Promise.resolve("metrics");
    };
    await vscode.commands.executeCommand("elide.addMember", { root: sample });
  } finally {
    windowStubs.showQuickPick = realQuickPick;
    windowStubs.showInputBox = realInputBox;
  }
  log("add member prompts:", JSON.stringify(prompts));
  for (const problem of nameProblems) assert.equal(typeof problem, "string", `rejected member name reported, got ${JSON.stringify(nameProblems)}`);
  assert.ok(existsSync(path.join(member("metrics"), "elide.pkl")), "the member was generated");
  assert.match(readFileSync(path.join(sample, "elide.pkl"), "utf8"), /"cli"\n\s+"metrics"/, "the root declares the new member last");
  const withMember = await waitFor("metrics in workspace.json", () => {
    const json = readWorkspace();
    return json?.modules.some((m) => m.name.startsWith("metrics.")) ? json : undefined;
  }, 300_000, 2_000);
  assert.ok(withMember.modules.some((m) => m.name === "metrics.main"), "the new member is modelled");
  const withMetrics = ((await explorer.getChildren(roots[0])) as Node[]).filter((n) => n.kind === "project");
  assert.deepEqual(withMetrics.map((n) => n.label), [...MEMBERS, "metrics"], "the sidebar nests the new member too");
  log("add member ok");
}
