import { describe, expect, test } from "bun:test";
import { TapParser, type TapEvent } from "../src/index.js";

function decode(lines: readonly string[], { flush = true }: { flush?: boolean } = {}): TapEvent[] {
  const events: TapEvent[] = [];
  const parser = new TapParser((event) => events.push(event));
  for (const line of lines) parser.feed(line);
  if (flush) parser.end();
  return events;
}

describe("TapParser", () => {
  test("decodes a passing run as it streams", () => {
    expect(
      decode([
        "TAP version 13",
        "# start 1: sample.MainTest > testGreeting()",
        "ok 1 - sample.MainTest > testGreeting()",
        "1..1",
      ]),
    ).toEqual([
      { kind: "version", version: 13 },
      { kind: "start", n: 1, label: "sample.MainTest > testGreeting()" },
      { kind: "result", n: 1, label: "sample.MainTest > testGreeting()", ok: true },
      { kind: "plan", count: 1 },
    ]);
  });

  test("a result is emitted as soon as the next line proves it has no diagnostic block", () => {
    const events = decode(["ok 1 - a", "# start 2: b"], { flush: false });
    expect(events).toEqual([
      { kind: "result", n: 1, label: "a", ok: true },
      { kind: "start", n: 2, label: "b" },
    ]);
  });

  test("a failing point carries its message and detail lines, unindented", () => {
    expect(
      decode([
        "not ok 1 - sample.MainTest > a failing test \\#1()",
        "  ---",
        '  message: "org.opentest4j.AssertionFailedError: expected: <1> but was: <2>"',
        "  severity: assertion",
        "  detail: |",
        "    \torg.opentest4j.AssertionFailedError: expected: <1> but was: <2>",
        "    \t\tat sample.MainTest.a failing test #1(MainTest.kt:14)",
        "  ...",
      ]),
    ).toEqual([
      {
        kind: "result",
        n: 1,
        label: "sample.MainTest > a failing test #1()",
        ok: false,
        diagnostics: {
          message: "org.opentest4j.AssertionFailedError: expected: <1> but was: <2>",
          severity: "assertion",
          detail: [
            "\torg.opentest4j.AssertionFailedError: expected: <1> but was: <2>",
            "\t\tat sample.MainTest.a failing test #1(MainTest.kt:14)",
          ],
        },
      },
    ]);
  });

  test("a diagnostic block the stream cut short is still reported at the end", () => {
    expect(decode(["not ok 1 - boom", "  ---", '  message: "nope"'])).toEqual([
      { kind: "result", n: 1, label: "boom", ok: false, diagnostics: { message: "nope", detail: [] } },
    ]);
  });

  test("quoted scalars are unescaped", () => {
    const [result] = decode(["not ok 1 - boom", "  ---", '  message: "said \\"hi\\"\\nthen left"', "  ..."]);
    expect(result).toMatchObject({ diagnostics: { message: 'said "hi"\nthen left' } });
  });

  test("SKIP and TODO directives are kept apart from the label", () => {
    expect(decode(["ok 1 - MyTest > skipped() # SKIP voluntarily skipped", "ok 2 - MyTest > later() # TODO", "ok 3 - plain"])).toEqual([
      {
        kind: "result",
        n: 1,
        label: "MyTest > skipped()",
        ok: true,
        directive: { type: "skip", reason: "voluntarily skipped" },
      },
      { kind: "result", n: 2, label: "MyTest > later()", ok: true, directive: { type: "todo", reason: "" } },
      { kind: "result", n: 3, label: "plain", ok: true },
    ]);
  });

  test("an escaped hash in a label is not a directive", () => {
    expect(decode(["ok 1 - computes \\#1 right"])).toEqual([
      { kind: "result", n: 1, label: "computes #1 right", ok: true },
    ]);
  });

  test("a test cannot forge protocol lines: its own output stays framed output", () => {
    expect(
      decode(["# start 1: MyTest > sneaky()", "# out 1: ok 99 - fake", "# out 1: # start 4: forged", "# out: top level chatter"]),
    ).toEqual([
      { kind: "start", n: 1, label: "MyTest > sneaky()" },
      { kind: "output", n: 1, text: "ok 99 - fake" },
      { kind: "output", n: 1, text: "# start 4: forged" },
      { kind: "output", n: undefined, text: "top level chatter" },
    ]);
  });

  test("lines that are not protocol pass through instead of being dropped", () => {
    expect(decode(["[ 0.4s] error: kotlinc: unresolved reference"])).toEqual([
      { kind: "other", line: "[ 0.4s] error: kotlinc: unresolved reference" },
    ]);
  });
});
