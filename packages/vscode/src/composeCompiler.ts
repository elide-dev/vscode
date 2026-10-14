import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";
import { sourceSelection, type SourceSelection } from "@elide/ide-core";
import type { ComposeRenderInputs } from "./composeRender.js";
import { ComposeWorker } from "./composeWorker.js";

type Tool = "kotlinc" | "javac";
interface Source {
  file: string;
  snapshot: string;
  content: string;
}
interface Unit {
  tool: Tool;
  project: string;
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
}

const classPathFlags: Record<string, true | undefined> = { "-classpath": true, "-cp": true, "--class-path": true, "--module-path": true, "-p": true, "-Xmodule-path": true };
const sourcePathFlags: Record<string, true | undefined> = { "-sourcepath": true, "--source-path": true, "-Xjava-source-roots": true };
const outputFlags: Record<string, true | undefined> = { "-d": true, "-s": true, "-h": true, "--emit-abi": true, "-Xdump-directory": true };
const sourceExtension = /\.(?:kt|java)$/;
const portableKotlinValues = new Set(["-api-version", "-language-version", "-jvm-target", "-module-name"]);
const portableKotlinSwitches = new Set(["-Xdisable-standard-script", "-no-stdlib", "-no-reflect", "-no-jdk", "-java-parameters", "-nowarn", "-Werror"]);

