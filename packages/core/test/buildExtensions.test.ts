import { describe, expect, test } from "bun:test";
import { parseManifestBuildExtensions } from "../src/index.js";

function paths(text: string): string[] {
  return parseManifestBuildExtensions(text).map((entry) => entry.path);
}

describe("parseManifestBuildExtensions", () => {
  test("reads local bare and configured entries with source offsets", () => {
    const text = `amends "elide:project.pkl"
extensions {
  "tools/tasks.ts"
  new {
    from = "../tools/shared.mts"
    config { message = "not-a-module.ts"; nested { from = "also-not.ts" } }
  }
  new { from = "tools/inline.js" config { message = "ignored.js" } }
  "one.ts"; "two.mjs", "three.tsx"
}`;
    expect(paths(text)).toEqual(["tools/tasks.ts", "../tools/shared.mts", "tools/inline.js", "one.ts", "two.mjs", "three.tsx"]);
    for (const entry of parseManifestBuildExtensions(text)) {
      expect(text.slice(entry.start, entry.end)).toBe(entry.path);
    }
  });

  test("only the top-level listing and the entry's direct from property count", () => {
    const text = `other { extensions { "nested.ts" } }
// extensions { "comment.ts" }
/* extensions { "block-comment.ts" } */
extensions {
  new { config { from = "config.ts" } }
  unrelated { from = "unrelated.ts" }
  new { nested { from = "nested-from.ts" } }
  ["mapping"] = "mapping.ts"
  "real.ts"
}
other { "outside.ts" }`;
    expect(paths(text)).toEqual(["real.ts"]);
    expect(paths(`other { extensions { "nested-only.ts" } }`)).toEqual([]);
  });

  test("comments and braces in strings do not invent entries or shift nesting", () => {
    expect(paths(`extensions /* opening { */ {
  // "comment.ts" }
  "tools/{tasks}.ts" // }
  /* "ignored.ts" { */ new { /* from = "no.ts" */ from = "yes.ts" }
  "after.ts"
}`)).toEqual(["tools/{tasks}.ts", "yes.ts", "after.ts"]);
  });

  test("remote declarations and nonliteral expressions have no destination", () => {
    expect(paths(`extensions {
  "url:https://example.test/tasks.elx"
  "npm:@example/tasks@1.0.0"
  new { from = "maven:dev.example:tasks:1.0" }
  "https://example.test/not-local.ts"
  "prefix/" + "tasks.ts"
  read("tasks.ts")
  if (enabled) "conditional.ts"
  new { from = base + "tasks.ts" }
  new { from = "tools/" + module }
  "prefix/"
    + "continued.ts"
  read(
    "argument.ts"
  )
  new {
    from = "prefix/"
      + "continued-from.ts"
  }
  "local.elx"
}`)).toEqual(["local.elx"]);
  });

  test("decodes supported Pkl escapes while preserving the literal source range", () => {
    const text = String.raw`extensions {
  "tools/quote\"name.ts"
  "tools/back\\slash.ts"
  "tools/\u{61}.ts"
  "tools/\(computed).ts"
  "tools/\q.ts"
}`;
    const entries = parseManifestBuildExtensions(text);
    expect(entries.map((entry) => entry.path)).toEqual(['tools/quote"name.ts', "tools/back\\slash.ts", "tools/a.ts"]);
    expect(text.slice(entries[2]!.start, entries[2]!.end)).toBe(String.raw`tools/\u{61}.ts`);
  });

  test("only reserved fetch schemes exclude otherwise local paths", () => {
    expect(paths(String.raw`extensions { "C:\\tools\\tasks.ts"; "custom:tasks.ts" }`))
      .toEqual(["C:\\tools\\tasks.ts", "custom:tasks.ts"]);
  });

  test("declines unsupported raw, multiline, and unfinished declarations", () => {
    expect(paths('extensions { #"tools/raw.ts"# }')).toEqual([]);
    expect(paths('extensions { """tools/multiline.ts""" }')).toEqual([]);
    expect(paths('extensions { "unfinished.ts"')).toEqual([]);
    expect(paths('extensions { new { from = "unfinished.ts } }')).toEqual([]);
    expect(paths('extensions { "ok.ts" /* unfinished }')).toEqual([]);
  });
});
