import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { TimelineNode } from "@elide/ide-core";
import { ComposeBackend, isPreviewKeyEvent, type CompileMessage, type ImageStore, type PreviewBuild, type PreviewGallery, type PreviewKeyEvent, type PreviewRequest } from "./composeBackend.js";
import type { ComposeCompiler } from "./composeCompiler.js";
import { StaleBuildRecordError } from "./composeProcessing.js";
import { layoutNodes, type CompiledPreview, type PreviewImage } from "./composeRender.js";
import type { ComposeRuntime } from "./composeRuntime.js";

/** The daemon protocol this client speaks (Komodo's docs/VSCODE_PREVIEW.md, protocol 2). */
export const KOMODO_PROTOCOL = 2;
const lineLimit = 8 * 1024 * 1024;
/** How long a rebuild's compiler swap waits for the retired session's compile in flight (an edit's compile takes 0.3-1.5 s). */
const RETIRE_COMPILE_MS = 5_000;

export type KomodoEvent = Record<string, unknown> & { event: string };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The daemon cannot serve the extension (an older protocol): the preview shows why. */
export class KomodoUnavailable extends Error {}

/** Protocol-2 JSON lines over an authenticated loopback session in the workspace language server. */
interface KomodoChannel {
  readonly output: Readable;
  readonly input: Writable;
  readonly ended: Promise<string>;
  /** Closes this session without stopping the workspace language server. */
  stop(): void;
}

/**
 * A protocol-2 daemon over JSON lines, modeled on the render workers: the `ready` handshake with the protocol check, a line cap,
 * per-request timeouts, the channel stopped on failure. Events arrive in order; `next` waits for one.
 */
export class KomodoRenderer {
  private stdout = "";
  private readonly listeners = new Set<(event: KomodoEvent) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly waiters = new Set<{ match: (event: KomodoEvent) => boolean; resolve: (event: KomodoEvent) => void; reject: (error: Error) => void }>();
  private failure: Error | undefined;
  private ended = false;
  /** A `sources` command is sent and its `compile` answer has not arrived: the daemon may be reading the program's inputs. */
  private compiling = false;
  private readonly abort = (): void => { this.dispose(); };

  private constructor(private readonly channel: KomodoChannel, private readonly log: (line: string) => void, private readonly signal?: AbortSignal) {
    channel.output.setEncoding("utf8");
    channel.output.on("data", (chunk: string) => this.read(chunk));
    channel.input.on("error", (error) => this.fail(error));
    void channel.ended.then((reason) => {
      this.ended = true;
      this.fail(new Error(reason));
    });
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }


  /** Connects to the language server session, authenticating with the first UTF-8 line before protocol-2 commands. */
  static async connect(port: number, token: string, log: (line: string) => void, timeoutMs = 60_000, signal?: AbortSignal): Promise<KomodoRenderer> {
    signal?.throwIfAborted();
    const socket = connect({ host: "127.0.0.1", port });
    const ended = Promise.withResolvers<string>();
    socket.once("close", () => ended.resolve(`the Komodo preview session on port ${port} closed`));
    socket.once("error", (error) => ended.resolve(`the Komodo preview session on port ${port} failed: ${error.message}`));
    socket.write(`${token}\n`);
    return KomodoRenderer.handshake(new KomodoRenderer({ output: socket, input: socket, ended: ended.promise, stop: () => socket.destroy() }, log, signal), timeoutMs);
  }

  /** Waits for `ready`; rejects a daemon older than protocol 2 with KomodoUnavailable. */
  private static async handshake(renderer: KomodoRenderer, timeoutMs: number): Promise<KomodoRenderer> {
    try {
      const ready = await renderer.next((event) => event.event === "ready", timeoutMs);
      if (typeof ready.protocol !== "number" || ready.protocol < KOMODO_PROTOCOL) {
        throw new KomodoUnavailable("this Komodo is too old for the Komodo preview engine; use an Elide distribution with a newer Komodo (lib/komodo)");
      }
      renderer.ready = ready;
      return renderer;
    } catch (error) {
      renderer.dispose();
      throw error;
    }
  }

  ready: KomodoEvent = { event: "ready" };

  get alive(): boolean { return !this.failure; }

