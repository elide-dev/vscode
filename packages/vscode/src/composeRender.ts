import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ComposeRuntime } from "./composeRuntime.js";

const run = promisify(execFile);
const protocolLimit = 8 * 1024 * 1024;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface ComposeRenderInputs {
  classPath: string[];
  projectClassPath: string[];
  sourceSelections: Record<string, string[]>;
  namespace: string;
  resourceApkPath: string;
}

/** One `@Preview` configuration as the render JVM's discovery reports it (`DiscoverPreviews`). */
export interface CompiledPreview {
  methodFQN: string;
  previewId: string;
  name: string;
  previewParams: Record<string, string>;
  methodParams: Record<string, string>[];
}

export interface PreviewLayoutNode {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  source?: {
    fileName: string;
    packageHash: number;
    lineNumber: number;
    offset: number;
    length: number;
  };
}

export interface PreviewImage {
  id: string;
  name: string;
  detail: string;
  data?: string;
  error?: string;
  width?: number;
  height?: number;
  nodes?: PreviewLayoutNode[];
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): value is Record<string, string> {
  return object(value) && Object.values(value).every((item) => typeof item === "string");
}

function compiledPreview(value: unknown): value is CompiledPreview {
  return object(value) && typeof value.methodFQN === "string" && typeof value.previewId === "string"
    && typeof value.name === "string" && strings(value.previewParams)
    && Array.isArray(value.methodParams) && value.methodParams.every(strings);
}

interface ScreenshotResult {
  id: string;
  previewId: string;
  imagePath?: string;
  error?: unknown;
  nodes?: unknown;
}

function screenshotResult(value: unknown): value is ScreenshotResult {
  return object(value) && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 1024
    && typeof value.previewId === "string"
    && (value.imagePath === undefined || typeof value.imagePath === "string");
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= 0x7fff_ffff;
}

/** Never forward unchecked renderer metadata to the webview or source resolver. */
function layoutNodes(value: unknown, width: number, height: number): PreviewLayoutNode[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 2048) throw new Error("Invalid Compose layout metadata.");
  const ids = new Set<string>();
  for (const node of value) {
    if (!object(node) || typeof node.id !== "string" || !node.id || node.id.length > 128 || ids.has(node.id)
      || typeof node.name !== "string" || !node.name || node.name.length > 512
      || !integer(node.x) || !integer(node.y) || !integer(node.width, 1) || !integer(node.height, 1)
      || node.x + node.width > width || node.y + node.height > height) {
      throw new Error("Invalid Compose layout bounds.");
    }
    ids.add(node.id);
    const source = node.source;
    if (source !== undefined && (!object(source)
      || typeof source.fileName !== "string" || !source.fileName || source.fileName.length > 1024
      || /[/\\\0]/.test(source.fileName)
      || !integer(source.packageHash, -0x8000_0000) || !integer(source.lineNumber, -1)
      || !integer(source.offset, -1) || !integer(source.length, -1)
      || (source.offset >= 0 && source.length >= 0 && source.offset + source.length > 0x7fff_ffff))) {
      throw new Error("Invalid Compose layout source location.");
    }
  }
  return value as PreviewLayoutNode[];
}

/** Shared boundary for persisted gallery images and renderer messages. */
export function isPreviewImage(value: unknown): value is PreviewImage {
  if (!object(value) || typeof value.id !== "string" || !value.id || value.id.length > 1024
    || typeof value.name !== "string" || typeof value.detail !== "string"
    || (value.data !== undefined && typeof value.data !== "string")
    || (value.error !== undefined && typeof value.error !== "string")) return false;
  const hasDimensions = value.width !== undefined || value.height !== undefined;
  if (hasDimensions && (!integer(value.width, 1) || !integer(value.height, 1))) return false;
  if (value.nodes !== undefined) {
    if (!integer(value.width, 1) || !integer(value.height, 1)) return false;
    try {
      layoutNodes(value.nodes, value.width, value.height);
    } catch {
      return false;
    }
  }
  return true;
}

