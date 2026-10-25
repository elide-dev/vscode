import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { inside, type WorkspacePaths } from "./workspacePaths.js";

const prefix = "plugin:org.jetbrains.kotlin.kapt3:";

/**
 * A build record that does not describe this checkout's last build: it names another checkout, or outputs that no
 * longer exist, as when the build cache restored records written elsewhere. A build without the cache rewrites it.
 */
export class StaleBuildRecordError extends Error {
  constructor(readonly record: string, detail: string) {
    super(`Stale build record ${record}: ${detail}. Rebuild the preview inputs without the build cache (elide build --no-cache) to rewrite it.`);
    this.name = "StaleBuildRecordError";
  }
}

export interface KotlinToolchainRecord {
  version: 1;
  kind: "embedded" | "managed" | "external";
  home?: string;
  classpath?: string[];
}

export async function kotlinToolchain(record: string): Promise<KotlinToolchainRecord> {
  let value: KotlinToolchainRecord;
  try { value = JSON.parse(await readFile(record, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Compose preview needs the Kotlin toolchain record at ${record}. Rebuild with a current Elide version.`, { cause: error });
    throw error;
  }
  if (!value || value.version !== 1 || !["embedded", "managed", "external"].includes(value.kind)
    || (value.kind === "external" && (typeof value.home !== "string" || !path.isAbsolute(value.home)))
    || (value.kind === "managed" && (!Array.isArray(value.classpath) || !value.classpath.length || !value.classpath.every((entry) => typeof entry === "string" && path.isAbsolute(entry))))) {
    throw new Error(`Invalid Kotlin toolchain record: ${record}. Rebuild with a current Elide version.`);
  }
  return value;
}

export function toolchainOptions(toolchain: KotlinToolchainRecord): string[] {
  if (toolchain.kind === "managed") return [`--toolchain-classpath=${toolchain.classpath!.join(path.delimiter)}`];
  return toolchain.kind === "external" ? [`--toolchain-home=${toolchain.home}`] : [];
}

async function files(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return (await Promise.all(entries.map((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? files(file) : [file];
    }))).flat().sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function outputFingerprint(directory: string, extension = ""): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await files(directory)) {
    if (file.endsWith(extension)) hash.update(path.relative(directory, file)).update("\0").update(await readFile(file)).update("\0");
  }
  return hash.digest("hex");
}

/** kapt hashes Java declarations, not diagnostic source-position metadata (.kapt_metadata). */
export async function stubFingerprint(directory: string): Promise<string> {
  return outputFingerprint(directory, ".java");
}

/** Java ObjectOutputStream block-data framing around DataOutput's int + modified-UTF map. */
export function decodeProcessorOptions(encoded: string): Map<string, string> {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.readUInt32BE(0) !== 0xaced0005) throw new Error("Invalid kapt processor option stream.");
  const blocks: Buffer[] = [];
  for (let offset = 4; offset < bytes.length;) {
    const tag = bytes[offset++]!;
    const length = tag === 0x77 ? bytes[offset++]! : tag === 0x7a ? bytes.readUInt32BE(offset) : -1;
    if (tag === 0x7a) offset += 4;
    if (length < 0 || offset + length > bytes.length) throw new Error("Invalid kapt processor option block.");
    blocks.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  const data = Buffer.concat(blocks);
  let offset = 4;
  const utf = (): string => {
    const length = data.readUInt16BE(offset);
    offset += 2;
    const end = offset + length;
    if (end > data.length) throw new Error("Truncated kapt processor option.");
    let result = "";
    while (offset < end) {
      const byte = data[offset++]!;
      const code = byte < 0x80 ? byte : byte < 0xe0
        ? ((byte & 0x1f) << 6) | (data[offset++]! & 0x3f)
        : ((byte & 0x0f) << 12) | ((data[offset++]! & 0x3f) << 6) | (data[offset++]! & 0x3f);
      result += String.fromCharCode(code);
    }
    return result;
  };
  const options = new Map<string, string>();
  const count = data.readInt32BE(0);
  if (count < 0 || count > data.length / 4) throw new Error("Invalid kapt processor option count.");
  for (let index = 0; index < count; index++) options.set(utf(), utf());
  if (offset !== data.length) throw new Error("Trailing kapt processor option data.");
  return options;
}

export function encodeProcessorOptions(options: ReadonlyMap<string, string>): string {
  const count = Buffer.alloc(4);
  count.writeInt32BE(options.size);
  const values: Buffer[] = [count];
  for (const entry of options) for (const text of entry) {
    const bytes: number[] = [];
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code > 0 && code < 0x80) bytes.push(code);
      else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      else bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
    if (bytes.length > 0xffff) throw new Error("kapt processor option exceeds Java UTF limit.");
    const length = Buffer.alloc(2);
    length.writeUInt16BE(bytes.length);
    values.push(length, Buffer.from(bytes));
  }
  const data = Buffer.concat(values);
  const header = Buffer.alloc(9);
  header.writeUInt32BE(0xaced0005);
  header[4] = 0x7a;
  header.writeUInt32BE(data.length, 5);
  return Buffer.concat([header, data]).toString("base64");
}

function option(arg: string): { name: string; value: string } | undefined {
  if (arg.startsWith("-P=")) arg = arg.slice(3);
  if (!arg.startsWith(prefix)) return undefined;
  const equals = arg.indexOf("=", prefix.length);
  if (equals < 0) throw new Error(`Invalid kapt option: ${arg}`);
  return { name: arg.slice(prefix.length, equals), value: arg.slice(equals + 1) };
}

export class ComposeProcessing {
  readonly generated = new Map<string, string>();
  readonly counts = { stubs: 0, apt: 0 };
  private stubKey: string | undefined;
  private externalKey: string | undefined;
  private readonly options: Map<string, string>;
  private readonly paths = new Map<string, string>();
  private readonly dependencies: string[];
  private readonly stubs: string;
  readonly classes: string;
  private readonly sources: string;

  get requiresBytecodeTransform(): boolean { return this.options.has("dagger.hilt.android.internal.disableAndroidSuperclassValidation"); }

  private constructor(
    readonly args: string[], readonly roots: string[], readonly directory: string, readonly project: string,
  ) {
    const values = args.map(option).filter((value) => value !== undefined);
    const encoded = values.find((value) => value.name === "apoptions")?.value;
    this.options = encoded ? decodeProcessorOptions(encoded) : new Map();
    this.dependencies = values.filter((value) => value.name === "apclasspath").map((value) => path.resolve(project, value.value));
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (!/^(?:-classpath|-cp|--class-path|-Xmodule-path)(?:=|$)/.test(arg)) continue;
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++index];
      if (value === undefined) throw new Error(`Missing processing classpath in ${project}.`);
      for (const entry of value.split(path.delimiter)) {
        const file = path.resolve(project, entry);
        if (!this.owns(file)) this.dependencies.push(file);
      }
    }
    for (const [key, value] of this.options) {
      if (key === "kapt.kotlin.generated") continue;
      if (value && (path.isAbsolute(value) || /(?:location|directory|dir|path|file)$/i.test(key))) this.paths.set(key, path.resolve(project, value));
    }
    this.stubs = path.join(directory, "stubs");
    this.classes = path.join(directory, "classes");
    this.sources = path.join(directory, "attempt", "sources");
  }

  /** `paths` respells the record's canonical project paths the way the workspace spells them. */
  static async create(record: string, directory: string, project: string, paths: WorkspacePaths): Promise<ComposeProcessing | undefined> {
    let args: string[];
    try {
      args = (await readFile(record, "utf8")).split("\n");
      if (args.at(-1) === "") args.pop();
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const provenancePath = path.join(path.dirname(record), "kapt.generated.json");
    const provenance = JSON.parse(await readFile(provenancePath, "utf8")) as { version: number; roots: string[]; files: string[] };
    if (provenance.version !== 1 || !Array.isArray(provenance.roots) || !provenance.roots.length
      || !provenance.roots.every((root) => typeof root === "string" && path.isAbsolute(root))
      || !Array.isArray(provenance.files) || !provenance.files.every((file) => typeof file === "string" && path.isAbsolute(file))) {
      throw new Error(`Invalid generated source provenance: ${provenancePath}`);
    }
    const roots = provenance.roots.map((root) => paths.lexical(root));
    const foreign = roots.find((root) => !inside(project, root));
    if (foreign) throw new StaleBuildRecordError(provenancePath, `its generated sources are in ${foreign}, outside ${project}`);
    const stage = new ComposeProcessing(args.map((arg) => paths.argument(arg)), roots, directory, project);
    await mkdir(stage.classes, { recursive: true });
    for (const file of provenance.files.map((file) => paths.lexical(file))) {
      if (!stage.owns(file)) throw new Error(`Generated file outside recorded roots: ${file}`);
      try {
        if (/\.(?:java|kt)$/.test(file)) stage.generated.set(file, await readFile(file, "utf8"));
        else {
          const root = roots.find((root) => file.startsWith(`${root}${path.sep}`))!;
          const destination = path.join(stage.classes, path.relative(root, file));
          await mkdir(path.dirname(destination), { recursive: true });
          await cp(file, destination);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        throw new StaleBuildRecordError(provenancePath, `the generated file ${file} it lists does not exist`);
      }
    }
    return stage;
  }

  owns(file: string): boolean {
    return this.roots.some((root) => inside(root, file));
  }

  async inputs(stamp: (file: string) => Promise<string>): Promise<string> {
    const hash = createHash("sha256").update(this.args.join("\n"));
    for (const file of [...this.dependencies, ...this.paths.values()]) hash.update(file).update("\0").update(await stamp(file)).update("\0");
    return hash.digest("hex");
  }

  /** Isolated stubs first; only commit generated inputs after apt succeeds. */
  async verify(args: string[], externalKey: string, run: (args: string[]) => Promise<void>): Promise<boolean> {
    await rm(this.stubs, { recursive: true, force: true });
    await rm(path.join(this.directory, "attempt"), { recursive: true, force: true });
    await mkdir(this.stubs, { recursive: true });
    await mkdir(this.sources, { recursive: true });
    await mkdir(path.join(this.directory, "attempt", "classes"), { recursive: true });
    this.counts.stubs++;
    await run(this.arguments(args, "stubs"));
    const stubKey = await stubFingerprint(this.stubs);
    if (stubKey === this.stubKey && externalKey === this.externalKey) return false;
    await rm(this.sources, { recursive: true, force: true });
    await mkdir(this.sources, { recursive: true });
    for (const [key, source] of this.paths) {
      const target = this.optionPath(key, source);
      await rm(target, { recursive: true, force: true });
      await mkdir(path.dirname(target), { recursive: true });
      try { await cp(source, target, { recursive: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    this.counts.apt++;
    await run(this.arguments(args, "apt"));
    const generated = new Map<string, string>();
    for (const file of await files(this.sources)) {
      if (/\.(?:java|kt)$/.test(file)) generated.set(path.join(this.roots[0]!, path.relative(this.sources, file)), await readFile(file, "utf8"));
      else {
        const destination = path.join(this.directory, "attempt", "classes", path.relative(this.sources, file));
        await mkdir(path.dirname(destination), { recursive: true });
        await cp(file, destination);
      }
    }
    const classes = path.join(this.directory, "attempt", "classes");
    const changed = generated.size !== this.generated.size
      || [...generated].some(([file, text]) => this.generated.get(file) !== text)
      || await outputFingerprint(classes) !== await outputFingerprint(this.classes);
    if (changed) {
      await rm(this.classes, { recursive: true, force: true });
      await rename(classes, this.classes);
      this.generated.clear();
      for (const [file, text] of generated) this.generated.set(file, text);
    }
    // Changed declarations can produce identical output (for example a new composable beside
    // Room entities). Confirm those inputs without discarding warm compiler state or repainting.
    this.stubKey = stubKey;
    this.externalKey = externalKey;
    return changed;
  }

  private optionPath(key: string, source: string): string {
    return path.join(this.directory, "options", createHash("sha256").update(key).digest("hex").slice(0, 16), path.basename(source));
  }

  private arguments(args: string[], mode: "stubs" | "apt"): string[] {
    const options = new Map(this.options);
    options.set("kapt.kotlin.generated", this.sources);
    for (const [key, source] of this.paths) options.set(key, this.optionPath(key, source));
    const processingClasses = path.join(this.directory, "attempt", "classes");
    const overrides: Record<string, string> = {
      aptMode: mode, sources: this.sources, stubs: this.stubs, classes: processingClasses, apoptions: encodeProcessorOptions(options),
      incrementalData: path.join(this.directory, "attempt", "incremental-data"),
      dumpFileReadHistory: path.join(this.directory, "attempt", "file-read-history.txt"),
      dumpProcessorStats: path.join(this.directory, "attempt", "processor-stats.txt"),
    };
    const result: string[] = [];
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      const parsed = option(arg);
      if (parsed && parsed.name in overrides) result.push(`${arg.startsWith("-P=") ? "-P=" : ""}${prefix}${parsed.name}=${overrides[parsed.name]}`);
      else if (arg === "-d") { result.push(arg, processingClasses); index++; }
      else if (arg.startsWith("-d=")) result.push(`-d=${processingClasses}`);
      else result.push(arg);
    }
    return result;
  }
}
