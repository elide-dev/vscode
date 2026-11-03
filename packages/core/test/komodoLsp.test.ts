import { describe, expect, test } from "bun:test";
import { emitKomodoProject, serializeKomodoProject, type ProjectModel } from "../src/index.js";

function model(over: Partial<ProjectModel> = {}): ProjectModel {
  return {
    root: "/ws",
    name: "app",
    elideVersion: "1.5.1",
    kotlin: { freeCompilerArgs: [] },
    modules: [
      {
        name: "app.main",
        sourceSet: "main",
        kind: "source",
        contentRoots: [{ path: "/ws/src", sourceRoots: [{ path: "/ws/src/main", kind: "source" }, { path: "/ws/src/res", kind: "resource" }], excludedPatterns: [] }],
        libraries: [{ name: "Elide: org.jetbrains.kotlinx:kotlinx-serialization-core-jvm:1.9.0", scope: "compile" }],
        moduleDeps: [],
      },
      {
        name: "app.test",
        sourceSet: "test",
        kind: "test",
        contentRoots: [{ path: "/ws/src", sourceRoots: [{ path: "/ws/src/test", kind: "test" }], excludedPatterns: [] }],
        libraries: [{ name: "Elide: junit:junit:4.13.2", scope: "test" }],
        moduleDeps: [{ project: "/ws", module: "app.main", scope: "compile", exported: false }],
      },
      {
        name: "app.resources",
        sourceSet: "resources",
        kind: "resource",
        contentRoots: [{ path: "/ws/res", sourceRoots: [{ path: "/ws/res", kind: "resource" }], excludedPatterns: [] }],
        libraries: [],
        moduleDeps: [],
      },
    ],
    libraries: [
      { name: "Elide: org.jetbrains.kotlinx:kotlinx-serialization-core-jvm:1.9.0", classes: "C:\\m2\\serialization.jar", coordinate: "org.jetbrains.kotlinx:kotlinx-serialization-core-jvm:1.9.0" },
      { name: "Elide: junit:junit:4.13.2", classes: "/ws/.dev/junit,4.13.2.jar" },
    ],
    entrypoints: [],
    warnings: [],
    members: [],
    ...over,
  };
}

describe("emitKomodoProject", () => {
  const project = emitKomodoProject([model()]);

  test("one module per source set with Kotlin roots, named as Komodo accepts, depending by those names", () => {
    expect(project.modules.map((m) => [m.name, m.sources, m.depends])).toEqual([
      ["app_main", ["/ws/src/main"], []],
      ["app_test", ["/ws/src/test"], ["app_main"]],
    ]);
    expect(project.skipped).toContain("app.resources (/ws): no Kotlin source root");
  });

  test("a test source set sees its own project's main set's internals, never another project's", () => {
    expect(project.modules.map((m) => [m.name, m.friends])).toEqual([["app_main", []], ["app_test", ["app_main"]]]);
    const other = model({ root: "/ws/lib" });
    const app = model();
    app.modules[1]!.moduleDeps.push({ project: "/ws/lib", module: "app.main", scope: "compile", exported: false });
    expect(emitKomodoProject([app, other]).modules[1]).toMatchObject({ name: "app_test", depends: ["app_main", "app_main_2"], friends: ["app_main"] });
    expect(serializeKomodoProject(project)).toContain("module.app_test.friends=app_main\n");
  });

  test("an entry with a comma is left out and reported, never split", () => {
    expect(project.modules[1]!.classpath).toEqual([]);
    expect(project.skipped.some((reason) => reason.includes("junit,4.13.2.jar"))).toBe(true);
  });

  test("plugins follow the models: Compose by flag, serialization by its runtime", () => {
    expect(project.plugins).toEqual({ compose: false, serialization: true });
    expect(emitKomodoProject([model({ kotlin: { freeCompilerArgs: [], compose: true }, libraries: [] })]).plugins).toEqual({ compose: true, serialization: false });
    const byName = model({ libraries: [{ name: "Elide: org.jetbrains.kotlinx:kotlinx-serialization-core-jvm:1.11.0", classes: "/m2/core.jar" }] });
    expect(emitKomodoProject([byName]).plugins.serialization).toBe(true);
  });

  test("colliding module names across projects get distinct names and dependencies follow them", () => {
    const other = model({ root: "/ws/lib" });
    other.modules = other.modules.map((m) => ({ ...m, moduleDeps: m.moduleDeps.map((d) => ({ ...d, project: "/ws/lib" })) }));
    const names = emitKomodoProject([model(), other]).modules.map((m) => [m.name, m.depends]);
    expect(names).toEqual([["app_main", []], ["app_test", ["app_main"]], ["app_main_2", []], ["app_test_2", ["app_main_2"]]]);
  });

  test("properties escape backslashes so Windows paths survive java.util.Properties", () => {
    expect(serializeKomodoProject(project)).toContain("module.app_main.classpath=C:\\\\m2\\\\serialization.jar\n");
  });
});
