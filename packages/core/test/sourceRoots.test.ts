import { describe, expect, test } from "bun:test";
import { absolutePattern, collectContentRoots, staticPrefix } from "../src/index.js";

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
