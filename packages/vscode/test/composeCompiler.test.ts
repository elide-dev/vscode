import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposeCompiler, firstCompilerError } from "../src/composeCompiler.js";
import { StaleBuildRecordError } from "../src/composeProcessing.js";

/** A built Kotlin source set with kapt, its records written with the paths under `recorded` as Elide writes them. */
async function project(root: string, recorded = root) {
  const at = (base: string) => ({
    parent: path.join(base, ".dev/jvm/classes/main"),
    kotlin: path.join(base, ".dev/jvm/classes/main/kotlin"),
    generated: path.join(base, ".dev/jvm/generated-sources/main/kapt"),
    source: path.join(base, "src/Example.kt"),
    impl: path.join(base, ".dev/jvm/generated-sources/main/kapt/Example_Impl.java"),
  });
  const files = at(root);
  const record = at(recorded);
  await Promise.all([files.kotlin, files.generated, path.dirname(files.source)].map((directory) => mkdir(directory, { recursive: true })));
  await Promise.all([
    writeFile(files.source, "class Example"), writeFile(files.impl, "class Example_Impl {}"),
    writeFile(path.join(files.parent, "kotlinc.args"), ["-d", record.kotlin, record.source, record.impl].join("\n")),
    writeFile(path.join(files.parent, "kapt.args"), ["-d", record.kotlin, record.source].join("\n")),
    writeFile(path.join(files.parent, "kotlinc.toolchain.json"), JSON.stringify({ version: 1, kind: "managed", classpath: [path.join(root, "compiler.jar")] })),
    writeFile(path.join(files.parent, "kapt.generated.json"), JSON.stringify({ version: 1, roots: [record.generated], files: [record.impl] })),
  ]);
  return files;
}

function inputs(kotlin: string) {
  return { projectClassPath: [kotlin], classPath: [kotlin], namespace: "sample", resourceApkPath: "resources.apk", sourceSelections: { [kotlin]: ["src/**.*"] } };
}

describe("Compose compiler setup", () => {
  test("failed input discovery removes each private compiler directory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "elide-compose-compiler-test-"));
    try {
      for (const output of [path.join(directory, "unknown-output"), path.join(directory, ".dev", "jvm", "classes", "main", "kotlin")]) {
        const workspace = path.join(directory, "workspace");
        const inputs = { classPath: [], projectClassPath: [output], sourceSelections: {}, namespace: "sample", resourceApkPath: "resources.apk" };
        await expect(ComposeCompiler.create("elide", directory, inputs, workspace, new AbortController().signal, new Map())).rejects.toThrow("Compose preview");
        expect(await readdir(workspace)).toEqual([]);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a workspace opened through a symlink owns the canonical paths Elide records", async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "elide-compose-symlink-")));
    let compiler: ComposeCompiler | undefined;
    try {
      const canonical = path.join(directory, "checkout");
      const opened = path.join(directory, "opened");
      await mkdir(canonical);
      await symlink(canonical, opened, "dir");
      const files = await project(opened, canonical);
      compiler = await ComposeCompiler.create("elide", opened, inputs(files.kotlin), path.join(directory, "private"), new AbortController().signal, new Map());
      const edited = await compiler.sources(new Map([[files.source, "class Example(val edited: Int)"]]));
      expect([...edited.files[0]!]).toEqual([[files.source, "class Example(val edited: Int)"]]);
      expect(compiler.supports(files.source)).toBe(true);
      expect(await compiler.seed(await compiler.sources(new Map()), true)).toBe(true);
    } finally {
      compiler?.dispose();
      await compiler?.remove();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("records of another checkout are stale, not missing files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "elide-compose-stale-"));
    try {
      const checkout = path.join(directory, "checkout");
      const other = path.join(directory, "deleted-checkout");
      const files = await project(checkout, other);
      await expect(ComposeCompiler.create("elide", checkout, inputs(files.kotlin), path.join(directory, "private"), new AbortController().signal, new Map()))
        .rejects.toThrow(new StaleBuildRecordError(path.join(files.parent, "kotlinc.args"), `it compiles into ${path.join(other, ".dev/jvm/classes/main/kotlin")}, not this checkout's ${files.kotlin}`));
      // Only the generated-source provenance came from the other checkout.
      await writeFile(path.join(files.parent, "kotlinc.args"), ["-d", files.kotlin, files.source].join("\n"));
      await writeFile(path.join(files.parent, "kapt.args"), ["-d", files.kotlin, files.source].join("\n"));
      await expect(ComposeCompiler.create("elide", checkout, inputs(files.kotlin), path.join(directory, "private"), new AbortController().signal, new Map()))
        .rejects.toThrow(/^Stale build record .*kapt\.generated\.json: its generated sources are in .*deleted-checkout.*--no-cache/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("renderers load the build's classes until the compiler publishes its own copy", async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "elide-compose-current-")));
    let compiler: ComposeCompiler | undefined;
    try {
      const files = await project(path.join(directory, "checkout"));
      compiler = await ComposeCompiler.create("elide", path.join(directory, "checkout"), inputs(files.kotlin), path.join(directory, "private"), new AbortController().signal, new Map());
      // An unsaved edit keeps the build's classes from being adopted: nothing is published, and the copies are empty.
      expect(await compiler.seed(await compiler.sources(new Map([[files.source, "class Example(val edited: Int)"]])), true)).toBe(false);
      expect(compiler.currentInputs.projectClassPath).toEqual([files.kotlin]);
      expect(compiler.currentInputs.classPath).toEqual([files.kotlin]);
      expect(await compiler.seed(await compiler.sources(new Map()), true)).toBe(true);
      await compiler.publish();
      expect(compiler.currentInputs).toEqual(compiler.inputs);
      expect(compiler.currentInputs.projectClassPath.every((entry) => entry.startsWith(path.join(directory, "private")))).toBe(true);
    } finally {
      compiler?.dispose();
      await compiler?.remove();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("the status line names the first compiler error and its location, never a warning or note", () => {
    expect(firstCompilerError([
      "kotlinc failed for /work/ui (main, exit 1).",
      "kotlinc: -Xplugin '/opt/kotlin/lib/kotlin-compose-compiler-plugin.jar' matches the bundled 'compose' plugin. Prefer Elide's flag (`--compose` or `--plugins=compose`).",
      "warning: kotlinc: Parameter 'x' is never used.",
      "In file: /work/ui/src/Other.kt:3:9",
      "error: kotlinc: Unresolved reference 'missing'.",
      "In file: /work/ui/src/main/kotlin/Cards.kt:12:5",
      "   12 |     missing()",
      "error: kotlinc: Second error.",
    ].join("\n"))).toBe("Cards.kt:12 Unresolved reference 'missing'.");
    expect(firstCompilerError("Build failed after 2.1s: elide build exited with 1.\nerror: kotlinc: Type mismatch.\n  In file: src/Cards.kt:4:3\nOpen the Build log for the complete output."))
      .toBe("Cards.kt:4 Type mismatch.");
    expect(firstCompilerError("javac failed for /work/app (main, exit 1).\n/work/app/src/Main.java:7: error: cannot find symbol")).toBe("Main.java:7 cannot find symbol");
    expect(firstCompilerError("kapt failed for /work/app (main, exit 1).\nerror: kapt: Room cannot verify the data integrity.")).toBe("Room cannot verify the data integrity.");
    expect(firstCompilerError("Elide kotlinc worker exited (1).\nwarning: kotlinc: deprecated flag")).toBeUndefined();
  });
});
