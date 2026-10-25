import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";
import { parseElideOutputLine, sourceSelection, type SourceSelection } from "@elide/ide-core";
import type { ComposeRenderInputs } from "./composeRender.js";
import { ComposeWorker } from "./composeWorker.js";
import { ComposeProcessing, StaleBuildRecordError, kotlinToolchain, toolchainOptions, type KotlinToolchainRecord } from "./composeProcessing.js";
import { WorkspacePaths, canonicalPath, inside } from "./workspacePaths.js";

type Tool = "kotlinc" | "javac";
interface Source {
  file: string;
  snapshot: string;
  content: string;
}
interface Unit {
  tool: Tool;
  project: string;
  toolchain: KotlinToolchainRecord;
  toolchainKey: string;
  processing?: ComposeProcessing;
  sourceSet: string;
  original: string;
  /** The build's compiler record (`kotlinc.args`/`javac.args`) for `original`. */
  record: string;
  /** Private compiler destination; never read by renderers. */
  output: string;
  /** Render-facing copy of `output`, replaced only between render generations. */
  published: string;
  /** `output` file → stat stamp, as last copied to `published`. */
  publishedFiles: Map<string, string>;
  directory: string;
  args: string[];
  roots: string[];
  selections: SourceSelection[];
  explicit: Set<string>;
  sources: Map<string, Source>;
  dependencies: Set<Unit>;
  dirty: boolean;
  /** `output` holds the build's classes for the current sources, not this compiler's. */
  seeded: boolean;
  /** This compiler primed the unit's incremental paths (`--warm-incremental`). */
  warmed: boolean;
  abiReport?: string;
  abiFingerprint?: string;
}

/** One consistent read of every unit's sources, editor text over disk, in unit order. */
export interface ComposeSources {
  readonly key: string;
  readonly documents: ReadonlyMap<string, string>;
  readonly files: readonly ReadonlyMap<string, string>[];
  readonly processingInputs: ReadonlyMap<ComposeProcessing, string>;
}

const classPathFlags: Record<string, true | undefined> = { "-classpath": true, "-cp": true, "--class-path": true, "--module-path": true, "-p": true, "-Xmodule-path": true };
const sourcePathFlags: Record<string, true | undefined> = { "-sourcepath": true, "--source-path": true, "-Xjava-source-roots": true };
const outputFlags: Record<string, true | undefined> = { "-d": true, "-s": true, "-h": true, "--emit-abi": true, "-Xdump-directory": true };
const sourceExtension = /\.(?:kt|java)$/;
const portableKotlinValues = new Set(["-api-version", "-language-version", "-jvm-target", "-module-name"]);
const portableKotlinSwitches = new Set(["-Xdisable-standard-script", "-no-stdlib", "-no-reflect", "-no-jdk", "-java-parameters", "-nowarn", "-Werror"]);

/** Elide ArgsRecord is argv, one unescaped argument per line, NOT a shell or Java @argfile. */
function recordedArguments(text: string): string[] {
  const args = text.split("\n");
  if (args.at(-1) === "") args.pop();
  return args;
}

/**
 * The first compiler error in `output` as one status line, `File.kt:12 message`. Elide prints a diagnostic as
 * `error: kotlinc: message` with its `In file: path:line:column` on the next line (indented in a quoted build
 * failure); javac's own format puts the location first. Notes and warnings, such as Elide's advice about recorded
 * `-Xplugin` arguments, never stand in for the error.
 */
export function firstCompilerError(output: string): string | undefined {
  const lines = output.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const parsed = parseElideOutputLine(line);
    if (parsed?.kind === "diagnostic" && parsed.severity === "error") {
      const message = parsed.message.replace(/^(?:kotlinc|javac|kapt):\s+/, "");
      const location = /^\s*In file:\s+(.+?):(\d+)(?::\d+)?\s*$/.exec(lines[index + 1] ?? "");
      return location ? `${path.basename(location[1]!)}:${location[2]} ${message}` : message;
    }
    const located = /^(.+\.(?:kt|java)):(\d+)(?::\d+)?:\s*error:\s*(.+)$/.exec(line);
    if (located) return `${path.basename(located[1]!)}:${located[2]} ${located[3]!.trim()}`;
  }
  return undefined;
}

/**
 * A record must compile into the output it sits beside, physically: Elide records canonical paths, which the
 * workspace may spell through a symlink. Anything else is another checkout's record.
 */
async function verifyDestination(record: string, args: readonly string[], project: string, original: string): Promise<void> {
  const index = args.findIndex((arg) => arg === "-d" || arg.startsWith("-d="));
  const destination = index < 0 ? undefined : args[index] === "-d" ? args[index + 1] : args[index]!.slice("-d=".length);
  if (destination === undefined) throw new Error(`The compiler record at ${record} has no -d destination for ${original}. Rebuild the Elide project.`);
  if (await canonicalPath(path.resolve(project, destination)) !== await canonicalPath(original)) {
    throw new StaleBuildRecordError(record, `it compiles into ${destination}, not this checkout's ${original}`);
  }
}

function splitOption(arg: string): { flag: string; value?: string } {
  const equals = arg.indexOf("=");
  return equals < 0 ? { flag: arg } : { flag: arg.slice(0, equals), value: arg.slice(equals + 1) };
}

function pathArguments(args: readonly string[]): string[] {
  const entries: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const option = splitOption(args[index]!);
    if (!classPathFlags[option.flag] && option.flag !== "-Xfriend-paths" && option.flag !== "--patch-module") continue;
    const value = option.value ?? args[++index];
    if (value === undefined) throw new Error(`Missing compiler argument after ${option.flag}.`);
    entries.push(...(option.flag === "--patch-module" ? patchModule(value).paths : value).split(option.flag === "-Xfriend-paths" ? "," : path.delimiter));
  }
  return entries;
}

function patchModule(value: string): { module: string; paths: string } {
  const equals = value.indexOf("=");
  if (equals <= 0) throw new Error(`Invalid --patch-module argument: ${value}`);
  return { module: value.slice(0, equals), paths: value.slice(equals + 1) };
}

async function walk(directory: string, accept: (file: string) => boolean): Promise<string[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return accept(directory) ? [directory] : [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(file, accept));
    } else if ((entry.isFile() || entry.isSymbolicLink()) && accept(file)) files.push(file);
  }
  return files;
}

/**
 * Only self-contained invocations may share a worker across project directories. `bundledKotlin` is the Kotlin
 * directory of the Elide distribution running the worker, whose compiler plugins (Compose, serialization, …) are its own.
 */
