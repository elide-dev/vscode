import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ManifestParseError, decodeManifest, effectiveType } from "../src/index.js";

const whiplash = readFileSync(path.join(import.meta.dir, "fixtures", "manifest-whiplash.json"), "utf8");
/** `elide manifest` of a project of the workspace sample, printed by Elide 1.5.4. */
const workspaceManifest = (project: string) => readFileSync(path.join(import.meta.dir, "fixtures", "workspace", `${project}.json`), "utf8");

describe("decodeManifest", () => {
  test("decodes the CLI's @type-discriminated unions", () => {
    const m = decodeManifest(whiplash);
    expect(m.name).toBe("elide");
    expect(m.kotlin?.compilerOptions?.languageVersion).toEqual({ kind: "version", value: "2.4" });
    expect(m.kotlin?.apiLevel).toEqual({ kind: "auto" });
    expect(m.kotlin?.compilerOptions?.freeCompilerArgs).toEqual(["-Xcontext-parameters"]);
    expect(m.toolchain.engines.java).toBe("25.0.3");
    expect(m.dependencies.maven?.localRepository).toBeUndefined();
  });

  test("source sets: spec with nulls, bare glob, JVM spec with resources, other", () => {
    const m = decodeManifest(whiplash);
    expect(m.sources.main).toEqual({
      type: "source",
      paths: ["packages/base/main/**/*.kt", "packages/generated/main/**/*.java", ".dev/codegen/jvm/sources/**/*.java"],
      dependsOn: [],
      resources: {},
    });
    expect(m.sources.test).toEqual({ type: "source", paths: ["packages/base/test/**/*.kt"], dependsOn: [], resources: {} });
    expect(effectiveType("test", m.sources.test!)).toBe("test");
    expect(m.sources.examples?.type).toBe("example");
    expect(m.sources.examples?.resources).toEqual({ "examples/**/*.kt": "examples/res" });
    expect(m.sources.docs?.type).toBe("other");
  });

  test("schema defaults apply when sources are absent", () => {
    const m = decodeManifest("{}");
    expect(Object.keys(m.sources)).toEqual(["main", "test"]);
    expect(m.sources.main?.paths).toEqual(["src/**.*"]);
    expect(m.sources.test?.type).toBe("test");
    expect(m.entrypoint).toEqual([]);
    expect(m.scripts).toEqual({});
  });

  test("jvm target variants", () => {
    const of = (target: unknown) => decodeManifest(JSON.stringify({ jvm: { target } })).jvm?.target;
    expect(of({ "@type": "elide.jvm.JvmTargetLevel.OfInt", value: 21 })).toEqual({ kind: "version", major: 21 });
    expect(of({ "@type": "elide.jvm.JvmTargetLevel.OfFloat", value: 1.8 })).toEqual({ kind: "version", major: 8 });
    expect(of({ "@type": "elide.jvm.JvmTargetLevel.OfFloat", value: 17.0 })).toEqual({ kind: "version", major: 17 });
    expect(of({ "@type": "elide.jvm.JvmTargetLevel.Latest" })).toEqual({ kind: "latest" });
    expect(of(undefined)).toEqual({ kind: "auto" });
  });

  test("entrypoints and scripts", () => {
    const m = decodeManifest(JSON.stringify({ entrypoint: ["src/main.kt"], scripts: { dev: "elide serve" }, jvm: { main: "app.MainKt" } }));
    expect(m.entrypoint).toEqual(["src/main.kt"]);
    expect(m.scripts).toEqual({ dev: "elide serve" });
    expect(m.jvm?.main).toBe("app.MainKt");
  });

  test("a workspace root declares its members, and nothing else of a member", () => {
    const root = decodeManifest(workspaceManifest("root"));
    expect(root.workspaceMembers).toEqual(["model", "parser", "report", "cli"]);
    expect(root.projectReferences).toEqual([]);
    expect(root.jars).toEqual({});
    const member = decodeManifest(workspaceManifest("cli"));
    expect(member.workspaceMembers).toEqual([]);
    expect(decodeManifest("{}").workspaceMembers).toEqual([]);
  });

  test("project references, with or without an artifact, and the JARs a member declares", () => {
    const cli = decodeManifest(workspaceManifest("cli"));
    expect(cli.projectReferences).toEqual([
      { project: "parser", test: false },
      { project: "report", artifact: "report", test: false },
    ]);
    expect(cli.jars).toEqual({ cli: { sources: ["main"] } });
    // Coordinates are not references; the root pins the version this one omits.
    expect(decodeManifest(workspaceManifest("report")).projectReferences).toEqual([{ project: "model", test: false }]);
  });

  test("test-only references are told apart; plugins and exclusions put nothing on a classpath", () => {
    const ref = (project: string, artifact?: string) => ({
      "@type": "elide.jvm.MavenPackageDependency.OfProjectArtifact",
      value: { project, ...(artifact ? { artifact } : {}) },
    });
    const m = decodeManifest(
      JSON.stringify({
        dependencies: {
          maven: {
            compileOnly: [ref("api")],
            testPackages: [ref("fixtures"), ref("api")],
            kotlinPlugins: [ref("plugin")],
            exclusions: [ref("excluded")],
            packages: [ref("api"), { "@type": "elide.jvm.MavenPackageDependency.OfString", value: "g:a:1" }],
          },
        },
        artifacts: {
          fat: { "@type": "elide.jvm.Jar", name: "app-all", sources: ["main", "extra"] },
          image: { "@type": "elide.jvm.NativeImage" },
        },
      }),
    );
    expect(m.projectReferences).toEqual([
      { project: "api", test: false },
      { project: "fixtures", test: true },
      { project: "api", test: true },
    ]);
    expect(m.jars).toEqual({ fat: { name: "app-all", sources: ["main", "extra"] } });
  });

  test("rejects malformed JSON", () => {
    expect(() => decodeManifest("not json")).toThrow(ManifestParseError);
    expect(() => decodeManifest("[]")).toThrow(ManifestParseError);
  });
});
