import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { composePreviewInputs, type AndroidTargetModel, type ProjectModel } from "@elide/ide-core";
import { ComposeCompiler } from "./composeCompiler.js";
import { ComposeRenderer, helperDigest, isPreviewImage, type PreviewImage } from "./composeRender.js";
import type { ComposeRuntime } from "./composeRuntime.js";
import type { ComposeWorker } from "./composeWorker.js";

/** Runs async sections one at a time; a failed section never blocks later ones. */
class Queue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(section: () => Promise<T>): Promise<T> {
    const result = this.tail.then(section);
    this.tail = result.catch(() => {});
    return result;
  }
}

function previewImages(value: unknown): value is PreviewImage[] {
  return Array.isArray(value) && value.every(isPreviewImage) && new Set(value.map((image) => image.id)).size === value.length;
}

const STORED_GALLERIES = 48;

/**
 * Galleries by the exact inputs that rendered them: build fingerprint, compiler source text, previewed
 * file and renderer. Shared by every backend and window; replaying one skips compiling and rendering.
 */
export class ImageStore {
  constructor(private readonly directory: string) {}

  async get(key: string): Promise<PreviewImage[] | undefined> {
    try {
      const images: unknown = JSON.parse(await readFile(path.join(this.directory, `${key}.json`), "utf8"));
      return previewImages(images) ? images : undefined;
    } catch {
      return undefined;
    }
  }