function portableKotlinArguments(args: readonly string[], toolchain: KotlinToolchainRecord, bundledKotlin: string | undefined): boolean {
  const homeIndex = args.indexOf("-kotlin-home");
  const kotlinHome = homeIndex < 0 ? undefined : args[homeIndex + 1];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (path.isAbsolute(arg)) continue; // Private source paths.
    const option = splitOption(arg);
    if (portableKotlinSwitches.has(option.flag) && option.value === undefined) continue;
    if (portableKotlinValues.has(option.flag)) {
      if (option.value === undefined && args[++index] === undefined) return false;
      continue;
    }
    if (option.flag === "-P" && (option.value ?? args[index + 1]) === "plugin:androidx.compose.compiler.plugins.kotlin:sourceInformation=true") {
      if (option.value === undefined) index++;
      continue;
    }
    if (option.flag === "-Xplugin") {
      const value = option.value ?? args[++index];
      // Custom plugins may read implicit cwd-relative configuration, even with an absolute jar.
      const externalCompose = kotlinHome && value === path.join(kotlinHome, "lib", "kotlin-compose-compiler-plugin.jar");
      const managedCompose = value && toolchain.kind === "managed" && toolchain.classpath?.includes(value)
        && /^kotlin-compose-compiler-plugin-embeddable-[\d.]+(?:-[\w.]+)?\.jar$/.test(path.basename(value));
      const bundled = value && bundledKotlin && inside(bundledKotlin, value) && /^kotlin-[\w-]+-compiler-plugin\.jar$/.test(path.basename(value));
      if (!externalCompose && !managedCompose && !bundled) return false;
      continue;
    }
    const paths = classPathFlags[option.flag] || sourcePathFlags[option.flag] || outputFlags[option.flag]
      || option.flag === "-kotlin-home" || option.flag === "-jdk-home" || option.flag === "-Xfriend-paths";
    if (!paths) return false;
    const value = option.value ?? args[++index];
    const delimiter = option.flag === "-Xfriend-paths" || option.flag === "-Xjava-source-roots" ? "," : path.delimiter;
    if (value === undefined || !value.split(delimiter).every((entry) => path.isAbsolute(entry))) return false;
  }
  return true;
}

/** What a build contributes to a compiler; a later build that only changed its content replaces it whole. */
interface BuildInputs {
  /** Renderer inputs; project classes resolve to the published copies. */
  inputs: ComposeRenderInputs;
  /** Renderer inputs over the build's own outputs (project classes and workspace archives as the build wrote them). */
  built: ComposeRenderInputs;
  /** Build path → this compiler's stand-ins: private outputs, content-addressed mirrors, extracted archive resources. */
  replacements: Map<string, string[]>;
  /** Everything a build contributes besides project classes: inputs, compiler records, resources, libraries. With a source key, determines the classes. */
  fingerprint: string;
  /** The parts of `fingerprint` that decide what is compiled and how: records, toolchains, input paths, archive resources. */
  structure: string;
  /** Content stamp of each classpath entry that is not a project output. */
  stamps: ReadonlyMap<string, string>;
  /** Stamp of the build's project class outputs. */
  originals: string;
}

/** A compiler session owns its sources, classes and IC caches. Build outputs remain read-only. */
export class ComposeCompiler {
  private disposed = false;
  private updating = false;
  private initialized = false;
  /** Source key `output` holds; undefined after a failed or partial update. */
  private current: string | undefined;
  /** Source key the render-facing classes hold. */
  private publishedKey: string | undefined;
  /** Some generation was published: the render-facing directories hold a complete set of classes. */
  private populated = false;
  /** Instrumentation provenance of the published generation, never of an in-flight compile. */
  publishedInstrumented = false;
  /** Stamp of the build outputs seeded units were copied from. */
  private seededFrom: string | undefined;
  private verifiedKey: string | undefined;
  readonly rebuildRequired: boolean;

  private constructor(
    private readonly bin: string,
    private readonly cwd: string,
    private readonly units: Unit[],
    private readonly workers: Map<string, ComposeWorker>,
    private readonly directory: string,
    private build: BuildInputs,
    /** Kotlin directory of the Elide distribution running the workers: its compiler plugins are portable. */
    private readonly bundledKotlin: string | undefined,
    private readonly signal: AbortSignal,
  ) {
    // Older builds cannot authorize replay of generated inputs without the processing record.
    this.rebuildRequired = units.some((unit) => unit.processing?.requiresBytecodeTransform || (!unit.processing
      && [...unit.explicit].some((file) => inside(path.join(unit.project, ".dev"), file))));
  }

  /** Renderer inputs; project classes resolve to the published copies. */
  get inputs(): ComposeRenderInputs { return this.build.inputs; }

  /**
   * Renderer inputs that hold the project's classes now: the published copies once a generation was published, before that the
   * build's own outputs (a source newer than the build, or an unsaved one, keeps the build's classes from being adopted).
   */
  get currentInputs(): ComposeRenderInputs { return this.populated ? this.build.inputs : this.build.built; }

  /** See {@link BuildInputs.fingerprint}; part of every stored gallery key. */
  get fingerprint(): string { return this.build.fingerprint; }

