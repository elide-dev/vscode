import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { composePreviewAnnotations, composePreviewInputs, type AndroidTargetModel, type ProjectModel, type TimelineNode } from "@elide/ide-core";
import { ComposeCompiler } from "./composeCompiler.js";
import type { ComposeSources } from "./composeCompiler.js";
import { StaleBuildRecordError } from "./composeProcessing.js";
import { ComposeRenderer, helperDigest, isPreviewImage, type CompiledPreview, type PreviewImage } from "./composeRender.js";
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

/** A card failed to render: such a gallery is never replayed, since the failure may not recur (a timeout on a busy machine). */
function failed(images: readonly PreviewImage[]): boolean {
  return images.some((image) => image.error !== undefined);
}

const STORED_GALLERIES = 48;

/**
 * Galleries by the exact inputs that rendered them: build fingerprint, compiler source text, previewed
 * file and renderer. Shared by every backend and window; replaying one skips compiling and rendering.
 * Galleries with failed cards are neither stored nor replayed.
 */
export class ImageStore {
  constructor(private readonly directory: string) {}

  async get(key: string): Promise<PreviewImage[] | undefined> {
    try {
      const images: unknown = JSON.parse(await readFile(path.join(this.directory, `${key}.json`), "utf8"));
      return previewImages(images) && !failed(images) ? images : undefined;
    } catch {
      return undefined;
    }
  }

