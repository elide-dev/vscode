import { elideRecordOutput, parseElideOutputLine, type ElideOutputLine } from "./buildOutput.js";
import type { RunOptions } from "./elide.js";
import { formatDuration, type TimelineNode } from "./timeline.js";

/** A task the CLI reported starting, with what it and each of its steps last said about their progress. */
interface RunningTask {
  node: TimelineNode;
  /** The task's own message, without the workspace member a build names it under: the status line is short. */
  label: string;
  /** By step, or `""` for what the task reported itself; latest last. */
  progress: Map<string, { message?: string; total?: number; text: string }>;
}

/**
 * Observe the CLI processes an invocation starts as steps of whatever `parent()` returns when each one starts. Each
 * process becomes a step of its own, and the build tasks it reports become its steps, with the durations Elide
 * measured. `echo` receives the command line, every line meant for a person, and a closing line with the outcome and
 * duration.
 *
 * A CLI that reports progress records shows each task while it runs, with the progress it and its steps report, and
 * the share of the build's tasks done so far; the process's {@link TimelineNode.status} says what it is doing now.
 * An older one is followed through its text: the tasks it finished, and the one it last said it started.
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
    let totalTasks: number | undefined;
    let completedTasks = 0;
    /** Records drive the tree once one arrived; the text they render to is then only logged. */
    let structured = false;
    const running = new Map<string, RunningTask>();
    /** The task whose progress was reported last, or what text output last said it started. */
    let focus: RunningTask | string | undefined;
    const summary = () =>
      [
        verdict,
        !verdict && totalTasks ? `${completedTasks}/${totalTasks} tasks` : undefined,
        tasks ? `${tasks} task${tasks === 1 ? "" : "s"}` : undefined,
        skipped ? `${skipped} up to date` : undefined,
        errors ? `${errors} error${errors === 1 ? "" : "s"}` : undefined,
      ].filter(Boolean).join(" · ") || undefined;
    const describe = (task: RunningTask) => (task.progress.get("") ?? [...task.progress.values()].at(-1))?.text || undefined;
    const status = () => {
      // The verdict is in: what remains is the process exiting.
      if (verdict) return undefined;
      const current = typeof focus === "string" ? focus : focus ? [focus.label, describe(focus)].filter(Boolean).join(": ") : undefined;
      const share = totalTasks ? `${completedTasks}/${totalTasks}` : undefined;
      return current && share ? `${current} (${share})` : current ?? (share && `${share} tasks`);
    };
    const apply = (parsed: ElideOutputLine | undefined) => {
      switch (parsed?.kind) {
        case "build-configured":
          totalTasks = parsed.totalTasks;
          break;
        case "build-progress":
          completedTasks = parsed.completedTasks;
          break;
        case "task-started": {
          if (parsed.task) {
            focus = { node: node.start(parsed.scope ? `[${parsed.scope}] ${parsed.label}` : parsed.label), label: parsed.label, progress: new Map() };
            running.set(parsed.task, focus);
          } else focus = parsed.label;
          break;
        }
        case "task-progress": {
          const task = running.get(parsed.task);
          if (!task) return;
          const key = parsed.step ?? "";
          const previous = task.progress.get(key);
          const message = parsed.message ?? previous?.message;
          const total = parsed.total ?? previous?.total;
          const share = total && parsed.progress !== undefined ? `${Math.floor((parsed.progress / total) * 100)}%` : undefined;
          task.progress.delete(key);
          task.progress.set(key, { message, total, text: [message, parsed.detail, share].filter(Boolean).join(" · ") });
          task.node.setDetail(describe(task));
          focus = task;
          break;
        }
        case "step-finished": {
          const task = running.get(parsed.task);
          if (!task?.progress.delete(parsed.step)) return;
          task.node.setDetail(describe(task));
          break;
        }
        case "task": {
          const task = parsed.task ? running.get(parsed.task) : undefined;
          if (parsed.task) running.delete(parsed.task);
          if (task && focus === task) focus = [...running.values()].at(-1);
          // A skipped task stays a step, with the reason it was skipped: its up-to-date check takes time too.
          const skip = parsed.outcome === "skipped";
          if (skip) skipped++;
          else tasks++;
          const label = parsed.scope ? `[${parsed.scope}] ${parsed.label}` : parsed.label;
          if (task) task.node.end(parsed.outcome, skip ? parsed.reason : task.node.label === label ? undefined : parsed.label);
          else node.record(label, parsed.durationMs, parsed.outcome, skip ? parsed.reason : undefined);
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
      node.setStatus(status());
    };
    return {
      record: (record) => {
        structured = true;
        apply(elideRecordOutput(record));
      },
      line: (line) => {
        node.log(line);
        echo?.(line);
        if (!structured) apply(parseElideOutputLine(line));
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
