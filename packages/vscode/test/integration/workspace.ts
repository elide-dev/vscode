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
  // One module per source set Elide resolves: the root declares no sources and holds none, so its export resolves no
  // source set for it and it contributes no module.
  assert.deepEqual(
    ws.modules.map((m) => m.name),
    MEMBERS.flatMap((p) =>
      [...readFileSync(path.join(member(p), "elide.pkl"), "utf8").matchAll(/\["(\w+)"\] = new Sources\.SourceSetSpec/g)].map((m) => `${p}.${m[1]}`),
    ),
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

  // Manifest providers navigate the editor buffer, but describe only members in the synced model.
  const manifestUri = vscode.Uri.file(path.join(sample, "elide.pkl"));
  const manifestDocument = await vscode.workspace.openTextDocument(manifestUri);
  await vscode.window.showTextDocument(manifestDocument);
  const modelOffset = manifestDocument.getText().indexOf('"model"') + 1;
  assert.ok(modelOffset > 0);
  const modelPosition = manifestDocument.positionAt(modelOffset);
  const modelUri = vscode.Uri.file(path.join(member("model"), "elide.pkl")).toString();
  const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>("vscode.executeLinkProvider", manifestUri);
  assert.ok(links?.some((link) => link.target?.toString() === modelUri && link.range.contains(modelPosition)), "member links open their manifests");
  const definitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>("vscode.executeDefinitionProvider", manifestUri, modelPosition);
  assert.ok(definitions?.some((definition) => ("targetUri" in definition ? definition.targetUri : definition.uri).toString() === modelUri), "Go to Definition opens the member manifest");
  const memberHover = async () => {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", manifestUri, modelPosition);
    return (hovers?.flatMap((hover) => hover.contents.map((content) => typeof content === "string" ? content : "value" in content ? content.value : "")).join("\n") ?? "").replaceAll("&nbsp;", " ");
  };
  const description = readFileSync(path.join(member("model"), "elide.pkl"), "utf8").match(/^description = "(.*)"$/m)![1]!;
  const hover = await waitFor("synced workspace member hover", async () => {
    const value = await memberHover();
    return value.includes(description) ? value : undefined;
  }, 60_000, 500);
  assert.match(hover, /model/);
  const originalManifest = manifestDocument.getText();
  const edit = new vscode.WorkspaceEdit();
  edit.replace(manifestUri, new vscode.Range(manifestDocument.positionAt(modelOffset), manifestDocument.positionAt(modelOffset + "model".length)), "./parser");
  assert.ok(await vscode.workspace.applyEdit(edit));
  const editedLinks = await vscode.commands.executeCommand<vscode.DocumentLink[]>("vscode.executeLinkProvider", manifestUri);
  assert.ok(editedLinks?.some((link) => link.target?.toString() === vscode.Uri.file(path.join(member("parser"), "elide.pkl")).toString() && link.range.contains(modelPosition)), "unsaved member edits change navigation");
  assert.ok(!editedLinks?.some((link) => link.target?.toString() === modelUri), "the old synced declaration does not supply a stale link");
  const unloadedEdit = new vscode.WorkspaceEdit();
  unloadedEdit.replace(manifestUri, new vscode.Range(manifestDocument.positionAt(modelOffset), manifestDocument.positionAt(modelOffset + "./parser".length)), "not-loaded");
  assert.ok(await vscode.workspace.applyEdit(unloadedEdit));
  assert.equal(await memberHover(), "", "unloaded members have no project metadata hover");
  const missingLinks = await vscode.commands.executeCommand<vscode.DocumentLink[]>("vscode.executeLinkProvider", manifestUri);
  assert.ok(!missingLinks?.some((link) => link.range.contains(modelPosition)), "missing member manifests have no navigation target");
  await vscode.commands.executeCommand("workbench.action.files.revert");
  assert.equal(manifestDocument.getText(), originalManifest);
  log("workspace member links, definitions, synced hover and unsaved navigation ok");
  if (process.env.ELIDE_TEST_WORKSPACE_NAVIGATION_ONLY === "1") return;

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
  // Nothing but workspace.json lands in the project: with no other build's files beside it, the server's
  // auto-detection already imports workspace.json, so no importer pin (and no `.vscode/settings.json`) is written.
  assert.equal(existsSync(path.join(sample, ".vscode", "settings.json")), false, "no .vscode/settings.json written");
  assert.equal(vscode.workspace.getConfiguration("intellij").inspect<string>("buildTool")?.workspaceValue, undefined, "intellij.buildTool not pinned");
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
  // class; it has no source set, and the root's Maven block only pins its members' versions — with no sources, its
  // classpath is empty. Build targets are read once for the whole workspace and listed per project.
  const rootGroups = ((await explorer.getChildren(roots[0])) as Node[]).filter((n) => n.kind === "group");
  assert.deepEqual(rootGroups.map((g) => g.group), ["tasks"], "the root offers no entrypoints, source sets or dependencies section");
  const cliGroups = (await explorer.getChildren(members[3])) as Node[];
  assert.deepEqual(
    cliGroups.filter((n) => n.kind === "group").map((g) => g.group),
    ["entrypoints", "tasks", "sourceSets", "dependencies"],
    "a member shows every section it has",
  );
  const tasks = (await explorer.getChildren(cliGroups.find((g) => g.group === "tasks"))) as Node[];
  // Every target stays in inspect order, including the internal targets that have no description.
  const targets = ((await explorer.getChildren(tasks.find((t) => t.group === "buildTargets"))) as Node[]).filter((t) => t.kind === "buildTarget");
  const labels = targets.map((t) => t.label);
  assert.ok(labels.includes("cli") && labels.includes("run"), `cli's own targets listed, got ${JSON.stringify(labels)}`);
  assert.ok(labels.every((l) => !l.includes(":")), `labels carry no project scope, got ${JSON.stringify(labels)}`);
  assert.ok(targets.every((t) => t.root === member("cli") && t.args?.[0] === t.label), "targets run in cli under their own name");
  assert.ok(labels.includes("index-local"), "undescribed targets stay alongside the other targets");
  assert.deepEqual(labels, [...labels].sort(), "targets retain inspect's name order");
  const rootTasks = (await explorer.getChildren(rootGroups.find((g) => g.group === "tasks"))) as Node[];
  const targetProjects = (await explorer.getChildren(rootTasks.find((g) => g.group === "buildTargets"))) as Node[];
  assert.deepEqual(targetProjects.map((n) => [n.kind, n.label]),
    ["logstat", ...MEMBERS].map((name) => ["buildTargetProject", name]), "inspect project groups, root first then declaration order");
  for (const group of targetProjects) {
    const rows = (await explorer.getChildren(group)) as Node[];
    const root = group.label === "logstat" ? sample : member(group.label);
    assert.ok(rows.every((row) => row.kind === "buildTarget" && row.root === root && row.args?.[0] === row.label),
      `${group.label}'s grouped targets execute in their own project`);
    assert.ok(rows.some((row) => row.label === "index-local"), `${group.label}'s undescribed targets are not hidden`);
    assert.deepEqual(rows.map((row) => row.label), rows.map((row) => row.label).sort(), `${group.label}'s inspect order`);
    if (group.label === "cli") assert.deepEqual(rows.map((row) => row.label), labels, "workspace and member list the same targets");
  }
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
  //    While the wizard is open the root manifest is edited in an editor, once saved and once not: the member is
  //    declared in the manifest as it then stands, keeping both edits.
  const rootManifest = vscode.Uri.file(path.join(sample, "elide.pkl"));
  const editRoot = async (from: string, to: string) => {
    const document = await vscode.workspace.openTextDocument(rootManifest);
    const at = document.getText().indexOf(from);
    assert.ok(at >= 0, `the root manifest holds ${from}`);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(rootManifest, new vscode.Range(document.positionAt(at), document.positionAt(at + from.length)), to);
    assert.ok(await vscode.workspace.applyEdit(edit), `edited ${from}`);
    return document;
  };
  const savedEdit = `description = "Access-log reporting CLI, edited while a member is added"`;
  const unsavedEdit = "// The root declares its members by hand;";
  let editedDuringWizard = false;
  const windowStubs: Record<string, unknown> = vscode.window;
  const realQuickPick = windowStubs.showQuickPick;
  const realInputBox = windowStubs.showInputBox;
  const prompts: string[] = [];
  let nameProblems: (string | undefined)[] = [];
  try {
    windowStubs.showQuickPick = async (items: unknown, options?: vscode.QuickPickOptions) => {
      if (!editedDuringWizard) {
        editedDuringWizard = true;
        assert.ok(await (await editRoot(`description = "Access-log reporting CLI, built as an Elide workspace"`, savedEdit)).save(), "saved the root manifest");
        assert.ok((await editRoot("// The root declares its members explicitly;", unsavedEdit)).isDirty, "the root manifest has unsaved edits");
      }
      const list = items as (string | { label: string; description?: string })[];
      const chosen = list.find((i) => typeof i !== "string" && i.description === "java") ?? list[0]!;
      prompts.push(`pick ${options?.title ?? options?.placeHolder}: ${typeof chosen === "string" ? chosen : chosen.label}`);
      return chosen;
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
  const declared = readFileSync(path.join(sample, "elide.pkl"), "utf8");
  assert.match(declared, /"cli"\n\s+"metrics"/, "the root declares the new member last");
  assert.ok(declared.includes(savedEdit) && declared.includes(unsavedEdit), `edits made during the wizard are kept, got ${declared}`);
  assert.ok(!(await vscode.workspace.openTextDocument(rootManifest)).isDirty, "the root manifest is saved");
  const withMember = await waitFor("metrics in workspace.json", () => {
    const json = readWorkspace();
    return json?.modules.some((m) => m.name.startsWith("metrics.")) ? json : undefined;
  }, 300_000, 2_000);
  assert.ok(withMember.modules.some((m) => m.name === "metrics.main"), "the new member is modelled");
  const withMetrics = ((await explorer.getChildren(roots[0])) as Node[]).filter((n) => n.kind === "project");
  assert.deepEqual(withMetrics.map((n) => n.label), [...MEMBERS, "metrics"], "the sidebar nests the new member too");
  log("add member ok");
}
