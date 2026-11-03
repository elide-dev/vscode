import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposeCompiler } from "../src/composeCompiler.js";
import { ComposeProcessing, decodeProcessorOptions, encodeProcessorOptions, stubFingerprint } from "../src/composeProcessing.js";
import { WorkspacePaths } from "../src/workspacePaths.js";

describe("Compose annotation processing inputs", () => {
  test("generated source editors and later build writes cannot replace frozen processing inputs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "elide-compose-provenance-"));
    let compiler: ComposeCompiler | undefined;
    try {
      const parent = path.join(root, ".dev/jvm/classes/main");
      const kotlin = path.join(parent, "kotlin");
      const java = path.join(parent, "java");
      const generated = path.join(root, ".dev/jvm/generated-sources/main/kapt");
      const source = path.join(root, "src/Example.kt");
      const impl = path.join(generated, "Example_Impl.java");
      const stubs = path.join(root, ".dev/jvm/kapt-stubs/main");
      await Promise.all([kotlin, java, generated, stubs, path.dirname(source)].map((directory) => mkdir(directory, { recursive: true })));
      await Promise.all([
        writeFile(source, "class Example"), writeFile(impl, "class Example_Impl {}"),
        writeFile(path.join(parent, "kotlinc.args"), ["-d", kotlin, source, impl].join("\n")),
        writeFile(path.join(parent, "javac.args"), ["-d", java, "-proc:none", impl].join("\n")),
        writeFile(path.join(parent, "kapt.args"), ["-d", kotlin, source, "-P", `plugin:org.jetbrains.kotlin.kapt3:stubs=${stubs}`].join("\n")),
        writeFile(path.join(parent, "kotlinc.toolchain.json"), JSON.stringify({ version: 1, kind: "managed", classpath: [path.join(root, "compiler.jar")] })),
        writeFile(path.join(parent, "kapt.generated.json"), JSON.stringify({ version: 1, roots: [generated, kotlin], files: [impl] })),
      ]);
      compiler = await ComposeCompiler.create("elide", root, {
        projectClassPath: [kotlin, java], classPath: [kotlin, java], namespace: "sample", resourceApkPath: "resources.apk",
        sourceSelections: { [kotlin]: ["src/**.*"], [java]: ["src/**.*"] },
      }, path.join(root, "private"), new AbortController().signal, new Map());
      const before = await compiler.sources(new Map());
      await writeFile(impl, "class WrongBuildGeneration {}");
      const generatedEdit = await compiler.sources(new Map([[impl, "class UnsavedGeneratedEdit {}"]]));
      expect(generatedEdit.key).toBe(before.key);
      expect(compiler.supports(source)).toBe(true);
      expect(compiler.supports(impl)).toBe(false);
      const edited = await compiler.sources(new Map([[source, "class Example(val value: Int)"]]));
      expect(edited.key).not.toBe(before.key);
      expect(edited.files.some((files) => files.get(source) === "class Example(val value: Int)")).toBe(true);
      expect(compiler.isVerified(edited.key)).toBe(false);
    } finally {
      compiler?.dispose();
      await compiler?.remove();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stub declaration annotations and removals invalidate processing, diagnostic offsets do not", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "elide-compose-stubs-"));
    try {
      const file = path.join(directory, "Dao.java");
      const declaration = '@Query("SELECT * FROM journeys") public java.util.List<Journey> journeys();';
      await writeFile(file, declaration);
      await writeFile(path.join(directory, "Dao.kapt_metadata"), "positions:1,2");
      const baseline = await stubFingerprint(directory);
      await writeFile(path.join(directory, "Dao.kapt_metadata"), "positions:1,200");
      expect(await stubFingerprint(directory)).toBe(baseline);
      await writeFile(file, declaration.replace("SELECT *", "SELECT missing_column"));
      expect(await stubFingerprint(directory)).not.toBe(baseline);
      await rm(file);
      expect(await stubFingerprint(directory)).not.toBe(baseline);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("kapt options preserve Java modified UTF and long block data when private paths are substituted", () => {
    const options = new Map([["room.schemaLocation", "/tmp/schema"], ["unicode", "nul\0 astral \ud83d\ude80"], ["long", "x".repeat(2_000)]]);
    const encoded = encodeProcessorOptions(options);
    const decoded = decodeProcessorOptions(encoded);
    expect(decoded).toEqual(options);
    decoded.set("room.schemaLocation", "/private/schema");
    expect(decodeProcessorOptions(encodeProcessorOptions(decoded))).toEqual(new Map([...options, ["room.schemaLocation", "/private/schema"]]));
    expect(() => decodeProcessorOptions("AAAAAA==")).toThrow("Invalid kapt");
  });
  test("processing confirms a fresh baseline and commits source-output resources only after success", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "elide-compose-processing-"));
    try {
      const generated = path.join(root, "build-sources");
      const classes = path.join(root, "build-classes");
      const stubs = path.join(root, "build-stubs");
      await Promise.all([generated, classes, stubs].map((directory) => mkdir(directory, { recursive: true })));
      const source = path.join(generated, "Generated.java");
      await writeFile(source, "class Generated {}");
      await writeFile(path.join(stubs, "Input.java"), "class Input {}");
      const args = ["-d", classes, ...Object.entries({
        aptMode: "stubsAndApt", sources: generated, stubs, classes,
        dumpFileReadHistory: path.join(root, "build-read-history"),
      }).flatMap(([key, value]) => ["-P", `plugin:org.jetbrains.kotlin.kapt3:${key}=${value}`])];
      await writeFile(path.join(root, "kapt.args"), args.join("\n"));
      await writeFile(path.join(root, "kapt.generated.json"), JSON.stringify({ version: 1, roots: [generated, classes], files: [source] }));
      const stage = (await ComposeProcessing.create(path.join(root, "kapt.args"), path.join(root, "private"), root, await WorkspacePaths.of([root])))!;
      let declaration = "class Input {}";
      let fail = false;
      let emitResource = true;
      let generatedText = "class Generated { int version; }";
      let resource = "new-schema";
      let emitSource = true;
      const run = async (invocation: string[]) => {
        const options = Object.fromEntries(invocation.filter((arg) => arg.startsWith("plugin:org.jetbrains.kotlin.kapt3:")).map((arg) => {
          const value = arg.slice("plugin:org.jetbrains.kotlin.kapt3:".length);
          const equals = value.indexOf("=");
          return [value.slice(0, equals), value.slice(equals + 1)];
        }));
        await writeFile(path.join(options.stubs!, "Input.java"), declaration);
        if (options.aptMode !== "apt") return;
        await writeFile(options.dumpFileReadHistory!, "private diagnostic output");
        if (emitSource) await writeFile(path.join(options.sources!, "Generated.java"), generatedText);
        if (emitResource) await writeFile(path.join(options.sources!, "schema.json"), resource);
        if (fail) throw new Error("processor failed after writing outputs");
      };
      expect(await stage.verify(args, "current-inputs", run)).toBe(true);
      expect(await readFile(path.join(stage.classes, "schema.json"), "utf8")).toBe("new-schema");
      expect(await readFile(source, "utf8")).toBe("class Generated {}");
      await expect(readFile(path.join(root, "build-read-history"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await stage.verify(args, "current-inputs", run)).toBe(false);
      declaration = "class Input { int added; }";
      expect(await stage.verify(args, "current-inputs", run)).toBe(false);
      expect(stage.counts.apt).toBe(2);
      expect(await stage.verify(args, "current-inputs", run)).toBe(false);
      expect(stage.counts.apt).toBe(2);
      expect(await stage.verify(args, "changed-classpath", run)).toBe(false);
      expect(stage.counts.apt).toBe(3);
      declaration = "class Input { int added; int changedAgain; }";
      fail = true;
      emitResource = false;
      await expect(stage.verify(args, "current-inputs", run)).rejects.toThrow("processor failed");
      expect(await readFile(path.join(stage.classes, "schema.json"), "utf8")).toBe("new-schema");
      fail = false;
      expect(await stage.verify(args, "current-inputs", run)).toBe(true);
      await expect(readFile(path.join(stage.classes, "schema.json"))).rejects.toMatchObject({ code: "ENOENT" });
      generatedText = "class Generated { String version; }";
      expect(await stage.verify(args, "source-change", run)).toBe(true);
      expect(stage.generated.get(source)).toBe(generatedText);
      emitResource = true;
      expect(await stage.verify(args, "resource-added", run)).toBe(true);
      resource = "changed-schema";
      expect(await stage.verify(args, "resource-changed", run)).toBe(true);
      expect(await readFile(path.join(stage.classes, "schema.json"), "utf8")).toBe(resource);
      emitSource = false;
      expect(await stage.verify(args, "source-removed", run)).toBe(true);
      expect(stage.generated.has(source)).toBe(false);
      expect(await stage.verify(args, "unchanged-empty-sources", run)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