interface PendingResponse {
  id: number;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface WorkerResult {
  order: string[];
  images: { previewId: string; image: PreviewImage; weight: number }[];
  previews: CompiledPreview[];
}

/** Each worker owns one single-threaded layoutlib; compiled helpers are shared on disk. */
class RenderWorker {
  private readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<Record<string, unknown>>;
  private pending?: PendingResponse;
  private stdout = "";
  private logs = "";
  private dead = false;
  private rendering = false;
  private generation = 0;
  private readonly abort = (): void => { this.fail(new Error("Compose renderer cancelled.")); };

  constructor(
    java: string, runtime: ComposeRuntime, classesDirectory: string,
    private readonly directory: string, private readonly signal: AbortSignal,
    private readonly shardIndex: number, private readonly shardCount: number,
    private readonly onFailure: () => void,
  ) {
    // Favor first-edit latency over long-running throughput; other JVMs may ignore HotSpot tuning.
    this.child = spawn(java, ["-Djava.awt.headless=true", "--enable-native-access=ALL-UNNAMED",
      "-XX:+IgnoreUnrecognizedVMOptions", "-XX:TieredStopAtLevel=1", "-cp",
      [classesDirectory, ...runtime.rendererClassPath].join(path.delimiter), "RenderServer", runtime.layoutlibPath],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.ready = this.response(0);
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.receive(chunk));
    this.child.stderr.on("data", (chunk: string) => { this.logs = (this.logs + chunk).slice(-64 * 1024); });
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("close", (code, terminationSignal) => {
      this.fail(new Error(`Compose renderer exited (${terminationSignal ?? code}).`));
      void rm(directory, { recursive: true, force: true }).catch(() => {});
    });
    signal.addEventListener("abort", this.abort, { once: true });
    if (signal.aborted) this.abort();
  }


  get alive(): boolean { return !this.dead; }

  private response(id: number): Promise<Record<string, unknown>> {
    const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
    this.pending = {
      id, resolve, reject,
      timer: setTimeout(() => this.fail(new Error("Compose preview rendering timed out.")), 60_000),
    };
    return promise;
  }

