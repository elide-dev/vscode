/**
 * What Elide reports about a build on stderr, in either of its two forms.
 *
 * Spawned with `ELIDE_PROGRESS=json` (Elide 1.6.1 and newer), every build event is one JSON object per line: an
 * {@link ElideRecord}. Program output is passed through raw, so only a line that parses as an object with a known
 * `type` is a record.
 *
 * An older CLI, or one in `auto`/`plain` mode without a terminal, prints text instead: one line per finished task
 * (`plain` adds a `>` line per started one), compiler diagnostics, and one verdict:
 *
 * ```
 * [ 41ms] > [android] Linking resources
 * [ 2.4s] ⇥ [android] android-link-sample (Up to date)
 * [22.7s] ✓ [android] Dexed 'sample-dev' into 3 dex files (17.7s)
 * [ 2.6s] warning: androidx.core:core 1.18.0 upgraded to 1.19.0, …
 * [24.8s] ✓ Build successful in 24.7s
 * [ 3.1s] ✗ Build failed in 3.0s
 * ```
 *
 * The `[elapsed]` prefix counts from the CLI's start; compiler diagnostics are printed without it, with the
 * `In file:` location on the line after the headline. Both forms map onto {@link ElideOutputLine}.
 */

export type ElideTaskOutcome = "succeeded" | "failed" | "skipped";

export type ElideOutputLine =
  | {
      kind: "task";
      outcome: ElideTaskOutcome;
      /** The task's key (`android:compile-kotlin-main`); only records carry it. */
      task?: string;
      /** Workspace member or tool the task belongs to: the `[android]` of `✓ [android] Dexed …`. */
      scope?: string;
      label: string;
      /** How long the task took by Elide's measure, its up-to-date check included; text output leaves a skipped one's out. */
      durationMs?: number;
      /** Why a task was skipped: `Up to date`, `From cache`. */
      reason?: string;
    }
  | { kind: "task-started"; task?: string; scope?: string; label: string; total?: number }
  /** A task or one of its steps moved on: `progress` of `total` when the task can count, a message otherwise. */
  | { kind: "task-progress"; task: string; step?: string; message?: string; detail?: string; progress?: number; total?: number }
  | { kind: "step-finished"; task: string; step: string }
  | { kind: "build-configured"; totalTasks: number }
  | { kind: "build-progress"; completedTasks: number }
  | { kind: "verdict"; outcome: Exclude<ElideTaskOutcome, "skipped">; label: string; durationMs: number }
  | {
      kind: "diagnostic";
      severity: "error" | "warning" | "hint";
      message: string;
      /** Absolute path of the source the diagnostic is about; only records carry the location. */
      file?: string;
      line?: number;
      column?: number;
    };

/** One `ELIDE_PROGRESS=json` record; fields the CLI had no value for are absent. */
export type ElideRecord = { time: number } & (
  | { type: "build-started"; plannedTasks?: number; workspace?: string; projects?: string[] }
  | { type: "build-configured"; totalTasks: number }
  | { type: "build-progress"; completedTasks?: number; message?: string }
  | { type: "task-started"; task: string; project?: string; message?: string; total?: number }
  | { type: "task-progress"; task: string; project?: string; message?: string; progress?: number; total?: number }
  | {
      type: "task-finished";
      task: string;
      project?: string;
      message?: string;
      outcome: "success" | "failure" | "skipped";
      reason?: string;
      durationMs?: number;
    }
  | { type: "step-started"; task: string; project?: string; step: string; message?: string; total?: number }
  | { type: "step-progress"; task: string; project?: string; step: string; message?: string; progress?: number; detail?: string }
  | { type: "step-finished"; task: string; project?: string; step: string }
  | {
      type: "message";
      level: "output" | "hint" | "warning" | "error";
      text: string;
      task?: string;
      project?: string;
      file?: string;
      line?: number;
      column?: number;
    }
  | { type: "build-finished"; outcome: "success" | "failure"; exitCode?: number; durationMs?: number; message?: string }
);

const PREFIX = /^(?:\[[^\]]*\]\s+)?/;
const OUTCOME = new RegExp(`${PREFIX.source}([✓✗⇥])\\s+(.*)$`);
/** `plain` mode's start line; only ever printed behind the elapsed prefix, which tells it apart from a quote. */
const STARTED = /^\[[^\]]*\]\s+>\s+(.*)$/;
const DIAGNOSTIC = new RegExp(`${PREFIX.source}(error|warning|hint):\\s+(.*)$`);
const DURATION = String.raw`(\d+ms|\d+(?:\.\d+)?s|\d+m(?: \d+s)?)`;
const VERDICT_TAIL = new RegExp(`^(.*?) in \\(?${DURATION}\\)?$`);
const TASK_TAIL = new RegExp(`^(.*?) \\(${DURATION}\\)$`);
const SKIP_TAIL = /^(.*?) \(([^()]*)\)$/;
const SCOPE = /^\[([^\]]+)\]\s+(.*)$/;
const IN_FILE = /^In file:\s+\S+$/;

/** Milliseconds of an Elide duration label: `431ms`, `1.6s`, `1m`, `1m 30s`. */
export function parseElideDuration(text: string): number | undefined {
  const match = /^(?:(\d+)ms|(\d+(?:\.\d+)?)s|(\d+)m(?: (\d+)s)?)$/.exec(text.trim());
  if (!match) return undefined;
  if (match[1] !== undefined) return Number(match[1]);
  if (match[2] !== undefined) return Math.round(Number(match[2]) * 1_000);
  return (Number(match[3]) * 60 + Number(match[4] ?? 0)) * 1_000;
}

