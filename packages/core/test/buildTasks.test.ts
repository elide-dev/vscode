import { describe, expect, test } from "bun:test";
import { buildTasksOf, parseBuildInspect, unqualifiedTaskName } from "../src/index.js";

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

/** `elide build --inspect` of the workspace sample (Elide 1.5.4), abridged: every task is qualified by its project. */
const INSPECT_WORKSPACE = `43 tasks across 5 projects:

logstat
  logstat:compile-java-main   Compile main Java source files
    no options declared

  logstat:run   Run the main JVM application
    --debugger   Attach JDWP debugger, optionally specify host:port
    --args   Space-separated program arguments

model
  model:compile-kotlin-main   Compile main Kotlin source files to bytecode
    no options declared

  model:model   Package compiled classes into a JAR archive
    no options declared

cli
  cli:run   Run the main JVM application
    --debugger   Attach JDWP debugger, optionally specify host:port

Global options:
  --no-cache   Disable the build cache for this run
`;

/** The same listing from a CLI that leaves the root's tasks unqualified. */
const INSPECT_WORKSPACE_BARE_ROOT = `3 tasks across 2 projects:

workspace-sample
  maven-dependencies   Resolve and download Maven dependencies
    --fresh   Re-download dependencies even if present in the local cache

core
  core:jar   Package compiled classes into a JAR archive
    no options declared

  core:run   Run the main JVM application
    no options declared

Global options:
  --no-cache   Disable the build cache for this run
`;

describe("parseBuildInspect in a workspace", () => {
  test("group headers scope the rows below them and are not tasks themselves", () => {
    const tasks = parseBuildInspect(INSPECT_WORKSPACE);
    expect(tasks.map((t) => [t.project, t.name])).toEqual([
      ["logstat", "logstat:compile-java-main"],
      ["logstat", "logstat:run"],
      ["model", "model:compile-kotlin-main"],
      ["model", "model:model"],
      ["cli", "cli:run"],
    ]);
    expect(tasks[1]!.options.map((o) => o.option)).toEqual(["--debugger", "--args"]);
    expect(tasks.map((t) => t.name)).not.toContain("--no-cache");
  });

  test("each project's tasks, under the names the project knows them by", () => {
    const tasks = parseBuildInspect(INSPECT_WORKSPACE);
    expect(buildTasksOf(tasks, "model").map(unqualifiedTaskName)).toEqual(["compile-kotlin-main", "model"]);
    expect(buildTasksOf(tasks, "logstat").map(unqualifiedTaskName)).toEqual(["compile-java-main", "run"]);
    expect(buildTasksOf(tasks, "report")).toEqual([]);
  });

  test("a root whose tasks are listed bare still owns its group", () => {
    const tasks = parseBuildInspect(INSPECT_WORKSPACE_BARE_ROOT);
    expect(buildTasksOf(tasks, "workspace-sample").map(unqualifiedTaskName)).toEqual(["maven-dependencies"]);
    expect(buildTasksOf(tasks, "core").map(unqualifiedTaskName)).toEqual(["jar", "run"]);
  });

  test("a standalone listing belongs wholly to its project", () => {
    const tasks = parseBuildInspect(INSPECT);
    expect(tasks.every((t) => t.project === undefined)).toBe(true);
    expect(buildTasksOf(tasks, "anything")).toEqual(tasks);
    expect(tasks.map(unqualifiedTaskName)).toEqual(tasks.map((t) => t.name));
  });
});
