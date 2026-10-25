import {
  KOTLIN_DATA_SHARING_SETTING,
  KOTLIN_REGION_SETTING,
  KOTLIN_SETUP_COMMAND,
  kotlinSetupPendingMessage,
  unansweredKotlinSetupSteps,
  type KotlinSetupStep,
} from "@elide/ide-core";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as vscode from "vscode";
import { awaitKotlinAnalysis, type KotlinAnalysisResult, type KotlinAnalysisStage } from "./kotlinAnalysis.js";

export const JETBRAINS_EXTENSION_ID = "JetBrains.kotlin-server";
const RELOAD_COMMAND = "jetbrains.kotlin.reloadWorkspace";
const RESTART_COMMAND = "jetbrains.kotlin.restartLsp";
const DEBUGGER_TYPES = ["intellij_jvm", "intellij_debugger"];
const PLUGIN_PATH_PROPERTY = "-Dplugin.path";
/** A wait shorter than this attaches without a progress notification flashing by. */
const ANALYSIS_PROGRESS_DELAY_MS = 750;
const ANALYSIS_STAGES: Record<KotlinAnalysisStage, string> = {
  server: "waiting for the Kotlin language server",
  import: "waiting for the Kotlin language server to import the workspace",
  index: "waiting for Kotlin indexing to finish",
};

/** What this window adds to the Kotlin server's launch options. */
export interface KotlinLspLaunchOptions {
  /** Elide's server plugin directory (`kotlinLspPlugin`), listed in `-Dplugin.path` while a Compose project is open. */
  plugin?: string;
}

/**
 * IJ_JAVA_OPTIONS is the JetBrains launcher's inherited option string; the companion appends the user's
 * `intellij.additionalJvmArgs` to it, quoted the way {@link launcherQuote} does. Elide's options live there, in the
 * current extension host, and never in persisted settings: a workspace array would shadow the user's arguments, and
 * the plugin path is local to this machine and VS Code profile.
 *
 * A `-Dplugin.path` of the user's own comes later on the command line and wins: the JVM keeps the last value.
 */
export class KotlinLspEnvironment {
  private inherited: string | undefined;
  private applied: string | undefined;

  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  /** Apply `options` over the inherited launcher options; `true` when they changed, which needs a new server. */
  configure(options: KotlinLspLaunchOptions): boolean {
    const current = this.environment.IJ_JAVA_OPTIONS;
    const ownsCurrent = this.applied !== undefined && current === this.applied;
    const inherited = ownsCurrent ? this.inherited : current;
    const added = [
      ...(options.plugin ? [launcherQuote(`${PLUGIN_PATH_PROPERTY}=${options.plugin}`)] : []),
    ];
    const next = added.length > 0 ? [...(inherited ? [inherited] : []), ...added].join(" ") : inherited;
    this.inherited = inherited;
    this.applied = added.length > 0 ? next : undefined;
    if (next === current) return false;
    if (next === undefined) delete this.environment.IJ_JAVA_OPTIONS;
    else this.environment.IJ_JAVA_OPTIONS = next;
    return true;
  }

  dispose(): void {
    this.configure({});
  }
}

/** One launcher option as the JetBrains companion quotes `intellij.additionalJvmArgs` into `IJ_JAVA_OPTIONS`. */
function launcherQuote(option: string): string {
  return /^[a-zA-Z0-9._=:/@-]+$/.test(option) ? option : `"${option.replace(/(["\\$`])/g, "\\$1")}"`;
}

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

