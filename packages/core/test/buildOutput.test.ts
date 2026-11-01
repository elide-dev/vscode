import { describe, expect, test } from "bun:test";
import { parseElideDuration, parseElideOutputLine } from "../src/index.js";

describe("parseElideDuration", () => {
  test("reads every unit the CLI prints", () => {
    expect(parseElideDuration("431ms")).toBe(431);
    expect(parseElideDuration("17.7s")).toBe(17_700);
    expect(parseElideDuration("1m")).toBe(60_000);
    expect(parseElideDuration("2m 5s")).toBe(125_000);
    expect(parseElideDuration("soon")).toBeUndefined();
  });
});

describe("parseElideOutputLine", () => {
  test("a finished task carries its scope, label and own duration", () => {
    expect(parseElideOutputLine("[22.7s] ✓ [app] Compiled 3 Kotlin files (17.7s)")).toEqual({
      kind: "task", outcome: "succeeded", scope: "app", label: "Compiled 3 Kotlin files", durationMs: 17_700,
    });
    expect(parseElideOutputLine("✗ compile-kotlin-main (2m 5s)")).toEqual({ kind: "task", outcome: "failed", label: "compile-kotlin-main", durationMs: 125_000 });
  });

  test("a skipped task keeps its reason and has no duration", () => {
    expect(parseElideOutputLine("[ 2.4s] ⇥ [app] compile-kotlin-main (Up to date)")).toEqual({
      kind: "task", outcome: "skipped", scope: "app", label: "compile-kotlin-main", reason: "Up to date",
    });
  });

  test("the verdict is told apart from a task by its `in` separator, success or failure", () => {
    expect(parseElideOutputLine("[24.8s] ✓ Build successful in 24.7s")).toEqual({ kind: "verdict", outcome: "succeeded", label: "Build successful", durationMs: 24_700 });
    expect(parseElideOutputLine("[ 3.1s] ✗ Build failed in 3.0s")).toEqual({ kind: "verdict", outcome: "failed", label: "Build failed", durationMs: 3_000 });
    // The CLI also prints parenthesized verdict durations.
    expect(parseElideOutputLine("[ 3.1s] ✗ Build failed in (3.0s)")).toEqual({ kind: "verdict", outcome: "failed", label: "Build failed", durationMs: 3_000 });
  });

  test("a start line is a started task, but only behind the elapsed prefix", () => {
    expect(parseElideOutputLine("[ 41ms] > [model] Resolving Maven dependencies")).toEqual({ kind: "task-started", scope: "model", label: "Resolving Maven dependencies" });
    expect(parseElideOutputLine("> quoted reply")).toBeUndefined();
  });

  test("diagnostics are recognized with or without the elapsed prefix; other output is not", () => {
    expect(parseElideOutputLine("[ 2.6s] warning: dependency upgraded")).toEqual({ kind: "diagnostic", severity: "warning", message: "dependency upgraded" });
    expect(parseElideOutputLine("error: kotlinc: Unresolved reference 'Foo'.")).toEqual({ kind: "diagnostic", severity: "error", message: "kotlinc: Unresolved reference 'Foo'." });
    expect(parseElideOutputLine("compiler: 3 files processed")).toBeUndefined();
    expect(parseElideOutputLine("In file: app/src/Main.kt:3:5")).toBeUndefined();
  });
});
