import { describe, expect, test } from "bun:test";
import { absolutePattern, collectContentRoots, sourceSelection, staticPrefix } from "../src/index.js";

const root = "/proj";

describe("staticPrefix", () => {
  test("strips the glob tail", () => {
    expect(staticPrefix("/proj/src/main/**/*.kt")).toBe("/proj/src/main");
    expect(staticPrefix("/proj/src/**.*")).toBe("/proj/src");
    expect(staticPrefix("/proj/Main.kt")).toBe("/proj/Main.kt");
    expect(staticPrefix("/proj/{a,b}/**")).toBe("/proj");
    expect(staticPrefix("/*.kt")).toBe("/");
  });
});

describe("collectContentRoots", () => {
  test("a folder's parent becomes the content root, clamped so the project root never does", () => {
    const roots = collectContentRoots(root, ["src/main/**/*.kt"]);
    expect([...roots]).toEqual([["/proj/src", ["/proj/src/main"]]]);
  });

  test("top-level folders own themselves", () => {
    const roots = collectContentRoots(root, ["src/**.*"]);
    expect([...roots]).toEqual([["/proj/src", ["/proj/src"]]]);
  });

  test("nested candidates merge into the outermost root", () => {
    const roots = collectContentRoots(root, ["packages/base/main/**/*.kt", "packages/base/main/gen/**/*.java", "packages/other/**/*.kt"]);
    expect([...roots]).toEqual([["/proj/packages", ["/proj/packages/base/main", "/proj/packages/base/main/gen", "/proj/packages/other"]]]);
  });

  test("a root-level glob makes the project root the content root", () => {
    const roots = collectContentRoots(root, ["**/*.kt"]);
    expect([...roots]).toEqual([["/proj", ["/proj"]]]);
  });

  test("patterns outside the project own themselves; drive-letter paths count as absolute", () => {
    expect([...collectContentRoots(root, ["/elsewhere/src/**/*.kt"]).keys()]).toEqual(["/elsewhere/src"]);
    expect(absolutePattern("C:\\other\\src\\**\\*.kt", root)).toBe("C:/other/src/**/*.kt");
    expect(absolutePattern("./src/**", root)).toBe("/proj/src/**");
  });

  test("src/a is not a parent of src/ab", () => {
    const roots = collectContentRoots(root, ["src/a/**", "src/ab/**"]);
    expect(roots.get("/proj/src")).toEqual(["/proj/src/a", "/proj/src/ab"]);
  });
});

describe("sourceSelection", () => {
  test("Elide's default glob crosses directories without widening the source tree", () => {
    const selection = sourceSelection(root, "src/**.*");
    expect(selection.root).toBe("/proj/src");
    for (const file of ["src/Main.kt", "src/dev/example/build/Main.java", "src/.dev/Generated.kt", "src/node_modules/Legal.kt"]) {
      expect(selection.matches(`${root}/${file}`)).toBe(true);
    }
    expect(selection.matches("/proj/other/Main.kt")).toBe(false);
    expect(selection.matches("/proj/src/extensionless")).toBe(false);
  });

  test("single stars do not include excluded siblings or nested packages", () => {
    const selection = sourceSelection(root, "src/main/Included*.kt");
    expect(selection.root).toBe("/proj/src/main");
    expect(selection.matches("/proj/src/main/Included.kt")).toBe(true);
    expect(selection.matches("/proj/src/main/Excluded.kt")).toBe(false);
    expect(selection.matches("/proj/src/main/nested/Included.kt")).toBe(false);
    expect(selection.matches("/proj/src/test/Included.kt")).toBe(false);
  });

  test("optional globstar directories, alternatives, classes and escapes retain Java glob meaning", () => {
    const selection = sourceSelection(root, "src/**/File[!0-9]?.{kt,java}");
    expect(selection.matches("/proj/src/FileAx.kt")).toBe(true);
    expect(selection.matches("/proj/src/deep/build/FileAz.java")).toBe(true);
    expect(selection.matches("/proj/src/File1x.kt")).toBe(false);
    expect(selection.matches("/proj/src/FileAx.js")).toBe(false);
    expect(sourceSelection(root, "src/Name\\?.kt").matches("/proj/src/Name?.kt")).toBe(true);
    expect(sourceSelection(root, "src/Name\\?.kt").matches("/proj/src/NameA.kt")).toBe(false);
  });

  test("literal trees and exact files cannot select adjacent siblings", () => {
    const tree = sourceSelection(root, "custom");
    expect(tree.matches("/proj/custom/build/Main.kt")).toBe(true);
    expect(tree.matches("/proj/custom-other/Main.kt")).toBe(false);
    const file = sourceSelection(root, "src/Only.kt");
    expect(file.matches("/proj/src/Only.kt")).toBe(true);
    expect(file.matches("/proj/src/Other.kt")).toBe(false);
    expect(() => sourceSelection(root, "src/[unclosed*.kt")).toThrow();
  });
});
