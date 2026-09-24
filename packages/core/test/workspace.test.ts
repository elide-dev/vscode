import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ArtifactIndex,
  ElideCli,
  buildProjectModels,
  decodeManifest,
  distributionAt,
  findEnclosingWorkspace,
  normalizePath,
  parseWorkspaceMembers,
  referencedSourceSets,
  sourceSetsForArtifactOutput,
  withWorkspaceMember,
  type Manifest,
  type ProjectModel,
} from "../src/index.js";

const fixture = (project: string) => readFileSync(path.join(import.meta.dir, "fixtures", "workspace", `${project}.json`), "utf8");

const manifestWith = (json: object): Manifest => decodeManifest(JSON.stringify(json));

describe("ArtifactIndex", () => {
  const index = new ArtifactIndex(
    [
      { name: "logstat", root: "/ws" },
      { name: "model", root: "/ws/model" },
      { name: "parser", root: "/ws/parser" },
    ],
    (p) => p.replace(/^\/ws/, "/private/ws"),
  );

  test("a sibling JAR, spelled relative to the consumer as the CLI prints it, names its project and artifact", () => {
    expect(index.resolve("/ws/cli/../model/.dev/artifacts/jar/model/model.jar")).toEqual({ project: "model", name: "model" });
    expect(index.resolve("/ws/parser/.dev/artifacts/jar/parser-fat/parser-fat.jar")).toEqual({ project: "parser", name: "parser-fat" });
  });

  test("the real spelling of a root matches too", () => {
    expect(index.resolve("/private/ws/model/.dev/artifacts/jar/model/model.jar")).toEqual({ project: "model", name: "model" });
  });

  test("the root's own artifacts are the root's, not a member's", () => {
    expect(index.resolve("/ws/.dev/artifacts/jar/app/app.jar")).toEqual({ project: "logstat", name: "app" });
  });

  test("libraries in the shared repository, and an artifact directory holding no named output, are told apart", () => {
    expect(index.resolve("/ws/cli/../.dev/dependencies/m2/com/google/guava/guava/33.4.8-jre/guava-33.4.8-jre.jar")).toBeUndefined();
    expect(index.resolve("/ws/model/.dev/artifacts/jar")).toEqual({ project: "model" });
    expect(index.resolve("/elsewhere/model/.dev/artifacts/jar/model/model.jar")).toBeUndefined();
  });
});

describe("source sets behind an artifact", () => {
  const model = decodeManifest(fixture("model"));
  const fat = manifestWith({
    sources: { main: { paths: ["src/**"] }, extra: { paths: ["extra/**"] }, test: { paths: ["test/**"] } },
    artifacts: {
      slim: { "@type": "elide.jvm.Jar" },
      fat: { "@type": "elide.jvm.Jar", name: "app-all", sources: ["main", "extra", "undeclared"] },
    },
  });

  test("a reference naming no artifact resolves against the one JAR a project declares", () => {
    expect(referencedSourceSets(model, undefined)).toEqual(["main"]);
    expect(referencedSourceSets(fat, undefined)).toEqual([]);
  });

  test("a named reference resolves by key; a JAR naming no source set packages the default one", () => {
    expect(referencedSourceSets(fat, "fat")).toEqual(["main", "extra"]);
    expect(referencedSourceSets(fat, "slim")).toEqual(["main"]);
    expect(referencedSourceSets(fat, "app-all")).toEqual([]);
  });

  test("a classpath entry resolves by the output name the JAR is written under", () => {
    expect(sourceSetsForArtifactOutput(fat, "app-all")).toEqual(["main", "extra"]);
    expect(sourceSetsForArtifactOutput(fat, "slim")).toEqual(["main"]);
    expect(sourceSetsForArtifactOutput(fat, "fat")).toEqual([]);
    expect(sourceSetsForArtifactOutput(model, undefined)).toEqual(["main"]);
  });
});

