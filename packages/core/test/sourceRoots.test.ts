import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { absolutePattern, collectContentRoots, decodeWorkspaceSources, selectsKotlinSources, sourceSelection, staticPrefix } from "../src/index.js";

const root = "/proj";

describe("decodeWorkspaceSources", () => {
  const exported = () => ({
    format: "elide.intellij.workspace", version: 1, root: "/workspace",
    projects: [{ name: "root", path: "" }, { name: "app", path: "app" }, { name: "components", path: "components" }],
    modules: [
      {
        name: "app.main", project: "app", sourceSet: "main", type: "source",
        sourceRoots: [{ path: "app/src/main/kotlin" }, { path: "app/src/main/java" }],
        resourceRoots: [{ path: "app/src/main/resources", relativeOutputPath: "" }],
        moduleDependencies: [{ module: "components.main" }],
      },
      {
        name: "app.test", project: "app", sourceSet: "test", type: "test",
        sourceRoots: [{ path: "app/spec/**/*.kt" }], resourceRoots: [],
        moduleDependencies: [{ module: "app.main" }],
      },
      {
        name: "components.main", project: "components", sourceSet: "main", type: "source",
        sourceRoots: [{ path: "components/src/main/kotlin" }], resourceRoots: [], moduleDependencies: [],
      },
    ],
  });

  test("keeps resolved language roots, explicit globs, resources and only same-project source edges", () => {
    const sources = decodeWorkspaceSources(JSON.stringify(exported()));
    expect(sources.get("/workspace")).toEqual({});
    expect(sources.get("/workspace/app")).toEqual({
      main: { type: "source", paths: ["src/main/kotlin", "src/main/java"], resources: { "src/main/resources": "src/main/resources" }, dependsOn: [] },
      test: { type: "test", paths: ["spec/**/*.kt"], resources: {}, dependsOn: ["main"] },
    });
    expect(sources.get("/workspace/components")!.main!.paths).toEqual(["src/main/kotlin"]);
  });

  test("rejects wrong schemas and incomplete module edges instead of falling back to guessed roots", () => {
    expect(() => decodeWorkspaceSources("{}")).toThrow();
    expect(() => decodeWorkspaceSources("not json")).toThrow();
    expect(() => decodeWorkspaceSources(JSON.stringify({ ...exported(), version: 2 }))).toThrow();
    const missing = exported();
    missing.modules[0]!.moduleDependencies = [{ module: "missing.main" }];
    expect(() => decodeWorkspaceSources(JSON.stringify(missing))).toThrow();
  });
});

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

describe("selectsKotlinSources", () => {
  const project = mkdtempSync(path.join(tmpdir(), "elide-kotlin-sources-"));
  afterAll(() => rmSync(project, { recursive: true, force: true }));
  const file = (relative: string) => {
    mkdirSync(path.dirname(path.join(project, relative)), { recursive: true });
    writeFileSync(path.join(project, relative), "");
  };
  file("src/main/java/demo/Hello.java");
  file("src/main/kotlin/demo/Excluded.kt");
  file("scripts/build.kts");

  test("Java sources alone, or Kotlin ones the selectors leave out, are no Kotlin compilation", async () => {
    expect(await selectsKotlinSources(project, ["src/main/java/**", "src/main/kotlin/Included*.kt"])).toBe(false);
    expect(await selectsKotlinSources(project, ["src/main/kotlin/**/*.java", "missing"])).toBe(false);
  });

  test("a selected Kotlin source or script is, through globs, literal trees and literal files", async () => {
    expect(await selectsKotlinSources(project, ["src/**.*"])).toBe(true);
    expect(await selectsKotlinSources(project, ["scripts"])).toBe(true);
    expect(await selectsKotlinSources(project, ["scripts/build.kts"])).toBe(true);
  });
});
