import { describe, expect, test } from "bun:test";
import { TimelineNode, liveStatus, observeCommands } from "../src/index.js";

/** Feed stderr lines to an observer the way `ElideCli` does. */
const run = (lines: string[], exitCode = 0) => {
  let now = 0;
  const root = TimelineNode.root("Sync", { clock: () => now });
  const echoed: string[] = [];
  const observer = observeCommands(() => root, (line) => echoed.push(line))(["build", "app"], "/p")!;
  const snapshots: (string | undefined)[] = [];
  for (const line of lines) {
    now += 10;
    observer.line?.(line, true);
    snapshots.push(liveStatus(root));
  }
  observer.end({ exitCode, durationMs: now, aborted: false });
  return { root, command: root.children[0]!, echoed, snapshots };
};

describe("observeCommands", () => {
  test("finished tasks retain their measured durations without inventing running tasks or totals", () => {
    const { command, snapshots } = run([
      "[ 2.6s] ✓ [app] Resolved 21 Maven dependencies (2.5s)",
      "[ 2.7s] ⇥ [app] compile-kotlin-main (Up to date)",
      "[ 2.8s] ✓ Build successful in 2.7s",
    ]);
    expect(snapshots).toEqual([undefined, undefined, undefined]);
    expect(command.children.map((task) => [task.label, task.state, task.durationMs, task.detail])).toEqual([
      ["[app] Resolved 21 Maven dependencies", "succeeded", 2_500, undefined],
      ["[app] compile-kotlin-main", "skipped", 0, "Up to date"],
    ]);
    expect(command.state).toBe("succeeded");
    expect(command.detail).toBe("Build successful · 1 task · 1 up to date");
  });

  test("text diagnostics and failures are logged and echoed without losing source locations", () => {
    const lines = [
      "✗ Kotlin main compilation failed (101ms)",
      "error: kotlinc: Unresolved reference 'x'.",
      "In file: /p/Main.kt:3",
      "✗ Build failed in (114ms)",
    ];
    const { command, echoed } = run(lines, 1);
    expect(command.state).toBe("failed");
    expect(command.detail).toBe("exit 1 · Build failed · 1 task · 1 error");
    expect(command.children.map((task) => [task.label, task.state, task.durationMs])).toEqual([["Kotlin main compilation failed", "failed", 101]]);
    expect(command.lines().map((line) => line.text)).toEqual(lines);
    expect(echoed).toEqual([
      "$ elide build app",
      ...lines,
      "✗ elide build exit 1 after 40 ms",
    ]);
  });

  test("a task-start message clears at the next completion rather than claiming a finished task is running", () => {
    const { command, snapshots } = run([
      "[ 41ms] > [model] Compiling Kotlin sources",
      "[ 2.6s] ✓ [model] Compiled 3 Kotlin files (2.5s)",
      "[ 2.7s] ⇥ [model] compile-java-main (Up to date)",
      "[ 2.8s] ✓ Build successful in 2.7s",
    ]);
    expect(snapshots).toEqual(["Compiling Kotlin sources", undefined, undefined, undefined]);
    expect(command.children.map((task) => [task.label, task.state, task.durationMs, task.detail])).toEqual([
      ["[model] Compiled 3 Kotlin files", "succeeded", 2_500, undefined],
      ["[model] compile-java-main", "skipped", 0, "Up to date"],
    ]);
    expect(command.detail).toBe("Build successful · 1 task · 1 up to date");
  });

  test("arbitrary tool output is retained without becoming activity or errors", () => {
    const lines = ["compiler: reading sources", "warning: dependency upgraded", "> quoted reply"];
    const { command, snapshots } = run(lines);
    expect(command.children).toEqual([]);
    expect(command.detail).toBeUndefined();
    expect(command.lines().map((line) => line.text)).toEqual(lines);
    expect(snapshots).toEqual([undefined, undefined, undefined]);
  });

  test("cancellation clears live status and preserves the process outcome", () => {
    const root = TimelineNode.root("Sync");
    const observer = observeCommands(() => root)(["build"], "/p")!;
    observer.line?.("[ 41ms] > Compiling Kotlin sources", true);
    expect(liveStatus(root)).toBe("Compiling Kotlin sources");
    observer.end({ exitCode: null, durationMs: 50, aborted: true });
    expect(root.children[0]!.state).toBe("cancelled");
    expect(root.children[0]!.detail).toBe("cancelled");
    expect(liveStatus(root)).toBeUndefined();
  });

  test("a failed process needs no diagnostic or verdict to be shown as failed", () => {
    const { command } = run(["unexpected tool failure"], 2);
    expect(command.state).toBe("failed");
    expect(command.detail).toBe("exit 2");
  });
});