/** A root manifest as the workspace sample writes it: the members listed one per line, with a comment among them. */
const ROOT_MANIFEST = `amends "elide:project.pkl"

name = "logstat"

// The root declares its members explicitly.
workspace {
  members {
    "model"
    // "retired" was dropped
    "cli"
  }
}

dependencies {
  maven {
    packages {
      "com.google.guava:guava:33.4.8-jre"
    }
  }
}
`;

describe("workspace members declared in manifest text", () => {
  test("the members a root declares, without what comments or other blocks hold", () => {
    expect(parseWorkspaceMembers(ROOT_MANIFEST)).toEqual(["model", "cli"]);
    expect(parseWorkspaceMembers(`workspace { members { "a" "b" } }\n`)).toEqual(["a", "b"]);
    expect(parseWorkspaceMembers(`name = "app"\nsources { ["main"] = new Sources.SourceSetSpec { paths { "src/**" } } }\n`)).toEqual([]);
    expect(parseWorkspaceMembers(`workspace {\n  strict = true\n}\n`)).toEqual([]);
    expect(parseWorkspaceMembers(`workspace {\n  members = new Listing {\n    "a"\n  }\n}\n`)).toEqual(["a"]);
  });

  test("a new member joins the block, indented like the ones already there", () => {
    const updated = withWorkspaceMember(ROOT_MANIFEST, "parser");
    expect(parseWorkspaceMembers(updated)).toEqual(["model", "cli", "parser"]);
    expect(updated).toContain(`    "cli"\n    "parser"\n  }`);
    expect(withWorkspaceMember(updated, "parser")).toBe(updated);
  });

  test("a manifest declaring no workspace gets one; a one-line block keeps its shape", () => {
    const standalone = `amends "elide:project.pkl"\n\nname = "app"\n`;
    const rooted = withWorkspaceMember(standalone, "core");
    expect(rooted).toBe(`${standalone}\nworkspace {\n  members {\n    "core"\n  }\n}\n`);
    expect(parseWorkspaceMembers(rooted)).toEqual(["core"]);
    expect(withWorkspaceMember(`workspace { members { "a" } }\n`, "b")).toBe(`workspace { members { "a" "b" } }\n`);
    expect(withWorkspaceMember(`workspace {\n  strict = true\n}\n`, "core")).toBe(`workspace {\n  members {\n    "core"\n  }\n  strict = true\n}\n`);
  });
});

describe("findEnclosingWorkspace", () => {
  const manifests: Record<string, string> = {
    "/ws/elide.pkl": ROOT_MANIFEST,
    "/ws/cli/elide.pkl": `name = "cli"\n`,
    "/ws/cli/vendored/elide.pkl": `name = "vendored"\n`,
  };
  const read = (file: string): string | undefined => manifests[normalizePath(file)];

  test("the root declaring the directory, however far up it is", () => {
    expect(findEnclosingWorkspace("/ws/cli", read)).toEqual({ root: "/ws", member: "cli" });
  });

  test("a directory no manifest above it declares belongs to no workspace", () => {
    expect(findEnclosingWorkspace("/ws/cli/vendored", read)).toBeUndefined();
    expect(findEnclosingWorkspace("/ws", read)).toBeUndefined();
  });
});

/**
 * A stand-in for the CLI: answers `manifest` and `classpath` from files in the directory it is invoked in, the way
 * the real one answers for the project it is focused on, and records every `install` in the workspace root.
 */
const FAKE_ELIDE = `#!/bin/sh
case "$1" in
  --version) echo "1.5.4+test" ;;
  manifest) cat .fake/manifest.json ;;
  classpath) cat ".fake/classpath-\${2%%:*}.txt" ;;
  install) echo "$PWD" >> "$FAKE_INSTALL_LOG" ;;
esac
`;

