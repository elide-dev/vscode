import { describe, expect, test } from "bun:test";
import {
  elideRecordOutput,
  formatElideDuration,
  parseElideDuration,
  parseElideOutputLine,
  parseElideRecord,
  renderElideRecord,
  type ElideOutputLine,
  type ElideRecord,
} from "../src/index.js";

describe("parseElideDuration", () => {
  test("reads every unit the CLI prints", () => {
    expect(parseElideDuration("431ms")).toBe(431);
    expect(parseElideDuration("17.7s")).toBe(17_700);
    expect(parseElideDuration("1m")).toBe(60_000);
    expect(parseElideDuration("2m 5s")).toBe(125_000);
    expect(parseElideDuration("soon")).toBeUndefined();
  });

  test("formatting reads back as the same duration at the precision of its unit", () => {
    for (const ms of [0, 431, 999, 1_000, 17_740, 59_940, 60_000, 125_400]) {
      const precision = ms < 1_000 ? 1 : ms < 60_000 ? 100 : 1_000;
      expect(Math.abs(parseElideDuration(formatElideDuration(ms))! - ms)).toBeLessThanOrEqual(precision / 2);
    }
  });
});

describe("parseElideOutputLine", () => {
  test("a finished task carries its scope, label and own duration", () => {
    expect(parseElideOutputLine("[22.7s] ✓ [android] Dexed 'sample-dev' into 3 dex files (17.7s)")).toEqual({
      kind: "task", outcome: "succeeded", scope: "android", label: "Dexed 'sample-dev' into 3 dex files", durationMs: 17_700,
    });
    expect(parseElideOutputLine("✗ compile-kotlin-main (2m 5s)")).toEqual({ kind: "task", outcome: "failed", label: "compile-kotlin-main", durationMs: 125_000 });
  });

  test("a skipped task keeps its reason and has no duration", () => {
    expect(parseElideOutputLine("[ 2.4s] ⇥ [android] android-link-sample (Up to date)")).toEqual({
      kind: "task", outcome: "skipped", scope: "android", label: "android-link-sample", reason: "Up to date",
    });
  });

  test("the verdict is told apart from a task by its `in` separator, success or failure", () => {
    expect(parseElideOutputLine("[24.8s] ✓ Build successful in 24.7s")).toEqual({ kind: "verdict", outcome: "succeeded", label: "Build successful", durationMs: 24_700 });
    expect(parseElideOutputLine("[ 3.1s] ✗ Build failed in 3.0s")).toEqual({ kind: "verdict", outcome: "failed", label: "Build failed", durationMs: 3_000 });
    // Releases before 1.6.1 parenthesized the failed verdict's duration.
    expect(parseElideOutputLine("[ 3.1s] ✗ Build failed in (3.0s)")).toEqual({ kind: "verdict", outcome: "failed", label: "Build failed", durationMs: 3_000 });
  });

  test("plain mode's start line is a started task, but only behind the elapsed prefix", () => {
    expect(parseElideOutputLine("[ 41ms] > [model] Resolving Maven dependencies")).toEqual({ kind: "task-started", scope: "model", label: "Resolving Maven dependencies" });
    expect(parseElideOutputLine("> quoted reply")).toBeUndefined();
  });

  test("diagnostics are recognized with or without the elapsed prefix; other output is not", () => {
    expect(parseElideOutputLine("[ 2.6s] warning: androidx.core:core 1.18.0 upgraded to 1.19.0")).toEqual({ kind: "diagnostic", severity: "warning", message: "androidx.core:core 1.18.0 upgraded to 1.19.0" });
    expect(parseElideOutputLine("error: kotlinc: Unresolved reference 'Foo'.")).toEqual({ kind: "diagnostic", severity: "error", message: "kotlinc: Unresolved reference 'Foo'." });
    expect(parseElideOutputLine("d8: 34,135 kotlin-metadata diagnostic lines from the Kotlin runtime")).toBeUndefined();
    expect(parseElideOutputLine("In file: app/src/Main.kt:3:5")).toBeUndefined();
  });
});

