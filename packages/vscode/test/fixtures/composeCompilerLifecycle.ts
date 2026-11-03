import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock } from "bun:test";

import type { ComposeWorker } from "../../src/composeWorker.js";
const scenario = process.argv[2];
// Elide records canonical paths; the bundled plugins are recognized under the canonical distribution.
const root = await realpath(await mkdtemp(path.join(tmpdir(), "elide-compose-compiler-lifecycle-")));
const calls: { cwd: string; args: string[] }[] = [];
const starts: string[] = [];
mock.module("../../src/composeWorker.js", () => ({ ComposeWorker: class {
  alive = true;
  constructor(_bin: string, _tool: string, readonly cwd: string) { starts.push(cwd); }
  async request(args: string[]) {
    calls.push({ cwd: this.cwd, args });
    const output = args[args.indexOf("-d") + 1]!;
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, "Preview.class"), "instrumented");
    const abi = args.find((arg) => arg.startsWith("--report-abi="));
    if (abi) await writeFile(abi.slice("--report-abi=".length), "abi");
    return { exitCode: 0, output: "" };
  }
  dispose() { this.alive = false; }
} }));
// Register the process-boundary replacement before loading the real compiler module.
const { ComposeCompiler } = await import("../../src/composeCompiler.js");
const compilers: { dispose(): void; remove(): Promise<void> }[] = [];
try {
  const bundled = scenario === "bundled-plugins" || scenario === "rebase";
  const bin = bundled ? path.join(root, "dist", "bin", "elide") : "elide";
  const pluginDirectory = path.join(root, "dist", "lib", "resources", "kotlin", "2.5.0-Beta1", "lib");
  const plugin = bundled ? path.join(pluginDirectory, "kotlin-compose-compiler-plugin.jar") : path.join(root, "kotlin-compose-compiler-plugin-embeddable-2.2.21.jar");
  const custom = path.join(root, "custom-plugin.jar");
  await mkdir(path.dirname(plugin), { recursive: true });
  await writeFile(plugin, "compose plugin");
  await writeFile(custom, "custom plugin");
  const outputs = ["library", "app"].map((project) => path.join(root, project, ".dev", "jvm", "classes", "main", "kotlin"));
  const rClasses = path.join(root, "app", ".dev", "android", "app", "r");
  const resources = path.join(root, "app", ".dev", "android", "app", "resources.apk");
  await mkdir(rClasses, { recursive: true });
  await writeFile(path.join(rClasses, "R.class"), "ids v1");
  await writeFile(resources, "resources v1");
  const files: string[] = [];
  const records: string[] = [];
  const record = async (index: number, extra: string[] = []) => {
    const output = outputs[index]!;
    const source = files[index]!;
    const plugins = !index && scenario === "custom-plugin" ? [`-Xplugin=${custom}`]
      : !index && bundled ? [`-Xplugin=${path.join(pluginDirectory, "kotlin-serialization-compiler-plugin.jar")}`] : [];
    const args = ["-jvm-target", "17", `-Xplugin=${plugin}`, "-P", "plugin:androidx.compose.compiler.plugins.kotlin:sourceInformation=false",
      ...(index ? ["-classpath", [outputs[0]!, rClasses].join(path.delimiter)] : []), ...plugins, ...extra, "-d", output, source];
    records[index] = args.join("\n") + "\n";
    await writeFile(path.join(path.dirname(output), "kotlinc.args"), records[index]!);
    await writeFile(path.join(path.dirname(output), "kotlinc.toolchain.json"),
      JSON.stringify(bundled ? { version: 1, kind: "embedded" } : { version: 1, kind: "managed", classpath: [plugin] }));
  };
  for (const [index, output] of outputs.entries()) {
    const project = path.join(root, index ? "app" : "library");
    const source = path.join(project, "src", "Gallery.kt");
    files.push(source);
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, `package ${index ? "app" : "library"}\nfun Gallery() = Unit\n`);
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, "Preview.class"), "build");
    await record(index);
  }
  const workers = new Map<string, ComposeWorker>();
  const create = async () => {
    const compiler = await ComposeCompiler.create(bin, path.join(root, "app"), {
      classPath: [...outputs, rClasses], projectClassPath: outputs, sourceSelections: Object.fromEntries(outputs.map((output) => [output, ["src/**/*.kt"]])),
      namespace: "app", resourceApkPath: resources,
    }, path.join(root, "private"), new AbortController().signal, workers);
    compilers.push(compiler);
    return compiler;
  };
  const compiler = await create();
  const sources = await compiler.sources(new Map());
  assert.equal(await compiler.seed(sources, true), true);
  await compiler.publish();
  assert.equal(compiler.publishedInstrumented, false);
  assert.equal(compiler.needsWarmup, true);
  assert.equal(calls.length, 0, "saved build outputs paint without invoking the compiler");
  await compiler.update(sources, true);
  assert.equal(compiler.publishedInstrumented, false, "private compile cannot relabel the published build classes");
  await compiler.publish();
  assert.equal(compiler.publishedInstrumented, true);
  assert.equal(compiler.needsWarmup, false);
  assert.equal(calls.length, 2, "initialize app and workspace library once each");
  assert.equal(starts.length, scenario === "custom-plugin" ? 2 : 1,
    "managed and Elide-bundled Compose share their JVM, as do Elide's other bundled plugins; custom plugins retain project cwd");
  assert.ok(calls.every(({ args }) => args.includes("--warm-incremental") && args.includes("plugin:androidx.compose.compiler.plugins.kotlin:sourceInformation=true")));
  assert.ok(calls.every(({ args }) => !args.includes("plugin:androidx.compose.compiler.plugins.kotlin:sourceInformation=false")));
  if (scenario === "rebase") {
    // Relinked resources with unchanged identifiers: the warm compiler takes the new inputs and compiles nothing.
    const fingerprint = compiler.fingerprint;
    const published = compiler.inputs.projectClassPath;
    await writeFile(resources, "resources v2");
    const relinked = await create();
    assert.equal(compiler.sameBuild(relinked), false);
    assert.equal(compiler.rebase(relinked), true, "a resource-only build keeps the compiler");
    assert.equal(compiler.fingerprint, relinked.fingerprint);
    assert.notEqual(compiler.fingerprint, fingerprint, "stored galleries of the old resources stay apart");
    assert.equal(compiler.ready, true, "unchanged classes stay published");
    assert.equal(compiler.needsWarmup, false, "no cold initialization");
    await compiler.update(await compiler.sources(new Map()));
    assert.equal(calls.length, 2, "nothing recompiles");
    // New resource identifiers change the app's R classes: only the app recompiles, incrementally, against them.
    await writeFile(path.join(rClasses, "R.class"), "ids v2");
    const regenerated = await create();
    assert.equal(compiler.rebase(regenerated), true, "an R class change keeps the compiler");
    assert.equal(compiler.ready, false, "classes compiled against the old identifiers are not rendered");
    assert.equal(compiler.needsWarmup, false);
    assert.deepEqual(compiler.inputs.projectClassPath, published, "render inputs name this compiler's own classes, not the discarded candidate's");
    await compiler.update(await compiler.sources(new Map()));
    await compiler.publish();
    assert.equal(calls.length, 3, "only the app recompiles");
    assert.equal(calls[2]!.args.includes("--warm-incremental"), false, "incrementally");
    const classPath = calls[2]!.args[calls[2]!.args.indexOf("-classpath") + 1]!.split(path.delimiter);
    const mirrored = classPath.find((entry) => entry.startsWith(path.join(root, "private", "mirror")));
    assert.equal(mirrored && await readFile(path.join(mirrored, "R.class"), "utf8"), "ids v2", "against the new R classes");
    // A changed compiler record is another compilation.
    await record(1, ["-opt-in=kotlin.RequiresOptIn"]);
    assert.equal(compiler.rebase(await create()), false, "changed records need a new compiler");
  } else if (scenario === "toolchain-switch") {
    const [previous] = workers.values();
    compiler.pruneWorkers();
    assert.equal(previous!.alive, true, "a compiler keeps the worker it compiles with");
    // A Kotlin upgrade: the managed toolchain's compiler jars change, and with them the worker.
    await writeFile(plugin, "compose plugin v2");
    const upgraded = await create();
    upgraded.pruneWorkers();
    assert.equal(previous!.alive, false, "the replaced toolchain's worker stops with its compiler");
    assert.equal(workers.size, 0);
    const sources = await upgraded.sources(new Map());
    assert.equal(await upgraded.seed(sources, true), true);
    await upgraded.update(sources, true);
    assert.equal(starts.length, 2, "the new toolchain starts its own worker");
    upgraded.pruneWorkers();
    assert.equal(workers.size, 1);
  } else {
    await compiler.update(await compiler.sources(new Map([[files[1]!, "package app\nfun Gallery() = Unit\n// edit\n"]])));
    assert.equal(calls.length, 3, "first edit only recompiles the changed app");
    assert.equal(calls[2]!.args.includes("--warm-incremental"), false, "first edit does not repeat cold incremental initialization");
  }
  for (const [index, output] of outputs.entries()) {
    assert.equal(await readFile(path.join(output, "Preview.class"), "utf8"), "build");
    assert.equal(await readFile(path.join(path.dirname(output), "kotlinc.args"), "utf8"), records[index]);
  }
  for (const worker of workers.values()) worker.dispose();
} finally {
  for (const compiler of compilers) {
    compiler.dispose();
    await compiler.remove();
  }
  await rm(root, { recursive: true, force: true });
}
