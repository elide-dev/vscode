import { describe, expect, test } from "bun:test";
import { TimelineNode, liveStatus, observeCommands, parseElideRecord, renderElideRecord } from "../src/index.js";

/** Feed `lines` to an observer the way `ElideCli` does: a record first as itself, then as its text. */
const run = (lines: string[], exitCode = 0) => {
  let now = 0;
  const root = TimelineNode.root("Sync", { clock: () => now });
  const echoed: string[] = [];
  const observer = observeCommands(() => root, (line) => echoed.push(line))(["build", "app"], "/p")!;
  const snapshots: (string | undefined)[] = [];
  for (const line of lines) {
    now += 10;
    const record = parseElideRecord(line);
    if (record) observer.record?.(record);
    for (const text of record ? renderElideRecord(record) : [line]) observer.line?.(text, true);
    snapshots.push(liveStatus(root));
  }
  observer.end({ exitCode, durationMs: now, aborted: false });
  return { root, command: root.children[0]!, echoed, snapshots };
};

describe("observeCommands", () => {
  test("records show each task while it runs, with its progress and the build's share of tasks done", () => {
    const { command, snapshots } = run([
      `{"type":"build-configured","totalTasks":3,"time":1}`,
      `{"type":"task-started","task":"app:maven-dependencies","project":"app","message":"Resolving Maven dependencies","time":1}`,
      `{"type":"task-progress","task":"app:maven-dependencies","project":"app","progress":230,"total":1000,"time":1}`,
      `{"type":"step-started","task":"app:maven-dependencies","project":"app","step":"r-0","message":"Resolve kotlin-stdlib","total":4,"time":1}`,
      `{"type":"step-finished","task":"app:maven-dependencies","project":"app","step":"r-0","time":1}`,
      `{"type":"task-finished","task":"app:maven-dependencies","project":"app","message":"Resolved 21 Maven dependencies","outcome":"success","durationMs":48,"time":1}`,
      `{"type":"build-progress","completedTasks":1,"time":1}`,
      `{"type":"task-started","task":"app:android-libraries","project":"app","message":"Unpacking Android libraries","time":1}`,
      `{"type":"task-finished","task":"app:android-libraries","project":"app","outcome":"skipped","reason":"Up to date","durationMs":0,"time":1}`,
      `{"type":"build-progress","completedTasks":2,"time":1}`,
      `{"type":"build-finished","outcome":"success","durationMs":140,"message":"Build successful","time":1}`,
    ]);
    expect(snapshots.slice(0, 6)).toEqual([
      "0/3 tasks",
      "Resolving Maven dependencies (0/3)",
      "Resolving Maven dependencies: 23% (0/3)",
      "Resolving Maven dependencies: 23% (0/3)",
      "Resolving Maven dependencies: 23% (0/3)",
      "0/3 tasks",
    ]);
    expect(snapshots.at(-1)).toBeUndefined();
    // An up-to-date task is counted, not kept as a step.
    expect(command.children.map((task) => [task.label, task.state, task.detail])).toEqual([
      ["[app] Resolving Maven dependencies", "succeeded", "Resolved 21 Maven dependencies"],
    ]);
    expect(command.state).toBe("succeeded");
    expect(command.detail).toBe("Build successful · 1 task · 1 up to date");
  });

  test("a step's progress is its share of the total its start announced", () => {
    const { snapshots } = run([
      `{"type":"task-started","task":"dex","message":"Dexing","time":1}`,
      `{"type":"step-started","task":"dex","step":"d","message":"Dexing classes","total":40,"time":1}`,
      `{"type":"step-progress","task":"dex","step":"d","progress":12,"time":1}`,
    ]);
    expect(snapshots).toEqual(["Dexing", "Dexing: Dexing classes", "Dexing: Dexing classes · 30%"]);
  });

  test("a record's rendered text is logged and echoed but not counted again", () => {
    const { command, echoed } = run([
      `{"type":"task-finished","task":"compile-kotlin-main","message":"Kotlin main compilation failed","outcome":"failure","durationMs":101,"time":1}`,
      `{"type":"message","level":"error","text":"error: kotlinc: Unresolved reference 'x'.","file":"/p/Main.kt","line":3,"time":1}`,
      `{"type":"build-finished","outcome":"failure","exitCode":1,"durationMs":114,"message":"Build failed","time":1}`,
    ], 1);
    expect(command.detail).toBe("exit 1 · Build failed · 1 task · 1 error");
    expect(command.children.map((task) => [task.label, task.state, task.durationMs])).toEqual([["Kotlin main compilation failed", "failed", 101]]);
    expect(echoed).toEqual([
      "$ elide build app",
      "✗ Kotlin main compilation failed (101ms)",
      "error: kotlinc: Unresolved reference 'x'.",
      "In file: /p/Main.kt:3",
      "✗ Build failed in 114ms",
      "✗ elide build exit 1 after 30 ms",
    ]);
  });

  test("an older CLI is followed through its text: what it started last, and the tasks it finished", () => {
    const { command, snapshots } = run([
      "[ 41ms] > [model] Compiling Kotlin sources",
      "[ 2.6s] ✓ [model] Compiled 3 Kotlin files (2.5s)",
      "[ 2.7s] ⇥ [model] android-r-model (Up to date)",
      "[ 2.8s] ✓ Build successful in 2.7s",
    ]);
    expect(snapshots).toEqual(["Compiling Kotlin sources", "Compiling Kotlin sources", "Compiling Kotlin sources", undefined]);
    expect(command.children.map((task) => [task.label, task.durationMs])).toEqual([["[model] Compiled 3 Kotlin files", 2_500]]);
    expect(command.detail).toBe("Build successful · 1 task · 1 up to date");
  });
});
