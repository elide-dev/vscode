import { describe, expect, test } from "bun:test";
import { AndroidTestResultParser, parseElideRecord, type AndroidTestResult, type ElideRecord } from "../src/index.js";

/** Messages as `ELIDE_PROGRESS=json elide build android-test-app` reports them. */
const message = (level: "output" | "error", text: string, task = "android-test-app"): ElideRecord =>
  parseElideRecord(JSON.stringify({ type: "message", level, text, task, time: 1 }))!;

function parse(records: ElideRecord[], task = "android-test-app"): { results: AndroidTestResult[]; problems: string[] } {
  const results: AndroidTestResult[] = [];
  const problems: string[] = [];
  const parser = new AndroidTestResultParser(task, (result) => results.push(result), (text) => problems.push(text));
  for (const record of records) parser.accept(record);
  parser.end();
  return { results, problems };
}

describe("instrumented test results", () => {
  test("each finished test maps to its class and method, a failure keeping the stack trace reported after it", () => {
    const stack = "java.lang.AssertionError: expected 36\n\tat smoke.DeviceTest.verifiesApi(DeviceTest.java:15)";
    const { results, problems } = parse([
      message("output", "smoke.DeviceTest#verifiesPackage passed"),
      message("error", "smoke.DeviceTest#verifiesApi failed"),
      message("error", stack),
      message("output", "smoke.DeviceTest#ignored skipped"),
      message("output", "1 passed, 1 failed, 1 skipped"),
    ]);
    expect(results).toEqual([
      { className: "smoke.DeviceTest", method: "verifiesPackage", outcome: "passed" },
      { className: "smoke.DeviceTest", method: "verifiesApi", outcome: "failed", detail: stack },
      { className: "smoke.DeviceTest", method: "ignored", outcome: "skipped" },
    ]);
    expect(problems).toEqual([]);
  });

  test("a failure followed by another result, or by the end of the run, carries no stack trace", () => {
    const { results } = parse([
      message("error", "smoke.A#first failed"),
      message("error", "smoke.A#second failed"),
    ]);
    expect(results).toEqual([
      { className: "smoke.A", method: "first", outcome: "failed" },
      { className: "smoke.A", method: "second", outcome: "failed" },
    ]);
  });

  test("nested classes and method names with spaces survive", () => {
    const { results } = parse([message("output", "smoke.Outer$Inner#reads the label passed")]);
    expect(results).toEqual([{ className: "smoke.Outer$Inner", method: "reads the label", outcome: "passed" }]);
  });

  test("the run's own errors are problems; other tasks' messages are not read", () => {
    const { results, problems } = parse([
      message("error", "error: kotlinc: Unresolved reference 'x'.", "compile-kotlin-main"),
      message("error", "No tests matched smoke.Missing"),
      message("output", "0 passed, 0 failed, 0 skipped"),
    ]);
    expect(results).toEqual([]);
    expect(problems).toEqual(["No tests matched smoke.Missing"]);
  });

  test("a workspace member's test target is read under its qualified name", () => {
    const { results } = parse([message("output", "smoke.A#works passed", "mobile:android-test-app")]);
    expect(results).toEqual([{ className: "smoke.A", method: "works", outcome: "passed" }]);
    expect(parse([message("output", "smoke.A#works passed", "mobile:android-test-other")]).results).toEqual([]);
  });
});
