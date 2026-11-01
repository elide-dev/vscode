import { parseElideOutputLine, type ElideOutputLine } from "./buildOutput.js";
import type { RunOptions } from "./elide.js";
import { formatDuration, type TimelineNode } from "./timeline.js";

/**
 * Observe the CLI processes an invocation starts as steps of whatever `parent()` returns when each one starts. Each
 * process becomes a step of its own, and the build tasks it reports become its steps, with the durations Elide
 * measured. `echo` receives the command line, every line meant for a person, and a closing line with the outcome and
 * duration.
 *
 * Text output supplies finished tasks and, when printed, the latest task-start message. No task totals or
 * completion percentages are inferred from it.
 */
export function observeCommands(parent: () => TimelineNode, echo?: (line: string) => void): NonNullable<RunOptions["onCommand"]> {
  return (argv) => {
    const commandLine = `elide ${argv.join(" ")}`;
    const node = parent().start(commandLine);
    echo?.(`$ ${commandLine}`);
    let tasks = 0;
    let skipped = 0;
    let errors = 0;
    let verdict: string | undefined;
    let focus: string | undefined;
    const summary = () =>
      [
        verdict,
        tasks ? `${tasks} task${tasks === 1 ? "" : "s"}` : undefined,
        skipped ? `${skipped} up to date` : undefined,
        errors ? `${errors} error${errors === 1 ? "" : "s"}` : undefined,
      ].filter(Boolean).join(" · ") || undefined;
    const apply = (parsed: ElideOutputLine | undefined) => {
      switch (parsed?.kind) {
        case "task-started":
          focus = parsed.label;
          break;
        case "task": {
          // Text has no stable task key, so a completion ends the last start message rather than leaving it stale.
          focus = undefined;
          // A skipped task stays a step with the reason it was skipped.
          const skip = parsed.outcome === "skipped";
          if (skip) skipped++;
          else tasks++;
          const label = parsed.scope ? `[${parsed.scope}] ${parsed.label}` : parsed.label;
          node.record(label, parsed.durationMs, parsed.outcome, skip ? parsed.reason : undefined);
          break;
        }
        case "verdict":
          verdict = parsed.label;
          focus = undefined;
          break;
        case "diagnostic":
          if (parsed.severity !== "error") return;
          errors++;
          break;
        default:
          return;
      }
      node.setDetail(summary());
      node.setStatus(verdict ? undefined : focus);
    };
    return {
      line: (line) => {
        node.log(line);
        echo?.(line);
        apply(parseElideOutputLine(line));
      },
      end: ({ exitCode, durationMs, aborted }) => {
        const state = aborted ? "cancelled" : exitCode === 0 ? "succeeded" : "failed";
        const exit = aborted ? "cancelled" : exitCode === 0 ? undefined : exitCode === null ? "killed" : `exit ${exitCode}`;
        node.end(state, [exit, summary()].filter(Boolean).join(" · ") || undefined);
        echo?.(state === "succeeded"
          ? `✓ elide ${argv[0] ?? ""} finished in ${formatDuration(durationMs)}`
          : `✗ elide ${argv[0] ?? ""} ${exit} after ${formatDuration(durationMs)}`);
      },
    };
  };
}