  /**
   * `workers` is shared across compilers of one backend and outlives them; its owner disposes it.
   * `directory` is the backend's: compilers share its content-addressed dependency mirror.
   */
  static async create(
    bin: string, cwd: string, inputs: ComposeRenderInputs, directory: string, signal: AbortSignal, workers: Map<string, ComposeWorker>,
  ): Promise<ComposeCompiler> {
    signal.throwIfAborted();
    await mkdir(directory, { recursive: true });
    directory = await mkdtemp(path.join(path.resolve(directory), "compiler-"));
    try {
      return await ComposeCompiler.createInDirectory(bin, cwd, inputs, directory, signal, workers);
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  private static async createInDirectory(
    bin: string, cwd: string, inputs: ComposeRenderInputs, directory: string, signal: AbortSignal, workers: Map<string, ComposeWorker>,
  ): Promise<ComposeCompiler> {
    const mirrors = path.join(path.dirname(directory), "mirror");
    const units: Unit[] = [];
    const originals = [...new Set(inputs.projectClassPath)].map((entry) => path.resolve(cwd, entry));
    // Records name canonical paths; outputs are `<project>/.dev/jvm/classes/<source set>/<language>`.
    const paths = await WorkspacePaths.of([cwd, ...originals.map((original) => path.resolve(original, "../../../../.."))]);
    for (const original of originals) {
      const language = path.basename(original);
      const parent = path.dirname(original);
      const sourceSet = path.basename(parent);
      const classes = path.dirname(parent);
      const dev = path.dirname(path.dirname(classes));
      if ((language !== "kotlin" && language !== "java") || path.basename(classes) !== "classes" || path.basename(path.dirname(classes)) !== "jvm" || path.basename(dev) !== ".dev") {
        throw new Error(`Compose preview cannot identify the compiler for project output ${original}. Rebuild and sync the Elide project.`);
      }
      const tool = language === "kotlin" ? "kotlinc" : "javac";
      const record = path.join(parent, `${tool}.args`);
      let args: string[];
      try { args = recordedArguments(await readFile(record, "utf8")).map((arg) => paths.argument(arg)); }
      catch (error) {
        throw new Error(`Compose preview needs authoritative compiler arguments at ${record}. Build with an Elide version that records ${tool}.args.`, { cause: error });
      }
      if (args.some((arg) => arg.startsWith("@"))) throw new Error(`Compose preview requires expanded compiler arguments in ${record}; nested @argfiles are not supported.`);
      if (args.includes("plugin:org.jetbrains.kotlin.kapt3:aptMode=stubsAndApt")) {
        throw new Error(`The compiler record at ${record} contains only the annotation-processing pass. Complete an Elide build to record the final compilation.`);
      }
      if (tool === "kotlinc" && args.some((arg) => /(?:compose-compiler|compiler-hosted).*\.jar/.test(arg))) {
        const sourceInformation = "plugin:androidx.compose.compiler.plugins.kotlin:sourceInformation=";
        // Preview-only instrumentation: do not alter the project's build arguments or outputs.
        let configured = false;
        args = args.map((arg) => {
          if (!arg.startsWith(sourceInformation) && !arg.startsWith(`-P=${sourceInformation}`)) return arg;
          configured = true;
          return `${arg.startsWith("-P=") ? "-P=" : ""}${sourceInformation}true`;
        });
        if (!configured) args.push("-P", `${sourceInformation}true`);
      }
      const project = path.dirname(dev);
      await verifyDestination(record, args, project, original);
      const explicit = new Set(args.filter((arg) => !arg.startsWith("-") && sourceExtension.test(arg)).map((arg) => path.resolve(project, arg)));
      if (!explicit.size) throw new Error(`Compose preview found no source files in ${record}. Rebuild the Elide project.`);
      const patterns = inputs.sourceSelections?.[original];
      if (!patterns) throw new Error(`Compose preview needs authoritative source selectors for ${original}. Rebuild and sync the Elide project.`);
      const selections = patterns.map((pattern) => sourceSelection(project, pattern));
      const roots = [...new Set([...selections.map((selection) => sourceExtension.test(selection.root) ? path.dirname(selection.root) : selection.root), ...[...explicit].map((file) => path.dirname(file))])];
      const privateDirectory = path.join(directory, String(units.length));
      const toolchain = tool === "kotlinc" ? await kotlinToolchain(path.join(parent, "kotlinc.toolchain.json")) : { version: 1 as const, kind: "embedded" as const };
      const toolchainFiles = toolchain.kind === "external" ? [path.join(toolchain.home!, "lib")] : toolchain.classpath ?? [];
      const toolchainHash = createHash("sha256").update(JSON.stringify(toolchain));
      for (const file of toolchainFiles) toolchainHash.update("\0").update(await stamp(file));
      const toolchainKey = toolchainHash.digest("hex");
      const processing = tool === "kotlinc" ? await ComposeProcessing.create(path.join(parent, "kapt.args"), path.join(privateDirectory, "kapt"), project, paths) : undefined;
      if (processing) await verifyDestination(path.join(parent, "kapt.args"), processing.args, project, original);
      if (processing && toolchain.kind === "embedded") throw new Error(`kapt requires a recorded managed or external Kotlin toolchain at ${parent}. Rebuild with a current Elide version.`);
      units.push({
        tool, toolchain, toolchainKey, processing, project, sourceSet, original, record, output: path.join(privateDirectory, language),
        published: path.join(privateDirectory, "published", language), publishedFiles: new Map(), directory: privateDirectory,
        args, selections, roots: roots.filter((root) => !roots.some((other) => other !== root && inside(other, root))),
        explicit, sources: new Map(), dependencies: new Set(), dirty: true, seeded: false, warmed: false,
      });
    }
    if (!units.length) throw new Error("Compose preview has no project compiler outputs. Rebuild and sync the Elide project.");
    for (const kotlin of units.filter((unit) => unit.tool === "kotlinc")) {
      for (const java of units.filter((unit) => unit.tool === "javac" && sameSourceSet(unit, kotlin))) {
        java.processing = kotlin.processing;
        for (const file of java.explicit) kotlin.explicit.add(file);
        for (const root of java.roots) if (!kotlin.roots.some((other) => inside(other, root))) kotlin.roots.push(root);
        if (kotlin.processing) for (const root of kotlin.processing.roots) {
          if (!java.roots.includes(root)) java.roots.push(root);
          if (!kotlin.roots.includes(root)) kotlin.roots.push(root);
        }
      }
    }
    for (const unit of units) unit.roots = unit.roots.filter((root) => !unit.roots.some((other) => other !== root && inside(other, root)));

    // `structure` decides what is compiled and how; the fingerprint adds the content of every input.
    const structure = createHash("sha256").update(`${bin}\0${path.resolve(cwd)}\0`).update(JSON.stringify(inputs));
    const fingerprint = createHash("sha256");
    for (const unit of units) structure.update("\0args\0").update(unit.args.join("\n")).update(unit.toolchainKey);
    for (const unit of units) {
      if (unit.processing && unit.tool === "kotlinc") {
        fingerprint.update(await unit.processing.inputs(stamp));
        fingerprint.update(await stamp(unit.processing.classes));
        for (const [file, content] of unit.processing.generated) fingerprint.update(file).update("\0").update(content);
      }
    }
    const replacements = new Map(units.map((unit) => [unit.original, [unit.output]]));
    const renderReplacements = new Map(units.map((unit) => [unit.original, [unit.published]]));
    const candidates = new Set([
      ...inputs.classPath.map((entry) => path.resolve(cwd, entry)),
      ...units.flatMap((unit) => pathArguments(unit.args).map((entry) => path.resolve(unit.project, entry))),
    ]);
    // Android dependencies use .dev/android/<artifact>/classes.jar, and JVM artifacts use
    // .dev/artifacts/jar/<artifact>/*.jar, even when discovery already names their class dirs.
    for (const archive of candidates) {
      if (!archive.endsWith(".jar")) continue;
      const owners = units.filter((unit) => {
        const relative = path.relative(path.join(unit.project, ".dev"), archive).split(path.sep);
        return (relative[0] === "android" && relative.length === 3 && relative[2] === "classes.jar")
          || (relative[0] === "artifacts" && relative[1] === "jar");
      });
      if (!owners.length) continue;
      signal.throwIfAborted();
      const resources = path.join(directory, "archives", createHash("sha256").update(archive).digest("hex").slice(0, 16));
      const entries = await archiveResources(archive, resources, signal);
      // Bytecode comes from this compiler; only packaged resources are build inputs here. Their extracted copy is
      // private to each compiler, so a change cannot carry over to an existing one: structure, not content.
      structure.update("\0archive\0").update(archive);
      for (const [name, crc] of [...entries].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
        if (!name.endsWith("/") && !/\.(?:class|kotlin_module)$/.test(name)) structure.update(`\0${name}\0${crc}`);
      }
      const groups = new Set(owners.map((unit) => unit.sourceSet));
      let selected = owners;
      if (groups.size > 1) {
        const matching = new Set<string>();
        for (const unit of owners) {
          const classes = await walk(unit.original, (file) => file.endsWith(".class"));
          if (classes.some((file) => entries.has(path.relative(unit.original, file).split(path.sep).join("/")))) matching.add(unit.sourceSet);
        }
        selected = owners.filter((unit) => matching.has(unit.sourceSet));
        if (!selected.length) throw new Error(`Compose preview cannot map workspace archive ${archive} to its source sets. Rebuild the artifact.`);
      }
      structure.update(`\0owners\0${selected.map((unit) => unit.original).join("\0")}`);
      replacements.set(archive, [...selected.map((unit) => unit.output), resources]);
      renderReplacements.set(archive, [...selected.map((unit) => unit.published), resources]);
    }
    const stamps = new Map<string, string>();
    for (const entry of [...candidates].sort()) {
      if (replacements.has(entry)) continue;
      const content = await stamp(entry);
      stamps.set(entry, content);
      fingerprint.update(`\0${entry}\0${content}`);
      // Elide rewrites identical build outputs (libraries, R classes) on every build. A content-addressed copy
      // keeps the path and modification time the incremental compiler sees stable until the content changes,
      // instead of rescanning the classpath on the first edit after each build.
      if (content === "missing" || !units.some((unit) => inside(path.join(unit.project, ".dev"), entry) && !inside(path.join(unit.project, ".dev", "dependencies"), entry))) continue;
      const mirror = await mirrorEntry(entry, content, mirrors);
      if (mirror) {
        replacements.set(entry, [mirror]);
        renderReplacements.set(entry, [mirror]);
      }
    }
    fingerprint.update(`\0resources\0${await stamp(path.resolve(cwd, inputs.resourceApkPath))}`);

    const byOutput = new Map(units.map((unit) => [unit.output, unit]));
    for (const unit of units) {
      for (const entry of pathArguments(unit.args)) {
        for (const output of replacements.get(path.resolve(unit.project, entry)) ?? []) {
          const dependency = byOutput.get(output);
          if (!dependency || dependency === unit) continue;
          // Kotlin resolves the source set's Java sources before javac consumes Kotlin classes.
          if (unit.tool === "kotlinc" && dependency.tool === "javac" && sameSourceSet(unit, dependency)) continue;
          unit.dependencies.add(dependency);
        }
      }
      if (unit.tool === "javac") {
        for (const kotlin of units.filter((other) => other.tool === "kotlinc" && sameSourceSet(unit, other))) unit.dependencies.add(kotlin);
      }
    }
    const ordered: Unit[] = [];
    const active = new Set<Unit>();
    const visit = (unit: Unit): void => {
      if (ordered.includes(unit)) return;
      if (active.has(unit)) throw new Error(`Compose preview cannot incrementally compile a dependency cycle at ${unit.original}.`);
      active.add(unit);
      for (const dependency of unit.dependencies) visit(dependency);
      active.delete(unit);
      ordered.push(unit);
    };
    units.forEach(visit);
    for (const unit of units) {
      if (unit.tool === "kotlinc" && units.some((consumer) => consumer.dependencies.has(unit))) {
        unit.abiReport = path.join(unit.directory, "abi.snapshot");
      }
    }
    const replace = (entries: string[], map: Map<string, string[]>): string[] => [...new Set(entries.flatMap((entry) => map.get(path.resolve(cwd, entry)) ?? [entry]))];
    const structureKey = structure.digest("hex");
    const build: BuildInputs = {
      inputs: { ...inputs, classPath: replace(inputs.classPath, renderReplacements), projectClassPath: replace(inputs.projectClassPath, renderReplacements) },
      built: { ...inputs, classPath: inputs.classPath.map((entry) => path.resolve(cwd, entry)), projectClassPath: originals },
      replacements, structure: structureKey, fingerprint: fingerprint.update(structureKey).digest("hex"), stamps,
      originals: await classesStamp(ordered, "original"),
    };
    // Elide bundles its Kotlin compiler plugins at `<distribution>/lib/resources/kotlin/<version>/lib`.
    const bundledKotlin = path.isAbsolute(bin) ? path.join(path.dirname(path.dirname(await canonicalPath(bin))), "lib", "resources", "kotlin") : undefined;
    const compiler = new ComposeCompiler(bin, path.resolve(cwd), ordered, workers, directory, build, bundledKotlin, signal);
    // Materialize the full private layout before any worker or renderer sees a classpath entry.
    await Promise.all(units.flatMap((unit) => [mkdir(unit.output, { recursive: true }), mkdir(unit.published, { recursive: true })]));
    signal.throwIfAborted();
    return compiler;
  }

  /** Render-facing classes exist for some source state; edits may still need compiling. */
  get ready(): boolean { return this.publishedKey !== undefined; }

  /** Source key the render-facing classes hold. */
  get publishedSources(): string | undefined { return this.publishedKey; }

  /**
   * What the build compiled the Kotlin sources against (`kotlinc.args` class paths: libraries and the Android platform jar), the
   * project's own outputs excluded: another compiler of the same sources (the Komodo engine's) needs exactly this.
   */
  get compileClassPath(): string[] {
    const own = new Set([...this.inputs.projectClassPath, ...this.units.flatMap((unit) => [unit.original, unit.output, unit.published])]);
    const entries = new Set<string>();
    for (const unit of this.units) if (unit.tool === "kotlinc") for (const entry of pathArguments(unit.args)) if (entry && !own.has(entry)) entries.add(entry);
    return [...entries];
  }

  /** Some units still hold build classes and have not primed their incremental compiler. */
  get seeded(): boolean { return this.units.some((unit) => unit.seeded); }

  /** A complete private baseline (including workspace libraries) has not been compiled yet. */
  get needsWarmup(): boolean { return !this.rebuildRequired && (!this.initialized || this.seeded); }

  get processingRequired(): boolean { return !this.rebuildRequired && this.units.some((unit) => unit.processing !== undefined); }

  get processingStats(): { stubs: number; apt: number } {
    let stubs = 0;
    let apt = 0;
    for (const unit of this.units) if (unit.tool === "kotlinc" && unit.processing) {
      stubs += unit.processing.counts.stubs;
      apt += unit.processing.counts.apt;
    }
    return { stubs, apt };
  }

  isVerified(key: string): boolean { return !this.processingRequired || this.verifiedKey === key; }

  /** Whether `candidate`, created after a later build, describes the same compilation as this compiler. */
  sameBuild(candidate: ComposeCompiler): boolean {
    return !this.rebuildRequired && this.fingerprint === candidate.fingerprint
      && (this.seededFrom === undefined || this.seededFrom === candidate.build.originals);
  }

  /**
   * Take over the inputs of `candidate`, created after a later build that changed only input content (linked
   * resources, R classes, libraries) but compiles the same records the same way. This compiler's classes, sources
   * and incremental caches stay: no cold initialization. Units whose classpath content changed recompile
   * incrementally on the next update, until which nothing is published. Callers exclude updates and renders;
   * `candidate` is discarded afterwards. False when `candidate` compiles something else.
   */
  rebase(candidate: ComposeCompiler): boolean {
    if (this.disposed || this.updating || this.rebuildRequired || candidate.rebuildRequired
      || this.build.structure !== candidate.build.structure
      || this.seededFrom !== undefined && this.seededFrom !== candidate.build.originals) return false;
    // Equal structure lays out private directories identically; `candidate`'s are about to be removed.
    const own = (entry: string): string => inside(candidate.directory, entry) ? path.join(this.directory, path.relative(candidate.directory, entry)) : entry;
    let invalidated = false;
    for (const unit of this.units) {
      const entries = pathArguments(unit.args).map((entry) => path.resolve(unit.project, entry));
      if (entries.every((entry) => this.build.stamps.get(entry) === candidate.build.stamps.get(entry))) continue;
      unit.dirty = true;
      invalidated = true;
    }
    const { inputs, replacements } = candidate.build;
    this.build = {
      ...candidate.build,
      inputs: { ...inputs, classPath: inputs.classPath.map(own), projectClassPath: inputs.projectClassPath.map(own) },
      replacements: new Map([...replacements].map(([entry, targets]) => [entry, targets.map(own)])),
    };
    if (invalidated) {
      this.current = undefined;
      this.publishedKey = undefined;
    }
    return true;
  }

  supports(file: string): boolean {
    file = path.resolve(file);
    return !this.rebuildRequired && sourceExtension.test(file)
      && this.units.some((unit) => unit.tool === (file.endsWith(".java") ? "javac" : "kotlinc") && this.accepts(unit, file));
  }

  requiresBuild(file: string): boolean {
    file = path.resolve(file);
    return this.rebuildRequired && this.units.some((unit) => this.accepts(unit, file));
  }

  /** Read every unit's sources once; `key` identifies the exact compiler input text. */
  async sources(documents: ReadonlyMap<string, string>): Promise<ComposeSources> {
    this.signal.throwIfAborted();
    const files = await Promise.all(this.units.map((unit) => this.collect(unit, documents)));
    const processingInputs = new Map<ComposeProcessing, string>();
    for (const unit of this.units) if (unit.tool === "kotlinc" && unit.processing) {
      processingInputs.set(unit.processing, await this.processingInputFingerprint(unit.processing));
    }
    const key = createHash("sha256");
    for (const unit of files) {
      for (const [file, content] of unit) key.update(file).update("\0").update(content).update("\0");
      key.update("\u0001");
    }
    for (const input of processingInputs.values()) key.update("\0processing\0").update(input);
    return { key: key.digest("hex"), documents, files, processingInputs };
  }

  /**
   * Adopt the build's classes as this compiler's output when they were produced from exactly
   * `sources`, deferring the cold compile. `verified` means a build just completed; otherwise the
   * compiler records must postdate every source. Seeded units compile on change or `update(…, true)`.
   */
  async seed(sources: ComposeSources, verified: boolean): Promise<boolean> {
    this.signal.throwIfAborted();
    if (this.rebuildRequired || this.initialized || this.updating || this.disposed || this.seeded) return false;
    try {
      for (const [file, text] of sources.documents) {
        if (this.units.some((unit) => this.accepts(unit, file)) && await readFile(file, "utf8") !== text) return false;
      }
      for (const [index, unit] of this.units.entries()) {
        const files = this.withGenerated(unit, sources.files[index]!);
        if (files.size !== unit.explicit.size || [...files.keys()].some((file) => !unit.explicit.has(file))) return false;
        if (!(await stat(unit.original)).isDirectory()) return false;
        if (!verified) {
          const recorded = (await stat(unit.record)).mtimeMs;
          for (const file of files.keys()) if ((await stat(file)).mtimeMs > recorded) return false;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    this.updating = true;
    try {
      for (const [index, unit] of this.units.entries()) {
        this.signal.throwIfAborted();
        await this.clean(unit);
        await cp(unit.original, unit.output, { recursive: true });
        await this.apply(unit, this.withGenerated(unit, sources.files[index]!));
        unit.dirty = false;
        unit.seeded = true;
      }
      // What was copied, not what was there: a build rewriting its outputs mid-copy cannot match
      // the stamp of its completed outputs, so `sameBuild` replaces this compiler.
      this.seededFrom = await classesStamp(this.units, "output");
      this.current = sources.key;
      return true;
    } catch (error) {
      for (const unit of this.units) {
        unit.dirty = true;
        unit.seeded = false;
      }
      this.current = undefined;
      this.seededFrom = undefined;
      throw error;
    } finally {
      this.updating = false;
    }
  }

  /** Compile `sources` into the private outputs. `warm` also compiles seeded units, priming incremental compilation. */
  async update(sources: ComposeSources, warm = false): Promise<void> {
    await this.compile(sources, warm);
  }

  private async compile(sources: ComposeSources, warm: boolean, stopBefore?: Unit): Promise<void> {
    this.signal.throwIfAborted();
    if (this.disposed) throw new Error("Compose compiler disposed.");
    if (this.updating) throw new Error("Concurrent Compose compiler updates are not supported.");
    this.updating = true;
    this.current = undefined;
    if (warm) this.verifiedKey = undefined;
    const documents = sources.documents;
    let failed: Unit | undefined;
    let preserveClasspath = false;
    let preserveIncremental = false;
    try {
      const changed = new Set<Unit>();
      for (const file of documents.keys()) {
        if (file.endsWith(".java") && this.units.some((unit) => this.accepts(unit, file))
          && !this.units.some((unit) => unit.tool === "javac" && this.accepts(unit, file))) {
          throw new Error(`Save ${file} and rebuild the preview to create its Java compiler inputs.`);
        }
      }
      if (this.rebuildRequired) {
        for (const [file, text] of documents) {
          if (this.units.some((unit) => this.accepts(unit, file)) && await readFile(file, "utf8") !== text) {
            throw new Error(`Save ${file} and rebuild the preview. This build needs processing records or bytecode post-processing that live compilation cannot replay.`);
          }
        }
      }
      // Synchronize every source before compiling, so mixed Kotlin/Java sees one document snapshot.
      for (const [index, unit] of this.units.entries()) {
        if (await this.apply(unit, this.withGenerated(unit, sources.files[index]!))) unit.dirty = true;
        if (warm && unit.seeded) unit.dirty = true;
        if (unit.dirty) changed.add(unit);
        for (const file of unit.sources.keys()) {
          if (file.endsWith(".java") && !this.units.some((owner) => owner.tool === "javac" && (this.accepts(owner, file) || owner.processing?.owns(file)))) {
            throw new Error(`Save ${file} and rebuild the preview to create its Java compiler inputs.`);
          }
        }
      }
      if (this.rebuildRequired && this.initialized && changed.size) throw new Error("Generated source inputs changed; rebuild the Elide project before refreshing Compose preview.");
      if (this.rebuildRequired) {
        if (!this.initialized) {
          // The full build also performs bytecode post-processing (for example Hilt). Preserve
          // that result rather than replaying only the final compiler pass without its processor.
          for (const unit of this.units) {
            this.signal.throwIfAborted();
            if (this.disposed) throw new Error("Compose compiler disposed.");
            failed = unit;
            await this.clean(unit);
            await cp(unit.original, unit.output, { recursive: true });
            unit.dirty = false;
            failed = undefined;
          }
          this.initialized = true;
        }
        this.current = sources.key;
        return;
      }
      for (const unit of this.units) {
        if (unit === stopBefore) return;
        if (!unit.dirty) continue;
        this.signal.throwIfAborted();
        if (this.disposed) throw new Error("Compose compiler disposed.");
        failed = unit;
        preserveClasspath = false;
        preserveIncremental = false;
        if (unit.seeded) {
          // Build classes have no incremental state; compile from scratch into a clean output.
          await this.clean(unit);
          unit.seeded = false;
        }
        const sources = [...unit.sources.values()];
        if (!sources.length || (unit.tool === "kotlinc" && !sources.some((source) => source.file.endsWith(".kt")))) {
          await this.clean(unit);
          for (const consumer of this.units) if (consumer.dependencies.has(unit)) consumer.dirty = true;
          unit.dirty = false;
          failed = undefined;
          continue;
        }
        // javac is persistent but not incrementally cleaning: rebuild its complete private output
        // so removed/renamed/nested Java classes can never leak into subsequent discovery.
        if (unit.tool === "javac") await this.clean(unit);
        const args = this.arguments(unit);
        const options = unit.tool === "kotlinc"
          ? [...toolchainOptions(unit.toolchain), "--incremental", "--transactional-incremental", ...(!unit.warmed ? ["--warm-incremental"] : []), `--incremental-cache-dir=${path.join(unit.directory, "incremental")}`, "--plugins=", ...(unit.abiReport ? [`--report-abi=${unit.abiReport}`] : []), "--"]
          : ["--"];
        // Absolute standard Kotlin invocations retain module-local caches but share JVM/JIT/BTA
        // infrastructure. Unknown flags, relative paths and custom plugins keep their own cwd.
        const response = await this.worker(unit.tool, this.workerDirectory(unit, args), unit.toolchainKey).request([...options, ...args]);
        if (response.exitCode !== 0) {
          preserveClasspath = response.exitCode === 1;
          const preserved = /^elide: incremental failure state preserved\r?$/m;
          preserveIncremental = unit.tool === "kotlinc" && response.exitCode === 1 && preserved.test(response.output);
          let diagnostic = response.output.replace(/^elide: incremental failure state preserved\r?$(?:\n)?/gm, "");
          for (const owner of this.units) {
            for (const source of owner.sources.values()) diagnostic = diagnostic.replaceAll(source.snapshot, source.file);
          }
          throw new Error(`${unit.tool} failed for ${unit.project} (${unit.sourceSet}, exit ${response.exitCode}).\n${diagnostic || "Elide returned no compiler diagnostics."}`);
        }
        if (unit.tool === "kotlinc") unit.warmed = true;
        if (unit.tool === "kotlinc" && unit.processing) await cp(unit.processing.classes, unit.output, { recursive: true });
        if (await this.abiChanged(unit)) {
          for (const consumer of this.units) if (consumer.dependencies.has(unit)) consumer.dirty = true;
        }
        unit.dirty = false;
        failed = undefined;
      }
      this.initialized = true;
      this.current = sources.key;
      if (!this.seeded) this.seededFrom = undefined;
    } catch (error) {
      // Only an acknowledged transactional rollback keeps outputs, ABI and IC state coherent.
      // Other diagnostics retain classpath snapshots; transport/internal failures discard those too.
      if (failed && !preserveIncremental) await this.clean(failed, preserveClasspath);
      throw error;
    } finally {
      this.updating = false;
    }
  }

  /** Confirm processor inputs after the optimistic paint; failures never confirm stale generated code. */
  async verify(sources: ComposeSources): Promise<boolean> {
    this.signal.throwIfAborted();
    if (this.isVerified(sources.key) && this.current === sources.key) return false;
    if (this.updating || this.disposed) throw new Error("Compose compiler cannot verify during another update or after disposal.");
    let changed = this.current !== sources.key;
    this.updating = true;
    this.verifiedKey = undefined;
    try {
      for (const [index, unit] of this.units.entries()) {
        if (await this.apply(unit, this.withGenerated(unit, sources.files[index]!))) unit.dirty = true;
      }
      for (const unit of this.units) {
        const stage = unit.processing;
        if (unit.tool !== "kotlinc" || !stage) continue;
        // Earlier stages may have regenerated inputs since the optimistic compile. Materialize
        // their Kotlin/Java outputs before this stage inspects the downstream classpath.
        this.updating = false;
        try { await this.compile(sources, false, unit); }
        finally { this.updating = true; }
        let processingInput = sources.processingInputs.get(stage)!;
        for (const dependency of unit.dependencies) processingInput += `\0${dependency.original}\0${await stamp(dependency.output)}`;
        for (const source of unit.sources.values()) {
          if (source.file.endsWith(".java") && !stage.owns(source.file)) processingInput += `\0${source.file}\0${source.content}`;
        }
        // Processors may resolve options against the project directory. The Kotlin worker there serves kapt as well.
        const worker = this.worker("kotlinc", unit.project, unit.toolchainKey);
        const regenerated = await stage.verify(this.arguments(unit, stage.args, false), processingInput, async (args) => {
          const response = await worker.request([...toolchainOptions(unit.toolchain), "--plugins=", "--", ...args]);
          if (response.exitCode !== 0) {
            let diagnostic = response.output;
            for (const owner of this.units) for (const source of owner.sources.values()) diagnostic = diagnostic.replaceAll(source.snapshot, source.file);
            throw new Error(`kapt failed for ${unit.project} (${unit.sourceSet}, exit ${response.exitCode}).\n${diagnostic}`);
          }
        });
        if (regenerated) {
          changed = true;
          for (const owner of this.units) if (owner.processing === stage) {
            owner.dirty = true;
            // Removed generated declarations must not survive an incremental cache from the old generation.
            await this.clean(owner);
            owner.warmed = false;
            owner.seeded = false;
          }
        }
      }
    } finally {
      this.updating = false;
    }
    await this.update(sources);
    for (const [stage, input] of sources.processingInputs) {
      if (await this.processingInputFingerprint(stage) !== input) throw new Error("Annotation processor inputs changed during preview verification; refresh the preview.");
    }
    this.verifiedKey = sources.key;
    return changed;
  }

  private async processingInputFingerprint(stage: ComposeProcessing): Promise<string> {
    return stage.inputs(async (file) => {
      const replacement = this.build.replacements.get(file);
      // Build-owned mirrors are frozen with this resource context. Project-unit outputs are
      // instead verified in DAG order and separately included in each processing pass's key.
      if (!replacement || replacement.some((entry) => this.units.some((unit) => unit.output === entry))) return stamp(file);
      return (await Promise.all(replacement.map(stamp))).join("\0");
    });
  }

  private withGenerated(unit: Unit, files: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
    if (!unit.processing) return files;
    const result = new Map(files);
    for (const [file, text] of unit.processing.generated) {
      if (unit.tool === "kotlinc" || file.endsWith(".java")) result.set(file, text);
    }
    return result;
  }

  /** Copy changed private classes to the render-facing directories. Callers exclude concurrent renders. */
  async publish(): Promise<void> {
    const key = this.current;
    if (key === undefined) throw new Error("Compose compiler has no complete generation to publish.");
    this.publishedKey = undefined;
    for (const unit of this.units) {
      this.signal.throwIfAborted();
      const next = new Map<string, string>();
      for (const file of await walk(unit.output, () => true)) {
        const relative = path.relative(unit.output, file);
        const info = await stat(file, { bigint: true });
        const stamp = `${info.mtimeNs}:${info.size}:${info.ino}`;
        next.set(relative, stamp);
        if (unit.publishedFiles.get(relative) === stamp) continue;
        const target = path.join(unit.published, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(file, target);
      }
      for (const relative of unit.publishedFiles.keys()) {
        if (!next.has(relative)) await rm(path.join(unit.published, relative), { force: true });
      }
      unit.publishedFiles = next;
    }
    this.publishedKey = key;
    this.populated = true;
    this.publishedInstrumented = !this.rebuildRequired && this.initialized && !this.seeded;
  }

  dispose(): void {
    this.disposed = true;
  }

  /**
   * Stop the backend's workers this compiler never uses: a replaced compiler's, for another toolchain, Elide distribution
   * or working directory. Callers exclude compiles.
   */
  pruneWorkers(): void {
    const used = new Set<string>();
    for (const unit of this.units) {
      let args: string[];
      // Such a unit fails before it starts a worker.
      try { args = this.arguments(unit); } catch { continue; }
      used.add(this.workerKey(unit.tool, this.workerDirectory(unit, args), unit.toolchainKey));
      if (unit.processing) used.add(this.workerKey("kotlinc", unit.project, unit.toolchainKey));
    }
    for (const [key, worker] of this.workers) {
      if (used.has(key)) continue;
      worker.dispose();
      this.workers.delete(key);
    }
  }

  /** Delete this compiler's private directory. Only after `dispose` and outside renders using its classes. */
  async remove(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true });
  }

  private accepts(unit: Unit, file: string): boolean {
    return (unit.tool === "kotlinc" ? sourceExtension.test(file) : file.endsWith(".java"))
      && !unit.processing?.owns(file)
      && (unit.explicit.has(file) || unit.selections.some((selection) => selection.matches(file)));
  }

  private async collect(unit: Unit, documents: ReadonlyMap<string, string>): Promise<Map<string, string>> {
    const roots = [...new Set(unit.selections.map((selection) => selection.root))];
    const files = new Set([...unit.explicit].filter((file) => !unit.processing?.owns(file)));
    for (const file of (await Promise.all(roots.map((root) => walk(root, (file) => this.accepts(unit, file))))).flat()) files.add(file);
    for (const file of documents.keys()) if (this.accepts(unit, file)) files.add(file);
    const sorted = [...files].sort();
    const contents = await Promise.all(sorted.map(async (file) => {
      const document = documents.get(file);
      if (document !== undefined) return document;
      try { return await readFile(file, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    }));
    const result = new Map<string, string>();
    for (const [index, file] of sorted.entries()) {
      const content = contents[index];
      if (content !== undefined) result.set(file, content);
    }
    return result;
  }

  private async apply(unit: Unit, files: ReadonlyMap<string, string>): Promise<boolean> {
    const next = new Map<string, Source>();
    let changed = false;
    for (const [file, content] of files) {
      this.signal.throwIfAborted();
      const previous = unit.sources.get(file);
      // Preserve package layout and basenames (JVM SourceFile); roots with identical relative
      // names stay separate without copying or rewriting original project sources.
      const root = unit.roots.find((candidate) => inside(candidate, file)) ?? path.dirname(file);
      const snapshot = previous?.snapshot ?? path.join(snapshotRoot(unit, root), path.relative(root, file));
      if (!previous || previous.content !== content) {
        await mkdir(path.dirname(snapshot), { recursive: true });
        await writeFile(snapshot, content, { signal: this.signal });
        changed = true;
      }
      next.set(file, { file, snapshot, content });
    }
    for (const [file, source] of unit.sources) {
      if (next.has(file)) continue;
      await rm(source.snapshot, { force: true });
      changed = true;
    }
    unit.sources = next;
    return changed;
  }

  /** The worker directory `unit` compiles `args` in: the workspace's when they are self-contained, else its project's. */
  private workerDirectory(unit: Unit, args: readonly string[]): string {
    return unit.tool === "kotlinc" && portableKotlinArguments(args, unit.toolchain, this.bundledKotlin) ? this.cwd : unit.project;
  }

  private workerKey(tool: Tool, cwd: string, toolchainKey: string): string {
    return `${this.bin}\0${cwd}\0${tool}\0${toolchainKey}`;
  }

  /** The backend's persistent `tool` worker in `cwd`, started on first use or after it died. */
  private worker(tool: Tool, cwd: string, toolchainKey: string): ComposeWorker {
    const key = this.workerKey(tool, cwd, toolchainKey);
    let worker = this.workers.get(key);
    if (!worker?.alive) {
      worker?.dispose();
      worker = new ComposeWorker(this.bin, tool, cwd, this.signal);
      this.workers.set(key, worker);
    }
    return worker;
  }

  private arguments(unit: Unit, recorded = unit.args, generated = true): string[] {
    const args: string[] = [];
    for (let index = 0; index < recorded.length; index++) {
      const arg = recorded[index]!;
      if (unit.explicit.has(path.resolve(unit.project, arg)) || unit.processing?.owns(path.resolve(unit.project, arg))) continue;
      const option = splitOption(arg);
      const paths = classPathFlags[option.flag] || option.flag === "-Xfriend-paths" || option.flag === "--patch-module";
      const sources = sourcePathFlags[option.flag];
      if (paths || sources || outputFlags[option.flag]) {
        const value = option.value ?? recorded[++index];
        if (value === undefined) throw new Error(`Missing compiler argument after ${option.flag}.`);
        let replaced: string;
        if (paths) {
          const delimiter = option.flag === "-Xfriend-paths" ? "," : path.delimiter;
          const patch = option.flag === "--patch-module" ? patchModule(value) : undefined;
          replaced = [...new Set((patch?.paths ?? value).split(delimiter).flatMap((entry) => this.build.replacements.get(path.resolve(unit.project, entry)) ?? [entry]))].join(delimiter);
          if (patch) replaced = `${patch.module}=${replaced}`;
        } else if (sources) {
          const delimiter = option.flag === "-Xjava-source-roots" ? "," : path.delimiter;
          const roots = unit.roots.filter((root) => generated || !unit.processing?.owns(root));
          if (!roots.length) continue;
          replaced = roots.map((root) => snapshotRoot(unit, root)).join(delimiter);
        } else {
          replaced = option.flag === "-d" ? unit.output
            : path.join(unit.directory, "generated", `${option.flag.replace(/^-+/, "")}${option.flag === "--emit-abi" && value.endsWith(".jar") ? ".jar" : ""}`);
        }
        if (option.value === undefined) args.push(option.flag, replaced);
        else args.push(`${option.flag}=${replaced}`);
      } else if (/^plugin:[^:]+:(?:outputDir|reportsDestination|metricsDestination)=/.test(arg)) {
        const equals = arg.indexOf("=");
        const archive = arg.startsWith("plugin:org.jetbrains.kotlin.jvm.abi:outputDir=") && arg.endsWith(".jar") ? ".jar" : "";
        args.push(`${arg.slice(0, equals + 1)}${path.join(unit.directory, "plugin-output", createHash("sha256").update(arg.slice(0, equals)).digest("hex").slice(0, 16) + archive)}`);
      } else args.push(arg);
    }
    const sources = [...unit.sources.values()].filter((source) => generated || !unit.processing?.owns(source.file));
    if (unit.tool === "kotlinc") {
      // Elide's BTA source list contains Kotlin only; explicitly retain Java resolution roots.
      const java = unit.roots.filter((root) => sources.some((source) => source.file.endsWith(".java") && inside(root, source.file))).map((root) => snapshotRoot(unit, root));
      if (java.length) args.push(`-Xjava-source-roots=${java.join(",")}`);
    }
    args.push(...sources.map((source) => source.snapshot));
    return args;
  }

  private async abiChanged(unit: Unit): Promise<boolean> {
    // Java remains conservative; Kotlin's own snapshot covers inline code and friend members.
    if (!unit.abiReport) return true;
    let snapshot: Buffer;
    try { snapshot = await readFile(unit.abiReport); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Elide emitted no ABI snapshot for ${unit.original}. Update the experimental Elide runtime to a version supporting --report-abi with incremental compilation.`);
      }
      throw error;
    }
    const fingerprint = createHash("sha256").update(snapshot).digest("hex");
    const changed = unit.abiFingerprint !== fingerprint;
    unit.abiFingerprint = fingerprint;
    return changed;
  }

  private async clean(unit: Unit, preserveClasspath = false): Promise<void> {
    const incremental = path.join(unit.directory, "incremental");
    unit.abiFingerprint = undefined;
    await Promise.all([unit.output, preserveClasspath ? path.join(incremental, "ic") : incremental, path.join(unit.directory, "generated"), path.join(unit.directory, "plugin-output"), ...(unit.abiReport ? [unit.abiReport] : [])]
      .map((directory) => rm(directory, { recursive: true, force: true })));
    await mkdir(unit.output, { recursive: true });
  }
}

function snapshotRoot(unit: Unit, root: string): string {
  return path.join(unit.directory, "sources", createHash("sha256").update(root).digest("hex").slice(0, 16));
}

function sameSourceSet(first: Unit, second: Unit): boolean {
  return first.project === second.project && first.sourceSet === second.sourceSet;
}

const zipEnd = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/**
 * Content fingerprint of a zip from its central directory (names, sizes, CRC-32s), without reading
 * entry data. Undefined for anything this cannot parse (not a zip, ZIP64, comment containing the marker).
 */
async function zipStamp(file: string, size: number): Promise<string | undefined> {
  const handle = await open(file, "r");
  try {
    const tail = Buffer.alloc(Math.min(size, 22 + 0xffff));
    await handle.read(tail, 0, tail.length, size - tail.length);
    const end = tail.lastIndexOf(zipEnd);
    if (end < 0 || end + 22 > tail.length) return undefined;
    const length = tail.readUInt32LE(end + 12);
    const offset = tail.readUInt32LE(end + 16);
    if (offset === 0xffffffff || offset + length > size) return undefined;
    const directory = Buffer.alloc(length);
    await handle.read(directory, 0, length, offset);
    return createHash("sha256").update(directory).digest("hex");
  } finally {
    await handle.close();
  }
}

/**
 * Content fingerprint of a build input. Elide restores cached outputs by rewriting identical bytes,
 * so modification times change on every build; content must not.
 */
async function stamp(entry: string): Promise<string> {
  let info;
  try { info = await stat(entry); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if (info.isDirectory()) {
    const files = (await walk(entry, () => true)).sort();
    const stamps = await Promise.all(files.map(stamp));
    const hash = createHash("sha256");
    for (const [index, file] of files.entries()) hash.update(`${path.relative(entry, file)}\0${stamps[index]}\0`);
    return hash.digest("hex");
  }
  if (/\.(?:jar|zip|apk|aar)$/.test(entry)) {
    const central = await zipStamp(entry, info.size);
    if (central) return `zip:${central}`;
  }
  return createHash("sha256").update(await readFile(entry)).digest("hex");
}

/**
 * Copy (clone where the filesystem supports it) a build output to `root/<content>/<name>`, once per content.
 * Undefined when the source changed while copying, as during a concurrent build: use the original then.
 */
async function mirrorEntry(entry: string, content: string, root: string): Promise<string | undefined> {
  const target = path.join(root, createHash("sha256").update(content).digest("hex").slice(0, 24), path.basename(entry));
  try {
    await stat(target);
    return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(path.join(root, "staging-"));
  try {
    const copy = path.join(staging, path.basename(entry));
    await cp(entry, copy, { recursive: true, mode: constants.COPYFILE_FICLONE });
    if (await stamp(copy) !== content) return undefined;
    await mkdir(path.dirname(target), { recursive: true });
    try { await rename(copy, target); }
    catch (error) {
      // A concurrent compiler of the same backend published this content first.
      if (!await stat(target).then(() => true, () => false)) throw error;
    }
    return target;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Content stamp of every unit's build classes, or of the private copies made from them. */
async function classesStamp(units: readonly Unit[], directory: "original" | "output"): Promise<string> {
  const stamps = await Promise.all(units.map((unit) => stamp(unit[directory])));
  return createHash("sha256").update(stamps.join("\0")).digest("hex");
}

/** Keep packaged resources, never old bytecode or Kotlin module metadata as a fallback. Returns entry name → CRC-32. */
async function archiveResources(archive: string, destination: string, signal: AbortSignal): Promise<Map<string, number>> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true, autoClose: false, strictFileNames: true }, (error, file) => {
      if (error) reject(error);
      else if (file) resolve(file);
      else reject(new Error(`Cannot open workspace archive ${archive}.`));
    });
  });
  const names = new Map<string, number>();
  let failure: Error | undefined;
  const onError = (error: Error) => { failure = error; };
  zip.on("error", onError);
  try {
    await mkdir(destination, { recursive: true });
    while (true) {
      signal.throwIfAborted();
      if (failure) throw failure;
      const entry = await new Promise<yauzl.Entry | undefined>((resolve, reject) => {
        const cleanup = () => { zip.off("entry", onEntry); zip.off("end", onEnd); zip.off("error", onFailure); signal.removeEventListener("abort", onAbort); };
        const onEntry = (value: yauzl.Entry) => { cleanup(); resolve(value); };
        const onEnd = () => { cleanup(); resolve(undefined); };
        const onFailure = (error: Error) => { cleanup(); reject(error); };
        const onAbort = () => { cleanup(); reject(signal.reason); };
        zip.once("entry", onEntry); zip.once("end", onEnd); zip.once("error", onFailure);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort(); else zip.readEntry();
      });
      if (!entry) break;
      names.set(entry.fileName, entry.crc32);
      if (entry.fileName.endsWith("/") || /\.(?:class|kotlin_module)$/.test(entry.fileName)) continue;
      const file = path.resolve(destination, entry.fileName);
      if (!inside(destination, file) || file === destination) throw new Error(`Unsafe workspace archive entry ${entry.fileName}.`);
      await mkdir(path.dirname(file), { recursive: true });
      const stream = await new Promise<Readable>((resolve, reject) => {
        zip.openReadStream(entry, (error, value) => {
          if (error) reject(error);
          else if (value) resolve(value);
          else reject(new Error(`Cannot read workspace archive entry ${entry.fileName}.`));
        });
      });
      await pipeline(stream, createWriteStream(file, { flags: "wx" }), { signal });
    }
  } finally {
    zip.close();
    zip.off("error", onError);
  }
  return names;
}
