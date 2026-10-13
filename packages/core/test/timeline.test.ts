import { describe, expect, test } from "bun:test";
import { TimelineNode, formatDuration, timelineBreakdown } from "../src/index.js";

function clock() {
  let now = 1_000;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe("TimelineNode", () => {
  test("the phase is the running direct step, and ending a parent ends the steps it left running", () => {
    const time = clock();
    const sync = TimelineNode.root("sync", { clock: time.now });
    sync.start("export").end();
    const install = sync.start("install");
    const command = install.start("elide install");
    expect(sync.phase).toBe(install);
    time.advance(500);
    sync.end("failed");
    expect([install.state, command.state]).toEqual(["cancelled", "cancelled"]);
    expect(sync.phase).toBeUndefined();
    expect(command.durationMs).toBe(500);
  });

  test("a recorded step reports the duration the tool measured, not the time since it was recorded", () => {
    const time = clock();
    const build = TimelineNode.root("build", { clock: time.now });
    time.advance(30_000);
    const task = build.record("Dexed app", 17_700, "succeeded");
    time.advance(5_000);
    expect(task.durationMs).toBe(17_700);
    expect(task.running).toBe(false);
  });

  test("a step that throws fails with the error and rethrows it", async () => {
    const root = TimelineNode.root("preview");
    await expect(root.run("render", async () => { throw new Error("no JVM"); })).rejects.toThrow("no JVM");
    expect(root.children[0]).toMatchObject({ state: "failed", detail: "no JVM" });
  });

  test("a node's lines include its descendants', and the oldest go once the cap is reached", () => {
    const root = TimelineNode.root("sync", { maxLines: 3 });
    const a = root.start("a");
    const b = root.start("b");
    a.log("a1");
    b.log("b1");
    a.log("a2");
    root.log("r1");
    expect(root.lines().map((line) => line.text)).toEqual(["b1", "a2", "r1"]);
    expect(a.lines().map((line) => line.text)).toEqual(["a2"]);
  });

  test("the children cap drops the oldest finished child, never a running one", () => {
    const root = TimelineNode.root("preview", { maxChildren: 2 });
    const running = root.start("first");
    root.record("second", 1);
    root.record("third", 1);
    expect(root.children.map((child) => child.label)).toEqual(["first", "third"]);
    expect(running.running).toBe(true);
  });
});

describe("formatDuration", () => {
  test("switches units at a second and a minute", () => {
    expect(formatDuration(431.4)).toBe("431 ms");
    expect(formatDuration(4_260)).toBe("4.2 s");
    expect(formatDuration(65_000)).toBe("1 m 05 s");
  });
});

describe("timelineBreakdown", () => {
  test("lists steps slowest first with their share, folding the negligible ones", () => {
    const time = clock();
    const sync = TimelineNode.root("sync", { clock: time.now });
    for (const [label, ms] of [["export", 1_000], ["install", 6_000], ["jdk", 10], ["classpath", 3_000]] as const) {
      const step = sync.start(label);
      time.advance(ms);
      step.end();
    }
    sync.end();
    expect(timelineBreakdown(sync)).toEqual([
      "6.0 s   60%  install",
      "3.0 s   30%  classpath",
      "1.0 s   10%  export",
      "10 ms    0%  1 more step",
    ]);
  });
});
