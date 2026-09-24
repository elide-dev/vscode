import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ElideCli,
  ElideCommandFailedError,
  ElideNotFoundError,
  InvalidElideHomeError,
  PROJECT_NAME_PARAMETER,
  parseWorkspaceMembers,
  resolveElideDistribution,
  validateInitParameter,
  withWorkspaceMember,
  type ElideDistribution,
  type InitTemplate,
} from "@elide/ide-core";
import * as vscode from "vscode";
import { readConfig } from "./config.js";
import type { ElideUi } from "./output.js";
import { reportElideMissing, type ElideProject, type ElideWorkspace } from "./projects.js";

/**
 * `Elide: New Project…` — pick a template, answer its parameters, generate into a new directory and open it.
 *
 * The questions come from `elide init --templates --json`, so the wizard asks exactly what the installed CLI asks
 * interactively and validates answers with the same rules. Dismissing any prompt cancels silently.
 */
export async function newProject(ui: ElideUi): Promise<void> {
  const dist = resolveDistribution(ui, "new project");
  if (!dist) return;

  const template = await pickTemplate(dist, ui);
  if (!template) return;

  const parent = (
    await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: "Create project here",
    })
  )?.[0];
  if (!parent) return;
  const parentPath = parent.fsPath;

  const name = await vscode.window.showInputBox({
    prompt: "Project name (directory to create)",
    value: template.id,
    validateInput: (value) => validateDirectoryName(value, parentPath),
  });
  if (!name) return;
  const projectName = name.trim();
  const target = path.join(parentPath, projectName);

  if (!(await generate(dist, template, target, projectName, ui))) return;

  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(target), {
    forceNewWindow: (vscode.workspace.workspaceFolders?.length ?? 0) > 0,
  });
}

/**
 * `Elide: Add Workspace Member…` — generate a project inside an existing one's directory and declare it in that
 * project's `workspace.members`, which is what makes the two build, install and resolve as one graph.
 *
 * A project declaring no members yet becomes the root of a workspace by gaining its first one. `value` is the
 * project row the Elide view passes; without one the command asks, and a window holding a single root uses it.
 */
export async function addWorkspaceMember(workspace: ElideWorkspace, ui: ElideUi, value: unknown): Promise<void> {
  const root = await pickWorkspaceRoot(workspace, value);
  if (!root) return;

  let manifest: string;
  try {
    manifest = readFileSync(root.manifestPath, "utf8");
  } catch (e) {
    ui.log(`add member: could not read ${root.manifestPath}: ${e instanceof Error ? e.message : String(e)}`);
    void vscode.window.showErrorMessage(`Elide: could not read ${root.manifestPath}.`);
    return;
  }
  const declared = parseWorkspaceMembers(manifest);

  const dist = resolveDistribution(ui, "add member");
  if (!dist) return;

  const answer = await vscode.window.showInputBox({
    title: `Add a member to ${root.model?.name ?? path.basename(root.root)}`,
    prompt: "Member name (directory created inside the workspace root)",
    validateInput: (candidate) => {
      const trimmed = candidate.trim();
      if (declared.includes(trimmed)) return `${trimmed} is already a member of this workspace`;
      // The member's directory is its project name in `elide build core:jar`, which takes neither.
      if (/[\s:]/.test(trimmed)) return "must contain no whitespace or ':'";
      return validateDirectoryName(candidate, root.root);
    },
  });
  if (!answer) return;
  const member = answer.trim();

  const template = await pickTemplate(dist, ui);
  if (!template) return;

  const target = path.join(root.root, member);
  if (!(await generate(dist, template, target, member, ui))) return;

  try {
    writeFileSync(root.manifestPath, withWorkspaceMember(manifest, member), "utf8");
  } catch (e) {
    ui.log(`add member: could not update ${root.manifestPath}: ${e instanceof Error ? e.message : String(e)}`);
    void vscode.window.showErrorMessage(`Elide: ${member} was created, but ${root.manifestPath} could not be updated.`);
    return;
  }
  ui.log(`workspace member added: ${target} (declared in ${root.manifestPath})`);

  await vscode.window.showTextDocument(vscode.Uri.file(path.join(target, path.basename(root.manifestPath))), { preview: false });
  await workspace.syncFolder(root.folder, "project-added");
}

/** The project a new member is added to: the one the command was invoked on, the only one, or the one picked. */
async function pickWorkspaceRoot(workspace: ElideWorkspace, value: unknown): Promise<ElideProject | undefined> {
  const named = typeof value === "object" && value !== null && typeof (value as { root?: unknown }).root === "string" ? (value as { root: string }).root : undefined;
  const roots = workspace.projects.filter((p) => !p.workspaceRoot);
  if (named) {
    const project = roots.find((p) => p.root === named) ?? workspace.projectAt(named);
    // Elide workspaces are exactly two layers deep: a member's members belong to the root above it.
    return project?.workspaceRoot ? (workspace.projectAt(project.workspaceRoot) ?? project) : project;
  }
  if (roots.length === 0) {
    void vscode.window.showWarningMessage("Elide: no Elide project in this window to add a member to.");
    return undefined;
  }
  if (roots.length === 1) return roots[0];
  const pick = await vscode.window.showQuickPick(
    roots.map((project) => ({
      label: project.model?.name ?? path.basename(project.root),
      description: project.root,
      project,
    })),
    { placeHolder: "Workspace root to add the member to" },
  );
  return pick?.project;
}

