import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { moduleReaders, projectModules } from "../src/manifestModules.js";

describe("projectModules", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  /** A checkout whose opened folder is `app/`, beside a `shared/` directory outside it. */
  const checkout = (files: Record<string, string>) => {
    const dir = mkdtempSync(path.join(tmpdir(), "elide-modules-"));
    dirs.push(dir);
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), text);
    }
    return (name: string) => path.join(dir, name);
  };

  test("a project maps to the modules it reads transitively, outside the folder too, but no manifest or .dev file", async () => {
    const at = checkout({
      "app/elide.pkl": `amends "elide:project.pkl"\nimport "versions.pkl"\nimport "../shared/deps.pkl"\nimport ".dev/generated.pkl"\n`,
      "app/versions.pkl": `local compose = import("deps/compose.pkl")\n`,
      "app/deps/compose.pkl": `extends "../../shared/base.pkl"\n`,
      "shared/deps.pkl": `amends "../app/elide.pkl"\n`,
      "shared/base.pkl": `x = 1\n`,
      "app/.dev/generated.pkl": `y = 2\n`,
    });
    const modules = await projectModules([{ root: at("app"), manifestPath: at("app/elide.pkl") }]);
    expect(modules.get(at("app"))?.sort()).toEqual(
      ["app/deps/compose.pkl", "app/versions.pkl", "shared/base.pkl", "shared/deps.pkl"].map(at).sort(),
    );
  });

  test("a module is dropped once the import is removed", async () => {
    const at = checkout({
      "app/elide.pkl": `amends "elide:project.pkl"\nimport "versions.pkl"\n`,
      "app/versions.pkl": `import "../shared/deps.pkl"\n`,
      "shared/deps.pkl": `x = 1\n`,
    });
    const project = { root: at("app"), manifestPath: at("app/elide.pkl") };
    expect((await projectModules([project])).get(at("app"))).toEqual([at("app/versions.pkl"), at("shared/deps.pkl")]);
    writeFileSync(at("app/elide.pkl"), `amends "elide:project.pkl"\n`);
    expect((await projectModules([project])).get(at("app"))).toEqual([]);
  });

  test("a workspace root reads its members' manifests; a member only its own", async () => {
    const at = checkout({
      "elide.pkl": `amends "elide:project.pkl"\n`,
      "ui/elide.pkl": `amends "elide:project.pkl"\nimport "../versions.pkl"\n`,
      "versions.pkl": `x = 1\n`,
    });
    const root = { root: at(""), manifestPath: at("elide.pkl") };
    const member = { root: at("ui"), manifestPath: at("ui/elide.pkl"), workspaceRoot: at("") };
    const modules = await projectModules([root, member]);
    expect(modules.get(at(""))).toEqual([at("versions.pkl")]);
    expect(modules.get(at("ui"))).toEqual([at("versions.pkl")]);
    expect((await projectModules([root])).get(at(""))).toEqual([]);
  });
});

describe("moduleReaders", () => {
  test("maps each module to the distinct folders reading it", () => {
    const readers = moduleReaders([
      { folder: "a", modules: ["/v.pkl", "/a.pkl"] },
      { folder: "a", modules: ["/v.pkl"] },
      { folder: "b", modules: ["/v.pkl"] },
      { folder: "c" },
    ]);
    expect(Object.fromEntries(readers)).toEqual({ "/v.pkl": ["a", "b"], "/a.pkl": ["a"] });
  });
});