  async set(key: string, images: PreviewImage[]): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = path.join(this.directory, `${key}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(images));
      await rename(temporary, path.join(this.directory, `${key}.json`));
    } finally {
      await rm(temporary, { force: true });
    }
    const files = (await readdir(this.directory)).filter((file) => file.endsWith(".json"));
    if (files.length <= STORED_GALLERIES) return;
    const dated = await Promise.all(files.map(async (file) => {
      try { return { file, time: (await stat(path.join(this.directory, file))).mtimeMs }; }
      catch { return { file, time: Infinity }; }
    }));
    dated.sort((left, right) => left.time - right.time);
    await Promise.all(dated.slice(0, dated.length - STORED_GALLERIES).map(({ file }) => rm(path.join(this.directory, file), { force: true })));
  }
}

/** The build a compiler is derived from. */
export interface PreviewBuild {
  model: ProjectModel;
  artifact: AndroidTargetModel;
  models: readonly ProjectModel[];
  bin: string;
}

export interface PreviewRequest {
  /** Open editor text of the project's sources, by path. */
  documents: ReadonlyMap<string, string>;
  sourceFile: string;
  packageName: string;
}

/**
 * Warm Compose preview infrastructure for one Android resource context: render JVMs, Elide compiler
 * workers and the current compiler. It outlives preview panels (keep-alive) and may start before
 * one opens (prewarm). Lock order: `compiling`, then `rendering`; renders only read published classes.
 */
export class ComposeBackend {
  private readonly controller = new AbortController();
  private readonly workers = new Map<string, ComposeWorker>();
  private readonly compiling = new Queue();
  private readonly rendering = new Queue();
  private directory: Promise<string> | undefined;
  private renderer: ComposeRenderer | undefined;
  private rendererSetup: { runtime: ComposeRuntime; java: string } | undefined;
  /** Renderer code and JDK the next render uses; part of every stored gallery key. */
  private rendererIdentity: Promise<string> | undefined;
  private current: ComposeCompiler | undefined;
  /** The current render JVMs completed a render, so their JIT and layoutlib are warm. */
  private rendered = false;
  /** Open preview panels using this backend. */
  users = 0;
  disposed = false;

  constructor(readonly key: string, private readonly cacheRoot: string, private readonly helperDirectory: string, private readonly store: ImageStore) {}

  get compiler(): ComposeCompiler | undefined { return this.current; }

  /** Start (or keep) the render JVMs for this JDK and runtime. */
  startRenderer(runtime: ComposeRuntime, java: string): Promise<void> {
    this.rendererIdentity = helperDigest(runtime, this.helperDirectory)
      .then((digest) => createHash("sha256").update(`${digest}\0${java}`).digest("hex"));
    this.rendererIdentity.catch(() => {});
    return this.rendering.run(async () => {
      if (this.renderer?.alive && this.rendererSetup?.java === java && this.rendererSetup.runtime.layoutlibPath === runtime.layoutlibPath) return;
      this.rendererSetup = { runtime, java };
      await this.createRenderer();
    });
  }

  /**
   * Derive a compiler from the build's current outputs. An equivalent existing compiler, warm
   * incremental state included, is kept. Without `verified`, the outputs may predate the sources.
   * Returns whether the published classes changed, so images rendered before are stale.
   */
  async configure(build: PreviewBuild, documents: ReadonlyMap<string, string>, verified: boolean): Promise<boolean> {
    const inputs = await composePreviewInputs(build.model, build.artifact, build.models);
    const candidate = await ComposeCompiler.create(build.bin, build.model.root, inputs, await this.workDirectory(), this.controller.signal, this.workers);
    let adopted = false;
    try {
      // Equivalence needs no lock: a compile in progress (warming, for example) keeps it.
      const kept = this.current;
      if (kept?.sameBuild(candidate) && kept.ready) return false;
      return await this.compiling.run(async () => {
        const previous = this.current;
        if (previous?.sameBuild(candidate)) return !previous.ready && await this.seed(previous, documents, verified);
        // Swap only between render generations: a running render reads the previous classes.
        await this.rendering.run(async () => {
          this.current = candidate;
          adopted = true;
          previous?.dispose();
          await previous?.remove();
        });
        await this.seed(candidate, documents, verified);
        return true;
      });
    } finally {
      if (!adopted) {
        candidate.dispose();
        await candidate.remove();
      }
    }
  }

  /**
   * Images for `request`: a stored gallery when these exact inputs rendered before, otherwise compile
   * what changed and render. Without `compile`, a compiler holding no classes yet returns undefined
   * instead of compiling from scratch.
   */
  preview(request: PreviewRequest): Promise<PreviewImage[]>;
  preview(request: PreviewRequest, compile: boolean): Promise<PreviewImage[] | undefined>;
  async preview(request: PreviewRequest, compile = true): Promise<PreviewImage[] | undefined> {
    for (;;) {
      const compiler = this.current;
      if (!compiler) throw new Error("Compose preview has no compiler inputs; build the project first.");
      const sources = await compiler.sources(request.documents);
      const stored = await this.stored(compiler, sources.key, request);
      if (stored) {
        this.prime(request);
        return stored;
      }
      if (!compile && !compiler.ready) return undefined;
      if (sources.key !== compiler.publishedSources) {
        const replaced = await this.compiling.run(async () => {
          if (this.current !== compiler) return true;
          if (compiler.publishedSources === sources.key) return false;
          await compiler.update(sources);
          await this.rendering.run(() => compiler.publish());
          return false;
        });
        if (replaced) continue;
      }
      const images = await this.rendering.run(async () => this.current === compiler ? await this.render(compiler, request) : undefined);
      if (images) return images;
    }
  }

  /**
   * Replace seeded build classes by this compiler's own output, priming incremental compilation so the
   * next edit compiles warm, and render once if stored galleries left the JVMs cold.
   */
  async warm(request: PreviewRequest): Promise<void> {
    const compiler = this.current;
    if (compiler?.seeded) {
      await this.compiling.run(async () => {
        if (this.current !== compiler || !compiler.seeded) return;
        await compiler.update(await compiler.sources(request.documents), true);
        await this.rendering.run(() => compiler.publish());
      });
    }
    this.prime(request);
  }

  /** Stored galleries skip rendering; render once in the background so JVMs are warm for the first edit. */
  private prime(request: PreviewRequest): void {
    if (this.rendered) return;
    this.rendering.run(async () => {
      const compiler = this.current;
      if (!this.rendered && compiler?.ready) await this.render(compiler, request);
    }).catch(() => {});
  }

  /** Under `rendering`: render the published classes and store the gallery under their inputs. */
  private async render(compiler: ComposeCompiler, request: PreviewRequest): Promise<PreviewImage[]> {
    if (!this.renderer?.alive) await this.createRenderer();
    const published = compiler.publishedSources!;
    const images = await this.renderer!.render(compiler.inputs, request.sourceFile, request.packageName);
    this.rendered = true;
    const key = await this.galleryKey(compiler, published, request);
    if (key) this.store.set(key, images).catch(() => {});
    return images;
  }

  /**
   * Bring everything up before a panel asks: render JVMs, the compiler from the last build's outputs,
   * one gallery for `request` (stored for the panel) and incremental compilation. Never builds.
   */
  async prewarm(build: PreviewBuild, runtime: ComposeRuntime, java: string, request: PreviewRequest): Promise<void> {
    const renderer = this.startRenderer(runtime, java);
    try {
      await this.configure(build, request.documents, false);
    } catch {
      // Never built, or a build is rewriting its outputs: the next panel builds first.
      await renderer;
      return;
    }
    await renderer;
    await this.preview(request);
    await this.warm(request);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    this.renderer?.dispose();
    this.current?.dispose();
    for (const worker of this.workers.values()) worker.dispose();
    this.workers.clear();
    const directory = this.directory;
    if (directory) void directory.then((value) => rm(value, { recursive: true, force: true })).catch(() => {});
  }

  private workDirectory(): Promise<string> {
    this.controller.signal.throwIfAborted();
    return this.directory ??= mkdtemp(path.join(tmpdir(), "elide-compose-"));
  }

  private async galleryKey(compiler: ComposeCompiler, sources: string, request: PreviewRequest): Promise<string | undefined> {
    const renderer = await this.rendererIdentity?.catch(() => undefined);
    if (!renderer) return undefined;
    return createHash("sha256").update([compiler.fingerprint, sources, renderer, request.sourceFile, request.packageName,
      compiler.seeded ? "build-classes" : "preview-source-information"].join("\0")).digest("hex");
  }

  private async stored(compiler: ComposeCompiler, sources: string, request: PreviewRequest): Promise<PreviewImage[] | undefined> {
    const key = await this.galleryKey(compiler, sources, request);
    return key ? await this.store.get(key) : undefined;
  }

  /** Under `rendering`. */
  private async createRenderer(): Promise<void> {
    const setup = this.rendererSetup;
    if (!setup) throw new Error("Compose renderer was never started.");
    this.renderer?.dispose();
    this.renderer = undefined;
    this.rendered = false;
    this.renderer = await ComposeRenderer.create(setup.runtime, setup.java, this.helperDirectory, this.cacheRoot, await this.workDirectory(), this.controller.signal);
  }

  /** Under `compiling`. */
  private async seed(compiler: ComposeCompiler, documents: ReadonlyMap<string, string>, verified: boolean): Promise<boolean> {
    if (!await compiler.seed(await compiler.sources(documents), verified)) return false;
    await this.rendering.run(() => compiler.publish());
    return true;
  }
}

/** At most one idle backend; panels hold theirs, idle ones expire after the keep-alive period. */
export class ComposeBackends {
  private readonly backends = new Map<string, ComposeBackend>();
  private readonly timers = new Map<ComposeBackend, NodeJS.Timeout>();
  private readonly store: ImageStore;

  constructor(private readonly cacheRoot: string, private readonly helperDirectory: string, private readonly keepAlive: () => number) {
    this.store = new ImageStore(path.join(cacheRoot, "compose-images"));
  }

  /** The backend for `key`, created when missing. Creating one releases other idle backends. */
  obtain(key: string): ComposeBackend {
    const existing = this.backends.get(key);
    if (existing && !existing.disposed) return existing;
    for (const backend of this.backends.values()) if (!backend.users) this.drop(backend);
    const backend = new ComposeBackend(key, this.cacheRoot, this.helperDirectory, this.store);
    this.backends.set(key, backend);
    return backend;
  }

  acquire(key: string): ComposeBackend {
    const backend = this.obtain(key);
    backend.users++;
    clearTimeout(this.timers.get(backend));
    this.timers.delete(backend);
    return backend;
  }

  release(backend: ComposeBackend): void {
    backend.users = Math.max(0, backend.users - 1);
    if (!backend.users) this.idle(backend);
  }

  /** (Re)start the keep-alive countdown of an unused backend. */
  idle(backend: ComposeBackend): void {
    if (backend.users || backend.disposed) return;
    clearTimeout(this.timers.get(backend));
    const delay = this.keepAlive();
    if (delay <= 0) {
      this.drop(backend);
      return;
    }
    const timer = setTimeout(() => this.drop(backend), delay);
    timer.unref();
    this.timers.set(backend, timer);
  }

  /** Apply a changed keep-alive period to every unused backend. */
  rearm(): void {
    for (const backend of [...this.backends.values()]) this.idle(backend);
  }

  /** Dispose unused backends whose key no longer satisfies `keep`. */
  retain(keep: (key: string) => boolean): void {
    for (const backend of this.backends.values()) if (!backend.users && !keep(backend.key)) this.drop(backend);
  }

  dispose(): void {
    for (const backend of this.backends.values()) this.drop(backend);
  }

  private drop(backend: ComposeBackend): void {
    clearTimeout(this.timers.get(backend));
    this.timers.delete(backend);
    if (this.backends.get(backend.key) === backend) this.backends.delete(backend.key);
    backend.dispose();
  }
}