  private receive(chunk: string): void {
    if (this.dead) return;
    this.stdout += chunk;
    if (this.stdout.length > protocolLimit) {
      this.fail(new Error("Compose renderer exceeded its response limit."));
      return;
    }
    let newline: number;
    while ((newline = this.stdout.indexOf("\n")) !== -1) {
      const line = this.stdout.slice(0, newline);
      this.stdout = this.stdout.slice(newline + 1);
      try {
        const value: unknown = JSON.parse(line);
        const pending = this.pending;
        if (!pending || !object(value) || (pending.id === 0 ? value.ready !== true : value.id !== pending.id)) {
          throw new Error("Invalid Compose renderer protocol response.");
        }
        this.pending = undefined;
        clearTimeout(pending.timer);
        pending.resolve(value);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }

  private fail(error: Error): void {
    if (this.dead) return;
    this.dead = true;
    this.signal.removeEventListener("abort", this.abort);
    this.child.kill("SIGKILL");
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${error.message}${this.logs ? `\n${this.logs}` : ""}`));
    }
    this.stdout = "";
    this.onFailure();
  }

  async render(inputs: ComposeRenderInputs, sourceFile: string, packageName: string, weights: Record<string, number>): Promise<WorkerResult> {
    if (this.dead) throw new Error("Compose renderer is no longer running.");
    if (this.rendering) throw new Error("Compose renderer requests must be serialized.");
    this.rendering = true;
    const id = ++this.generation;
    const outputFolder = path.join(this.directory, `images-${id}`);
    try {
      await mkdir(outputFolder);
      this.signal.throwIfAborted();
      if (this.dead) throw new Error("Compose renderer is no longer running.");
      const request = JSON.stringify({
        id, ...inputs, sourceFile: path.basename(sourceFile), packageName, outputFolder,
        shardIndex: this.shardIndex, shardCount: this.shardCount, weights,
      });
      if (Buffer.byteLength(request) > protocolLimit) throw new Error("Compose renderer request exceeds its protocol limit.");
      const response = this.response(id);
      this.child.stdin.write(`${request}\n`, (error) => { if (error) this.fail(error); });
      const results = await response;
      if (typeof results.globalError === "string" && results.globalError) throw new Error(results.globalError);
      if (!Array.isArray(results.previews) || !results.previews.every(compiledPreview)
        || !Array.isArray(results.screenshotResults) || !results.screenshotResults.every(screenshotResult)) {
        throw new Error("Invalid Compose renderer result.");
      }
      const previews = new Map(results.previews.map((preview) => [preview.previewId, preview]));
      const images: WorkerResult["images"] = [];
      const imageIds = new Set<string>();
      const root = await realpath(outputFolder);
      for (const result of results.screenshotResults) {
        const preview = previews.get(result.previewId);
        if (!preview) throw new Error("Renderer returned an unknown preview identifier.");
        if (!result.id.startsWith(`${result.previewId}:`) || imageIds.has(result.id)) {
          throw new Error("Renderer returned an invalid or duplicate image identifier.");
        }
        imageIds.add(result.id);
        const image: PreviewImage = { id: result.id, name: preview.name, detail: preview.methodFQN };
        let weight = 1;
        if (result.error) image.error = JSON.stringify(result.error, null, 2);
        else if (result.imagePath) {
          const file = await realpath(path.resolve(outputFolder, result.imagePath));
          const relative = path.relative(root, file);
          if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error("Renderer returned an image outside its output directory.");
          }
          const png = await readFile(file);
          if (png.length < 24 || !png.subarray(0, 8).equals(pngSignature)
            || png.toString("ascii", 12, 16) !== "IHDR") throw new Error("Renderer output is not a PNG image.");
          const width = png.readUInt32BE(16);
          const height = png.readUInt32BE(20);
          if (!integer(width, 1) || !integer(height, 1)) throw new Error("Renderer output has invalid PNG dimensions.");
          image.width = width;
          image.height = height;
          image.nodes = layoutNodes(result.nodes, width, height);
          weight += width * height / 1_000_000;
          image.data = png.toString("base64");
        } else image.error = "Renderer returned neither an image nor a diagnostic.";
        images.push({ previewId: result.previewId, image, weight });
      }
      return { order: [...previews.keys()], images, previews: results.previews };
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      this.rendering = false;
      await rm(outputFolder, { recursive: true, force: true });
    }
  }

  dispose(): void { this.fail(new Error("Compose renderer disposed.")); }
}

/** One atomic gallery generation, using at most six independent, persistent render JVMs. */
export class ComposeRenderer {
  private disposed = false;
  private rendering = false;
  private weights: Record<string, number> = {};
  /** The last render's discovered previews, in gallery order; the Komodo engine names its entries from them. */
  discovery: readonly CompiledPreview[] = [];

  private constructor(private readonly workers: RenderWorker[], private readonly directory: string) {}

  static async create(
    runtime: ComposeRuntime, java: string, helperDirectory: string, cacheRoot: string, directory: string, signal: AbortSignal,
  ): Promise<ComposeRenderer> {
    signal.throwIfAborted();
    await mkdir(directory, { recursive: true });
    const sessionDirectory = await mkdtemp(path.join(directory, "renderer-"));
    const workers: RenderWorker[] = [];
    let renderer: ComposeRenderer | undefined;
    try {
      const classes = await compiledHelpers(runtime, java, helperDirectory, cacheRoot, signal);
      const count = Math.max(1, Math.min(6, Math.floor(availableParallelism() / 2)));
      const directories = Array.from({ length: count }, (_, index) => path.join(sessionDirectory, `worker-${index}`));
      await Promise.all(directories.map((workerDirectory) => mkdir(workerDirectory)));
      const failure = (): void => {
        renderer?.dispose();
        for (const worker of workers) worker.dispose();
      };
      for (const [index, workerDirectory] of directories.entries()) {
        workers.push(new RenderWorker(java, runtime, classes, workerDirectory, signal, index, count, failure));
      }
      renderer = new ComposeRenderer(workers, sessionDirectory);
      await Promise.all(workers.map((worker) => worker.ready));
      return renderer;
    } catch (error) {
      for (const worker of workers) worker.dispose();
      await rm(sessionDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  get alive(): boolean { return !this.disposed && this.workers.every((worker) => worker.alive); }

  async render(inputs: ComposeRenderInputs, sourceFile: string, packageName: string): Promise<PreviewImage[]> {
    if (!this.alive) {
      this.dispose();
      throw new Error("Compose renderer is no longer running.");
    }
    if (this.rendering) throw new Error("Compose renderer requests must be serialized.");
    this.rendering = true;
    try {
      const shards = await Promise.all(this.workers.map((worker) => worker.render(inputs, sourceFile, packageName, this.weights)));
      const order = shards[0]!.order;
      if (shards.some((shard) => shard.order.length !== order.length || shard.order.some((id, index) => id !== order[index]))) {
        throw new Error("Compiled preview discovery changed during rendering.");
      }
      const images = shards.flatMap((shard) => shard.images);
      const positions = new Map(order.map((id, index) => [id, index]));
      const rendered = new Set(images.map((result) => result.previewId));
      if (order.some((id) => !rendered.has(id))) throw new Error("Compose renderer produced no result for a preview.");
      this.weights = {};
      for (const result of images) this.weights[result.previewId] = (this.weights[result.previewId] ?? 0) + result.weight;
      // Stable sorting preserves provider expansion order within each preview configuration.
      images.sort((left, right) => positions.get(left.previewId)! - positions.get(right.previewId)!);
      this.discovery = shards[0]!.previews;
      return images.map((result) => result.image);
    } catch (error) {
      this.dispose();
      throw error;
    } finally {
      this.rendering = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const worker of this.workers) worker.dispose();
    void rm(this.directory, { recursive: true, force: true }).catch(() => {});
  }
}

const helperSources = ["DiscoverPreviews.java", "RenderServer.java"];

/** Identifies the renderer code: pinned runtime plus helper sources. Equal digests render equal images. */
export async function helperDigest(runtime: ComposeRuntime, helperDirectory: string): Promise<string> {
  const hash = createHash("sha256").update(JSON.stringify(runtime.rendererClassPath));
  for (const file of ["CompileRenderer.java", ...helperSources]) hash.update(file).update("\0").update(await readFile(path.join(helperDirectory, file)));
  return hash.digest("hex");
}

/**
 * Helpers compile against the pinned runtime with `--release 17`, so the classes depend only on
 * their sources and that runtime. Compile once per content key and reuse across sessions.
 */
async function compiledHelpers(runtime: ComposeRuntime, java: string, helperDirectory: string, cacheRoot: string, signal: AbortSignal): Promise<string> {
  const root = path.join(cacheRoot, "compose-helpers");
  const destination = path.join(root, (await helperDigest(runtime, helperDirectory)).slice(0, 24));
  const ready = async (): Promise<boolean> => {
    try { return (await stat(path.join(destination, "RenderServer.class"))).isFile() && (await stat(path.join(destination, "ready"))).isFile(); }
    catch { return false; }
  };
  if (await ready()) return destination;
  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(path.join(root, "staging-"));
  try {
    await run(java, ["-cp", runtime.rendererClassPath.join(path.delimiter),
      path.join(helperDirectory, "CompileRenderer.java"), staging, ...helperSources.map((file) => path.join(helperDirectory, file))],
    { signal, timeout: 60_000, killSignal: "SIGKILL", maxBuffer: protocolLimit, windowsHide: true });
    await writeFile(path.join(staging, "ready"), "");
    try { await rename(staging, destination); }
    catch (error) {
      // Another extension host published the same content key first.
      if (!await ready()) throw error;
    }
    return destination;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