/** An Elide duration label, the inverse of {@link parseElideDuration}: `431ms`, `17.7s`, `2m 5s`. */
export function formatElideDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
  const seconds = Math.round(ms / 1_000);
  return seconds % 60 === 0 ? `${seconds / 60}m` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
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

/** A line of `ELIDE_PROGRESS=json` output as a record; `undefined` for anything else, program output included. */
export function parseElideRecord(line: string): ElideRecord | undefined {
  if (!line.startsWith("{")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  const str = (key: string) => typeof r[key] === "string";
  const num = (key: string) => typeof r[key] === "number";
  if (!num("time")) return undefined;
  switch (r.type) {
    case "build-started":
    case "build-progress":
      return r as ElideRecord;
    case "build-configured":
      return num("totalTasks") ? (r as ElideRecord) : undefined;
    case "task-started":
    case "task-progress":
      return str("task") ? (r as ElideRecord) : undefined;
    case "task-finished":
      return str("task") && ["success", "failure", "skipped"].includes(r.outcome as string) ? (r as ElideRecord) : undefined;
    case "step-started":
    case "step-progress":
    case "step-finished":
      return str("task") && str("step") ? (r as ElideRecord) : undefined;
    case "message":
      return str("text") && ["output", "hint", "warning", "error"].includes(r.level as string) ? (r as ElideRecord) : undefined;
    case "build-finished":
      return r.outcome === "success" || r.outcome === "failure" ? (r as ElideRecord) : undefined;
    default:
      return undefined;
  }
}

/** A record as the {@link ElideOutputLine} its text form would have parsed to, with what only records carry. */
export function elideRecordOutput(record: ElideRecord): ElideOutputLine | undefined {
  switch (record.type) {
    case "build-configured":
      return { kind: "build-configured", totalTasks: record.totalTasks };
    case "build-progress":
      return record.completedTasks === undefined ? undefined : { kind: "build-progress", completedTasks: record.completedTasks };
    case "task-started":
      return { kind: "task-started", task: record.task, ...defined({ scope: record.project, total: record.total }), label: record.message ?? bareTask(record.task) };
    case "task-progress":
      return { kind: "task-progress", task: record.task, ...defined({ message: record.message, progress: record.progress, total: record.total }) };
    case "step-started":
      return { kind: "task-progress", task: record.task, step: record.step, ...defined({ message: record.message, total: record.total }) };
    case "step-progress":
      return { kind: "task-progress", task: record.task, step: record.step, ...defined({ message: record.message, detail: record.detail, progress: record.progress }) };
    case "step-finished":
      return { kind: "step-finished", task: record.task, step: record.step };
    case "task-finished":
      return {
        kind: "task",
        outcome: TASK_OUTCOMES[record.outcome],
        task: record.task,
        label: record.message ?? bareTask(record.task),
        ...defined({ scope: record.project, reason: record.reason, durationMs: record.durationMs }),
      };
    case "message": {
      if (record.level === "output") return undefined;
      const lines = record.text.split("\n");
      return {
        kind: "diagnostic",
        severity: record.level,
        message: lines[0]!.replace(new RegExp(`^${record.level}:\\s+`), "").trim(),
        ...defined({ file: record.file, line: record.line, column: record.column }),
      };
    }
    case "build-finished":
      return {
        kind: "verdict",
        outcome: record.outcome === "success" ? "succeeded" : "failed",
        label: record.message ?? (record.outcome === "success" ? "Build successful" : "Build failed"),
        durationMs: record.durationMs ?? 0,
      };
    default:
      return undefined;
  }
}

/**
 * A record as the text lines the CLI would print without a terminal: finished tasks, messages and the verdict.
 * Starts and progress have no line, as they have none in `auto` mode; a compiler diagnostic's `In file:` location
 * names the absolute path the record carries.
 */
export function renderElideRecord(record: ElideRecord): string[] {
  switch (record.type) {
    case "task-finished": {
      const label = `${record.project ? `[${record.project}] ` : ""}${record.message ?? bareTask(record.task)}`;
      if (record.outcome === "skipped") return [`⇥ ${label}${record.reason ? ` (${record.reason})` : ""}`];
      return [`${record.outcome === "success" ? "✓" : "✗"} ${label}${record.durationMs === undefined ? "" : ` (${formatElideDuration(record.durationMs)})`}`];
    }
    case "message": {
      const lines = record.text.split("\n");
      if (record.level !== "output" && !lines[0]!.startsWith(`${record.level}:`)) lines[0] = `${record.level}: ${lines[0]}`;
      if (record.file) {
        const location = `In file: ${record.file}${record.line ? `:${record.line}${record.column ? `:${record.column}` : ""}` : ""}`;
        const at = lines.findIndex((text) => IN_FILE.test(text));
        if (at >= 0) lines[at] = location;
        else lines.splice(1, 0, location);
      }
      return lines;
    }
    case "build-finished": {
      const label = record.message ?? (record.outcome === "success" ? "Build successful" : "Build failed");
      return [`${record.outcome === "success" ? "✓" : "✗"} ${label}${record.durationMs === undefined ? "" : ` in ${formatElideDuration(record.durationMs)}`}`];
    }
    default:
      return [];
  }
}

const TASK_OUTCOMES = { success: "succeeded", failure: "failed", skipped: "skipped" } as const;

/** `android:compile-kotlin-main` → `compile-kotlin-main`: the name a task without a message is shown by. */
function bareTask(task: string): string {
  return task.slice(task.lastIndexOf(":") + 1);
}

function defined<T extends Record<string, unknown>>(fields: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

function scoped(message: string): { scope?: string; label: string } {
  const match = SCOPE.exec(message);
  return match ? { scope: match[1]!, label: match[2]! } : { label: message };
}
