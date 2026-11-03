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
  /** Rendered live (the Komodo engine): the card takes pointer input and updates by push. */
  live?: boolean;
  width?: number;
  height?: number;
  nodes?: PreviewLayoutNode[];
  /** Inspection failed without invalidating the rendered pixels. */
  layoutError?: string;
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
export function layoutNodes(value: unknown, width: number, height: number): PreviewLayoutNode[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 2048) throw new Error("Invalid Compose layout metadata.");
  const ids = new Set<string>();
  for (const node of value) {
    if (!object(node) || typeof node.id !== "string" || !node.id || node.id.length > 2048 || ids.has(node.id)
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

/** Visible text of a layoutlib problem's HTML summary, without its link to the details printed beside it. */
function htmlText(html: string): string {
  return html.replace(/\s*\(?<a\b[^>]*>[\s\S]*?<\/a>\)?/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .trim();
}

/**
 * A renderer `ScreenshotError` as a person reads it: each problem's summary and stack trace, not the result envelope,
 * whose `status` describes the render session rather than the preview. layoutlib reports a composable's exception
 * twice, also wrapped in the reflective call's `InvocationTargetException`; the wrapper is dropped.
 */
export function screenshotErrorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (!object(error)) return "The renderer reported a failure without details.";
  const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
  const problems = [
    { summary: text(error.message), trace: text(error.stackTrace) },
    ...(Array.isArray(error.problems) ? error.problems : []).filter(object)
      .map((problem) => ({ summary: htmlText(text(problem.html)), trace: text(problem.stackTrace) })),
  ].filter((problem) => problem.summary || problem.trace);
  const headlines = new Set(problems.map((problem) => problem.trace.split("\n", 1)[0]!.trim()).filter(Boolean));
  const traces = new Set<string>();
  const sections: string[] = [];
  for (const problem of problems) {
    const causes = problem.trace.split("\n").filter((line) => line.startsWith("Caused by: ")).map((line) => line.slice("Caused by: ".length).trim());
    if (problem.trace && (traces.has(problem.trace) || causes.some((cause) => headlines.has(cause)))) continue;
    if (problem.trace) traces.add(problem.trace);
    sections.push([problem.summary, problem.trace].filter(Boolean).join("\n"));
  }
  const classes = (value: unknown) => (Array.isArray(value) ? value : []).map((entry) => typeof entry === "string" ? entry
    : object(entry) ? [text(entry.className), text(entry.stackTrace)].filter(Boolean).join("\n") : "").filter(Boolean);
  const missing = classes(error.missingClasses);
  if (missing.length) sections.push(`Missing classes:\n${missing.join("\n")}`);
  const broken = classes(error.brokenClasses);
  if (broken.length) sections.push(`Classes that could not be initialized:\n${broken.join("\n\n")}`);
  if (!sections.length) {
    const status = text(error.status);
    sections.push(`The renderer reported a failure without details${status && status !== "SUCCESS" ? ` (status ${status})` : ""}.`);
  }
  return sections.join("\n\n");
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
}

/** Render weight (about one small preview image) one render JVM serves before another one is worth its memory. */
const WEIGHT_PER_WORKER = 4;
/** JVMs a smaller gallery leaves idle stop after this long without a render needing them. */
const SURPLUS_IDLE_MS = 60_000;
/**
 * A JVM that neither answers nor reports a rendered image for this long is hung. RenderServer bounds each image's
 * render steps (up to about 100 s in all) and reports it as a failed card; a shard of many images may take far longer.
 */
const RENDER_STALL_MS = 120_000;

/**
 * Render JVMs for a gallery of `weight` (see {@link ComposeRenderer}): each holds layoutlib, the runtime and the
 * application's classes, several hundred MB, so one per few previews, at most four and half the cores.
 */
export function renderWorkersFor(weight: number, parallelism = availableParallelism()): number {
  return Math.max(1, Math.min(4, Math.floor(parallelism / 2), Math.ceil(weight / WEIGHT_PER_WORKER)));
}

/** Each worker owns one single-threaded layoutlib; compiled helpers are shared on disk. */
class RenderWorker {
  private readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<Record<string, unknown>>;
  /** Answered its ready handshake. */
  started = false;
  /** Takes shards: one of the first JVMs, or one that rendered a whole gallery alone, so it is not cold. */
  joined = false;
  warming = false;
  private pending?: PendingResponse;
  private stdout = "";
  private logs = "";
  private dead = false;
  /** Stopped as surplus, not failed: its exit must not fail the renderer. */
  private retired = false;
  private rendering = false;
  private generation = 0;
  private readonly abort = (): void => { this.fail(new Error("Compose renderer cancelled.")); };

  constructor(
    java: string, runtime: ComposeRuntime, classesDirectory: string,
    private readonly directory: string, private readonly signal: AbortSignal,
    private readonly onFailure: (error: Error) => void, private readonly stallMs: number,
  ) {
    signal.throwIfAborted();
    // Favor first-edit latency over long-running throughput; other JVMs may ignore HotSpot tuning.
    this.child = spawn(java, ["-Djava.awt.headless=true", "--enable-native-access=ALL-UNNAMED",
      "-XX:+IgnoreUnrecognizedVMOptions", "-XX:TieredStopAtLevel=1", "-cp",
      [classesDirectory, ...runtime.rendererClassPath].join(path.delimiter), "RenderServer", runtime.layoutlibPath],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.ready = this.response(0);
    this.ready.then(() => { this.started = true; }, () => {});
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
      timer: setTimeout(() => this.fail(new Error("Compose preview rendering timed out.")), this.stallMs),
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
        // Another image of the shard is done: the JVM is working, however long the whole shard takes.
        if (pending.id !== 0 && value.progress === true) {
          pending.timer.refresh();
          continue;
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
    const failure = new Error(`${error.message}${this.logs ? `\n${this.logs}` : ""}`, { cause: error });
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.stdout = "";
    if (!this.retired) this.onFailure(failure);
  }

  /**
   * `affinity` maps preview IDs to the shard that rendered them last, identically for every shard of a request. `methods` names
   * the preview functions to render (a selection); absent, every preview of the file renders.
   */
  async render(inputs: ComposeRenderInputs, sourceFile: string, packageName: string, weights: Record<string, number>,
    affinity: Record<string, number>, shardIndex: number, shardCount: number, methods?: readonly string[]): Promise<WorkerResult> {
    if (this.dead) throw new Error("Compose renderer is no longer running.");
    if (this.rendering) throw new Error("Compose renderer requests must be serialized.");
    this.rendering = true;
    const id = ++this.generation;
    const outputFolder = path.join(this.directory, `images-${id}`);
    try {
      await mkdir(outputFolder, { recursive: true });
      this.signal.throwIfAborted();
      if (this.dead) throw new Error("Compose renderer is no longer running.");
      const request = JSON.stringify({
        id, ...inputs, sourceFile: path.basename(sourceFile), packageName, outputFolder,
        shardIndex, shardCount, weights, affinity, methods: methods ?? null,
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
        if (result.error) image.error = screenshotErrorText(result.error);
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
      return { order: [...previews.keys()], images };
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      this.rendering = false;
      await rm(outputFolder, { recursive: true, force: true });
    }
  }

  dispose(): void { this.fail(new Error("Compose renderer disposed.")); }

  retire(): void {
    this.retired = true;
    this.fail(new Error("Compose renderer stopped as surplus."));
  }
}

export interface RendererOptions {
  /** Expected render weight of the first gallery, sizing the JVMs started up front; later renders resize the pool. */
  weight?: number;
  surplusIdleMs?: number;
  /** How long after an abandoned warm-up no warm-up or replacement JVM starts. */
  quietMs?: number;
  /** How long a JVM may go without answering or reporting a rendered image before it counts as hung. */
  stallMs?: number;
}

/** Classes still being republished (live typing) make warm-ups wasted work; wait for a pause this long. */
const WARMUP_QUIET_MS = 3_000;

/**
 * One atomic gallery generation over independent, persistent render JVMs, as many as the last gallery's render
 * weight needs (see {@link renderWorkersFor}). A larger gallery starts more in the background, which join the next
 * render; a smaller one stops the surplus once it has idled.
 */
export class ComposeRenderer {
  private disposed = false;
  private rendering = false;
  private failure: Error | undefined;
  private weights: Record<string, number> = {};
  /** The shard that last rendered each preview, so every JVM computes the same assignment, new ones included. */
  private affinity: Record<string, number> = {};
  private surplus: NodeJS.Timeout | undefined;
  /** Counts abandoned warm-up generations: a warm-up joins only if none was abandoned while it ran. */
  private warmups = 0;
  /** No warm-up or growth starts before this time, set when warm-ups are abandoned. */
  private quietUntil = 0;

  private constructor(
    private readonly workers: RenderWorker[], private readonly directory: string,
    private readonly spawn: (joined: boolean) => RenderWorker, private readonly surplusIdleMs: number, private readonly quietMs: number,
  ) {}

  static async create(
    runtime: ComposeRuntime, java: string, helperDirectory: string, cacheRoot: string, directory: string, signal: AbortSignal,
    options: RendererOptions = {},
  ): Promise<ComposeRenderer> {
    signal.throwIfAborted();
    await mkdir(directory, { recursive: true });
    const sessionDirectory = await mkdtemp(path.join(directory, "renderer-"));
    const workers: RenderWorker[] = [];
    let renderer: ComposeRenderer | undefined;
    try {
      const classes = await compiledHelpers(runtime, java, helperDirectory, cacheRoot, signal);
      signal.throwIfAborted();
      const failure = (error: Error): void => {
        renderer?.dispose(error);
        for (const worker of workers) worker.dispose();
      };
      let started = 0;
      // A JVM still warming up serves no paint: its failure drops only that JVM, and the next render starts another.
      const spawn = (joined: boolean): RenderWorker => {
        const worker: RenderWorker = new RenderWorker(java, runtime, classes, path.join(sessionDirectory, `worker-${started++}`), signal,
          (error) => worker.joined ? failure(error) : renderer?.drop(worker), options.stallMs ?? RENDER_STALL_MS);
        worker.joined = joined;
        return worker;
      };
      for (let count = renderWorkersFor(options.weight ?? 1); workers.length < count;) workers.push(spawn(true));
      renderer = new ComposeRenderer(workers, sessionDirectory, spawn, options.surplusIdleMs ?? SURPLUS_IDLE_MS, options.quietMs ?? WARMUP_QUIET_MS);
      await Promise.all(workers.map((worker) => worker.ready));
      return renderer;
    } catch (error) {
      for (const worker of workers) worker.dispose();
      await rm(sessionDirectory, { recursive: true, force: true }).catch(() => {});
      throw renderer?.failure ?? error;
    }
  }

  get alive(): boolean { return !this.disposed && this.workers.every((worker) => worker.alive); }

  /** Render JVMs running or starting. */
  get size(): number { return this.workers.length; }

  /** Render weight of the last gallery (see {@link RendererOptions.weight}); 0 before the first render. */
  get weight(): number { return Object.values(this.weights).reduce((sum, weight) => sum + weight, 0); }

  /**
   * `methods` renders only those preview functions of the file (a selection). Such a gallery's weights and affinities join the
   * last ones instead of replacing them, so a selection's render never shrinks the pool its file's full gallery needs.
   */
  async render(inputs: ComposeRenderInputs, sourceFile: string, packageName: string, methods?: readonly string[]): Promise<PreviewImage[]> {
    if (!this.alive) {
      this.dispose();
      throw new Error("Compose renderer is no longer running.");
    }
    if (this.rendering) throw new Error("Compose renderer requests must be serialized.");
    this.rendering = true;
    clearTimeout(this.surplus);
    try {
      const workers = this.workers.filter((worker) => worker.joined);
      const shards = await Promise.all(workers.map((worker, index) =>
        worker.render(inputs, sourceFile, packageName, this.weights, this.affinity, index, workers.length, methods)));
      const order = shards[0]!.order;
      if (shards.some((shard) => shard.order.length !== order.length || shard.order.some((id, index) => id !== order[index]))) {
        throw new Error("Compiled preview discovery changed during rendering.");
      }
      const images = shards.flatMap((shard) => shard.images);
      const positions = new Map(order.map((id, index) => [id, index]));
      const rendered = new Set(images.map((result) => result.previewId));
      if (order.some((id) => !rendered.has(id))) throw new Error("Compose renderer produced no result for a preview.");
      if (!methods) {
        this.weights = {};
        this.affinity = {};
      } else for (const id of order) delete this.weights[id];
      for (const result of images) this.weights[result.previewId] = (this.weights[result.previewId] ?? 0) + result.weight;
      for (const [index, shard] of shards.entries()) for (const result of shard.images) this.affinity[result.previewId] = index;
      // A JVM started for a larger gallery first renders this one alone, in the background, so a cold JVM never
      // slows a paint; it takes shards from a later render on. Not while classes are being republished.
      for (const worker of performance.now() < this.quietUntil ? [] : this.workers) {
        if (!worker.started || worker.joined || worker.warming) continue;
        worker.warming = true;
        const generation = this.warmups;
        worker.render(inputs, sourceFile, packageName, this.weights, this.affinity, 0, 1, methods)
          .then(() => { worker.joined ||= generation === this.warmups; }, () => {}).finally(() => { worker.warming = false; });
      }
      this.fit(renderWorkersFor(this.weight));
      // Stable sorting preserves provider expansion order within each preview configuration.
      images.sort((left, right) => positions.get(left.previewId)! - positions.get(right.previewId)!);
      return images.map((result) => result.image);
    } catch (error) {
      this.dispose(error instanceof Error ? error : new Error(String(error)));
      // A failing shard cancels its siblings. Their cleanup may finish first; report the
      // initiating error rather than whichever cancellation happened to reject first.
      throw this.failure ?? error;
    } finally {
      this.rendering = false;
    }
  }

  /**
   * The caller is about to rewrite or remove the last gallery's classes, which background warm-ups read outside its
   * render lock. A warm-up in progress is discarded rather than stopped: each render loads project classes in a
   * fresh class loader, and its stable loader is rebuilt when the inputs change, so the JVM's state stays sound;
   * a failure drops only that JVM. No warm-up or replacement JVM starts until publications pause for `quietMs`,
   * so live typing never keeps a JVM busy with work that is thrown away.
   */
  abandonWarmups(): void {
    this.warmups++;
    this.quietUntil = performance.now() + this.quietMs;
  }

  private drop(worker: RenderWorker): void {
    const index = this.workers.indexOf(worker);
    if (index >= 0) this.workers.splice(index, 1);
  }

  /** Start the JVMs a larger gallery needs; stop those a smaller one leaves idle after `surplusIdleMs`. */
  private fit(wanted: number): void {
    if (performance.now() >= this.quietUntil) while (this.workers.length < wanted) this.workers.push(this.spawn(false));
    if (this.workers.length <= wanted) return;
    this.surplus = setTimeout(() => {
      // A render in progress re-evaluates its own need when it finishes.
      if (this.disposed || this.rendering) return;
      for (const worker of this.workers.splice(wanted)) worker.retire();
    }, this.surplusIdleMs);
    this.surplus.unref();
  }

  dispose(error?: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failure = error;
    clearTimeout(this.surplus);
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