/** Whether `type` is the JetBrains JVM debugger, which runs inside the Kotlin language server. */
export function isJetBrainsDebugger(type: string): boolean {
  return DEBUGGER_TYPES.includes(type);
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
  if ([RELOAD_COMMAND, RESTART_COMMAND].some((c) => available.has(c))) return undefined;
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
 * Hold a JetBrains debug session until the Kotlin language server would give it an analyzed workspace (see
 * {@link awaitKotlinAnalysis}), with cancellable progress while it waits. Resolves `false` once the user cancels or
 * `signal` aborts; `true` to attach, after warning when readiness could not be confirmed.
 */
export async function awaitKotlinDebuggerAnalysis(
  probe: string | undefined,
  watermark: string,
  signal: AbortSignal,
  log: (message: string) => void,
): Promise<boolean> {
  const cancel = new AbortController();
  const abort = () => cancel.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const started = Date.now();
  let stage: KotlinAnalysisStage = "server";
  let report: ((stage: KotlinAnalysisStage) => void) | undefined;
  const ready = awaitKotlinAnalysis({
    list: async () => vscode.commands.getCommands(true),
    execute: async (command, ...args) => vscode.commands.executeCommand(command, ...args),
  }, {
    ...(probe ? { probe } : {}),
    watermark,
    signal: cancel.signal,
    onStage: (next) => {
      stage = next;
      report?.(next);
    },
  });
  try {
    const result: KotlinAnalysisResult = await Promise.race([ready, sleep(ANALYSIS_PROGRESS_DELAY_MS, undefined)]) ?? await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Elide: debugger", cancellable: true },
      (progress, token) => {
        report = (next) => progress.report({ message: ANALYSIS_STAGES[next] });
        report(stage);
        token.onCancellationRequested(() => cancel.abort(new Error("cancelled")));
        return ready;
      },
    );
    log(`debug: Kotlin analysis ${result} after ${Date.now() - started} ms`);
    if (result === "unsupported") {
      void vscode.window.showWarningMessage("Elide: this Kotlin language server cannot tell when its analysis is ready. If breakpoints are skipped or evaluation fails, restart the debug session once indexing has finished.");
    } else if (result === "unimported") {
      void vscode.window.showWarningMessage("Elide: the Kotlin language server has not imported this project, so breakpoints in it may not bind. Sync the project and restart the debug session.");
    }
    return true;
  } catch (error) {
    if (cancel.signal.aborted) {
      log(`debug: attach cancelled while ${ANALYSIS_STAGES[stage]}`);
      return false;
    }
    const message = error instanceof Error ? error.message : String(error);
    log(`debug: could not confirm Kotlin analysis readiness: ${message}`);
    void vscode.window.showWarningMessage(`Elide: could not confirm the Kotlin language server is ready to debug (${message}). If breakpoints are skipped or evaluation fails, restart the debug session.`);
    return true;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/**
 * Ask a running Kotlin LSP to pick up the regenerated `workspace.json`, or — with `relaunch`, after a launch
 * setting such as `intellij.additionalJvmArgs` changed — to start a new server process, which imports as well.
 *
 * A plain `jetbrains.kotlin.restartLsp` does not apply launch settings: with a workspace folder open the server is
 * a daemon shared per workspace root, discovered through the port file `<tmpdir>/intellij-lsp-servers/<extension
 * version>/<sha256 of the first folder's path, 16 hex>.port` (`portFile.ts` in JetBrains.kotlin-server 0.0.27;
 * 0.0.13 had no version directory), and a restart reconnects to it. Removing the port file first makes the restart
 * spawn a fresh daemon with the current settings; the old one, left without clients, shuts itself down after its
 * idle timeout.
 *
 * A Kotlin/Java document may have started the companion without completing activation yet. When launch settings
 * changed, wait for that activation before restarting; otherwise its first server keeps the old VM arguments.
 * Without an open source document, invalidate shared-daemon discovery but keep activation lazy.
 *
 * Returns the command used, or `undefined` when the companion is not active. The command's own promise is not
 * awaited indefinitely: reload may remain pending while an import is already running. Throws
 * {@link KotlinSetupPendingError} while the companion waits on its first-run setup: the server imports
 * `workspace.json` when it starts afterwards.
 */
export async function reloadKotlinLsp(relaunch = false, waitForDebugger = false): Promise<string | undefined> {
  const ext = jetBrainsExtension();
  if (!ext) return undefined;
  if (relaunch && !ext.isActive && vscode.workspace.textDocuments.some((document) =>
    document.uri.scheme === "file" && (document.languageId === "kotlin" || document.languageId === "java"))) {
    await ext.activate();
  }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  let discovery: string[] = [];
  if (relaunch && root) {
    const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
    const servers = path.join(os.tmpdir(), "intellij-lsp-servers");
    const version = (ext.packageJSON as { version?: unknown } | undefined)?.version;
    discovery = [path.join(servers, `${hash}.port`), ...(typeof version === "string" ? [path.join(servers, version, `${hash}.port`)] : [])];
    for (const file of discovery) rmSync(file, { force: true });
  }
  if (!ext.isActive) return undefined;
  const available = new Set(await vscode.commands.getCommands(true));
  const candidates = relaunch ? [RESTART_COMMAND] : [RELOAD_COMMAND, RESTART_COMMAND];
  const command = candidates.find((c) => available.has(c));
  if (!command) {
    const steps = await pendingKotlinSetup();
    if (steps) throw new KotlinSetupPendingError(steps);
    throw new Error(`Kotlin LSP exposes none of ${candidates.join(", ")}`);
  }
  const pending = Promise.resolve(vscode.commands.executeCommand(command));
  // Surface a rejection to the caller only if it happens promptly; a long-running reload is not an error.
  const { promise: grace, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 2_000);
  await Promise.race([pending, grace]);
  pending.catch(() => undefined);
  if (relaunch && waitForDebugger && discovery.length > 0) {
    // The restart command finishes with a notification whose promise can remain pending. Instead observe the
    // newly published daemon and its initialized client's command registration; never attach to the old daemon.
    const deadline = Date.now() + 30_000;
    while (true) {
      if (discovery.some(publishesPort) && (await vscode.commands.getCommands(true)).includes("start_debug_server")) break;
      if (Date.now() >= deadline) throw new Error("Kotlin LSP did not finish restarting with the debugger options.");
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 100);
      await promise;
    }
  }
  return command;
}

function publishesPort(file: string): boolean {
  let port = 0;
  try { port = Number(readFileSync(file, "utf8").trim()); } catch { /* not published yet */ }
  return Number.isInteger(port) && port > 0 && port <= 65_535;
}
