import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ProjectModel } from "@elide/ide-core";

/*
 * A JetBrains debug session runs inside the Kotlin language server and analyzes the program against the workspace
 * snapshot the server holds when the session connects (`withDebugContext` in JetBrains.kotlin-server 0.0.13), for the
 * session's whole lifetime. Started before the workspace import is applied, it cannot map breakpoints to classes and
 * they are skipped; started while the server is still indexing, every evaluation fails on missing JDK and library
 * classes (`Cannot access 'java.io.Serializable'`, `Class not found: kotlin/Unit`). Waiting afterwards does not help.
 * These server commands, which the Kotlin client registers as VS Code commands, tell when a session would be whole.
 */
const DEBUG_SERVER = "start_debug_server";
/** Resolves the launch paths of the module containing a URI; fails while no imported module contains it. */
const RESOLVE_LAUNCH = "intellij.java.resolveLaunch";
/** Makes the server watch a file holding a number, its index high watermark. */
const SET_WATERMARK = "set-highwatermark-file";
/** Settles once an indexing pass that saw the watermark file hold at least the given number has finished. */
const WAIT_WATERMARK = "wait-for-highwatermark";
const NOT_IMPORTED = /No (?:file|module) found for uri/;

export type KotlinAnalysisStage = "server" | "import" | "index";

/**
 * `ready`; `unsupported` when the server offers no way to tell; `unimported` when the probe's module never appeared,
 * so only indexing was waited for.
 */
export type KotlinAnalysisResult = "ready" | "unsupported" | "unimported";

export interface KotlinLspCommands {
  /** Commands registered now: the Kotlin client registers the server's own once the server has initialized. */
  list(): Promise<readonly string[]>;
  execute(command: string, ...args: unknown[]): Promise<unknown>;
}

export interface KotlinAnalysisOptions {
  /** URI of a source root of the debugged project, which the server resolves once that module is imported. */
  probe?: string;
  /** File the server watches as its index high watermark; one per Kotlin server, so per workspace root. */
  watermark: string;
  signal: AbortSignal;
  onStage?(stage: KotlinAnalysisStage): void;
  pollMs?: number;
  /** How long a missing module is waited for before only indexing is: a root the server never imports. */
  importTimeoutMs?: number;
  /** A file watcher may coalesce an event; past this, the watermark is written again. */
  rewriteMs?: number;
}

let lastMark = 0;

/**
 * Settle once a debug session started now would analyze a complete workspace: the Kotlin server is up, has imported
 * the module `probe` belongs to, and has finished indexing everything queued before — the import's model change
 * included, which is why the import is confirmed first. Rejects with the abort reason when `signal` aborts.
 */
export async function awaitKotlinAnalysis(lsp: KotlinLspCommands, options: KotlinAnalysisOptions): Promise<KotlinAnalysisResult> {
  const { signal, pollMs = 250, importTimeoutMs = 60_000, rewriteMs = 5_000 } = options;
  signal.throwIfAborted();
  options.onStage?.("server");
  let commands = new Set(await lsp.list());
  while (!commands.has(DEBUG_SERVER)) {
    await sleep(pollMs, undefined, { signal });
    commands = new Set(await lsp.list());
  }
  if (![RESOLVE_LAUNCH, SET_WATERMARK, WAIT_WATERMARK].every((command) => commands.has(command))) return "unsupported";

  let result: KotlinAnalysisResult = "ready";
  if (options.probe) {
    options.onStage?.("import");
    const deadline = Date.now() + importTimeoutMs;
    while (!await imported(lsp, options.probe, signal)) {
      if (Date.now() >= deadline) {
        result = "unimported";
        break;
      }
      await sleep(pollMs, undefined, { signal });
    }
  }

  options.onStage?.("index");
  await mkdir(path.dirname(options.watermark), { recursive: true });
  await writeFile(options.watermark, "", { flag: "a" });
  // The server starts watching the file's directory once it is set; only a write after that is an event it orders
  // behind the indexing already queued.
  await abortable(lsp.execute(SET_WATERMARK, options.watermark), signal);
  let mark = nextMark();
  await writeFile(options.watermark, String(mark));
  const reached = lsp.execute(WAIT_WATERMARK, mark);
  // A later mark settles the same wait.
  while (!await settles(reached, rewriteMs, signal)) await writeFile(options.watermark, String(mark = nextMark()));
  return result;
}

/**
 * A source root of `models`, in order, that exists: the server resolves a directory only once it is indexed, so a
 * declared root that was never created would never resolve.
 */
export function probeSourceRoot(models: readonly (ProjectModel | undefined)[], exists: (path: string) => boolean): string | undefined {
  for (const model of models) {
    for (const module of model?.modules ?? []) {
      for (const content of module.contentRoots) {
        const root = content.sourceRoots.find((source) => (source.kind === "source" || source.kind === "test") && exists(source.path));
        if (root) return root.path;
      }
    }
  }
  return undefined;
}

async function imported(lsp: KotlinLspCommands, uri: string, signal: AbortSignal): Promise<boolean> {
  try {
    await abortable(lsp.execute(RESOLVE_LAUNCH, { uri }), signal);
    return true;
  } catch (error) {
    if (signal.aborted) throw error;
    // Anything else (no JDK for the module, for one) still means the module is known.
    return !NOT_IMPORTED.test(error instanceof Error ? error.message : String(error));
  }
}

function nextMark(): number {
  lastMark = Math.max(Date.now(), lastMark + 1);
  return lastMark;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const { promise: settled, resolve, reject } = Promise.withResolvers<T>();
  const abort = () => reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  return settled;
}

/** Whether `promise` resolves within `ms`; rejects with its error, or when `signal` aborts. */
async function settles(promise: Promise<unknown>, ms: number, signal: AbortSignal): Promise<boolean> {
  const timer = new AbortController();
  try {
    return await Promise.race([
      abortable(promise, signal).then(() => true),
      sleep(ms, false, { signal: AbortSignal.any([signal, timer.signal]) }),
    ]);
  } finally {
    timer.abort();
  }
}
