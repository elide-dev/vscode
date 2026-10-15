import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  KOTLIN_DATA_SHARING_SETTING,
  KOTLIN_REGION_SETTING,
  KOTLIN_SETUP_COMMAND,
  kotlinSetupPendingMessage,
  unansweredKotlinSetupSteps,
  type KotlinSetupStep,
} from "@elide/ide-core";
import * as vscode from "vscode";

export const JETBRAINS_EXTENSION_ID = "JetBrains.kotlin-server";
const RELOAD_COMMAND = "jetbrains.kotlin.reloadWorkspace";
const RESTART_COMMAND = "jetbrains.kotlin.restartLsp";
/** Either command: the Kotlin extension exposes them once its server can start (its first-run setup is answered). */
const RELOAD_COMMANDS = [RELOAD_COMMAND, RESTART_COMMAND];
const DEBUGGER_TYPES = ["intellij_jvm", "intellij_debugger"];

interface JetBrainsPackageJson {
  contributes?: { debuggers?: { type?: string }[] };
}

export function jetBrainsExtension(): vscode.Extension<unknown> | undefined {
  return vscode.extensions.getExtension(JETBRAINS_EXTENSION_ID);
}

/** Use the IDE plugin compiled for this server; a project's build plugin may have an incompatible compiler ABI. */
export function jetBrainsComposeCompilerPlugin(): string | undefined {
  const extension = jetBrainsExtension();
  if (!extension) return undefined;
  const plugin = path.join(extension.extensionPath, "server", "plugins", "kotlin", "lib", "intellij.libraries.kotlinc.compose.compiler.plugin.jar");
  return existsSync(plugin) ? plugin : undefined;
}

/** The language server bundled with the JetBrains extension, if installed. */
export function jetBrainsServerDirectory(): string | undefined {
  const extension = jetBrainsExtension();
  if (!extension) return undefined;
  const server = path.join(extension.extensionPath, "server");
  return existsSync(path.join(server, "product-info.json")) ? server : undefined;
}

/** Debugger type contributed by the installed JetBrains extension (`intellij_jvm` on newer builds). */
export function jetBrainsDebuggerType(): string | undefined {
  const pkg = jetBrainsExtension()?.packageJSON as JetBrainsPackageJson | undefined;
  const types = new Set((pkg?.contributes?.debuggers ?? []).map((d) => d.type).filter((t): t is string => typeof t === "string"));
  return DEBUGGER_TYPES.find((t) => types.has(t));
}

/** The Kotlin extension is active but holds its language server back until its first-run setup is complete. */
export class KotlinSetupPendingError extends Error {
  constructor(readonly steps: readonly KotlinSetupStep[]) {
    super(kotlinSetupPendingMessage(steps));
  }
}

/**
 * The first-run setup steps the Kotlin extension still waits on, or `undefined` when it is not held back by them.
 *
 * The region and data-sharing answers are read from its settings. Its accepted terms live in its private state, so
 * an active extension that registered its setup command but none of its server commands counts as waiting too
 * (with no step named): it registers those commands only once the server is allowed to start.
 */
export async function pendingKotlinSetup(): Promise<readonly KotlinSetupStep[] | undefined> {
  const ext = jetBrainsExtension();
  if (!ext) return undefined;
  const config = vscode.workspace.getConfiguration();
  const steps = unansweredKotlinSetupSteps(config.inspect(KOTLIN_REGION_SETTING)?.globalValue, config.inspect(KOTLIN_DATA_SHARING_SETTING)?.globalValue);
  if (!ext.isActive) return steps.length > 0 ? steps : undefined;
  const available = new Set(await vscode.commands.getCommands(true));
  if (RELOAD_COMMANDS.some((c) => available.has(c))) return undefined;
  return steps.length > 0 || available.has(KOTLIN_SETUP_COMMAND) ? steps : undefined;
}

let setupNoticeShown = false;

/**
 * Tell the user the Kotlin extension waits on its setup, offering to open it. Background callers (every sync) pass
 * `once` so the notice appears once per window; a command the user just ran always explains why it did nothing.
 */
export function notifyKotlinSetupPending(steps: readonly KotlinSetupStep[], { once = false } = {}): void {
  if (once && setupNoticeShown) return;
  setupNoticeShown = true;
  void vscode.window.showWarningMessage(`Elide: ${kotlinSetupPendingMessage(steps)}`, "Open Kotlin Setup").then(async (pick) => {
    if (pick !== "Open Kotlin Setup") return;
    const available = await vscode.commands.getCommands(true);
    if (available.includes(KOTLIN_SETUP_COMMAND)) await vscode.commands.executeCommand(KOTLIN_SETUP_COMMAND);
    else await vscode.commands.executeCommand("workbench.action.openSettings", "intellij.region intellij.dataSharing");
  });
}

/**
 * Ask a running Kotlin LSP to pick up the regenerated `workspace.json`, or — with `relaunch`, after a launch
 * setting such as `intellij.additionalJvmArgs` changed — to start a new server process, which imports as well.
 *
 * A plain `jetbrains.kotlin.restartLsp` does not apply launch settings: with a workspace folder open the server is
 * a daemon shared per workspace root, discovered through the port file `<tmpdir>/intellij-lsp-servers/<sha256 of
 * the first folder's path, 16 hex>.port` (`portFile.ts` in JetBrains.kotlin-server 0.0.13), and a restart
 * reconnects to it. Removing the port file first makes the restart spawn a fresh daemon with the current settings;
 * the old one, left without clients, shuts itself down after its idle timeout.
 *
 * Returns the command used, or `undefined` when the JetBrains extension is not active yet (the server reads the
 * file and the settings when it starts on the first Kotlin document, so nothing needs to happen). The command's own
 * promise is not awaited: `jetbrains.kotlin.reloadWorkspace` resolves only once the server finished re-importing
 * (and has been observed never to resolve while an import is already running); rejections are logged by the caller. Throws
 * {@link KotlinSetupPendingError} while the extension waits on its first-run setup: the server imports
 * `workspace.json` when it starts afterwards.
 */
export async function reloadKotlinLsp(relaunch = false): Promise<string | undefined> {
  const ext = jetBrainsExtension();
  if (!ext?.isActive) return undefined;
  const available = new Set(await vscode.commands.getCommands(true));
  const candidates = relaunch ? [RESTART_COMMAND] : [RELOAD_COMMAND, RESTART_COMMAND];
  const command = candidates.find((c) => available.has(c));
  if (!command) {
    const steps = await pendingKotlinSetup();
    if (steps) throw new KotlinSetupPendingError(steps);
    throw new Error(`Kotlin LSP exposes none of ${candidates.join(", ")}`);
  }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (relaunch && root) {
    const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
    rmSync(path.join(os.tmpdir(), "intellij-lsp-servers", `${hash}.port`), { force: true });
  }
  const pending = Promise.resolve(vscode.commands.executeCommand(command));
  // Surface a rejection to the caller only if it happens promptly; a long-running reload is not an error.
  const { promise: grace, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 2_000);
  await Promise.race([pending, grace]);
  pending.catch(() => undefined);
  return command;
}