  /** Every event, as it arrives; returns the unsubscribe function. */
  on(listener: (event: KomodoEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  send(command: Record<string, unknown>): void {
    if (this.failure) throw this.failure;
    const line = JSON.stringify(command);
    if (Buffer.byteLength(line) > lineLimit) throw new Error("Komodo command exceeds the protocol's line limit.");
    this.channel.input.write(`${line}\n`, (error) => { if (error) this.fail(error); });
    if (command.command === "sources") this.compiling = true;
  }

  /** Resolves once the last `sources` command's compile has answered, the session has ended, or `timeoutMs` has passed. */
  async settled(timeoutMs: number): Promise<void> {
    if (!this.compiling || this.failure) return;
    await this.poll((event) => event.event === "compile", timeoutMs).catch(() => undefined);
  }

  /** The next event `match` accepts, within `timeoutMs`; a daemon failure or the timeout rejects (and a timeout kills it). */
  async next(match: (event: KomodoEvent) => boolean, timeoutMs: number): Promise<KomodoEvent> {
    const event = await this.poll(match, timeoutMs);
    if (event) return event;
    const error = new Error(`the preview session did not answer within ${Math.round(timeoutMs / 1000)} s`);
    this.fail(error);
    throw error;
  }

  /** The next event `match` accepts, or undefined after `timeoutMs` with the session left running; a daemon failure rejects. */
  poll(match: (event: KomodoEvent) => boolean, timeoutMs: number): Promise<KomodoEvent | undefined> {
    if (this.failure) return Promise.reject(this.failure);
    const { promise, resolve, reject } = Promise.withResolvers<KomodoEvent | undefined>();
    const waiter = {
      match,
      resolve: (event: KomodoEvent) => { clearTimeout(timer); resolve(event); },
      reject: (error: Error) => { clearTimeout(timer); reject(error); },
    };
    const timer = setTimeout(() => {
      this.waiters.delete(waiter);
      resolve(undefined);
    }, timeoutMs);
    this.waiters.add(waiter);
    return promise;
  }

  dispose(): void { this.fail(new Error("the preview session closed")); }


  private read(chunk: string): void {
    if (this.failure) return;
    this.stdout += chunk;
    if (this.stdout.length > lineLimit && !this.stdout.includes("\n")) {
      this.fail(new Error("the preview session wrote a line beyond the protocol's limit"));
      return;
    }
    for (let newline = this.stdout.indexOf("\n"); !this.failure && newline >= 0; newline = this.stdout.indexOf("\n")) {
      const line = this.stdout.slice(0, newline);
      this.stdout = this.stdout.slice(newline + 1);
      if (!line.trim()) continue;
      let event: unknown;
      try { event = JSON.parse(line); }
      catch { this.log(`Komodo preview: unreadable event ${line.slice(0, 200)}`); continue; }
      if (!object(event) || typeof event.event !== "string") continue;
      const typed = event as KomodoEvent;
      if (typed.event === "compile") this.compiling = false;
      for (const listener of [...this.listeners]) listener(typed);
      for (const waiter of [...this.waiters]) {
        if (!waiter.match(typed)) continue;
        this.waiters.delete(waiter);
        waiter.resolve(typed);
      }
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.signal?.removeEventListener("abort", this.abort);
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
    if (!this.ended) this.channel.stop();
  }
}

/** A `@Preview` parameter as the daemon takes it: a number where numeric, a boolean where boolean, else the string. */
function parameterValue(value: string): unknown {
  return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value === "true" ? true : value === "false" ? false : value;
}

/** Whether the process lists `feature` on its ready event (`reconfigure`: it takes another configure and entries in the same process). */
function supports(daemon: KomodoRenderer, feature: string): boolean {
  return Array.isArray(daemon.ready.features) && daemon.ready.features.includes(feature);
}

/**
 * The daemon's entries for the discovered previews: one card `previewId:0` per plain preview, and per `@PreviewParameter` preview
 * one entry named `previewId` without an index, which the daemon expands into a `previewId:index` card per provider value.
 */
export function komodoEntries(previews: readonly CompiledPreview[]): Record<string, unknown>[] {
  return previews.map((preview) => {
    const parameters = Object.fromEntries(Object.entries(preview.previewParams).map(([name, value]) => [name, parameterValue(value)]));
    const provider = preview.methodParams[0];
    return { id: provider ? preview.previewId : `${preview.previewId}:0`, previewId: preview.previewId, method: preview.methodFQN, parameters,
      previewParams: preview.previewParams, methodParameter: provider ? { ...provider } : null };
  });
}

/**
 * The lines of a Kotlin source that decide which previews it declares (annotations, functions, classes, its package): an edit
 * that leaves them unchanged needs no new discovery.
 */
export function previewDeclarations(text: string): string {
  return text.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("@") || /\b(fun|class|object|interface|package)\b/.test(line)).join("\n");
}

export interface KomodoOptions {
  /** `komodo/previews` for a file: its previews from source and its errors (Komodo's language server). */
  previews: (file: string) => Promise<{ previews: CompiledPreview[]; errors: { message: string }[] }>;
  /** Opens a required protocol-2 preview session in the workspace language server; older servers report an upgrade error. */
  session: (file: string) => Promise<{ protocol: number; port: number; token: string; pid?: number }>;
  sync: (files: readonly string[]) => Promise<void>;
  log: (line: string) => void;
  /** Shared by every backend of the window: the language server hosts one preview session at a time. */
  arbiter?: KomodoSessionArbiter;
  /** Who previews with this backend (default `panel`); an agent's backend is created by {@link ComposeBackends.detached}. */
  role?: "panel" | "agent";
}

/** Why a paused panel's cards do not render. */
export const KOMODO_PAUSED = "Paused: an agent is using the Komodo preview session (Elide MCP); this preview resumes when it ends.";

/**
 * The language server hosts one Komodo preview session (opening one closes the others): the backend about to open one claims it.
 * An agent's claim preempts the holder; a panel's claim preempts it too, unless it is an agent backend in use ({@link setActive}),
 * when the panel pauses instead. A panel that lost the session to an agent pauses as well; paused panels resume (preview again)
 * once the holder turns inactive or is released.
 */
export class KomodoSessionArbiter {
  private holder: KomodoBackend | undefined;
  private readonly active = new Set<KomodoBackend>();
  private readonly paused = new Set<KomodoBackend>();

  /** Whether `backend` may open a session now; false pauses it (a panel behind an agent in use). */
  claim(backend: KomodoBackend): boolean {
    const holder = this.holder;
    if (holder === backend) return true;
    if (holder && backend.role === "panel" && holder.role === "agent" && this.active.has(holder)) {
      this.pause(backend);
      return false;
    }
    this.paused.delete(backend);
    this.holder = backend;
    if (holder?.role === "panel" && backend.role === "agent") {
      this.pause(holder);
      holder.preempt(KOMODO_PAUSED);
    } else holder?.preempt(`Komodo: ${backend.role === "agent" ? "an agent's preview (Elide MCP)" : "the preview panel"} took the preview session.`);
    return true;
  }

  /** Marks an agent backend in use (a render running, a live session open); a holder turning inactive resumes paused panels. */
  setActive(backend: KomodoBackend, active: boolean): void {
    if (active) this.active.add(backend);
    else if (this.active.delete(backend) && this.holder === backend) this.resume();
  }

  release(backend: KomodoBackend): void {
    this.active.delete(backend);
    this.paused.delete(backend);
    if (this.holder !== backend) return;
    this.holder = undefined;
    this.resume();
  }

  private pause(backend: KomodoBackend): void {
    this.paused.add(backend);
    backend.paused = true;
  }

  private resume(): void {
    const paused = [...this.paused];
    this.paused.clear();
    for (const backend of paused) backend.resume();
  }
}

/**
 * The `komodo` engine (opt-in): a Komodo daemon renders every card live; nothing renders with the layoutlib snapshot path. The
 * Elide build and the preview compiler still supply the inputs (resources, the project's classes, the libraries' class paths), and
 * Komodo's language server reports the previews from source (`komodo/previews`) when the session starts or an edit changes the
 * file's declarations: the preview engine needs `elide.kotlinLsp.server` = `komodo`. A card Komodo cannot render shows the reason. Unsaved edits
 * reach the daemon as its sources command; its compile messages become the panel's diagnostics.
 *
 * A daemon serves one session (one previewed file over one set of inputs). A process advertising `reconfigure` takes the next
 * session's configure in the same process and a changed preview set as another entries command; an older process is replaced for
 * either (it cannot open layoutlib twice, and entries sent again leave its later deltas invisible). A card that fails to render
 * is closed by the daemon (Komodo cea50485 and later) and shows its reason.
 */
export class KomodoBackend extends ComposeBackend {
  override readonly engine = "komodo";
  private runtime: ComposeRuntime | undefined;
  private daemon: KomodoRenderer | undefined;
  /** The process of a closed session, kept for the next session's configure when it advertises `reconfigure`. */
  private spare: KomodoRenderer | undefined;
  private starting: Promise<KomodoRenderer> | undefined;
  /** Owns a session before it is configured and published as `daemon`. */
  private startup: AbortController | undefined;
  /** The inputs and previewed file of the current session; others start a new one. */
  private session = "";
  /** Why the session's file cannot be hosted (configure refused), and the text that was refused. */
  private refusal: { reason: string; text: string } | undefined;
  /** The session's discovered previews, in gallery order, and the declarations they were discovered from. */
  private previews: CompiledPreview[] | undefined;
  private declarations: string | undefined;
  /** Value counts of the session's `@PreviewParameter` previews, by preview id, as the daemon expanded them. */
  private readonly expansions = new Map<string, number>();
  /** Cards the daemon hosted and then could not render, by reason. */
  private readonly failed = new Map<string, string>();
  /** The entries the daemon was given, as JSON; others need another daemon. */
  private entriesSent = "";
  /** The composables of those entries: the program the daemon compiled has no other preview functions. */
  private methodsSent = new Set<string>();
  /** The entries' first frames are being collected: their failures are handled there, not by the event listener. */
  private hosting = false;
  private hosted = new Set<string>();
  private refused = new Map<string, string>();
  private readonly latest = new Map<string, PreviewImage>();
  /** The program's texts as the daemon last compiled or was pushed them. */
  private lastDocuments = new Map<string, string>();
  /** Other sources the editor changed, compiled in the program beside the session's file (ahead of their build classes). */
  private programFiles: string[] = [];
  /** The session's file and the entries hosted for it, which a process configured again after a rejected delta hosts. */
  private sessionFile: string | undefined;
  private entries: readonly Record<string, unknown>[] = [];
  /** A delta was rejected and the process is not configured again yet; that configure, queued behind the running preview. */
  private rejected = false;
  private recovering: Promise<void> | undefined;
  /** The current session's last error that named no card: the reason it closed, if it then did. */
  private lastError: string | undefined;
  /** How long hosting waits for the cards' first frames; a card without one by then fails alone. */
  protected readonly firstFrameMs: number = 60_000;
  private readonly imageListeners = new Set<(images: PreviewImage[]) => void>();
  private readonly compileListeners = new Set<(outcome: { failed: boolean; messages: CompileMessage[] }) => void>();
  private readonly inputListeners = new Set<(imageId?: string) => void>();
  private readonly sessionListeners = new Set<() => void>();
  private readonly inputEntries = new Set<string>();
  /** The libraries' sources jars by classes path, from the last build's models: Komodo expands library inline functions from them. */
  private librarySources = new Map<string, string>();

  /** Text the daemon appends to program files (a selection's generated wrappers), by absolute path. */
  private appendices: ReadonlyMap<string, string> = new Map();
  /** Lost the session to an agent, or found an agent using it: previews show {@link KOMODO_PAUSED} until {@link resume}. */
  paused = false;
  /** Counts preemptions: a session configured across one is the language server's no longer. */
  private preemptions = 0;
  /** The appendices the daemon compiles, as JSON. */
  private appendicesSent = "[]";

  constructor(key: string, cacheRoot: string, helperDirectory: string, store: ImageStore, private readonly options: KomodoOptions) {
    super(key, cacheRoot, helperDirectory, store);
  }

  get role(): "panel" | "agent" { return this.options.role ?? "panel"; }

  /**
   * Another backend took the language server's session: this one's daemon closes quietly (no lost session) and its live cards fail
   * with `reason`. The next preview opens a new session.
   */
  preempt(reason: string): void {
    this.resetInput();
    this.preemptions++;
    const daemon = this.daemon;
    // Unset first: closing it on purpose is no lost session.
    this.daemon = undefined;
    this.session = "";
    this.startup?.abort();
    daemon?.dispose();
    this.spare?.dispose();
    this.spare = undefined;
    const cards = [...this.hosted].map((id) => {
      this.latest.delete(id);
      return { ...this.base(id), error: reason };
    });
    this.hosted.clear();
    if (cards.length) for (const listener of this.imageListeners) listener(cards);
  }

  /** The agent that paused this panel is done: the panel previews again (and claims the session). */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (!this.disposed) for (const listener of this.sessionListeners) listener();
  }

  /** The daemon's own compile replaces the preview compiler's warm-up and annotation-processing confirmation. */
  override get needsWarmup(): boolean { return false; }
  override get processingRequired(): boolean { return false; }
  override async warm(): Promise<void> {}
  override async verify(): Promise<boolean> { return false; }

  /** No render JVMs: the runtime is the daemon's layoutlib host. */
  override async startRenderer(runtime: ComposeRuntime): Promise<void> {
    this.signal.throwIfAborted();
    this.runtime = runtime;
  }

  override async configure(build: PreviewBuild, documents: ReadonlyMap<string, string>, verified: boolean): Promise<boolean> {
    this.librarySources = new Map(build.models.flatMap((model) => model.libraries)
      .flatMap((library) => library.sources ? [[path.resolve(library.classes), library.sources] as const] : []));
    return super.configure(build, documents, verified);
  }

  /** Starts the daemon for `request` from the last build's outputs, so the panel opens on live cards. Never builds. */
  override async prewarm(build: PreviewBuild, runtime: ComposeRuntime, java: string, request: PreviewRequest, onStep: (step: string) => void = () => {}): Promise<void> {
    await this.startRenderer(runtime);
    onStep("preparing the compiler inputs");
    try {
      await this.configure(build, request.documents, false);
    } catch (error) {
      // Never built, or a build is rewriting its outputs: the next panel builds first. A stale record needs more than that build.
      if (error instanceof StaleBuildRecordError) throw error;
      return;
    }
    onStep("starting the Komodo preview session");
    await this.preview(request);
  }

  /** Pushes an edit of a file of the session's program at once; the refresh that follows finds it pushed. */
  override edit(file: string, text: string): void {
    if (this.daemon?.alive && !this.hosting && this.lastDocuments.has(file)) this.push(new Map([[file, text]]), this.daemon);
  }

  /** The workspace preview compiler accepts Kotlin sources only. */
  override compiles(file: string): boolean {
    return file.endsWith(".kt") && super.compiles(file);
  }

  /** Each card as its latest frame (or failure) has it: a frame may arrive between `preview` and the panel showing its gallery. */
  override latestImages(images: readonly PreviewImage[]): readonly PreviewImage[] {
    return images.map((image) => {
      const reason = this.failed.get(image.id);
      return this.latest.get(image.id) ?? (reason === undefined ? image : this.failedCard(image.id, reason));
    });
  }

  override pointer(imageId: string, action: "down" | "up" | "move" | "scroll", x: number, y: number, dx?: number, dy?: number): boolean {
    if (!this.daemon?.alive || this.hosting || !this.hosted.has(imageId)) return false;
    if (action === "down" && supports(this.daemon, "keyboard")) this.inputEntries.add(imageId);
    this.daemon.send({ command: "pointer", entry: imageId, action, x, y, ...action === "scroll" ? { dx: dx ?? 0, dy: dy ?? 0 } : {} });
    return true;
  }

  override keyboardSupported(imageId: string): boolean {
    return !!this.daemon?.alive && !this.hosting && this.hosted.has(imageId) && supports(this.daemon, "keyboard");
  }

  override keyboard(imageId: string, event: PreviewKeyEvent): boolean {
    if (!this.keyboardSupported(imageId) || !isPreviewKeyEvent(event)) return false;
    this.inputEntries.add(imageId);
    this.daemon!.send({ ...event, command: "keyboard", entry: imageId });
    return true;
  }

  override blur(imageId: string): boolean {
    this.inputEntries.delete(imageId);
    if (!this.daemon?.alive || !this.hosted.has(imageId) || !supports(this.daemon, "keyboard")) return false;
    this.daemon.send({ command: "blur", entry: imageId });
    return true;
  }

  override onInputReset(listener: (imageId?: string) => void): () => void {
    this.inputListeners.add(listener);
    return () => this.inputListeners.delete(listener);
  }

  private resetInput(imageId?: string): void {
    if (imageId !== undefined) this.blur(imageId);
    else for (const entry of this.inputEntries) this.blur(entry);
    for (const listener of this.inputListeners) listener(imageId);
  }

  override onImages(listener: (images: PreviewImage[]) => void): () => void {
    this.imageListeners.add(listener);
    return () => this.imageListeners.delete(listener);
  }

  override onCompile(listener: (outcome: { failed: boolean; messages: CompileMessage[] }) => void): () => void {
    this.compileListeners.add(listener);
    return () => this.compileListeners.delete(listener);
  }

  override onSessionLost(listener: () => void): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  /**
   * The session was configured over `previous`'s inputs (its published class copies), which are deleted next: a compile reading
   * them then fails and ends the session. No further edit reaches it; one it is compiling now finishes first (up to
   * {@link RETIRE_COMPILE_MS}); then it closes, also as a `spare`, since its process may keep reading those inputs. The next
   * preview opens a session over the new compiler's inputs.
   */
  protected override async retire(_previous: ComposeCompiler): Promise<void> {
    this.session = "";
    const retired = [this.daemon, this.spare];
    // Unset first: closing them on purpose is no lost session, and reset keeps no spare.
    this.daemon = undefined;
    this.spare = undefined;
    this.startup?.abort();
    this.reset();
    await Promise.all(retired.map((daemon) => daemon?.settled(RETIRE_COMPILE_MS)));
    for (const daemon of retired) daemon?.dispose();
  }

  /**
   * The live gallery for `request`. Without `compile` (the panel's paint before the build confirms) the session starts from the
   * last build's classes, as a prewarm's does: the confirmed inputs start another only if the build changed them. Calls run one
   * after another: a panel's call during a prewarm's waits for its daemon instead of starting a second one.
   */
  override preview(request: PreviewRequest, compile?: true, trace?: TimelineNode): Promise<PreviewGallery>;
  override preview(request: PreviewRequest, compile: boolean, trace?: TimelineNode): Promise<PreviewGallery | undefined>;
  override preview(request: PreviewRequest, compile = true, trace?: TimelineNode): Promise<PreviewGallery | undefined> {
    const run = this.previewing.then(async () => {
      const preemptions = this.preemptions;
      try {
        return await this.previewNow(request, compile, trace);
      } catch (error) {
        // An agent took the session meanwhile (its configure or hosting then fails): the panel pauses, as if it had found it in use.
        if (this.paused && this.preemptions !== preemptions && !this.disposed) return { images: this.pausedGallery(), verified: true, reused: false };
        throw error;
      }
    });
    this.previewing = run.catch(() => {});
    return run;
  }

  private previewing: Promise<unknown> = Promise.resolve();

  private async previewNow(request: PreviewRequest, compile: boolean, trace?: TimelineNode): Promise<PreviewGallery> {
    this.signal.throwIfAborted();
    const compiler = this.compiler;
    if (!compiler) throw new Error("Compose preview has no compiler inputs; build the project first.");
    // The compiler's first publication moves the project classes from the build's outputs to its copies: a new session.
    // A selection's program (its files, the files it appends to) is part of the session; absent, the key is the panel's as before.
    const selection = request.selection && {
      files: [...new Set([...request.selection.files, ...request.selection.appendices.keys()])].filter((file) => file !== request.sourceFile).sort(),
      appendices: [...request.selection.appendices.keys()].sort(),
    };
    const session = JSON.stringify({ fingerprint: compiler.fingerprint, inputs: compiler.inputs, current: compiler.currentInputs, source: request.sourceFile, selection });
    if (session !== this.session) {
      this.session = session;
      this.sessionFile = request.sourceFile;
      this.reset();
      if (selection) this.programFiles = [...selection.files];
    }
    this.appendices = request.selection?.appendices ?? new Map();
    // Without a live session, an agent using the language server's session pauses a panel; a paused panel claims nothing.
    if (this.paused || !this.daemon?.alive && this.options.arbiter && !this.options.arbiter.claim(this)) {
      if (!this.previews) this.previews = request.selection ? [...request.selection.previews] : (await this.discover(request)).previews;
      return { images: this.pausedGallery(), verified: true, reused: false };
    }
    // Sources the editor changed that the previewed file's program compiles beside it (its module's, its dependencies'), ahead of
    // their build classes, which hold their saved text.
    const joining = compile ? await this.joining(request) : [];
    this.programFiles.push(...joining);
    // An edit of the live program reaches the daemon before any discovery it needs.
    if (this.daemon?.alive && !joining.length) this.push(request.documents, this.daemon);
    // A session without a daemon configures one while its previews are discovered: configure needs only the file and the inputs
    // (on a cold language server, discovery waits for its first analysis: 2.2 s of a cold open on elide-android-sample).
    const restart = () => trace ? trace.run("Start Komodo preview session", () => this.restart(request.sourceFile, request.documents)) : this.restart(request.sourceFile, request.documents);
    // Another file the editor changed joins the program: a configure again, with its text.
    const restarting = this.daemon?.alive && !joining.length ? undefined : restart();
    restarting?.catch(() => {});
    if (request.selection) this.previews = [...request.selection.previews];
    else {
      const text = request.documents.get(request.sourceFile) ?? await readFile(request.sourceFile, "utf8");
      const declarations = previewDeclarations(text);
      if (declarations !== this.declarations) {
        const found = await (trace ? trace.run("Discover previews", () => this.discover(request)) : this.discover(request));
        this.previews = found.previews;
        // Kept previews leave the declarations undiscovered: a body edit that clears the errors discovers again.
        this.declarations = found.complete ? declarations : undefined;
      }
    }
    const entries = komodoEntries(this.previews!);
    const entriesJson = JSON.stringify(entries);
    if (restarting || entriesJson !== this.entriesSent) {
      // A daemon that takes entries again (`reconfigure`) hosts a changed preview set itself, unless a preview function is new: its
      // program has no such method. One that compiles a configure's unsaved texts (`texts`) configures again with the buffer.
      const added = entries.some((entry) => !this.methodsSent.has(String(entry.method)));
      const live = !restarting && this.daemon?.alive && supports(this.daemon, "reconfigure") && !(added && supports(this.daemon, "texts")) ? this.daemon : undefined;
      const daemon = live ?? await (restarting ?? restart());
      this.entriesSent = entriesJson;
      this.entries = entries;
      this.methodsSent = new Set(entries.map((entry) => String(entry.method)));
      await (trace ? trace.run("Host cards", () => this.host(daemon, entries)) : this.host(daemon, entries));
      this.push(request.documents, daemon);
    }
    // A delta rejected while the cards were being hosted.
    this.reconfigureRejected();
    if (request.inspect && this.daemon && !supports(this.daemon, "layout")) {
      throw new Error("Layout inspection needs a newer Komodo. Use an Elide distribution with a newer Komodo (lib/komodo) and reload the window.");
    }
    return { images: this.gallery(), verified: true, reused: false };
  }

  override dispose(): void {
    this.resetInput();
    const daemon = this.daemon;
    // Unset first: closing it on purpose is no lost session.
    this.daemon = undefined;
    daemon?.dispose();
    this.spare?.dispose();
    this.spare = undefined;
    this.options.arbiter?.release(this);
    super.dispose();
  }

  /** The discovered cards of a paused panel, each naming why it does not render. */
  private pausedGallery(): PreviewImage[] {
    return (this.previews ?? []).flatMap((preview) => Array.from({ length: preview.methodParams.length ? this.expansions.get(preview.previewId) ?? 1 : 1 },
      (_, index) => ({ ...this.base(`${preview.previewId}:${index}`), error: KOMODO_PAUSED })));
  }


  /** A new session: nothing discovered, hosted or left out yet. */
  private reset(): void {
    this.startup?.abort();
    this.resetInput();
    const previous = this.daemon;
    this.daemon = undefined;
    if (previous?.alive && supports(previous, "reconfigure")) this.spare = previous;
    else previous?.dispose();
    this.refusal = undefined;
    this.previews = undefined;
    this.declarations = undefined;
    this.expansions.clear();
    this.failed.clear();
    this.entriesSent = "";
    this.entries = [];
    this.rejected = false;
    this.methodsSent.clear();
    this.programFiles = [];
    this.hosted.clear();
    this.refused.clear();
    this.latest.clear();
  }

  /**
   * The previews the documents declare, from Komodo's language server; an edit with errors keeps those discovered before it, and
   * is not `complete`: those may lack a preview the edit declares.
   */
  private async discover(request: PreviewRequest): Promise<{ previews: CompiledPreview[]; complete: boolean }> {
    const found = await this.options.previews(request.sourceFile);
    this.signal.throwIfAborted();
    if (found.errors.length > 0 && this.previews) {
      this.options.log(`Komodo: ${path.basename(request.sourceFile)} has errors; keeping the last previews (${found.errors[0]!.message.split("\n")[0]})`);
      return { previews: this.previews, complete: false };
    }
    return { previews: found.previews, complete: true };
  }

  /** Open sources outside the program whose editor text differs from the file and that the previewed file's compiler accepts. */
  private async joining(request: PreviewRequest): Promise<string[]> {
    const compiler = this.compiler!;
    const candidates = [...request.documents].filter(([file]) => file !== request.sourceFile && file.endsWith(".kt")
      && !this.programFiles.includes(file) && compiler.supports(file));
    const changed = await Promise.all(candidates.map(async ([file, text]) => await readFile(file, "utf8").catch(() => undefined) !== text ? file : undefined));
    return changed.filter((file): file is string => file !== undefined);
  }

  /** Configures all selected workspace sources together; source errors never exclude a dependency or retry its saved text. */
  private async restart(sourceFile: string, documents: ReadonlyMap<string, string>): Promise<KomodoRenderer> {
    const controller = new AbortController();
    this.startup = controller;
    const signal = AbortSignal.any([this.signal, controller.signal]);
    // A reused daemon predates this startup's signal, but must also close if configuration is cancelled.
    const previous = this.daemon ?? this.spare;
    const abort = () => previous?.dispose();
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await this.restartNow(sourceFile, documents, signal);
    } finally {
      signal.removeEventListener("abort", abort);
      if (this.startup === controller) this.startup = undefined;
      if (previous !== this.daemon && previous !== this.spare) previous?.dispose();
    }
  }

