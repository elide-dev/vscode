import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { composePreviewBuildTargets, composePreviewInputs, decodeManifest, packagedSourceSets, type AndroidTargetModel, type ModuleModel, type ProjectModel } from "../src/index.js";

const directories: string[] = [];
afterAll(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });

function project(root: string, name: string, sourceSets: string[]): ProjectModel {
  return {
    root, name, elideVersion: "1.6.0", kotlin: { compose: true, freeCompilerArgs: [] },
    modules: sourceSets.map((sourceSet): ModuleModel => ({
      name: `${name}.${sourceSet}`, sourceSet, kind: sourceSet === "test" ? "test" : "source",
      sourcePaths: [`src/${sourceSet}/**.*`],
      contentRoots: [], libraries: [], moduleDeps: [], runtimeModuleDeps: [], runtimeClassPath: [],
      compilationTargets: [`${name}:compile-kotlin-${sourceSet}`],
    })),
    libraries: [], entrypoints: [], warnings: [], members: [], workspaceRoot: path.dirname(root),
  };
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "compose-inputs-"));
  directories.push(root);
  const app = project(path.join(root, "app"), "app", ["screen", "shared", "unused", "test"]);
  const library = project(path.join(root, "library"), "library", ["widgets", "test"]);
  const provided = project(path.join(root, "provided"), "provided", ["main"]);
  const [screen, shared, , tests] = app.modules;
  const widgets = library.modules[0]!;
  screen!.runtimeModuleDeps = [
    { project: app.root, module: shared!.name, scope: "compile", exported: false },
    { project: library.root, module: widgets.name, scope: "compile", exported: true },
    { project: app.root, module: tests!.name, scope: "test", exported: false },
  ];
  // Compile/provided relationships must not leak into the executing closure.
  screen!.moduleDeps = [{ project: provided.root, module: provided.modules[0]!.name, scope: "compile", exported: true }];
  widgets.runtimeModuleDeps = [{ project: app.root, module: screen!.name, scope: "compile", exported: true }];
  shared!.compilationTargets = ["app:compile-java-shared"];
  const target: AndroidTargetModel = {
    name: "demo", kind: "apk", sourceSets: ["screen"], output: path.join(app.root, ".dev/artifacts/demo.apk"),
    manifestFile: path.join(app.root, "src/main/AndroidManifest.xml"),
  };
  const stage = path.join(app.root, ".dev/android/demo");
  mkdirSync(path.join(stage, "r-classes"), { recursive: true });
  writeFileSync(path.join(stage, "resources.apk"), "resources fixture");
  writeFileSync(path.join(stage, "AndroidManifest.xml"), `<!-- <manifest package="wrong.comment"/> -->
<manifest xmlns:android="http://schemas.android.com/apk/res/android" other="package='wrong.attribute' >" package='merged.application'><application package="wrong.child"/></manifest>`);
  return { app, library, provided, target, stage, models: [app, library, provided] };
}

describe("host Compose preview inputs", () => {
  test("builds declared source-set and workspace runtime closure, not tests, provided modules or full artifacts", () => {
    const { app, target, models } = fixture();
    expect(composePreviewBuildTargets(app, target, models)).toEqual([
      "app:android-r-demo", "app:compile-kotlin-screen", "app:compile-java-shared", "library:compile-kotlin-widgets",
    ]);
  });

  test("reads merged namespace and fresh original classes, excludes stubs and stale AAR versions", async () => {
    const { app, library, target, stage, models } = fixture();
    const kotlin = path.join(app.root, ".dev/jvm/classes/screen/kotlin");
    const java = path.join(app.root, ".dev/jvm/classes/shared/java");
    const libraryClasses = path.join(library.root, ".dev/jvm/classes/widgets/kotlin");
    // This directory is left over from an undeclared language task, not a current output.
    const staleJava = path.join(app.root, ".dev/jvm/classes/screen/java");
    for (const directory of [kotlin, java, libraryClasses, staleJava]) mkdirSync(directory, { recursive: true });
    const aar = path.join(app.root, ".dev/android/libraries/androidx.compose.ui/ui-tooling-android/2.0/classes.jar");
    const staleAar = path.join(library.root, ".dev/android/libraries/androidx.compose.ui/ui-tooling-android/1.0/classes.jar");
    const runtimeJar = path.join(app.root, ".dev/dependencies/m2/example/runtime/1/runtime-1.jar");
    const embedded = path.join(path.dirname(aar), "libs/embedded.jar");
    for (const file of [aar, runtimeJar, embedded]) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, "jar fixture"); }
    app.modules[0]!.runtimeClassPath = [staleAar, aar, runtimeJar, "/sdk/platforms/android-36/android.jar"];
    library.modules[0]!.runtimeClassPath = [
      staleAar, path.join(path.dirname(staleAar), "libs/embedded.jar"), path.join(path.dirname(staleAar), "libs/removed.jar"),
    ];
    const inputs = await composePreviewInputs(app, target, models);
    expect(inputs.namespace).toBe("merged.application");
    expect(inputs.resourceApkPath).toBe(path.join(stage, "resources.apk"));
    expect(inputs.projectClassPath).toEqual([kotlin, java, libraryClasses]);
    expect(inputs.sourceSelections).toEqual({
      [kotlin]: ["src/screen/**.*"], [java]: ["src/shared/**.*"], [libraryClasses]: ["src/widgets/**.*"],
    });
    expect(inputs.classPath).toEqual([path.join(stage, "r-classes"), kotlin, java, libraryClasses, aar, runtimeJar, embedded]);
    // Resolving again after a compile sees the newly created language output, not a prebuild snapshot.
    app.modules[0]!.compilationTargets!.push("app:compile-java-screen");
    expect((await composePreviewInputs(app, target, models)).projectClassPath).toContain(staleJava);
  });

  test("absent optional language outputs are not advertised", async () => {
    const { app, target, models } = fixture();
    expect((await composePreviewInputs(app, target, models)).projectClassPath).toEqual([]);
  });

  test("does not substitute the source manifest when the merged manifest lacks a namespace", async () => {
    const { app, target, stage, models } = fixture();
    mkdirSync(path.dirname(target.manifestFile), { recursive: true });
    writeFileSync(target.manifestFile, '<manifest package="source.package"/>');
    writeFileSync(path.join(stage, "AndroidManifest.xml"), '<manifest><application package="not.the.namespace"/></manifest>');
    await expect(composePreviewInputs(app, target, models)).rejects.toThrow("Merged Android manifest has no package");
  });

  test("Android's empty source selection uses all non-test production sets, not hardcoded main", () => {
    const manifest = decodeManifest(JSON.stringify({
      sources: { screen: { type: "source", paths: ["screen/**"] }, widgets: { type: "source", paths: ["widgets/**"] }, test: { paths: ["test/**"] } },
      android: { compileSdk: 36 }, artifacts: { app: { "@type": "elide.android.AndroidApk", sources: [] } },
    }));
    expect(packagedSourceSets(manifest, manifest.androidTargets.app!)).toEqual(["screen", "widgets"]);
    manifest.androidTargets.app!.sources = ["widgets", "missing"];
    expect(packagedSourceSets(manifest, manifest.androidTargets.app!)).toEqual(["widgets"]);
  });
});
