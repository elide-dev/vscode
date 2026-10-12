import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  output: string;
  directory: string;
  args: string[];
  roots: string[];
  selections: SourceSelection[];
  explicit: Set<string>;
  sources: Map<string, Source>;
  dependencies: Set<Unit>;
  dirty: boolean;
  abiReport?: string;
  abiFingerprint?: string;
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
  private readonly workers = new Map<string, ComposeWorker>();
  private disposed = false;
  private updating = false;
  private initialized = false;
  private readonly rebuildRequired: boolean;

  private constructor(
    private readonly bin: string,
    private readonly cwd: string,
    readonly inputs: ComposeRenderInputs,
    private readonly units: Unit[],
    private readonly replacements: Map<string, string[]>,
    private readonly signal: AbortSignal,
  ) {
    // Elide's final kotlinc.args includes generated inputs but overwrites the earlier kapt
    // processor invocation. Only a fresh build can regenerate those inputs authoritatively.
    this.rebuildRequired = units.some((unit) => unit.args.some((arg) => /(?:kotlin-annotation-processing|plugin:org\.jetbrains\.kotlin\.kapt3)/.test(arg))
      || [...unit.explicit].some((file) => inside(path.join(unit.project, ".dev"), file)));
  }

  static async create(
    bin: string, cwd: string, inputs: ComposeRenderInputs, directory: string, signal: AbortSignal,
  ): Promise<ComposeCompiler> {
    signal.throwIfAborted();
    await mkdir(directory, { recursive: true });
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
      const project = path.dirname(dev);
      const explicit = new Set(args.filter((arg) => !arg.startsWith("-") && sourceExtension.test(arg)).map((arg) => path.resolve(project, arg)));
      if (!explicit.size) throw new Error(`Compose preview found no source files in ${record}. Rebuild the Elide project.`);
      const patterns = inputs.sourceSelections?.[original];
      if (!patterns) throw new Error(`Compose preview needs authoritative source selectors for ${original}. Rebuild and sync the Elide project.`);
      const selections = patterns.map((pattern) => sourceSelection(project, pattern));
      const roots = [...new Set([...selections.map((selection) => sourceExtension.test(selection.root) ? path.dirname(selection.root) : selection.root), ...[...explicit].map((file) => path.dirname(file))])];
      const privateDirectory = path.join(directory, String(units.length));
      units.push({
        tool, project, sourceSet, original, output: path.join(privateDirectory, language), directory: privateDirectory,
        args, selections, roots: roots.filter((root) => !roots.some((other) => other !== root && inside(other, root))),
        explicit, sources: new Map(), dependencies: new Set(), dirty: true,
      });
    }
    if (!units.length) throw new Error("Compose preview has no project compiler outputs. Rebuild and sync the Elide project.");
    for (const kotlin of units.filter((unit) => unit.tool === "kotlinc")) {
      for (const java of units.filter((unit) => unit.tool === "javac" && sameSourceSet(unit, kotlin))) {
        for (const file of java.explicit) kotlin.explicit.add(file);
        for (const root of java.roots) if (!kotlin.roots.some((other) => inside(other, root))) kotlin.roots.push(root);
      }
    }

    const replacements = new Map(units.map((unit) => [unit.original, [unit.output]]));
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
    }

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
    const replace = (entries: string[]): string[] => [...new Set(entries.flatMap((entry) => replacements.get(path.resolve(cwd, entry)) ?? [entry]))];
    const compiler = new ComposeCompiler(bin, path.resolve(cwd), {
      ...inputs, classPath: replace(inputs.classPath), projectClassPath: replace(inputs.projectClassPath),
    }, ordered, replacements, signal);
    // Materialize the full private layout before any worker sees a classpath entry.
    await Promise.all(units.map((unit) => mkdir(unit.output, { recursive: true })));
    signal.throwIfAborted();
    return compiler;
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

  async update(documents: ReadonlyMap<string, string>): Promise<void> {
    this.signal.throwIfAborted();
    if (this.disposed) throw new Error("Compose compiler disposed.");
    if (this.updating) throw new Error("Concurrent Compose compiler updates are not supported.");
    this.updating = true;
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
      for (const unit of this.units) {
        if (await this.snapshot(unit, documents)) unit.dirty = true;
        if (unit.dirty) changed.add(unit);
        for (const file of unit.sources.keys()) {
          if (file.endsWith(".java") && !this.units.some((owner) => owner.tool === "javac" && this.accepts(owner, file))) {
            throw new Error(`Save ${file} and rebuild the preview to create its Java compiler inputs.`);
          }
        }
      }
      for (const unit of changed) unit.dirty = true;
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
        return;
      }
      for (const unit of this.units) {
        if (!unit.dirty) continue;
        this.signal.throwIfAborted();
        if (this.disposed) throw new Error("Compose compiler disposed.");
        failed = unit;
        preserveClasspath = false;
        preserveIncremental = false;
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
          ? ["--incremental", "--transactional-incremental", ...(!this.initialized ? ["--warm-incremental"] : []), `--incremental-cache-dir=${path.join(unit.directory, "incremental")}`, "--plugins=", ...(unit.abiReport ? [`--report-abi=${unit.abiReport}`] : []), "--"]
          : ["--"];
        // Absolute standard Kotlin invocations retain module-local caches but share JVM/JIT/BTA
        // infrastructure. Unknown flags, relative paths and custom plugins keep their own cwd.
        const cwd = unit.tool === "kotlinc" && portableKotlinArguments(args) ? this.cwd : unit.project;
        const key = `${cwd}\0${unit.tool}`;
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
        if (await this.abiChanged(unit)) {
          for (const consumer of this.units) if (consumer.dependencies.has(unit)) consumer.dirty = true;
        }
        unit.dirty = false;
        failed = undefined;
      }
      this.initialized = true;
    } catch (error) {
      // Only an acknowledged transactional rollback keeps outputs, ABI and IC state coherent.
      // Other diagnostics retain classpath snapshots; transport/internal failures discard those too.
      if (failed && !preserveIncremental) await this.clean(failed, preserveClasspath);
      throw error;
    } finally {
      this.updating = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const worker of this.workers.values()) worker.dispose();
    this.workers.clear();
  }

  private accepts(unit: Unit, file: string): boolean {
    return (unit.tool === "kotlinc" ? sourceExtension.test(file) : file.endsWith(".java"))
      && (unit.explicit.has(file) || unit.selections.some((selection) => selection.matches(file)));
  }

  private async snapshot(unit: Unit, documents: ReadonlyMap<string, string>): Promise<boolean> {
    const roots = [...new Set(unit.selections.map((selection) => selection.root))];
    const files = new Set([...unit.explicit, ...(await Promise.all(roots.map((root) => walk(root, (file) => this.accepts(unit, file))))).flat()]);
    for (const file of documents.keys()) if (this.accepts(unit, file)) files.add(file);
    const next = new Map<string, Source>();
    let changed = false;
    for (const file of [...files].sort()) {
      this.signal.throwIfAborted();
      let content = documents.get(file);
      if (content === undefined) {
        try { content = await readFile(file, "utf8"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
      }
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

/** Keep packaged resources, never old bytecode or Kotlin module metadata as a fallback. */
async function archiveResources(archive: string, destination: string, signal: AbortSignal): Promise<Set<string>> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true, autoClose: false, strictFileNames: true }, (error, file) => {
      if (error) reject(error);
      else if (file) resolve(file);
      else reject(new Error(`Cannot open workspace archive ${archive}.`));
    });
  });
  const names = new Set<string>();
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
      names.add(entry.fileName);
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
