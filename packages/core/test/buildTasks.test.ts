import { describe, expect, test } from "bun:test";
import { parseBuildInspect } from "../src/index.js";

/** Verbatim `elide build --inspect` output of `samples/ktjvm`, abridged to three tasks. */
const INSPECT = `Elide 1.5.3

3 tasks available:

  compile-kotlin-main   Compile main Kotlin source files to bytecode
    no options declared

  jvm-test   Run JVM tests using JUnit
    --debugger   Attach JDWP debugger, optionally specify host:port
    --test-name-pattern   Run only tests whose name matches this regular expression

  write-classpath-files
    no options declared

Global options:
  --no-cache   Disable the build cache for this run
`;

describe("parseBuildInspect", () => {
  test("reads the task table, its descriptions and its option rows", () => {
    expect(parseBuildInspect(INSPECT)).toEqual([
      { name: "compile-kotlin-main", description: "Compile main Kotlin source files to bytecode", options: [] },
      {
        name: "jvm-test",
        description: "Run JVM tests using JUnit",
        options: [
          { option: "--debugger", description: "Attach JDWP debugger, optionally specify host:port" },
          { option: "--test-name-pattern", description: "Run only tests whose name matches this regular expression" },
        ],
      },
      { name: "write-classpath-files", description: "", options: [] },
    ]);
  });

  test("the table ends at the global options, which are not tasks", () => {
    expect(parseBuildInspect(INSPECT).map((t) => t.name)).not.toContain("--no-cache");
  });

  test("output without a task header yields no tasks", () => {
    expect(parseBuildInspect("error: no project found\n")).toEqual([]);
    expect(parseBuildInspect("")).toEqual([]);
  });

  test("a singular header is a header too", () => {
    expect(parseBuildInspect("1 task available:\n  run   Run the main JVM application\n")).toEqual([
      { name: "run", description: "Run the main JVM application", options: [] },
    ]);
  });
});
