import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ElideCli,
  ElideCommandFailedError,
  ElideNotFoundError,
  InvalidElideHomeError,
  PROJECT_NAME_PARAMETER,
  resolveElideDistribution,
  validateInitParameter,
  type ElideDistribution,
  type InitTemplate,
} from "@elide/ide-core";
import * as vscode from "vscode";
import { readConfig } from "./config.js";
import type { ElideUi } from "./output.js";
import { reportElideMissing } from "./projects.js";

/**
 * `Elide: New Project…` — pick a template, answer its parameters, generate into a new directory and open it.
 *
 * The questions come from `elide init --templates --json`, so the wizard asks exactly what the installed CLI asks
 * interactively and validates answers with the same rules. Dismissing any prompt cancels silently.
 */
export async function newProject(ui: ElideUi): Promise<void> {
  let dist: ElideDistribution;
  try {
    dist = resolveElideDistribution({ explicitHome: readConfig().home });
  } catch (e) {
    ui.log(`new project: ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof ElideNotFoundError || e instanceof InvalidElideHomeError) reportElideMissing(ui, e);
    else void vscode.window.showErrorMessage(`Elide: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

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
    return;
  }
  if (templates.length === 0) {
    void vscode.window.showWarningMessage("Elide: the installed CLI reports no project templates.");
    return;
  }

  const ordered = [...templates].sort((a, b) => Number(b.default) - Number(a.default));
  const template = (
    await vscode.window.showQuickPick(
      ordered.map((t) => ({ label: t.title, description: t.id, detail: t.description, template: t })),
      { placeHolder: "Project template" },
    )
  )?.template;
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
    validateInput: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return "must not be empty";
      if (trimmed !== path.basename(trimmed) || trimmed === "." || trimmed === "..") return "must be a single directory name";
      if (existsSync(path.join(parentPath, trimmed))) return `${trimmed} already exists in ${parentPath}`;
      return undefined;
    },
  });
  if (!name) return;
  const projectName = name.trim();
  const target = path.join(parentPath, projectName);

  const answers: Record<string, string> = { [PROJECT_NAME_PARAMETER]: projectName };
  if (!(await collectAnswers(template, answers))) return;

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
    return;
  }

  ui.log(`created ${target}`);
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(target), {
    forceNewWindow: (vscode.workspace.workspaceFolders?.length ?? 0) > 0,
  });
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