  async set(key: string, images: PreviewImage[]): Promise<void> {
    if (failed(images)) return;
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

/** A compiler message at a source location (`file` absolute, lines and columns 1-based). */
export interface CompileMessage {
  level: "error" | "warning";
  text: string;
  file?: string;
  line?: number;
  column?: number;
}

/** Generated preview functions and the previews to render instead of every preview `sourceFile` declares. */
export interface PreviewSelection {
  /** Text appended to program files for this preview only (generated wrappers), by absolute path; never saved. */
  appendices: ReadonlyMap<string, string>;
  /** The previews to render, in order (generated wrappers and existing `@Preview` functions). */
  previews: readonly CompiledPreview[];
  /** Program files besides `sourceFile` whose previews are selected (komodo hosts them in one session). */
  files: readonly string[];
}

export interface PreviewRequest {
  /** Open editor text of the project's sources, by path. */
  documents: ReadonlyMap<string, string>;
  sourceFile: string;
  packageName: string;
  /** Require inspection support: snapshot source instrumentation or live measured layout metadata. */
  inspect?: boolean;
  /** Render only these previews, compiled with their appendices; absent, every preview of `sourceFile`. */
  selection?: PreviewSelection;
}

/** The texts `request` compiles: its documents, each appendix appended to its file's editor text or else its saved text. */
export async function previewDocuments(request: PreviewRequest): Promise<ReadonlyMap<string, string>> {
  const appendices = request.selection?.appendices;
  if (!appendices?.size) return request.documents;
  const documents = new Map(request.documents);
  for (const [file, text] of appendices) documents.set(file, (request.documents.get(file) ?? await readFile(file, "utf8")) + text);
  return documents;
}

/** The preview functions a selection renders, sorted and distinct; undefined renders every preview of the file. */
function selectedMethods(request: PreviewRequest): string[] | undefined {
  return request.selection && [...new Set(request.selection.previews.map((preview) => preview.methodFQN))].sort();
}

/** Browser key identity and modifier state; composition and clipboard text are not keyboard events. */
export interface PreviewKeyEvent {
  action: "down" | "up";
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat: boolean;
}

/** Named keys accepted by the native keyboard capability, in addition to printable Unicode code points. */
export const PREVIEW_KEY_NAMES = [
  "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", "Tab",
  "Escape", "Home", "End", "PageUp", "PageDown", "Insert", "Shift", "Control", "Alt", "Meta",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
] as const;

/** Validate messages before using the same input handler as the extension API. */
export function isPreviewKeyEvent(value: unknown): value is PreviewKeyEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  if ((event.action !== "down" && event.action !== "up") || typeof event.key !== "string" || typeof event.code !== "string"
    || !["shiftKey", "ctrlKey", "altKey", "metaKey", "repeat"].every((name) => typeof event[name] === "boolean")) return false;
  const point = event.key.codePointAt(0);
  return PREVIEW_KEY_NAMES.some((key) => key === event.key)
    || [...event.key].length === 1 && point! >= 32 && point !== 127 && !(point! >= 0xd800 && point! <= 0xdfff);
}

/** A gallery's provenance travels with its pixels, never with mutable backend-wide state. */
export interface PreviewGallery {
  images: PreviewImage[];
  verified: boolean;
  reused: boolean;
}

interface CachedGallery {
  images: PreviewImage[];
  verified: boolean;
  fingerprint: string;
  sources: string;
}

/** Workspaces of older versions name no owner; untouched this long, no running host still uses one. */
const UNOWNED_WORKSPACE_AGE_MS = 24 * 60 * 60 * 1000;

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Another user's process.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove the backend workspaces in `root` of extension hosts that have exited. A host that is closed, reloaded or crashes
 * cannot remove its own, and each holds copies of a project's classes and its compiler caches.
 */
async function sweepWorkspaces(root: string): Promise<void> {
  await Promise.all((await readdir(root, { withFileTypes: true })).map(async (entry) => {
    if (!entry.isDirectory()) return;
    const directory = path.join(root, entry.name);
    const owner = /^elide-compose-(\d+)-[A-Za-z0-9]{6}$/.exec(entry.name);
    if (owner) {
      const pid = Number(owner[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0 || running(pid)) return;
    } else {
      if (!/^elide-compose-[A-Za-z0-9]{6}$/.test(entry.name)) return;
      // Renderers and compilers add entries to the workspace while their host runs.
      const files = [directory, ...(await readdir(directory)).map((name) => path.join(directory, name))];
      const changed = Math.max(...await Promise.all(files.map((file) => stat(file).then((stats) => stats.mtimeMs, () => Infinity))));
      if (Date.now() - changed < UNOWNED_WORKSPACE_AGE_MS) return;
    }
    await rm(directory, { recursive: true, force: true });
  }).map((sweep) => sweep.catch(() => {})));
}

/**
 * Warm Compose preview infrastructure for one Android resource context: render JVMs, Elide compiler
 * workers and the current compiler. It outlives preview panels (keep-alive) and may start before
 * one opens (prewarm). Lock order: `configuring`, `compiling`, then `rendering`; renders only read published classes.
 */
export class ComposeBackend {
  private readonly controller = new AbortController();
  private readonly workers = new Map<string, ComposeWorker>();
  private readonly configuring = new Queue();
  private readonly compiling = new Queue();
  private readonly rendering = new Queue();
  private directory: Promise<string> | undefined;
  private renderer: ComposeRenderer | undefined;
  /**
   * `weight` sizes a new renderer's first JVMs; its renders resize the pool to each gallery. It keeps the last gallery's
   * weight, so a renderer replacing a failed one starts as many JVMs as the gallery needs.
   */
  private rendererSetup: { runtime: ComposeRuntime; java: string; weight: number; identity: Promise<string> } | undefined;
  /**
   * Renderer code and JDK the next render uses, to look up stored galleries. A gallery is stored under its own renderer's
   * identity (`rendererSetup`, changed only under the render lock): a render queued before a JDK change uses the old JVMs.
   */
  private rendererIdentity: Promise<string> | undefined;
  private current: ComposeCompiler | undefined;
  /** Verification of the published classes, changed only under the render lock. */
  private publishedVerified = false;
  /** Unverified galleries stay in memory until processing confirms their exact inputs. */
  private readonly galleries = new Map<string, CachedGallery>();
  /** Renderer initialization belongs to a compiler's private classpath, not just the JVM process. */
  private renderedCompiler: ComposeCompiler | undefined;
  private renderedInstrumented = false;
  /** Open preview panels using this backend. */
  users = 0;
  disposed = false;
  /** The engine rendering this backend's cards (`elide.android.composePreview.engine`). */
  readonly engine: string = "layoutlib";

  constructor(readonly key: string, private readonly cacheRoot: string, private readonly helperDirectory: string, private readonly store: ImageStore) {}

  get compiler(): ComposeCompiler | undefined { return this.current; }

  /** The backend's lifetime: aborted when it is disposed. */
  protected get signal(): AbortSignal { return this.controller.signal; }

  /** The next refresh first replaces seeded build classes by this backend's own compile (see {@link warm}). */
  get needsWarmup(): boolean { return this.current?.needsWarmup ?? false; }

  /** Annotation processing must confirm what an edit compiled (see {@link verify}). */
  get processingRequired(): boolean { return this.current?.processingRequired ?? false; }

  /** Pointer input on a live card (image pixels; `dx`/`dy` scroll by); false when this backend renders the card as a snapshot. */
  pointer(_imageId: string, _action: "down" | "up" | "move" | "scroll", _x: number, _y: number, _dx?: number, _dy?: number): boolean { return false; }

  /** Whether this live card accepts browser keyboard events; snapshots and older daemons do not. */
  keyboardSupported(_imageId: string): boolean { return false; }

  keyboard(_imageId: string, _event: PreviewKeyEvent): boolean { return false; }

  /** Release held keys and native focus for this card only. */
  blur(_imageId: string): boolean { return false; }

  /** A scene is being replaced, removed or disconnected; release focus before accepting further input. */
  onInputReset(_listener: (imageId?: string) => void): () => void { return () => {}; }

  /** Cards updated after `preview` resolved (live engines push frames); the snapshot engine never pushes. */
  onImages(_listener: (images: PreviewImage[]) => void): () => void { return () => {}; }

  /** Compile messages for the panel's diagnostics (live engines compile edits themselves); the snapshot engine reports none. */
  onCompile(_listener: (outcome: { failed: boolean; messages: CompileMessage[] }) => void): () => void { return () => {}; }

  /**
   * A live engine's session ended on its own (a language-server reload or restart, a crash): the panel previews again to reconnect.
   * The snapshot engine has no session to lose.
   */
  onSessionLost(_listener: () => void): () => void { return () => {}; }

  /**
   * `previous` is being replaced and its directory deleted, under the render lock: a live engine stops compiling and rendering
   * against its inputs (its published class copies) here, and the deletion waits for what it returns. Snapshot renders already
   * hold the render lock.
   */
  protected retire(_previous: ComposeCompiler): Promise<void> | void {}

  /**
   * An unsaved edit of `file` for a live session, sent as soon as the editor reports it: a live engine applies it without waiting for
   * the panel's refresh (which may still be confirming the open's build). The snapshot engine renders edits in its refresh only.
   */
  edit(_file: string, _text: string): void {}

  /** Whether the preview compiles `file`'s editor text itself; an edit of another source needs it saved and built. */
  compiles(file: string): boolean {
    return this.compiler?.supports(file) ?? false;
  }

  /** `images` (a gallery `preview` returned) with the frames a live engine rendered since; the snapshot engine's are final. */
  latestImages(images: readonly PreviewImage[]): readonly PreviewImage[] {
    return images;
  }

  /**
   * Start (or keep) the render JVMs for this JDK and runtime, about one per few of the source's `previews`, or of the last
   * gallery's render weight when that is larger.
   */
  async startRenderer(runtime: ComposeRuntime, java: string, previews = 1): Promise<void> {
    this.controller.signal.throwIfAborted();
    const identity = helperDigest(runtime, this.helperDirectory)
      .then((digest) => createHash("sha256").update(`${digest}\0${java}`).digest("hex"));
    identity.catch(() => {});
    this.rendererIdentity = identity;
    return this.rendering.run(async () => {
      this.controller.signal.throwIfAborted();
      // Equal JDK and runtime is equal identity: the helper sources are the extension's own.
      const setup = this.rendererSetup;
      const same = setup?.java === java && setup.runtime.layoutlibPath === runtime.layoutlibPath
        && setup.runtime.rendererClassPath.join(path.delimiter) === runtime.rendererClassPath.join(path.delimiter) ? setup : undefined;
      if (this.renderer?.alive && same) return;
      this.rendererSetup = { runtime, java, weight: Math.max(previews, same?.weight ?? 0), identity };
      await this.createRenderer();
    });
  }

  /**
   * Derive a compiler from the build's current outputs. An equivalent existing compiler, warm
   * incremental state included, is kept; so is one whose build changed only input content, such as
   * linked resources or R classes (see {@link ComposeCompiler.rebase}). Without `verified`, the outputs
   * may predate the sources. Returns whether the published classes or their inputs changed, so images
   * rendered before are stale.
   */
  async configure(build: PreviewBuild, documents: ReadonlyMap<string, string>, verified: boolean): Promise<boolean> {
    this.controller.signal.throwIfAborted();
    return this.configuring.run(async () => {
      this.controller.signal.throwIfAborted();
      const inputs = await composePreviewInputs(build.model, build.artifact, build.models);
      const candidate = await ComposeCompiler.create(build.bin, build.model.root, inputs, await this.workDirectory(), this.controller.signal, this.workers);
      let adopted = false;
      try {
        this.controller.signal.throwIfAborted();
        // Equivalence needs no compile lock: an update in progress keeps the same compiler.
        const kept = this.current;
        if (kept?.sameBuild(candidate) && kept.ready) return false;
        return await this.compiling.run(async () => {
          this.controller.signal.throwIfAborted();
          const previous = this.current;
          if (previous?.sameBuild(candidate)) return !previous.ready && await this.seed(previous, documents, verified);
          // Between render generations, like a swap: renders read the inputs and key galleries by the fingerprint.
          const rebased = previous?.ready && await this.rendering.run(async () => {
            this.controller.signal.throwIfAborted();
            if (!previous.rebase(candidate)) return false;
            // Processing confirms the galleries of the new inputs again.
            this.publishedVerified = !previous.processingRequired;
            return true;
          });
          if (rebased) return true;
          // Swap only between render generations: a running render reads the previous classes.
          await this.rendering.run(async () => {
            this.controller.signal.throwIfAborted();
            this.current = candidate;
            this.publishedVerified = false;
            adopted = true;
            if (previous) await this.retire(previous);
            previous?.dispose();
            // Background warm-ups read the previous classes outside the render lock.
            this.renderer?.abandonWarmups();
            await previous?.remove();
          });
          // Workers of the previous toolchain, distribution or working directory serve no compiler any more.
          candidate.pruneWorkers();
          await this.seed(candidate, documents, verified);
          return true;
        });
      } finally {
        if (!adopted) {
          candidate.dispose();
          await candidate.remove();
        }
      }
    });
  }

  /**
   * Images for `request`: a stored gallery when these exact inputs rendered before, otherwise compile
   * what changed and render. Without `compile`, a compiler holding no classes yet returns undefined
   * instead of compiling from scratch. Compiling and rendering are timed as steps of `trace`.
   */
  preview(request: PreviewRequest, compile?: true, trace?: TimelineNode): Promise<PreviewGallery>;
  preview(request: PreviewRequest, compile: boolean, trace?: TimelineNode): Promise<PreviewGallery | undefined>;
  async preview(request: PreviewRequest, compile = true, trace?: TimelineNode): Promise<PreviewGallery | undefined> {
    for (;;) {
      this.controller.signal.throwIfAborted();
      const compiler = this.current;
      if (!compiler) throw new Error("Compose preview has no compiler inputs; build the project first.");
      if (request.inspect && !compiler.publishedInstrumented) {
        if (!compile) return undefined;
        await this.warm(request);
        if (this.current !== compiler) continue;
        if (!compiler.publishedInstrumented) throw new Error("Layout inspection requires preview source instrumentation; this build's bytecode post-processing cannot be replayed.");
      }
      const sources = await compiler.sources(await previewDocuments(request));
      const stored = await this.stored(compiler, sources.key, request);
      this.controller.signal.throwIfAborted();
      if (stored) {
        trace?.record("Stored gallery", 0, "succeeded", "these exact inputs rendered before");
        void this.prime(request).catch(() => {});
        return { images: stored, verified: true, reused: true };
      }
      if (!compile && !compiler.ready) return undefined;
      if (sources.key !== compiler.publishedSources && await this.publishSources(compiler, sources, trace)) continue;
      const images = await this.rendering.run(async () => {
        // Another request may have queued publication while these classes were still current.
        // Check under the render lock so a caller never receives another source generation.
        if (this.current !== compiler || compiler.publishedSources !== sources.key) return undefined;
        return trace ? await trace.run("Render", () => this.render(compiler, request)) : await this.render(compiler, request);
      });
      if (images) return images;
    }
  }

  /** Compiles and publishes `sources` unless they are published; true when another compiler replaced this one meanwhile. */
  private publishSources(compiler: ComposeCompiler, sources: ComposeSources, trace?: TimelineNode): Promise<boolean> {
    return this.compiling.run(async () => {
      if (this.current !== compiler) return true;
      if (compiler.publishedSources === sources.key) return false;
      await (trace ? trace.run("Compile", () => compiler.update(sources)) : compiler.update(sources));
      await this.rendering.run(() => this.publish(compiler));
      return false;
    });
  }

  /**
   * Confirm processing inputs after an optimistic paint, or recover a declaration edit whose first
   * compile failed against old generated code. A confirmed stored gallery needs neither operation.
   * Returns whether to fetch fresh pixels, including when another window stored a confirmed gallery.
   */
  async verify(request: PreviewRequest, trace?: TimelineNode): Promise<boolean> {
    return this.compiling.run(async () => {
      this.controller.signal.throwIfAborted();
      const compiler = this.current;
      if (!compiler) throw new Error("Compose preview has no compiler inputs; build the project first.");
      if (!compiler.processingRequired) return false;
      const sources = await compiler.sources(await previewDocuments(request));
      if (await this.stored(compiler, sources.key, request)) return true;
      return this.verifyCompiler(compiler, sources, trace);
    });
  }

  /** Under `compiling`; processing can overlap a render, but certification waits for publication. */
  private async verifyCompiler(compiler: ComposeCompiler, sources: ComposeSources, trace?: TimelineNode): Promise<boolean> {
    const changed = await (trace
      ? trace.run("Verify annotation processing", () => compiler.verify(sources))
      : compiler.verify(sources));
    await this.rendering.run(async () => {
      this.controller.signal.throwIfAborted();
      if (changed) await this.publish(compiler);
      else if (compiler.publishedSources === sources.key) this.publishedVerified = true;
      for (const [key, gallery] of this.galleries) {
        if (gallery.verified || gallery.fingerprint !== compiler.fingerprint || gallery.sources !== sources.key) continue;
        if (changed) this.galleries.delete(key);
        else {
          gallery.verified = true;
          this.store.set(key, gallery.images).catch(() => {});
        }
      }
    });
    return changed;
  }

  /**
   * Replace seeded build classes by this compiler's own output, priming incremental compilation so the
   * next edit compiles warm, and render once if stored galleries left the JVMs cold.
   */
  async warm(request: PreviewRequest): Promise<void> {
    await this.compiling.run(async () => {
      this.controller.signal.throwIfAborted();
      const compiler = this.current;
      if (!compiler?.needsWarmup) return;
      const sources = await compiler.sources(await previewDocuments(request));
      try {
        await compiler.update(sources, true);
      } catch (error) {
        if (!compiler.processingRequired) throw error;
        await compiler.verify(sources);
      }
      await this.rendering.run(() => this.publish(compiler));
      // Render this private classpath, not the discarded seed/candidate, while kapt verifies it.
      // Renderers read published copies; processing only writes private outputs until publication.
      const primed = this.prime(request);
      primed.catch(() => {});
      try {
        if (compiler.processingRequired && !compiler.isVerified(sources.key)) await this.verifyCompiler(compiler, sources);
      } catch (error) {
        await primed.catch(() => {});
        throw error;
      }
      await primed;
    });
  }

  /** Stored pixels need no seeded render; initialize the final private classpath once instead. */
  private async prime(request: PreviewRequest): Promise<void> {
    const current = this.current;
    if (!current?.ready || current.needsWarmup
      || this.renderedCompiler === current && (!current.publishedInstrumented || this.renderedInstrumented)) return;
    await this.rendering.run(async () => {
      const compiler = this.current;
      if (compiler?.ready && !compiler.needsWarmup
        && (this.renderedCompiler !== compiler || compiler.publishedInstrumented && !this.renderedInstrumented)) {
        await this.render(compiler, request);
      }
    });
  }

  /** Under `rendering`: only confirmed output may enter the persistent gallery store. */
  private async render(compiler: ComposeCompiler, request: PreviewRequest): Promise<PreviewGallery> {
    if (!this.renderer?.alive) await this.createRenderer();
    const published = compiler.publishedSources!;
    const images = await this.renderer!.render(compiler.inputs, request.sourceFile, request.packageName, selectedMethods(request));
    this.renderedCompiler = compiler;
    this.renderedInstrumented = compiler.publishedInstrumented;
    if (this.rendererSetup) this.rendererSetup.weight = this.renderer!.weight;
    const verified = !compiler.processingRequired || this.publishedVerified;
    const key = await this.galleryKey(compiler, published, request, compiler.publishedInstrumented, this.rendererSetup?.identity);
    if (key) {
      this.remember(key, { images, verified, fingerprint: compiler.fingerprint, sources: published });
      if (verified) this.store.set(key, images).catch(() => {});
    }
    return { images, verified, reused: false };
  }

  /**
   * Bring everything up before a panel asks: render JVMs, the compiler from the last build's outputs,
   * one gallery for `request` (stored for the panel) and incremental compilation. Never builds.
   * `onStep` names each phase as it starts, for progress reporting. Stops after the step in progress
   * once a panel uses this backend: it compiles its own, newer editor text, and would wait for these steps.
   */
  async prewarm(build: PreviewBuild, runtime: ComposeRuntime, java: string, request: PreviewRequest, onStep: (step: string) => void = () => {}): Promise<void> {
    onStep("starting the renderer and compiler");
    const [, configured] = await Promise.all([
      this.startRenderer(runtime, java, composePreviewAnnotations(request.documents.get(request.sourceFile) ?? "")),
      // Never built, or a build is rewriting its outputs: the next panel builds first. A stale record needs more
      // than that build, so its owner must hear of it.
      previewDocuments(request).then((documents) => this.configure(build, documents, false)).then(() => true, (error: unknown) => {
        if (error instanceof StaleBuildRecordError) throw error;
        return false;
      }),
    ]);
    if (!configured || this.users) return;
    onStep("rendering from the last build");
    try {
      await this.preview(request);
    } catch (error) {
      if (this.users) return;
      if (!this.current?.processingRequired) throw error;
      onStep("verifying annotation processing");
      await this.verify(request);
      if (this.users) return;
      await this.preview(request);
    }
    if (this.users) return;
    onStep("initializing the compiler");
    await this.warm(request);
    if (this.users) return;
    await this.preview(request);
    if (this.users) return;
    if (this.current?.processingRequired) onStep("verifying annotation processing");
    if (await this.verify(request) && !this.users) await this.preview(request);
    if (!this.users) await this.prime(request);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    this.renderer?.dispose();
    this.current?.dispose();
    for (const worker of this.workers.values()) worker.dispose();
    this.workers.clear();
    // Cancellation stops processes immediately, but filesystem operations and failure cleanup
    // must settle before removal, otherwise they can recreate the deleted workspace.
    void this.configuring.run(() => this.compiling.run(() => this.rendering.run(async () => {
      if (this.directory) await rm(await this.directory, { recursive: true, force: true });
    }))).catch(() => {});
  }

  private workDirectory(): Promise<string> {
    this.controller.signal.throwIfAborted();
    if (!this.directory) {
      const root = tmpdir();
      void sweepWorkspaces(root).catch(() => {});
      // The owner's PID lets later hosts remove the workspace when this one exits without doing so.
      this.directory = mkdtemp(path.join(root, `elide-compose-${process.pid}-`));
    }
    return this.directory;
  }

  private async galleryKey(compiler: ComposeCompiler, sources: string, request: PreviewRequest, instrumented = compiler.publishedInstrumented,
    identity = this.rendererIdentity): Promise<string | undefined> {
    const renderer = await identity?.catch(() => undefined);
    if (!renderer) return undefined;
    const methods = selectedMethods(request);
    return createHash("sha256").update(["verified-processing-v3", compiler.fingerprint, sources, renderer, request.sourceFile, request.packageName,
      instrumented ? "preview-source-information" : "build-classes", ...methods ? [`methods:${methods.join(",")}`] : []].join("\0")).digest("hex");
  }

  private async stored(compiler: ComposeCompiler, sources: string, request: PreviewRequest): Promise<PreviewImage[] | undefined> {
    // A confirmed instrumented gallery is valid for these exact sources even before a cold
    // compiler has reproduced it. Never downgrade Inspect to an image-only build gallery.
    for (const instrumented of compiler.publishedInstrumented || request.inspect ? [true] : [true, false]) {
      const key = await this.galleryKey(compiler, sources, request, instrumented);
      if (!key) return undefined;
      const cached = this.galleries.get(key);
      if (cached?.verified && !failed(cached.images)) return cached.images;
      const images = await this.store.get(key);
      if (!images) continue;
      this.remember(key, { images, verified: true, fingerprint: compiler.fingerprint, sources });
      return images;
    }
    return undefined;
  }

  private remember(key: string, gallery: CachedGallery): void {
    this.galleries.delete(key);
    this.galleries.set(key, gallery);
    if (this.galleries.size > STORED_GALLERIES) this.galleries.delete(this.galleries.keys().next().value!);
  }

  /** Under `rendering`. */
  private async createRenderer(): Promise<void> {
    const setup = this.rendererSetup;
    if (!setup) throw new Error("Compose renderer was never started.");
    this.renderer?.dispose();
    this.renderer = undefined;
    this.renderedCompiler = undefined;
    this.renderedInstrumented = false;
    this.renderer = await ComposeRenderer.create(setup.runtime, setup.java, this.helperDirectory, this.cacheRoot, await this.workDirectory(),
      this.controller.signal, { weight: setup.weight });
  }

  /** Under `rendering`: verification never races a render of the previous generated output. */
  private async publish(compiler: ComposeCompiler): Promise<void> {
    // Background warm-ups read the published classes outside the render lock.
    this.renderer?.abandonWarmups();
    await compiler.publish();
    this.publishedVerified = !compiler.processingRequired || compiler.isVerified(compiler.publishedSources!);
  }

  /** Under `compiling`. */
  private async seed(compiler: ComposeCompiler, documents: ReadonlyMap<string, string>, verified: boolean): Promise<boolean> {
    if (!await compiler.seed(await compiler.sources(documents), verified)) return false;
    await this.rendering.run(() => this.publish(compiler));
    return true;
  }
}

/** At most one idle backend; panels hold theirs, idle ones expire after the keep-alive period. */
export class ComposeBackends {
  private readonly backends = new Map<string, ComposeBackend>();
  private readonly timers = new Map<ComposeBackend, NodeJS.Timeout>();
  private readonly store: ImageStore;

  constructor(
    private readonly cacheRoot: string,
    private readonly helperDirectory: string,
    private readonly keepAlive: () => number,
    /** Creates the backend for the configured engine and its user (`agent`: {@link detached}); the layoutlib snapshot backend when absent. */
    private readonly create: (key: string, cacheRoot: string, helperDirectory: string, store: ImageStore, role: "panel" | "agent") => ComposeBackend =
      (key, cacheRoot, helperDirectory, store) => new ComposeBackend(key, cacheRoot, helperDirectory, store),
    private readonly engine: () => string = () => "layoutlib",
  ) {
    this.store = new ImageStore(path.join(cacheRoot, "compose-images"));
  }

  /**
   * The backend for `key`, created when missing. Creating one releases other idle backends. An unused backend of another
   * engine than the configured one is replaced; a panel keeps its backend until it closes.
   */
  obtain(key: string): ComposeBackend {
    const existing = this.backends.get(key);
    if (existing && !existing.disposed && (existing.engine === this.engine() || existing.users)) return existing;
    for (const backend of this.backends.values()) if (!backend.users) this.drop(backend);
    const backend = this.create(key, this.cacheRoot, this.helperDirectory, this.store, "panel");
    this.backends.set(key, backend);
    return backend;
  }

  /** A backend for the configured engine outside the pool, for an agent's previews: never stored or dropped here; the caller disposes it. */
  detached(key: string): ComposeBackend {
    return this.create(key, this.cacheRoot, this.helperDirectory, this.store, "agent");
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
    this.timers.delete(backend);
    const delay = this.keepAlive();
    if (delay <= 0) {
      this.drop(backend);
      return;
    }
    // Longer than a timer can wait (about 24.8 days), which would fire at once: keep it until it is dropped otherwise.
    if (delay > 0x7fff_ffff) return;
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
