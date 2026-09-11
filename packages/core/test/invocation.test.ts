import { describe, expect, test } from "bun:test";
import {
  elideFlagArgs,
  elideInvocationArgs,
  elideInvocationOptionsFrom,
  mergeElideInvocationOptions,
  type ElideInvocationOptions,
} from "../src/index.js";

describe("elideInvocationArgs", () => {
  test("orders flags and options before positionals, and program arguments after `--`", () => {
    expect(
      elideInvocationArgs("run", {
        args: ["src/main.kt"],
        flags: ["release", "tag=beta"],
        options: { coverage: true },
        programArgs: ["--port", "8080"],
      }),
    ).toEqual(["run", "-f", "release", "-f", "tag=beta", "--coverage", "src/main.kt", "--", "--port", "8080"]);
  });

  test("spells options by name length, and repeats an array option", () => {
    expect(
      elideInvocationArgs("test", {
        options: { "test-timeout": 5000, t: "MyTest", limit: ["workers=4", "fds=256"] },
      }),
    ).toEqual(["test", "--test-timeout=5000", "-t", "MyTest", "--limit=workers=4", "--limit=fds=256"]);
  });

  test("keeps a dashed name as written", () => {
    expect(elideInvocationArgs("build", { options: { "--no-cache": true, "-q": true } })).toEqual(["build", "--no-cache", "-q"]);
  });

  test("emits `false` options not at all, so an override can cancel a configured default", () => {
    const configured: ElideInvocationOptions = { options: { offline: true, "no-cache": true } };
    const merged = mergeElideInvocationOptions(configured, { options: { offline: false } });
    expect(elideInvocationArgs("build", merged)).toEqual(["build", "--no-cache"]);
  });

  test("omits the `--` separator when the program takes no arguments", () => {
    expect(elideInvocationArgs("run", { programArgs: [] })).toEqual(["run"]);
  });

  test("drops empty flags and unnamed options", () => {
    expect(elideInvocationArgs("build", { flags: ["", "  "], options: { "  ": true } })).toEqual(["build"]);
  });
});

describe("elideFlagArgs", () => {
  test("pairs every flag with `-f`", () => {
    expect(elideFlagArgs(["release", "tag=beta"])).toEqual(["-f", "release", "-f", "tag=beta"]);
    expect(elideFlagArgs(undefined)).toEqual([]);
  });
});

describe("mergeElideInvocationOptions", () => {
  test("concatenates argument lists in layer order and overrides options and env per key", () => {
    expect(
      mergeElideInvocationOptions(
        { flags: ["ci"], options: { reporter: "console", bail: 1 }, env: { A: "1", B: "2" } },
        { args: ["src/api"], options: { reporter: "tap" }, env: { B: "3" }, programArgs: ["--fast"] },
        { args: ["src/db"] },
      ),
    ).toEqual({
      args: ["src/api", "src/db"],
      flags: ["ci"],
      programArgs: ["--fast"],
      options: { reporter: "tap", bail: 1 },
      env: { A: "1", B: "3" },
    });
  });

  test("leaves empty fields out, so a merged layer stays spreadable over a definition", () => {
    expect(mergeElideInvocationOptions(undefined, {}, { args: [] })).toEqual({});
  });
});

describe("elideInvocationOptionsFrom", () => {
  test("reads the invocation fields of a task definition or launch configuration", () => {
    expect(
      elideInvocationOptionsFrom({
        type: "elide",
        command: "test",
        args: ["src/api"],
        flags: ["ci"],
        options: { bail: 3, reporter: "tap", only: true, limit: ["workers=2"] },
        programArgs: ["--verbose"],
        env: { CI: "true" },
      }),
    ).toEqual({
      args: ["src/api"],
      flags: ["ci"],
      options: { bail: 3, reporter: "tap", only: true, limit: ["workers=2"] },
      programArgs: ["--verbose"],
      env: { CI: "true" },
    });
  });

  test("drops values that cannot become command-line tokens", () => {
    expect(
      elideInvocationOptionsFrom({
        args: ["ok", 7, null],
        options: { nested: { a: 1 }, bad: Number.NaN, list: ["ok", { b: 2 }], fine: "yes" },
        env: { OK: "1", NOPE: 2 },
      }),
    ).toEqual({ args: ["ok"], options: { list: ["ok"], fine: "yes" }, env: { OK: "1" } });
  });

  test("treats a non-object as no options at all", () => {
    expect(elideInvocationOptionsFrom(undefined)).toEqual({});
    expect(elideInvocationOptionsFrom("build")).toEqual({});
  });
});
