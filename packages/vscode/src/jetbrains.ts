import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";

export const JETBRAINS_EXTENSION_ID = "JetBrains.kotlin-server";
const RELOAD_COMMAND = "jetbrains.kotlin.reloadWorkspace";
const RESTART_COMMAND = "jetbrains.kotlin.restartLsp";
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
 * (and has been observed never to resolve while an import is already running); rejections are logged by the caller.
 */
export async function reloadKotlinLsp(relaunch = false): Promise<string | undefined> {
  const ext = jetBrainsExtension();
  if (!ext?.isActive) return undefined;
  const available = new Set(await vscode.commands.getCommands(true));
  const candidates = relaunch ? [RESTART_COMMAND] : [RELOAD_COMMAND, RESTART_COMMAND];
  const command = candidates.find((c) => available.has(c));
  if (!command) throw new Error(`Kotlin LSP exposes none of ${candidates.join(", ")}`);
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
