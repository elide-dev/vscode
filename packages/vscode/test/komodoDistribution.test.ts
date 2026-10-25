import { expect, test } from "bun:test";
import { elideJdkHome, resolveKomodoLauncher } from "../src/komodoDistribution.ts";

test("native launcher resolution honors payload precedence and explicit paths; only its distribution supplies JDK inputs", () => {
  const files = new Set(["/elide/lib/komodo/bin/komodo", "/elide/bin/komodo", "/usr/bin/komodo", "/elide/lib/modules"]);
  const exists = (file: string) => files.has(file);
  const env = { PATH: "/usr/bin" };
  expect(resolveKomodoLauncher("komodo", undefined, "/elide", env, exists)).toBe("/elide/lib/komodo/bin/komodo");
  files.delete("/elide/lib/komodo/bin/komodo");
  expect(resolveKomodoLauncher("komodo", undefined, "/elide", env, exists)).toBe("/elide/bin/komodo");
  expect(resolveKomodoLauncher("komodo", undefined, undefined, env, exists)).toBe("/usr/bin/komodo");
  // A configured path is never second-guessed.
  expect(resolveKomodoLauncher("komodo", "/missing/komodo", "/elide", env, exists)).toBeUndefined();
  expect(elideJdkHome("/elide/lib/komodo/bin/komodo", "/elide", exists)).toBe("/elide");
  expect(elideJdkHome("/usr/bin/komodo", "/elide", exists)).toBeUndefined();
  expect(elideJdkHome("/elide/lib/komodo/bin/komodo", undefined, exists)).toBeUndefined();
  files.delete("/elide/lib/modules");
  expect(elideJdkHome("/elide/lib/komodo/bin/komodo", "/elide", exists)).toBeUndefined();
});

