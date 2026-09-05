import { describe, expect, test } from "bun:test";
import { emitKotlinLspWorkspace, kotlinAdditionalArguments, portablePath, type ProjectModel } from "../src/index.js";

const ws = "/ws";

function model(over: Partial<ProjectModel> = {}): ProjectModel {
  return {
    root: "/ws",
    name: "app",
    elideVersion: "1.5.1",
    jdk: { home: "/home/u/.local/share/elide", version: "25.0.4.1" },
    kotlin: { languageVersion: "2.4", apiVersion: "2.4", freeCompilerArgs: ["-Xcontext-parameters"], jvmTarget: "21" },
    modules: [
      {
        name: "app.main",
        sourceSet: "main",
        kind: "source",
        contentRoots: [{ path: "/ws/src", sourceRoots: [{ path: "/ws/src/main", kind: "source" }, { path: "/ws/src/res", kind: "resource" }], excludedPatterns: [] }],
        libraries: [{ name: "Elide: org.jetbrains.kotlin:kotlin-stdlib:2.4.10", scope: "compile" }],
        moduleDeps: [],
      },
      {
        name: "app.test",
        sourceSet: "test",
        kind: "test",
        contentRoots: [{ path: "/ws/src", sourceRoots: [{ path: "/ws/src/test", kind: "test" }], excludedPatterns: [] }],
        libraries: [
          { name: "Elide: junit:junit:4.13.2", scope: "test" },
          { name: "Elide: org.jetbrains.kotlin:kotlin-stdlib:2.4.10", scope: "compile" },
        ],
        moduleDeps: ["app.main"],
      },
    ],
    libraries: [
      { name: "Elide: org.jetbrains.kotlin:kotlin-stdlib:2.4.10", classes: "/ws/.dev/dependencies/m2/k/kotlin-stdlib-2.4.10.jar", sources: "/ws/.dev/dependencies/m2/k/kotlin-stdlib-2.4.10-sources.jar" },
      { name: "Elide: junit:junit:4.13.2", classes: "/ws/.dev/dependencies/m2/j/junit-4.13.2.jar" },
    ],
    entrypoints: [],
    warnings: [],
    ...over,
  };
}

describe("portablePath", () => {
  test("workspace and home prefixes, absolute otherwise", () => {
    const opts = { workspaceRoot: ws, userHome: "/home/u" };
    expect(portablePath("/ws/src/main", opts)).toBe("<WORKSPACE>/src/main");
    expect(portablePath("/ws", opts)).toBe("<WORKSPACE>");
    expect(portablePath("/home/u/.local/share/elide", opts)).toBe("<HOME>/.local/share/elide");
    expect(portablePath("/opt/jdk", opts)).toBe("/opt/jdk");
    expect(portablePath("/wsx/other", opts)).toBe("/wsx/other");
  });
});

describe("emitKotlinLspWorkspace", () => {
  const out = emitKotlinLspWorkspace([model()], { workspaceRoot: ws, userHome: "/home/u" });

  test("module shape: explicit sdk, moduleSource, module and library deps with scopes", () => {
    expect(out.modules.map((m) => m.name)).toEqual(["app.main", "app.test"]);
    const test = out.modules[1]!;
    expect(test.type).toBe("JAVA_MODULE");
    expect(test.dependencies).toEqual([
      { type: "sdk", name: "Elide JDK 25.0.4.1", kind: "JavaSDK" },
      { type: "moduleSource" },
      { type: "module", name: "app.main", scope: "compile", isExported: false, isTestJar: false },
      { type: "library", name: "Elide: junit:junit:4.13.2", scope: "test", isExported: false },
      { type: "library", name: "Elide: org.jetbrains.kotlin:kotlin-stdlib:2.4.10", scope: "compile", isExported: false },
    ]);
    expect(test.contentRoots).toEqual([
      { path: "<WORKSPACE>/src", excludedPatterns: [], excludedUrls: [], sourceRoots: [{ path: "<WORKSPACE>/src/test", type: "java-test" }] },
    ]);
    expect(out.modules[0]!.contentRoots[0]!.sourceRoots).toEqual([
      { path: "<WORKSPACE>/src/main", type: "java-source" },
      { path: "<WORKSPACE>/src/res", type: "java-resource" },
    ]);
  });

  test("libraries carry CLASSES and SOURCES roots; sdk points at the JDK home", () => {
    expect(out.libraries[0]).toEqual({
      name: "Elide: org.jetbrains.kotlin:kotlin-stdlib:2.4.10",
      level: "project",
      type: null,
      roots: [
        { path: "<WORKSPACE>/.dev/dependencies/m2/k/kotlin-stdlib-2.4.10.jar", type: "CLASSES", inclusionOptions: "root_itself" },
        { path: "<WORKSPACE>/.dev/dependencies/m2/k/kotlin-stdlib-2.4.10-sources.jar", type: "SOURCES", inclusionOptions: "root_itself" },
      ],
    });
    expect(out.sdks).toEqual([{ name: "Elide JDK 25.0.4.1", type: "JavaSDK", version: "25.0.4.1", homePath: "<HOME>/.local/share/elide", additionalData: "" }]);
  });

  test("kotlin settings carry every field the importer requires and encode levels as kotlinc flags", () => {
    const ks = out.kotlinSettings[1]!;
    expect(Object.keys(ks).sort()).toEqual(
      [
        "additionalArguments", "additionalVisibleModuleNames", "compilerArguments", "configFileItems", "copyJsLibraryFiles",
        "dependsOnModuleNames", "externalProjectId", "externalSystemRunTasks", "flushNeeded", "implementedModuleNames",
        "isHmppEnabled", "isTestModule", "kind", "module", "name", "outputDirectoryForJsLibraryFiles", "productionOutputPath",
        "pureKotlinSourceFolders", "scriptTemplates", "scriptTemplatesClasspath", "sourceRoots", "sourceSetNames",
        "targetPlatform", "testOutputPath", "useProjectSettings", "version",
      ].sort(),
    );
    expect(ks.module).toBe("app.test");
    expect(ks.isTestModule).toBe(true);
    expect(ks.additionalArguments).toBe("-language-version 2.4 -api-version 2.4 -jvm-target 21 -Xcontext-parameters");
    expect(kotlinAdditionalArguments({ freeCompilerArgs: [] })).toBeNull();
  });

  test("no JDK → inheritedSdk and no sdks", () => {
    const o = emitKotlinLspWorkspace([model({ jdk: undefined })], { workspaceRoot: ws });
    expect(o.sdks).toEqual([]);
    expect(o.modules[0]!.dependencies[0]).toEqual({ type: "inheritedSdk" });
  });

  test("two projects with the same name get disambiguated module names", () => {
    const a = model({ root: "/ws/a" });
    const b = model({ root: "/ws/b" });
    const o = emitKotlinLspWorkspace([a, b], { workspaceRoot: ws });
    expect(o.modules.map((m) => m.name)).toEqual(["app.main", "app.test", "app.main (b)", "app.test (b)"]);
    expect(o.modules[3]!.dependencies.find((d) => d.type === "module")).toEqual({ type: "module", name: "app.main (b)", scope: "compile", isExported: false, isTestJar: false });
    expect(o.libraries).toHaveLength(2);
  });
});
