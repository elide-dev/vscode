import { describe, expect, test } from "bun:test";
import { splitSharedContentRoots, type ModuleModel } from "../src/index.js";

function module(name: string, kind: ModuleModel["kind"], roots: ModuleModel["contentRoots"]): ModuleModel {
  return { name, sourceSet: name, kind, contentRoots: roots, libraries: [], moduleDeps: [] };
}

describe("splitSharedContentRoots", () => {
  test("main and test grouping under the same parent get one content root per source folder", () => {
    const main = module("main", "source", [
      { path: "/p/src", sourceRoots: [{ path: "/p/src/main", kind: "source" }, { path: "/p/src/main/gen", kind: "source" }], excludedPatterns: [] },
    ]);
    const test = module("test", "test", [{ path: "/p/src", sourceRoots: [{ path: "/p/src/test", kind: "test" }], excludedPatterns: [] }]);
    splitSharedContentRoots([main, test]);
    expect(main.contentRoots).toEqual([
      { path: "/p/src/main", sourceRoots: [{ path: "/p/src/main", kind: "source" }, { path: "/p/src/main/gen", kind: "source" }], excludedPatterns: [] },
    ]);
    expect(test.contentRoots).toEqual([{ path: "/p/src/test", sourceRoots: [{ path: "/p/src/test", kind: "test" }], excludedPatterns: [] }]);
  });

  test("content roots owned by a single module are left alone", () => {
    const main = module("main", "source", [{ path: "/p/lib", sourceRoots: [{ path: "/p/lib/main", kind: "source" }], excludedPatterns: [] }]);
    const test = module("test", "test", [{ path: "/p/tests", sourceRoots: [{ path: "/p/tests/unit", kind: "test" }], excludedPatterns: [] }]);
    splitSharedContentRoots([main, test]);
    expect(main.contentRoots[0]!.path).toBe("/p/lib");
    expect(test.contentRoots[0]!.path).toBe("/p/tests");
  });
});
