import { expect, test } from "bun:test";
import { TargetShortcuts, USAGE_LIMIT, type TargetRef } from "../src/targetShortcuts.js";

/** A `Memento` that round-trips through JSON, as `workspaceState` does. */
function memento() {
  const values = new Map<string, string>();
  return {
    get: <T>(key: string): T | undefined => (values.has(key) ? JSON.parse(values.get(key)!) : undefined),
    update: async (key: string, value: unknown) => {
      if (value === undefined) values.delete(key);
      else values.set(key, JSON.stringify(value));
    },
  };
}

const target = (name: string, kind: TargetRef["kind"] = "buildTarget", root = "/app"): TargetRef => ({ kind, root, name });

test("frequent targets rank by runs, ties by the latest run, and leave pinned ones to the pinned section", async () => {
  let clock = 0;
  const shortcuts = new TargetShortcuts(memento(), () => ++clock);
  for (const name of ["jar", "run", "jar", "test", "native"]) await shortcuts.record(target(name));
  // The same name in another project, or as another kind of row, is another target.
  await shortcuts.record(target("jar", "buildTarget", "/lib"));
  await shortcuts.record(target("test", "task"));

  expect(shortcuts.frequent().map((t) => `${t.kind}:${t.root}:${t.name}`)).toEqual([
    "buildTarget:/app:jar",
    "task:/app:test",
    "buildTarget:/lib:jar",
    "buildTarget:/app:native",
    "buildTarget:/app:test",
    "buildTarget:/app:run",
  ]);

  // A whole sidebar row is passed in; only its identity is kept.
  await shortcuts.pin({ ...target("jar"), label: "jar", description: "the jar" } as TargetRef);
  await shortcuts.pin(target("jar"));
  expect(shortcuts.pinned()).toEqual([target("jar")]);
  expect(shortcuts.frequent().map((t) => t.name)).toEqual(["test", "jar", "native", "test", "run"]);

  // Unpinned, it is back where its runs put it; forgotten, it starts over.
  await shortcuts.unpin(target("jar"));
  expect(shortcuts.frequent()[0]).toEqual(target("jar"));
  await shortcuts.forget(target("jar"));
  expect(shortcuts.frequent().some((t) => t.root === "/app" && t.name === "jar" && t.kind === "buildTarget")).toBe(false);
  await shortcuts.clearUsage();
  expect(shortcuts.frequent()).toEqual([]);
});

test("a full usage record drops its least used target, never the one just run", async () => {
  let clock = 0;
  const shortcuts = new TargetShortcuts(memento(), () => ++clock);
  for (let i = 0; i < USAGE_LIMIT; i++) {
    await shortcuts.record(target(`t${i}`));
    await shortcuts.record(target(`t${i}`));
  }
  await shortcuts.record(target("new"));
  const names = shortcuts.frequent().map((t) => t.name);
  expect(names).toHaveLength(USAGE_LIMIT);
  expect(names.at(-1)).toBe("new");
  // Every other target ran twice; of those the one run longest ago went.
  expect(names).not.toContain("t0");
  expect(names).toContain("t1");
});