  private async restartNow(sourceFile: string, documents: ReadonlyMap<string, string>, signal: AbortSignal): Promise<KomodoRenderer> {
    signal.throwIfAborted();
    this.resetInput();
    const preemptions = this.preemptions;
    const previous = this.daemon ?? this.spare;
    this.daemon = undefined;
    this.spare = undefined;
    const reused = previous?.alive && supports(previous, "reconfigure") ? previous : undefined;
    if (!reused) previous?.dispose();
    const saved = new Map(await Promise.all([sourceFile, ...this.programFiles].map(async (file) => [file,
      await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" && documents.has(file)) return documents.get(file)!;
        throw error;
      }),
    ] as const)));
    signal.throwIfAborted();
    const compiled = new Map([...saved].map(([file, text]) => [file, documents.get(file) ?? text] as const));
    const key = (texts: ReadonlyMap<string, string>) => JSON.stringify([[...texts], [...this.appendices]]);
    if (this.refusal?.text === key(compiled)) {
      this.spare = reused;
      throw new Error(`Komodo: ${this.refusal.reason}`);
    }
    const daemon = reused ?? await (this.starting ??= (async () => {
      try {
        const started = await this.open(sourceFile, signal);
        started.on((event) => {
          if (this.daemon !== started) return;
          if (event.event === "error" && typeof event.entry !== "string" && event.kind !== "rejected" && typeof event.message === "string") {
            this.lastError = event.message.split("\n")[0];
          }
          this.event(event);
        });
        started.onClose(() => this.closed(started));
        return started;
      } finally {
        this.starting = undefined;
      }
    })());
    const reason = await this.configureDaemon(daemon, compiled, signal).catch((error: unknown) => {
      daemon.dispose();
      throw error;
    });
    if (reason) {
      // A process that takes another configure stays for the next attempt.
      if (supports(daemon, "reconfigure")) this.spare = daemon;
      else daemon.dispose();
      this.refusal = { reason, text: key(compiled) };
      throw new Error(`Komodo: ${reason}`);
    }
    // Preempted while it was configured: the language server closed this session for the other backend's.
    if (this.preemptions !== preemptions) {
      daemon.dispose();
      throw new Error(`Komodo: ${KOMODO_PAUSED}`);
    }
    this.refusal = undefined;
    // The daemon compiled `compiled`: a later editor text is the first push.
    this.lastDocuments = new Map(compiled);
    this.lastError = undefined;
    this.daemon = daemon;
    return daemon;
  }

  /**
   * The current session closed on its own (a language-server reload or restart, a crash): its live cards fail with the reason and
   * the panel previews again, which reconnects. A close while hosting fails that preview instead; one with no live card is quiet.
   */
  private closed(daemon: KomodoRenderer): void {
    if (this.daemon !== daemon) return;
    this.resetInput();
    if (this.hosting) return;
    this.daemon = undefined;
    if (!this.hosted.size) return;
    const reason = `the preview session closed${this.lastError ? ` (${this.lastError})` : ""}`;
    const cards = [...this.hosted].map((id) => {
      this.latest.delete(id);
      this.failed.set(id, reason);
      return this.failedCard(id, reason);
    });
    this.hosted.clear();
    for (const listener of this.imageListeners) listener(cards);
    for (const listener of this.sessionListeners) listener();
  }

  /** Opens a session in the workspace language server; there is no standalone compiler fallback. */
  private async open(sourceFile: string, signal: AbortSignal): Promise<KomodoRenderer> {
    signal.throwIfAborted();
    if (this.options.arbiter && !this.options.arbiter.claim(this)) throw new Error(`Komodo: ${KOMODO_PAUSED}`);
    const session = await this.options.session(sourceFile);
    signal.throwIfAborted();
    const connected = await KomodoRenderer.connect(session.port, session.token, this.options.log, 60_000, signal);
    if (connected.ready.compiler !== "workspace-fir") {
      connected.dispose();
      throw new KomodoUnavailable("The Komodo preview engine needs a newer Komodo language server. Use an Elide distribution with a newer Komodo (lib/komodo) and reload the window.");
    }
    if (signal.aborted) {
      connected.dispose();
      signal.throwIfAborted();
    }
    this.options.log(`Komodo: preview session in the language server ready (protocol ${String(connected.ready.protocol)}, host ${String(connected.ready.host)}, Kotlin ${String(connected.ready.kotlin)}, compiler ${String(connected.ready.compiler ?? "unreported")}, pid ${String(session.pid ?? connected.ready.pid ?? "unreported")})`);
    return connected;
  }

  /** Configures the daemon's session over the compiler's inputs, compiling `texts` (the program's files, by path); the refusal, or undefined. */
  private async configureDaemon(daemon: KomodoRenderer, texts: ReadonlyMap<string, string>, signal: AbortSignal): Promise<string | undefined> {
    const compiler = this.compiler!;
    const runtime = this.runtime;
    if (!runtime) return "the layoutlib runtime is not installed yet";
    if (this.appendices.size && !supports(daemon, "appendices")) {
      throw new KomodoUnavailable("Previewing a composable without @Preview needs a newer Komodo (the appendices feature). Use an Elide distribution with a newer Komodo (lib/komodo) and reload the window.");
    }
    const appendices = JSON.stringify([...this.appendices]);
    await this.pushing;
    await this.options.sync([...texts.keys()]);
    signal.throwIfAborted();
    // A save's build replaced the compiler meanwhile and deletes its inputs: the next preview configures over the new ones.
    const replaced = () => {
      if (this.compiler !== compiler) throw new Error("the preview compiler was replaced while the session was configured; preview again");
    };
    replaced();
    const inputs = compiler.currentInputs;
    const own = new Set(inputs.projectClassPath);
    const compileClassPath = compiler.compileClassPath;
    // A program that does not compile is a compile event, then the configure error: the refusal names the first errors.
    const errors: string[] = [];
    const stop = daemon.on((event) => {
      if (signal.aborted || event.event !== "compile" || event.outcome !== "failure" || !Array.isArray(event.messages)) return;
      // During configuration this.daemon is deliberately unset, so the live listener cannot publish these diagnostics.
      this.event(event);
      for (const message of event.messages.filter(object)) {
        if (message.level !== "error" || typeof message.text !== "string") continue;
        const at = typeof message.file === "string" ? `${path.basename(message.file)}${typeof message.line === "number" ? `:${message.line}` : ""}: ` : "";
        errors.push(`${at}${message.text}`);
      }
    });
    daemon.send({
      command: "configure", host: "layoutlib", namespace: inputs.namespace, resourceApkPath: inputs.resourceApkPath,
      // Libraries and R classes; the project's own classes go behind the program (projectClassPath), which replaces the previewed file's.
      classPath: inputs.classPath.filter((entry) => !own.has(entry)), projectClassPath: inputs.projectClassPath,
      layoutlib: runtime.layoutlibPath, rendererClassPath: runtime.rendererClassPath,
      sources: [...texts.keys()],
      // Include new unsaved files too; the server's versioned Workspace buffer remains authoritative.
      texts: Object.fromEntries(texts),
      inlineSources: [...new Set(compileClassPath.flatMap((entry) => this.librarySources.get(path.resolve(entry)) ?? []))],
      compile: { classPath: compileClassPath },
      ...this.appendices.size ? { appendices: Object.fromEntries(this.appendices) } : {},
    });
    const answer = await daemon.next((event) => event.event === "configured" || (event.event === "error" && event.kind === "configure"), 300_000)
      .finally(stop);
    signal.throwIfAborted();
    replaced();
    if (answer.event === "error") {
      const reason = typeof answer.message === "string" ? answer.message : "the preview session refused the program";
      return errors.length ? `${reason} (${errors.slice(0, 3).join("; ")}${errors.length > 3 ? `; ${errors.length - 3} more` : ""})` : reason;
    }
    this.appendicesSent = appendices;
    for (const listener of this.compileListeners) listener({ failed: false, messages: [] });
    return undefined;
  }

  /**
   * Sends the entries and collects every hosted card's first frame into `latest`, learning the provider expansions the daemon made.
   * Refused cards keep their reason in `refused`; cards it hosted and then could not render, in `failed`.
   */
  private async host(daemon: KomodoRenderer, entries: readonly Record<string, unknown>[]): Promise<void> {
    this.resetInput();
    this.latest.clear();
    this.failed.clear();
    this.expansions.clear();
    const frames = new Map<string, KomodoEvent>();
    const errors = new Map<string, string>();
    // Recorded from the entries answer on, in the listener (errors can share a chunk with it): before the answer, a frame is the
    // previous scenes', which keep rendering until the new cards' first frames and can carry the same card ids.
    let answered = false;
    const stop = daemon.on((event) => {
      if (event.event === "entries") answered = true;
      if (!answered || typeof event.entry !== "string") return;
      if (event.event === "frame" && !frames.has(event.entry)) frames.set(event.entry, event);
      if (event.event === "error" && event.fallback === true) errors.set(event.entry, typeof event.message === "string" ? event.message : "this card cannot be rendered live");
    });
    this.hosting = true;
    try {
      daemon.send({ command: "entries", entries });
      const answer = await daemon.next((event) => event.event === "entries", 120_000);
      const ids = (value: unknown) => (Array.isArray(value) ? value : []).filter((id): id is string => typeof id === "string");
      this.hosted = new Set(ids(answer.hosted));
      const refused = ids(answer.refused);
      const deadline = Date.now() + this.firstFrameMs;
      while ([...this.hosted].some((id) => !frames.has(id) && !errors.has(id)) && Date.now() < deadline) {
        // A card still without a frame at the deadline fails alone; the session and the other cards stay live.
        const event = await daemon.poll((candidate) => typeof candidate.entry === "string" && (candidate.event === "frame" || (candidate.event === "error" && candidate.fallback === true)), Math.max(1, deadline - Date.now()));
        if (!event) break;
      }
      this.refused = new Map(refused.map((id) => [id, errors.get(id) ?? "this card cannot be rendered live"]));
      for (const id of this.hosted) {
        if (errors.has(id)) this.failed.set(id, errors.get(id)!);
        else if (!frames.has(id)) this.failed.set(id, `no frame was rendered within ${Math.round(this.firstFrameMs / 1000)} s`);
      }
      // An entry without an index expanded into one card per provider value.
      for (const entry of entries) {
        const methodParameter = entry.methodParameter;
        if (!object(methodParameter) || "index" in methodParameter) continue;
        const prefix = `${String(entry.id)}:`;
        const indices = [...this.hosted, ...refused].filter((id) => id.startsWith(prefix)).map((id) => Number(id.slice(prefix.length)));
        if (indices.length) this.expansions.set(String(entry.id), Math.max(...indices) + 1);
      }
    } finally {
      this.hosting = false;
      stop();
    }
    for (const id of this.failed.keys()) this.hosted.delete(id);
    for (const id of this.hosted) this.latest.set(id, this.card(this.base(id), frames.get(id)!));
  }

  /** The gallery: one card per discovered preview, or per provider value, live or showing why it is not. */
  private gallery(): PreviewImage[] {
    return (this.previews ?? []).flatMap((preview) => {
      const count = preview.methodParams.length ? this.expansions.get(preview.previewId) : 1;
      // A provider preview the daemon did not expand (its provider failed) is one card naming the reason.
      if (count === undefined) return [this.failedCard(`${preview.previewId}:0`, this.refused.get(preview.previewId) ?? "the @PreviewParameter provider was not expanded")];
      return Array.from({ length: count }, (_, index) => {
        const id = `${preview.previewId}:${index}`;
        return this.latest.get(id) ?? this.failedCard(id, this.failed.get(id) ?? this.refused.get(id) ?? "no frame was rendered");
      });
    });
  }

  /** A card's name and detail from its preview (`previewId:index`). */
  private base(id: string): PreviewImage {
    const preview = this.previews?.find((candidate) => candidate.previewId === id.slice(0, id.lastIndexOf(":")));
    return { id, name: preview?.name ?? id, detail: preview?.methodFQN ?? "" };
  }

  private failedCard(id: string, reason: string): PreviewImage {
    return { ...this.base(id), error: `Komodo: ${reason}` };
  }

  /** The program's files, sent as the daemon's sources command when an editor text in `documents` changed since the last push. */
  private push(documents: ReadonlyMap<string, string>, daemon: KomodoRenderer): void {
    const changed = new Map(documents);
    this.pushing = this.pushing.then(async () => {
      if (!daemon.alive || this.daemon !== daemon) return;
      const appendices = JSON.stringify([...this.appendices]);
      if (!this.hosted.size || appendices === this.appendicesSent
        && ![...this.lastDocuments].some(([file, text]) => changed.has(file) && changed.get(file) !== text)) return;
      await this.options.sync([...this.lastDocuments.keys()]);
      if (!daemon.alive || this.daemon !== daemon) return;
      for (const file of this.lastDocuments.keys()) this.lastDocuments.set(file, changed.get(file) ?? this.lastDocuments.get(file)!);
      this.resetInput();
      // `appendices` replaces the session's; absent, they are unchanged.
      const replaced = appendices === this.appendicesSent ? {} : { appendices: Object.fromEntries(this.appendices) };
      this.appendicesSent = appendices;
      daemon.send({ command: "sources", files: Object.fromEntries(this.lastDocuments), ...replaced });
    }).catch((error: unknown) => {
      if (this.daemon !== daemon || this.signal.aborted) return;
      // Closed on purpose: no lost session to report.
      if (this.daemon === daemon) this.daemon = undefined;
      daemon.dispose();
      const message = `Komodo preview synchronization failed: ${error instanceof Error ? error.message : String(error)}`;
      this.options.log(message);
      for (const listener of this.compileListeners) listener({ failed: true, messages: [{ level: "error", text: message }] });
    });
  }

  private pushing: Promise<void> = Promise.resolve();


  /** Pushed frames, compile outcomes and cards that stopped rendering, after `preview` resolved. */
  private event(event: KomodoEvent): void {
    if (event.event === "frame" && typeof event.entry === "string" && this.hosted.has(event.entry) && typeof event.png === "string") {
      const previous = this.latest.get(event.entry);
      if (!previous) return;
      const card = this.card(previous, event);
      // Layout can change without changing pixels (transparent/overlapping layouts).
      if (previous.live && !previous.error && previous.data === card.data && previous.width === card.width
        && previous.height === card.height && previous.layoutError === card.layoutError
        && JSON.stringify(previous.nodes) === JSON.stringify(card.nodes)) return;
      this.latest.set(event.entry, card);
      for (const listener of this.imageListeners) listener([card]);
    } else if (event.event === "compile") {
      const messages = (Array.isArray(event.messages) ? event.messages : []).filter(object).map((message): CompileMessage => ({
        level: message.level === "warning" ? "warning" : "error",
        text: typeof message.text === "string" ? message.text : "",
        file: typeof message.file === "string" ? message.file : undefined,
        line: typeof message.line === "number" ? message.line : undefined,
        column: typeof message.column === "number" ? message.column : undefined,
      }));
      for (const listener of this.compileListeners) listener({ failed: event.outcome === "failure", messages });
    } else if (event.event === "error" && typeof event.entry === "string" && event.fallback === true && this.hosted.has(event.entry) && !this.hosting) {
      // The daemon closed the card; the others keep running.
      const reason = typeof event.message === "string" ? event.message : "this card cannot be rendered live";
      this.resetInput(event.entry);
      this.hosted.delete(event.entry);
      this.latest.delete(event.entry);
      this.failed.set(event.entry, reason);
      const card = this.failedCard(event.entry, reason);
      for (const listener of this.imageListeners) listener([card]);
    } else if (event.event === "error" && event.kind === "rejected" && event.restartRequired === true) {
      // Hosting cards: the preview that hosts them configures again once it has.
      this.rejected = true;
      if (!this.hosting) this.reconfigureRejected();
    }
  }

  /**
   * A rejected delta (a removed or re-signed member) leaves the daemon on its previous program, and every later delta of the file is
   * rejected too: the process configures again from the pushed text and hosts the same entries. Only a process that compiles unsaved
   * texts can; another keeps its cards until the file is saved and the preview restarts. The recovery queues behind the running
   * preview, which would otherwise find the process taken and open a second session.
   */
  private reconfigureRejected(): void {
    if (!this.rejected || this.recovering || !this.daemon || !this.sessionFile || !supports(this.daemon, "texts")) return;
    const recovery = this.previewing.then(async () => {
      await this.pushing;
      const daemon = this.daemon;
      const file = this.sessionFile;
      // That preview may have started another session or configured this one again.
      if (!this.rejected || !daemon?.alive || !file || !supports(daemon, "texts")) return;
      this.rejected = false;
      const next = await this.restart(file, new Map(this.lastDocuments));
      await this.host(next, this.entries);
      for (const listener of this.imageListeners) listener(this.gallery());
    }).catch((error: unknown) => {
      this.options.log(`Komodo: configuring again after a rejected delta failed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => { this.recovering = undefined; });
    this.recovering = this.previewing = recovery;
  }

  private card(base: PreviewImage, frame: KomodoEvent): PreviewImage {
    if (typeof frame.png !== "string") return base;
    const width = typeof frame.width === "number" ? frame.width : base.width;
    const height = typeof frame.height === "number" ? frame.height : base.height;
    let nodes: PreviewImage["nodes"];
    let layoutError = typeof frame.layoutError === "string" ? frame.layoutError : undefined;
    try {
      if (!Number.isInteger(width) || !Number.isInteger(height) || width! <= 0 || height! <= 0) {
        throw new Error("Invalid Compose frame dimensions.");
      }
      nodes = layoutNodes(frame.nodes, width!, height!);
    } catch (error) {
      nodes = [];
      layoutError = error instanceof Error ? error.message : String(error);
    }
    return { ...base, data: frame.png, error: undefined, nodes, layoutError, live: true, width, height };
  }
}
