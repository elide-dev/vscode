import * as vscode from "vscode";

export const JETBRAINS_EXTENSION_ID = "JetBrains.kotlin-server";
const RELOAD_COMMANDS = ["jetbrains.kotlin.reloadWorkspace", "jetbrains.kotlin.restartLsp"];
const DEBUGGER_TYPES = ["intellij_jvm", "intellij_debugger"];

interface JetBrainsPackageJson {
  contributes?: { debuggers?: { type?: string }[] };
}

export function jetBrainsExtension(): vscode.Extension<unknown> | undefined {
  return vscode.extensions.getExtension(JETBRAINS_EXTENSION_ID);
}

/** Debugger type contributed by the installed JetBrains extension (`intellij_jvm` on newer builds). */
export function jetBrainsDebuggerType(): string | undefined {
  const pkg = jetBrainsExtension()?.packageJSON as JetBrainsPackageJson | undefined;
  const types = new Set((pkg?.contributes?.debuggers ?? []).map((d) => d.type).filter((t): t is string => typeof t === "string"));
  return DEBUGGER_TYPES.find((t) => types.has(t));
}

/**
 * Ask a running Kotlin LSP to pick up the regenerated `workspace.json`.
 *
 * Returns the command used, or `undefined` when the JetBrains extension is not active yet (the server reads the
 * file when it starts on the first Kotlin document, so nothing needs to happen). The command's own promise is not
 * awaited: `jetbrains.kotlin.reloadWorkspace` resolves only once the server finished re-importing (and has been
 * observed never to resolve while an import is already running); rejections are logged by the caller.
 */
export async function reloadKotlinLsp(): Promise<string | undefined> {
  const ext = jetBrainsExtension();
  if (!ext?.isActive) return undefined;
  const available = new Set(await vscode.commands.getCommands(true));
  const command = RELOAD_COMMANDS.find((c) => available.has(c));
  if (!command) throw new Error(`Kotlin LSP exposes none of ${RELOAD_COMMANDS.join(", ")}`);
  const pending = Promise.resolve(vscode.commands.executeCommand(command));
  // Surface a rejection to the caller only if it happens promptly; a long-running reload is not an error.
  const { promise: grace, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 2_000);
  await Promise.race([pending, grace]);
  pending.catch(() => undefined);
  return command;
}