describe("progress records", () => {
  /** As `ELIDE_PROGRESS=json elide build` printed it for a Kotlin file with an unresolved reference. */
  const diagnostic = `{"type":"message","level":"error","text":"error: kotlinc: Unresolved reference 'undefinedSymbol'.\\nIn file: src/main/sample/Main.kt:10:21\\n\\n→10 │ fun broken(): Int = undefinedSymbol","task":"compile-kotlin-main","file":"/tmp/ejson/src/main/sample/Main.kt","line":10,"column":21,"time":1791911633168}`;

  test("only a JSON object with a known type and a time is a record; program output is not", () => {
    expect(parseElideRecord(`{"type":"build-configured","totalTasks":8,"time":1}`)).toEqual({ type: "build-configured", totalTasks: 8, time: 1 });
    expect(parseElideRecord(`{"type":"build-configured","totalTasks":8}`)).toBeUndefined();
    expect(parseElideRecord(`{"type":"telemetry","time":1}`)).toBeUndefined();
    expect(parseElideRecord(`{"type":"task-started","time":1}`)).toBeUndefined();
    expect(parseElideRecord(`{"level":"info","msg":"server started"}`)).toBeUndefined();
    expect(parseElideRecord(`{ not json`)).toBeUndefined();
    expect(parseElideRecord(`[1, 2]`)).toBeUndefined();
  });

  test("a finished task maps onto the text form's outcome, scope and duration, keeping its key", () => {
    const done = parseElideRecord(`{"type":"task-finished","task":"android:android-dex-app","project":"android","message":"Dexed 'app'","outcome":"success","durationMs":17700,"time":1}`)!;
    expect(elideRecordOutput(done)).toEqual({ kind: "task", outcome: "succeeded", task: "android:android-dex-app", scope: "android", label: "Dexed 'app'", durationMs: 17_700 });
    // A skipped task's duration is the time its up-to-date check took.
    const skipped = parseElideRecord(`{"type":"task-finished","task":"model:android-libraries","project":"model","outcome":"skipped","reason":"Up to date","durationMs":840,"time":1}`)!;
    expect(elideRecordOutput(skipped)).toEqual({
      kind: "task", outcome: "skipped", task: "model:android-libraries", scope: "model", label: "android-libraries", reason: "Up to date", durationMs: 840,
    });
  });

  test("starts, steps and build totals become live progress", () => {
    expect(elideRecordOutput(parseElideRecord(`{"type":"task-started","task":"maven-dependencies","message":"Resolving Maven dependencies","time":1}`)!))
      .toEqual({ kind: "task-started", task: "maven-dependencies", label: "Resolving Maven dependencies" });
    expect(elideRecordOutput(parseElideRecord(`{"type":"task-progress","task":"maven-dependencies","progress":23,"total":1000,"time":1}`)!))
      .toEqual({ kind: "task-progress", task: "maven-dependencies", progress: 23, total: 1000 });
    expect(elideRecordOutput(parseElideRecord(`{"type":"step-progress","task":"maven-dependencies","step":"resolving-2","message":"Resolve kotlin-reflect:pom:2.5.0","time":1}`)!))
      .toEqual({ kind: "task-progress", task: "maven-dependencies", step: "resolving-2", message: "Resolve kotlin-reflect:pom:2.5.0" });
    expect(elideRecordOutput(parseElideRecord(`{"type":"build-progress","completedTasks":3,"time":1}`)!)).toEqual({ kind: "build-progress", completedTasks: 3 });
  });

  test("a compiler diagnostic carries its absolute location; plain output is not a diagnostic", () => {
    expect(elideRecordOutput(parseElideRecord(diagnostic)!)).toEqual({
      kind: "diagnostic", severity: "error", message: "kotlinc: Unresolved reference 'undefinedSymbol'.", file: "/tmp/ejson/src/main/sample/Main.kt", line: 10, column: 21,
    });
    expect(elideRecordOutput(parseElideRecord(`{"type":"message","level":"output","text":"Wrote 3 files","time":1}`)!)).toBeUndefined();
  });

  test("rendered as text, a diagnostic keeps the In file adjacency with the absolute path", () => {
    expect(renderElideRecord(parseElideRecord(diagnostic)!)).toEqual([
      "error: kotlinc: Unresolved reference 'undefinedSymbol'.",
      "In file: /tmp/ejson/src/main/sample/Main.kt:10:21",
      "",
      "→10 │ fun broken(): Int = undefinedSymbol",
    ]);
    expect(renderElideRecord(parseElideRecord(`{"type":"message","level":"warning","text":"androidx.core 1.18.0 upgraded","file":"/p/elide.pkl","time":1}`)!))
      .toEqual(["warning: androidx.core 1.18.0 upgraded", "In file: /p/elide.pkl"]);
  });

  test("rendered as text, finished tasks and the verdict parse back to what the record maps to", () => {
    const records = [
      `{"type":"task-finished","task":"android:android-dex-app","project":"android","message":"Dexed 'app' into 3 dex files","outcome":"success","durationMs":17700,"time":1}`,
      `{"type":"task-finished","task":"compile-kotlin-main","message":"Kotlin main compilation failed","outcome":"failure","durationMs":101,"time":1}`,
      `{"type":"task-finished","task":"model:android-libraries","project":"model","outcome":"skipped","reason":"Up to date","durationMs":12,"time":1}`,
      `{"type":"build-finished","outcome":"failure","exitCode":1,"durationMs":3000,"message":"Build failed","time":1}`,
      `{"type":"build-finished","outcome":"success","durationMs":24700,"time":1}`,
    ].map((line) => parseElideRecord(line)!);
    for (const record of records) {
      const [line, ...rest] = renderElideRecord(record);
      expect(rest).toEqual([]);
      const { task: _key, ...mapped } = elideRecordOutput(record) as { task?: string; outcome?: string; durationMs?: number };
      // Like Elide's own text, a skipped task's line names the reason, not the time its check took.
      if (mapped.outcome === "skipped") delete mapped.durationMs;
      expect(parseElideOutputLine(line!)).toEqual(mapped as ElideOutputLine);
    }
  });

  test("starts and progress have no text, as they have none without a terminal", () => {
    const silent: ElideRecord[] = [
      { type: "build-started", plannedTasks: 1, time: 1 },
      { type: "task-started", task: "a", time: 1 },
      { type: "step-progress", task: "a", step: "s", progress: 3, time: 1 },
      { type: "build-progress", completedTasks: 1, time: 1 },
    ];
    for (const record of silent) expect(renderElideRecord(record)).toEqual([]);
  });
});