/** Resolve the distribution every `elide init` runs from, reporting the failure the way a sync does. */
function resolveDistribution(ui: ElideUi, what: string): ElideDistribution | undefined {
  try {
    return resolveElideDistribution({ explicitHome: readConfig().home });
  } catch (e) {
    ui.log(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof ElideNotFoundError || e instanceof InvalidElideHomeError) reportElideMissing(ui, e);
    else void vscode.window.showErrorMessage(`Elide: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/** Offer the CLI's templates, most-default first; `undefined` when the listing failed or the pick was dismissed. */
async function pickTemplate(dist: ElideDistribution, ui: ElideUi): Promise<InitTemplate | undefined> {
  // Templates are project-independent, so the listing runs outside any workspace.
  const templates = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Elide: loading project templates…" },
    async () => {
      try {
        return await new ElideCli(dist, tmpdir()).initTemplates();
      } catch (e) {
        ui.log(`elide init --templates --json failed: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      }
    },
  );
  if (!templates) {
    void vscode.window
      .showErrorMessage("Elide: could not list templates (needs Elide 1.5+ with `elide init --templates --json`).", "Show Output")
      .then((pick) => {
        if (pick === "Show Output") ui.output.show(true);
      });
    return undefined;
  }
  if (templates.length === 0) {
    void vscode.window.showWarningMessage("Elide: the installed CLI reports no project templates.");
    return undefined;
  }
  const ordered = [...templates].sort((a, b) => Number(b.default) - Number(a.default));
  return (
    await vscode.window.showQuickPick(
      ordered.map((t) => ({ label: t.title, description: t.id, detail: t.description, template: t })),
      { placeHolder: "Project template" },
    )
  )?.template;
}

/**
 * Ask the template's questions and run `elide init` in `target`, which is created first. Returns whether the
 * project was generated; a dismissed prompt cancels silently and a failed run is reported.
 */
async function generate(dist: ElideDistribution, template: InitTemplate, target: string, projectName: string, ui: ElideUi): Promise<boolean> {
  const answers: Record<string, string> = { [PROJECT_NAME_PARAMETER]: projectName };
  if (!(await collectAnswers(template, answers))) return false;

  mkdirSync(target, { recursive: true });
  ui.log(`elide init --template ${template.id} in ${target}: ${Object.entries(answers).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  const failure = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Elide: creating ${projectName} from ${template.id}…` },
    async () => {
      try {
        await new ElideCli(dist, target).init(template.id, answers, { onLine: (line) => ui.log(`  ${line}`) });
        return undefined;
      } catch (e) {
        return e;
      }
    },
  );
  if (failure) {
    ui.log(`elide init failed: ${failure instanceof Error ? failure.message : String(failure)}`);
    // Leave anything the CLI already wrote in place; only the directory this command created is removed.
    let empty = false;
    try {
      empty = readdirSync(target).length === 0;
    } catch {
      empty = false;
    }
    if (empty) rmSync(target, { recursive: true, force: true });
    const exit = failure instanceof ElideCommandFailedError ? ` (exit ${failure.exitCode ?? "signal"})` : "";
    void vscode.window.showErrorMessage(`Elide: project generation failed${exit}.`, "Show Output").then((pick) => {
      if (pick === "Show Output") ui.output.show(true);
    });
    return false;
  }
  ui.log(`created ${target}`);
  return true;
}

/** Why `value` is no directory name to generate into, or `undefined` when it is one. */
function validateDirectoryName(value: string, parent: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "must not be empty";
  if (trimmed !== path.basename(trimmed) || trimmed === "." || trimmed === "..") return "must be a single directory name";
  if (existsSync(path.join(parent, trimmed))) return `${trimmed} already exists in ${parent}`;
  return undefined;
}

/**
 * Ask for every parameter of `template` and, for each of its optional blocks, whether to include it — recursing
 * into the blocks the user enabled. Returns `false` when a prompt was dismissed.
 */
async function collectAnswers(template: InitTemplate, answers: Record<string, string>): Promise<boolean> {
  for (const parameter of template.parameters) {
    if (parameter.id === PROJECT_NAME_PARAMETER) continue;
    if (parameter.attributes.includes("Boolean")) {
      const choices = parameter.default === "false" ? ["false", "true"] : ["true", "false"];
      const pick = await vscode.window.showQuickPick(choices, { title: parameter.title, placeHolder: parameter.description });
      if (!pick) return false;
      answers[parameter.id] = pick;
      continue;
    }
    const value = await vscode.window.showInputBox({
      title: parameter.title,
      prompt: parameter.description,
      value: parameter.default,
      validateInput: (v) => validateInitParameter(parameter, v),
    });
    if (value === undefined) return false;
    answers[parameter.id] = value;
  }
  for (const block of template.blocks) {
    const choices = block.default ? ["Yes", "No"] : ["No", "Yes"];
    const pick = await vscode.window.showQuickPick(choices, { title: `Include ${block.title}?`, placeHolder: block.description });
    if (!pick) return false;
    const enabled = pick === "Yes";
    answers[block.id] = enabled ? "true" : "false";
    if (enabled && !(await collectAnswers(block, answers))) return false;
  }
  return true;
}