function inside(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/** Elide ArgsRecord is argv, one unescaped argument per line, NOT a shell or Java @argfile. */
function recordedArguments(text: string): string[] {
  const args = text.split("\n");
  if (args.at(-1) === "") args.pop();
  return args;
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

/** Only self-contained invocations may share a worker across project directories. */
function portableKotlinArguments(args: readonly string[]): boolean {
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
      if (!kotlinHome || value !== path.join(kotlinHome, "lib", "kotlin-compose-compiler-plugin.jar")) return false;
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

/** A compiler session owns its sources, classes and IC caches. Build outputs remain read-only. */
export class ComposeCompiler {
  private disposed = false;
  private updating = false;
  private initialized = false;
  /** Source key `output` holds; undefined after a failed or partial update. */
  private current: string | undefined;
  /** Source key the render-facing classes hold. */
  private publishedKey: string | undefined;
  /** Stamp of the build outputs seeded units were copied from. */
  private seededFrom: string | undefined;
  readonly rebuildRequired: boolean;

  private constructor(
    private readonly bin: string,
    private readonly cwd: string,
    /** Renderer inputs; project classes resolve to the published copies. */
    readonly inputs: ComposeRenderInputs,
    private readonly units: Unit[],
    private readonly replacements: Map<string, string[]>,
    private readonly workers: Map<string, ComposeWorker>,
    private readonly directory: string,
    /** Everything a build contributes besides project classes: inputs, compiler records, resources, libraries. With a source key, determines the classes. */
    readonly fingerprint: string,
    /** Stamp of the build's project class outputs when this compiler was created. */
    private readonly originals: string,
    private readonly signal: AbortSignal,
  ) {
    // Elide's final kotlinc.args includes generated inputs but overwrites the earlier kapt
    // processor invocation. Only a fresh build can regenerate those inputs authoritatively.
    this.rebuildRequired = units.some((unit) => unit.args.some((arg) => /(?:kotlin-annotation-processing|plugin:org\.jetbrains\.kotlin\.kapt3)/.test(arg))
      || [...unit.explicit].some((file) => inside(path.join(unit.project, ".dev"), file)));
  }

  /**
   * `workers` is shared across compilers of one backend and outlives them; its owner disposes it.
   * `directory` is the backend's: compilers share its content-addressed dependency mirror.
   */
  static async create(
    bin: string, cwd: string, inputs: ComposeRenderInputs, directory: string, signal: AbortSignal, workers: Map<string, ComposeWorker>,
  ): Promise<ComposeCompiler> {
    signal.throwIfAborted();
    await mkdir(directory, { recursive: true });
    const mirrors = path.join(path.resolve(directory), "mirror");
    directory = await mkdtemp(path.join(path.resolve(directory), "compiler-"));
    const units: Unit[] = [];
    for (const originalEntry of new Set(inputs.projectClassPath)) {
      const original = path.resolve(cwd, originalEntry);
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
      try { args = recordedArguments(await readFile(record, "utf8")); }
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
      const explicit = new Set(args.filter((arg) => !arg.startsWith("-") && sourceExtension.test(arg)).map((arg) => path.resolve(project, arg)));
      if (!explicit.size) throw new Error(`Compose preview found no source files in ${record}. Rebuild the Elide project.`);
      const patterns = inputs.sourceSelections?.[original];
      if (!patterns) throw new Error(`Compose preview needs authoritative source selectors for ${original}. Rebuild and sync the Elide project.`);
      const selections = patterns.map((pattern) => sourceSelection(project, pattern));
      const roots = [...new Set([...selections.map((selection) => sourceExtension.test(selection.root) ? path.dirname(selection.root) : selection.root), ...[...explicit].map((file) => path.dirname(file))])];
      const privateDirectory = path.join(directory, String(units.length));
      units.push({
        tool, project, sourceSet, original, record, output: path.join(privateDirectory, language),
        published: path.join(privateDirectory, "published", language), publishedFiles: new Map(), directory: privateDirectory,
        args, selections, roots: roots.filter((root) => !roots.some((other) => other !== root && inside(other, root))),
        explicit, sources: new Map(), dependencies: new Set(), dirty: true, seeded: false, warmed: false,
      });
    }
    if (!units.length) throw new Error("Compose preview has no project compiler outputs. Rebuild and sync the Elide project.");
    for (const kotlin of units.filter((unit) => unit.tool === "kotlinc")) {
      for (const java of units.filter((unit) => unit.tool === "javac" && sameSourceSet(unit, kotlin))) {
        for (const file of java.explicit) kotlin.explicit.add(file);
        for (const root of java.roots) if (!kotlin.roots.some((other) => inside(other, root))) kotlin.roots.push(root);
      }
    }

    const fingerprint = createHash("sha256").update(`${bin}\0${path.resolve(cwd)}\0`).update(JSON.stringify(inputs));
    for (const unit of units) fingerprint.update("\0args\0").update(unit.args.join("\n"));
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
      // Bytecode comes from this compiler; only packaged resources are build inputs here.
      fingerprint.update("\0archive\0").update(archive);
      for (const [name, crc] of [...entries].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
        if (!name.endsWith("/") && !/\.(?:class|kotlin_module)$/.test(name)) fingerprint.update(`\0${name}\0${crc}`);
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
      replacements.set(archive, [...selected.map((unit) => unit.output), resources]);
      renderReplacements.set(archive, [...selected.map((unit) => unit.published), resources]);
    }
    for (const entry of [...candidates].sort()) {
      if (replacements.has(entry)) continue;
      const content = await stamp(entry);
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
    const compiler = new ComposeCompiler(bin, path.resolve(cwd), {
      ...inputs, classPath: replace(inputs.classPath, renderReplacements), projectClassPath: replace(inputs.projectClassPath, renderReplacements),
    }, ordered, replacements, workers, directory, fingerprint.digest("hex"), await classesStamp(ordered, "original"), signal);
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

  /** Whether `candidate`, created after a later build, describes the same compilation as this compiler. */
  sameBuild(candidate: ComposeCompiler): boolean {
    return !this.rebuildRequired && this.fingerprint === candidate.fingerprint
      && (this.seededFrom === undefined || this.seededFrom === candidate.originals);
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
    const key = createHash("sha256");
    for (const unit of files) {
      for (const [file, content] of unit) key.update(file).update("\0").update(content).update("\0");
      key.update("\u0001");
    }
    return { key: key.digest("hex"), documents, files };
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
        const files = sources.files[index]!;
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
        await this.apply(unit, sources.files[index]!);
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
    this.signal.throwIfAborted();
    if (this.disposed) throw new Error("Compose compiler disposed.");
    if (this.updating) throw new Error("Concurrent Compose compiler updates are not supported.");
    this.updating = true;
    this.current = undefined;
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
            throw new Error(`Save ${file} to regenerate annotation-processor inputs before previewing. The final Elide compiler record does not contain the processor invocation.`);
          }
        }
      }
      // Synchronize every source before compiling, so mixed Kotlin/Java sees one document snapshot.
      for (const [index, unit] of this.units.entries()) {
        if (await this.apply(unit, sources.files[index]!)) unit.dirty = true;
        if (warm && unit.seeded) unit.dirty = true;
        if (unit.dirty) changed.add(unit);
        for (const file of unit.sources.keys()) {
          if (file.endsWith(".java") && !this.units.some((owner) => owner.tool === "javac" && this.accepts(owner, file))) {
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
          ? ["--incremental", "--transactional-incremental", ...(!unit.warmed ? ["--warm-incremental"] : []), `--incremental-cache-dir=${path.join(unit.directory, "incremental")}`, "--plugins=", ...(unit.abiReport ? [`--report-abi=${unit.abiReport}`] : []), "--"]
          : ["--"];
        // Absolute standard Kotlin invocations retain module-local caches but share JVM/JIT/BTA
        // infrastructure. Unknown flags, relative paths and custom plugins keep their own cwd.
        const cwd = unit.tool === "kotlinc" && portableKotlinArguments(args) ? this.cwd : unit.project;
        const key = `${this.bin}\0${cwd}\0${unit.tool}`;
        let worker = this.workers.get(key);
        if (!worker?.alive) {
          worker?.dispose();
          worker = new ComposeWorker(this.bin, unit.tool, cwd, this.signal);
          this.workers.set(key, worker);
        }
        const response = await worker.request([...options, ...args]);
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
  }

  dispose(): void {
    this.disposed = true;
  }

  /** Delete this compiler's private directory. Only after `dispose` and outside renders using its classes. */
  async remove(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true });
  }

  private accepts(unit: Unit, file: string): boolean {
    return (unit.tool === "kotlinc" ? sourceExtension.test(file) : file.endsWith(".java"))
      && (unit.explicit.has(file) || unit.selections.some((selection) => selection.matches(file)));
  }

  private async collect(unit: Unit, documents: ReadonlyMap<string, string>): Promise<Map<string, string>> {
    const roots = [...new Set(unit.selections.map((selection) => selection.root))];
    const files = new Set([...unit.explicit, ...(await Promise.all(roots.map((root) => walk(root, (file) => this.accepts(unit, file))))).flat()]);
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

  private arguments(unit: Unit): string[] {
    const args: string[] = [];
    let destination = false;
    for (let index = 0; index < unit.args.length; index++) {
      const arg = unit.args[index]!;
      if (unit.explicit.has(path.resolve(unit.project, arg))) continue;
      const option = splitOption(arg);
      const paths = classPathFlags[option.flag] || option.flag === "-Xfriend-paths" || option.flag === "--patch-module";
      const sources = sourcePathFlags[option.flag];
      if (paths || sources || outputFlags[option.flag]) {
        const value = option.value ?? unit.args[++index];
        if (value === undefined) throw new Error(`Missing compiler argument after ${option.flag}.`);
        let replaced: string;
        if (paths) {
          const delimiter = option.flag === "-Xfriend-paths" ? "," : path.delimiter;
          const patch = option.flag === "--patch-module" ? patchModule(value) : undefined;
          replaced = [...new Set((patch?.paths ?? value).split(delimiter).flatMap((entry) => this.replacements.get(path.resolve(unit.project, entry)) ?? [entry]))].join(delimiter);
          if (patch) replaced = `${patch.module}=${replaced}`;
        } else if (sources) {
          const delimiter = option.flag === "-Xjava-source-roots" ? "," : path.delimiter;
          replaced = unit.roots.map((root) => snapshotRoot(unit, root)).join(delimiter);
        } else {
          if (option.flag === "-d") {
            if (path.resolve(unit.project, value) !== unit.original) throw new Error(`Recorded compiler destination ${value} does not match ${unit.original}.`);
            destination = true;
            replaced = unit.output;
          } else replaced = path.join(unit.directory, "generated", `${option.flag.replace(/^-+/, "")}${option.flag === "--emit-abi" && value.endsWith(".jar") ? ".jar" : ""}`);
        }
        if (option.value === undefined) args.push(option.flag, replaced);
        else args.push(`${option.flag}=${replaced}`);
      } else if (/^plugin:[^:]+:(?:outputDir|reportsDestination|metricsDestination)=/.test(arg)) {
        const equals = arg.indexOf("=");
        const archive = arg.startsWith("plugin:org.jetbrains.kotlin.jvm.abi:outputDir=") && arg.endsWith(".jar") ? ".jar" : "";
        args.push(`${arg.slice(0, equals + 1)}${path.join(unit.directory, "plugin-output", createHash("sha256").update(arg.slice(0, equals)).digest("hex").slice(0, 16) + archive)}`);
      } else args.push(arg);
    }
    if (!destination) throw new Error(`Recorded ${unit.tool} arguments have no -d destination for ${unit.original}.`);
    const sources = [...unit.sources.values()];
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