describe("buildProjectModels", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The workspace sample, trimmed to `model` and `cli`: `cli` consumes `parser` in the sample, which is left out here,
   * so its classpath names `model` directly, the way it does when `model` arrives through a sibling.
   */
  const workspace = () => {
    const home = realpathSync(mkdtempSync(path.join(tmpdir(), "elide-home-")));
    const ws = realpathSync(mkdtempSync(path.join(tmpdir(), "elide-ws-")));
    dirs.push(home, ws);
    mkdirSync(path.join(home, "bin"));
    writeFileSync(path.join(home, "bin", "elide"), FAKE_ELIDE);
    chmodSync(path.join(home, "bin", "elide"), 0o755);

    const m2 = (coordinate: string) => {
      const [group, artifact, version] = coordinate.split(":") as [string, string, string];
      return `${ws}/.dev/dependencies/m2/${group.replace(/\./g, "/")}/${artifact}/${version}/${artifact}-${version}.jar`;
    };
    const stdlib = m2("org.jetbrains.kotlin:kotlin-stdlib:2.4.20");
    const junit = m2("org.junit.jupiter:junit-jupiter-api:6.1.3");
    const project = (dir: string, manifest: object, classpaths: Record<string, string[]>) => {
      mkdirSync(path.join(dir, ".fake"), { recursive: true });
      writeFileSync(path.join(dir, "elide.pkl"), "");
      writeFileSync(path.join(dir, ".fake", "manifest.json"), JSON.stringify(manifest));
      for (const [set, entries] of Object.entries(classpaths)) writeFileSync(path.join(dir, ".fake", `classpath-${set}.txt`), entries.join(":"));
    };
    const root = JSON.parse(fixture("root"));
    root.workspace.members = ["model", "cli"];
    project(ws, root, { main: [stdlib], test: [junit] });
    project(path.join(ws, "model"), JSON.parse(fixture("model")), { main: [stdlib], test: [junit] });
    const modelJar = `${ws}/cli/../model/.dev/artifacts/jar/model/model.jar`;
    const cli = JSON.parse(fixture("cli"));
    cli.dependencies.maven.packages = [{ "@type": "elide.jvm.MavenPackageDependency.OfProjectArtifact", value: { project: "model" } }];
    project(path.join(ws, "cli"), cli, { main: [modelJar, `${ws}/cli/../.dev/dependencies/m2/org/jetbrains/kotlin/kotlin-stdlib/2.4.20/kotlin-stdlib-2.4.20.jar`], test: [modelJar, junit] });

    const installs = path.join(ws, "installs.log");
    process.env.FAKE_INSTALL_LOG = installs;
    const cliAtRoot = new ElideCli(distributionAt(home), ws);
    const installedIn = (): string[] => {
      try {
        return readFileSync(installs, "utf8").trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    };
    return { ws, cliAtRoot, installedIn, stdlib };
  };

  const build = async (cli: ElideCli): Promise<ProjectModel[]> =>
    buildProjectModels(cli, await cli.manifest(), { jdk: { override: "/nonexistent" }, exists: () => false });

  test("the root first, then its members, each resolved in its own directory", async () => {
    const { ws, cliAtRoot } = workspace();
    const models = await build(cliAtRoot);
    expect(models.map((m) => [m.name, m.root])).toEqual([
      ["logstat", ws],
      ["model", `${ws}/model`],
      ["cli", `${ws}/cli`],
    ]);
    expect(models[0]!.members).toEqual([`${ws}/model`, `${ws}/cli`]);
    expect(models[0]!.workspaceRoot).toBeUndefined();
    expect(models.slice(1).map((m) => [m.workspaceRoot, m.members])).toEqual([
      [ws, []],
      [ws, []],
    ]);
    expect(models[2]!.modules.map((m) => m.name)).toEqual(["cli.main", "cli.test"]);
  });

  test("one install at the root covers the workspace", async () => {
    const { ws, cliAtRoot, installedIn } = workspace();
    await build(cliAtRoot);
    expect(installedIn()).toEqual([ws]);
  });

  test("a member manifest newer than the root's lockfile needs an install; one older does not", async () => {
    const { ws, cliAtRoot, installedIn } = workspace();
    mkdirSync(path.join(ws, ".dev", "dependencies"), { recursive: true });
    const lock = path.join(ws, ".dev", "elide.lock.v2.bin");
    writeFileSync(lock, "lock");
    const past = new Date(Date.now() - 60_000);
    for (const dir of [ws, `${ws}/model`, `${ws}/cli`]) utimesSync(path.join(dir, "elide.pkl"), past, past);
    await build(cliAtRoot);
    expect(installedIn()).toEqual([]);

    const future = new Date(Date.now() + 60_000);
    utimesSync(path.join(ws, "cli", "elide.pkl"), future, future);
    await build(cliAtRoot);
    expect(installedIn()).toEqual([ws]);
  });

  test("a sibling's JAR becomes an exported dependency on the modules packaged into it, never a library", async () => {
    const { ws, cliAtRoot } = workspace();
    const [, model, cli] = await build(cliAtRoot);
    const main = cli!.modules.find((m) => m.sourceSet === "main")!;
    const tests = cli!.modules.find((m) => m.sourceSet === "test")!;
    expect(main.moduleDeps).toEqual([{ project: `${ws}/model`, module: "model.main", scope: "compile", exported: true }]);
    expect(tests.moduleDeps).toEqual([
      { project: `${ws}/cli`, module: "cli.main", scope: "compile", exported: false },
      { project: `${ws}/model`, module: "model.main", scope: "test", exported: true },
    ]);
    expect(cli!.libraries.map((l) => l.classes).filter((c) => c.includes("/.dev/artifacts/"))).toEqual([]);
    // A project's own test module never depends on another project's test module.
    expect(model!.modules.flatMap((m) => m.moduleDeps).every((d) => d.project === `${ws}/model`)).toBe(true);
  });

  test("the workspace names every library once, whichever member resolved it", async () => {
    const { cliAtRoot, stdlib } = workspace();
    const models = await build(cliAtRoot);
    const named = models.flatMap((m) => m.libraries.filter((l) => l.classes === stdlib).map((l) => l.name));
    expect(new Set(named)).toEqual(new Set(["Elide: org.jetbrains.kotlin:kotlin-stdlib:2.4.20"]));
    expect(models[2]!.libraries.map((l) => l.classes)).toContain(stdlib);
  });

  test("a reference to a project the workspace does not hold is a warning, not a dependency", async () => {
    const { ws, cliAtRoot } = workspace();
    const cli = JSON.parse(readFileSync(path.join(ws, "cli", ".fake", "manifest.json"), "utf8"));
    cli.dependencies.maven.packages.push({ "@type": "elide.jvm.MavenPackageDependency.OfProjectArtifact", value: { project: "ghost" } });
    writeFileSync(path.join(ws, "cli", ".fake", "manifest.json"), JSON.stringify(cli));
    const [, , model] = await build(cliAtRoot);
    expect(model!.warnings).toContain("References unknown workspace project 'ghost'.");
  });

  test("a standalone project is a workspace of one", async () => {
    const { ws, cliAtRoot } = workspace();
    const manifest = JSON.parse(readFileSync(path.join(ws, ".fake", "manifest.json"), "utf8"));
    delete manifest.workspace;
    writeFileSync(path.join(ws, ".fake", "manifest.json"), JSON.stringify(manifest));
    const models = await build(cliAtRoot);
    expect(models).toHaveLength(1);
    expect(models[0]!.members).toEqual([]);
    expect(models[0]!.workspaceRoot).toBeUndefined();
  });

  test("a member resolved on its own reports the sibling artifact it cannot resolve, and never names it a library", async () => {
    const { ws, cliAtRoot } = workspace();
    const [model] = await build(new ElideCli(cliAtRoot.dist, path.join(ws, "cli")));
    expect(model!.libraries.map((l) => l.classes).filter((c) => c.includes("/.dev/artifacts/"))).toEqual([]);
    expect(model!.warnings).toContain(
      `Classpath names an artifact built by ${ws}/model, which is not part of this project's workspace; its sources cannot be resolved.`,
    );
  });
});
