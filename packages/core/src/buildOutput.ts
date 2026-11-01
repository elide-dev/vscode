/**
 * What Elide reports about a build on stderr: finished tasks, compiler diagnostics and a verdict.
 *
 * ```
 * [22.7s] ✓ [app] Compiled 3 Kotlin files (17.7s)
 * [ 2.4s] ⇥ [app] compile-kotlin-main (Up to date)
 * [24.8s] ✓ Build successful in 24.7s
 * [ 3.1s] ✗ Build failed in (3.0s)
 * ```
 *
 * The `[elapsed]` prefix counts from the CLI's start; compiler diagnostics are printed without it, with the
 * `In file:` location on the line after the headline.
 */

export type ElideTaskOutcome = "succeeded" | "failed" | "skipped";

export type ElideOutputLine =
  | {
      kind: "task";
      outcome: ElideTaskOutcome;
      /** Workspace member or tool the task belongs to: the `[app]` of `✓ [app] Compiled …`. */
      scope?: string;
      label: string;
      /** How long the task took by Elide's measure, its up-to-date check included; text output leaves a skipped one's out. */
      durationMs?: number;
      /** Why a task was skipped: `Up to date`, `From cache`. */
      reason?: string;
    }
  | { kind: "task-started"; scope?: string; label: string }
  | { kind: "verdict"; outcome: Exclude<ElideTaskOutcome, "skipped">; label: string; durationMs: number }
  | {
      kind: "diagnostic";
      severity: "error" | "warning" | "hint";
      message: string;
    };

const PREFIX = /^(?:\[[^\]]*\]\s+)?/;
const OUTCOME = new RegExp(`${PREFIX.source}([✓✗⇥])\\s+(.*)$`);
/** A task-start line is recognized only behind the elapsed prefix, which tells it apart from a quote. */
const STARTED = /^\[[^\]]*\]\s+>\s+(.*)$/;
const DIAGNOSTIC = new RegExp(`${PREFIX.source}(error|warning|hint):\\s+(.*)$`);
const DURATION = String.raw`(\d+ms|\d+(?:\.\d+)?s|\d+m(?: \d+s)?)`;
const VERDICT_TAIL = new RegExp(`^(.*?) in \\(?${DURATION}\\)?$`);
const TASK_TAIL = new RegExp(`^(.*?) \\(${DURATION}\\)$`);
const SKIP_TAIL = /^(.*?) \(([^()]*)\)$/;
const SCOPE = /^\[([^\]]+)\]\s+(.*)$/;

/** Milliseconds of an Elide duration label: `431ms`, `1.6s`, `1m`, `1m 30s`. */
export function parseElideDuration(text: string): number | undefined {
  const match = /^(?:(\d+)ms|(\d+(?:\.\d+)?)s|(\d+)m(?: (\d+)s)?)$/.exec(text.trim());
  if (!match) return undefined;
  if (match[1] !== undefined) return Number(match[1]);
  if (match[2] !== undefined) return Math.round(Number(match[2]) * 1_000);
  return (Number(match[3]) * 60 + Number(match[4] ?? 0)) * 1_000;
}

/** Recognize a task, verdict or diagnostic text line; `undefined` for anything else (tool output, snippets). */
export function parseElideOutputLine(line: string): ElideOutputLine | undefined {
  const outcome = OUTCOME.exec(line);
  if (outcome) {
    const glyph = outcome[1]!;
    const rest = outcome[2]!.trim();
    if (glyph === "⇥") {
      const skipped = SKIP_TAIL.exec(rest);
      return { kind: "task", outcome: "skipped", ...scoped(skipped ? skipped[1]! : rest), ...(skipped ? { reason: skipped[2]! } : {}) };
    }
    const result = glyph === "✓" ? "succeeded" : "failed";
    const verdict = VERDICT_TAIL.exec(rest);
    if (verdict) return { kind: "verdict", outcome: result, label: verdict[1]!, durationMs: parseElideDuration(verdict[2]!)! };
    const task = TASK_TAIL.exec(rest);
    if (task) return { kind: "task", outcome: result, ...scoped(task[1]!), durationMs: parseElideDuration(task[2]!)! };
    return { kind: "task", outcome: result, ...scoped(rest) };
  }
  const started = STARTED.exec(line);
  if (started) return { kind: "task-started", ...scoped(started[1]!.trim()) };
  const diagnostic = DIAGNOSTIC.exec(line);
  if (diagnostic) return { kind: "diagnostic", severity: diagnostic[1] as "error" | "warning" | "hint", message: diagnostic[2]!.trim() };
  return undefined;
}

function scoped(message: string): { scope?: string; label: string } {
  const match = SCOPE.exec(message);
  return match ? { scope: match[1]!, label: match[2]! } : { label: message };
}
