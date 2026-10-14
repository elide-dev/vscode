import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import type { TimelineNode } from "@elide/ide-core";
import { ComposeBackend, type CompileMessage, type ImageStore, type PreviewRequest } from "./composeBackend.js";
import type { CompiledPreview, PreviewImage } from "./composeRender.js";

/** The daemon protocol this client speaks (Komodo's docs/VSCODE_PREVIEW.md, protocol 2). */
export const KOMODO_PROTOCOL = 2;
const lineLimit = 8 * 1024 * 1024;

export type KomodoEvent = Record<string, unknown> & { event: string };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The daemon cannot serve this session (older protocol, refused inputs): every card renders with layoutlib. */
export class KomodoUnavailable extends Error {}

/**
 * A `komodo-preview --protocol-only` daemon over stdio JSON lines, modeled on the render workers: the `ready` handshake with
 * the protocol check, a line cap, per-request timeouts, kill on failure. Events arrive in order; `next` waits for one.
 */
export class KomodoRenderer {
  private stdout = "";
  private readonly listeners = new Set<(event: KomodoEvent) => void>();
  private readonly waiters = new Set<{ match: (event: KomodoEvent) => boolean; resolve: (event: KomodoEvent) => void; reject: (error: Error) => void }>();
  private failure: Error | undefined;

  private constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly log: (line: string) => void) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.read(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { for (const line of chunk.split("\n")) if (line.trim()) this.log(line); });
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code, signal) => this.fail(new Error(`komodo-preview exited (${signal ?? code})`)));
    child.stdin.on("error", (error) => this.fail(error));
  }

  /** Starts the daemon and waits for its `ready`; rejects a daemon older than protocol 2 with KomodoUnavailable. */
  static async start(command: string, args: readonly string[], log: (line: string) => void, timeoutMs = 60_000): Promise<KomodoRenderer> {
    const child = spawn(command, ["--protocol-only", ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const renderer = new KomodoRenderer(child, log);
    try {
      const ready = await renderer.next((event) => event.event === "ready", timeoutMs);
      if (typeof ready.protocol !== "number" || ready.protocol < KOMODO_PROTOCOL) {
        throw new KomodoUnavailable(`komodo-preview speaks protocol ${String(ready.protocol ?? 1)}; this extension needs ${KOMODO_PROTOCOL} or later`);
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

  send(command: Record<string, unknown>): void {
    if (this.failure) throw this.failure;
    const line = JSON.stringify(command);
    if (Buffer.byteLength(line) > lineLimit) throw new Error("Komodo command exceeds the protocol's line limit.");
    this.child.stdin.write(`${line}\n`, (error) => { if (error) this.fail(error); });
  }

  /** The next event `match` accepts, within `timeoutMs`; a daemon failure or the timeout rejects (and a timeout kills it). */
  next(match: (event: KomodoEvent) => boolean, timeoutMs: number): Promise<KomodoEvent> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const waiter = {
        match,
        resolve: (event: KomodoEvent) => { clearTimeout(timer); resolve(event); },
        reject: (error: Error) => { clearTimeout(timer); reject(error); },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        const error = new Error(`komodo-preview did not answer within ${Math.round(timeoutMs / 1000)} s`);
        reject(error);
        this.fail(error);
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  dispose(): void { this.fail(new Error("komodo-preview disposed")); }

  private read(chunk: string): void {
    this.stdout += chunk;
    if (this.stdout.length > lineLimit && !this.stdout.includes("\n")) {
      this.fail(new Error("komodo-preview wrote a line beyond the protocol's limit"));
      return;
    }
    for (let newline = this.stdout.indexOf("\n"); newline >= 0; newline = this.stdout.indexOf("\n")) {
      const line = this.stdout.slice(0, newline);
      this.stdout = this.stdout.slice(newline + 1);
      if (!line.trim()) continue;
      let event: unknown;
      try { event = JSON.parse(line); }
      catch { this.log(`komodo-preview: unreadable event ${line.slice(0, 200)}`); continue; }
      if (!object(event) || typeof event.event !== "string") continue;
      const typed = event as KomodoEvent;
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
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
    if (this.child.exitCode === null && !this.child.killed) this.child.kill();
  }
}

/** One daemon entry per gallery card: the card's image id, its discovered preview, and `@Preview` parameters as numbers where numeric. */
export function komodoEntries(images: readonly PreviewImage[], previews: readonly CompiledPreview[]): Record<string, unknown>[] {
  const byId = new Map(previews.map((preview) => [preview.previewId, preview]));
  const entries: Record<string, unknown>[] = [];
  const expansions = new Map<string, number>();
  for (const image of images) {
    const previewId = image.id.slice(0, image.id.indexOf(":"));
    const preview = byId.get(previewId);
    if (!preview) continue;
    const index = expansions.get(previewId) ?? 0;
    expansions.set(previewId, index + 1);
    const parameters: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(preview.previewParams)) {
      parameters[name] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value === "true" ? true : value === "false" ? false : value;
    }
    const provider = preview.methodParams[0];
    entries.push({
      id: image.id, previewId, method: preview.methodFQN, parameters,
      methodParameter: provider ? { ...provider, index } : null,
    });
  }
  return entries;
}

/** The daemon to run: the configured path, else `komodo-preview` beside the Elide binary, else on PATH. */
export async function komodoCommand(configured: string | undefined, elideBin: string | undefined): Promise<string> {
  if (configured) return configured;
  if (elideBin) {
    const beside = path.join(path.dirname(elideBin), "komodo-preview");
    try { await access(beside); return beside; } catch { /* not installed beside Elide */ }
  }
  return "komodo-preview";
}

export interface KomodoOptions {
  /** `elide.android.composePreview.komodo.path`, or undefined. */
  path: () => string | undefined;
  /** `elide.android.composePreview.komodo.fallback`: cards Komodo cannot render keep their layoutlib snapshot. */
  fallback: () => boolean;
  log: (line: string) => void;
}

/**
 * The `komodo` engine (opt-in): the layoutlib backend still builds, discovers and renders every card (a stored gallery or a
 * snapshot), and a Komodo daemon renders the cards it can host live, replacing their snapshots and pushing later frames; a card it
 * refuses keeps its layoutlib snapshot (or, without fallback, shows the reason). Unsaved edits reach the daemon as its sources
 * command; its compile messages become the panel's diagnostics.
 */
export class KomodoBackend extends ComposeBackend {
  override readonly engine = "komodo";
  private daemon: KomodoRenderer | undefined;
  private starting: Promise<KomodoRenderer | undefined> | undefined;
  /** The inputs the daemon was configured with; another set configures it again. */
  private configured = "";
  /** Why the session cannot be hosted (configure refused), until the inputs change. */
  private refusal: string | undefined;
  /** The entries the daemon was last given, as JSON; equal ones are not sent again. */
  private entriesSent = "";
  private hosted = new Map<string, string>();
  private refused = new Map<string, string>();
  private latest = new Map<string, PreviewImage>();
  private lastDocuments = new Map<string, string>();
  private logged = "";
  private readonly imageListeners = new Set<(images: PreviewImage[]) => void>();
  private readonly compileListeners = new Set<(outcome: { failed: boolean; messages: CompileMessage[] }) => void>();

  constructor(key: string, cacheRoot: string, helperDirectory: string, store: ImageStore, private readonly options: KomodoOptions, private readonly elideBin: () => string | undefined) {
    super(key, cacheRoot, helperDirectory, store);
  }

  override onImages(listener: (images: PreviewImage[]) => void): () => void {
    this.imageListeners.add(listener);
    return () => this.imageListeners.delete(listener);
  }

  override onCompile(listener: (outcome: { failed: boolean; messages: CompileMessage[] }) => void): () => void {
    this.compileListeners.add(listener);
    return () => this.compileListeners.delete(listener);
  }

  override preview(request: PreviewRequest, compile?: true, trace?: TimelineNode): Promise<PreviewImage[]>;
  override preview(request: PreviewRequest, compile: boolean, trace?: TimelineNode): Promise<PreviewImage[] | undefined>;
  override async preview(request: PreviewRequest, compile = true, trace?: TimelineNode): Promise<PreviewImage[] | undefined> {
    const images = await super.preview(request, compile, trace);
    if (!images) return images;
    try {
      return trace ? await trace.run("Komodo", () => this.overlay(images, request)) : await this.overlay(images, request);
    } catch (error) {
      // The live engine failed: every card keeps its snapshot, and the reason is in the log and the Activity view.
      const reason = error instanceof Error ? error.message : String(error);
      this.options.log(`Komodo: ${reason}; the layoutlib snapshots stand`);
      trace?.record("Komodo fallback", 0, "failed", reason);
      return images;
    }
  }

  override dispose(): void {
    this.daemon?.dispose();
    this.daemon = undefined;
    super.dispose();
  }

  /** Replaces hosted cards' snapshots by the daemon's frames; refused cards keep theirs (or show the reason without fallback). */
  private async overlay(images: PreviewImage[], request: PreviewRequest): Promise<PreviewImage[]> {
    const compiler = this.compiler;
    const previews = this.discovery;
    if (!compiler || !previews.length) return images;
    const inputs = JSON.stringify(compiler.inputs);
    if (inputs !== this.configured) {
      this.configured = inputs;
      this.refusal = undefined;
      this.entriesSent = "";
    }
    if (this.refusal) return this.fallback(images, () => this.refusal!);
    const daemon = await this.start();
    if (!daemon) return this.fallback(images, () => this.refusal ?? "komodo-preview is unavailable");
    if (!this.entriesSent) {
      daemon.send({
        command: "configure", host: "layoutlib", ...compiler.inputs,
        sources: [...new Set(Object.values(compiler.inputs.sourceSelections).flat())],
      });
      const answer = await daemon.next((event) => event.event === "configured" || (event.event === "error" && event.kind === "configure"), 300_000);
      if (answer.event === "error") {
        this.refusal = typeof answer.message === "string" ? answer.message : "komodo-preview refused the session";
        return this.fallback(images, () => this.refusal!);
      }
      this.entriesSent = "configured";
    }
    const entries = komodoEntries(images, previews);
    const entriesJson = JSON.stringify(entries);
    if (entriesJson !== this.entriesSent) {
      this.entriesSent = entriesJson;
      this.latest.clear();
      this.lastDocuments = new Map(request.documents);
      const frames = new Map<string, KomodoEvent>();
      const stop = daemon.on((event) => { if (event.event === "frame" && typeof event.entry === "string" && !frames.has(event.entry)) frames.set(event.entry, event); });
      try {
        daemon.send({ command: "entries", entries });
        const answer = await daemon.next((event) => event.event === "entries", 120_000);
        this.hosted = new Map((Array.isArray(answer.hosted) ? answer.hosted : []).filter((id): id is string => typeof id === "string").map((id) => [id, id]));
        this.refused = new Map((Array.isArray(answer.refused) ? answer.refused : []).filter((id): id is string => typeof id === "string").map((id) => [id, "refused by komodo-preview"]));
        const deadline = Date.now() + 60_000;
        while ([...this.hosted.keys()].some((id) => !frames.has(id)) && Date.now() < deadline) {
          await daemon.next((event) => event.event === "frame" || (event.event === "error" && typeof event.entry === "string"), Math.max(1, deadline - Date.now()))
            .then((event) => { if (event.event === "error" && typeof event.entry === "string") this.hosted.delete(event.entry); });
        }
      } finally {
        stop();
      }
      for (const [id, frame] of frames) this.latest.set(id, this.card(images.find((image) => image.id === id), frame));
    } else this.push(request.documents, daemon);
    return images.map((image) => this.latest.get(image.id) ?? (this.refused.has(image.id) ? this.refusedCard(image, this.refused.get(image.id)!) : image));
  }

  /** The documents that changed since the last push, sent as the daemon's sources command. */
  private push(documents: ReadonlyMap<string, string>, daemon: KomodoRenderer): void {
    const files: Record<string, string> = {};
    for (const [file, text] of documents) if (file.endsWith(".kt") && this.lastDocuments.get(file) !== text) files[file] = text;
    this.lastDocuments = new Map(documents);
    if (Object.keys(files).length && this.hosted.size) daemon.send({ command: "sources", files });
  }

  private async start(): Promise<KomodoRenderer | undefined> {
    if (this.daemon?.alive) return this.daemon;
    this.starting ??= (async () => {
      try {
        const command = await komodoCommand(this.options.path(), this.elideBin());
        const daemon = await KomodoRenderer.start(command, ["--stdio-frames", "png"], this.options.log);
        this.options.log(`Komodo: ${command} ready (protocol ${String(daemon.ready.protocol)}, host ${String(daemon.ready.host)}, Kotlin ${String(daemon.ready.kotlin)})`);
        daemon.on((event) => this.event(event));
        this.daemon = daemon;
        this.entriesSent = "";
        return daemon;
      } catch (error) {
        this.refusal = error instanceof Error ? error.message : String(error);
        return undefined;
      } finally {
        this.starting = undefined;
      }
    })();
    return this.starting;
  }

  /** Pushed frames and compile outcomes, after `preview` resolved. */
  private event(event: KomodoEvent): void {
    if (event.event === "frame" && typeof event.entry === "string" && this.hosted.has(event.entry) && typeof event.png === "string") {
      const previous = this.latest.get(event.entry);
      if (!previous) return;
      const card = this.card(previous, event);
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
    } else if (event.event === "error" && typeof event.entry === "string" && event.fallback === true) {
      this.hosted.delete(event.entry);
      this.latest.delete(event.entry);
      this.refused.set(event.entry, typeof event.message === "string" ? event.message : "komodo-preview cannot host this card");
    }
  }

  private card(image: PreviewImage | undefined, frame: KomodoEvent): PreviewImage {
    const base = image ?? { id: String(frame.entry), name: String(frame.entry), detail: "" };
    if (typeof frame.png !== "string") return base;
    return { ...base, data: frame.png, error: undefined, nodes: undefined,
      width: typeof frame.width === "number" ? frame.width : base.width, height: typeof frame.height === "number" ? frame.height : base.height };
  }

  private refusedCard(image: PreviewImage, reason: string): PreviewImage {
    return this.options.fallback() ? image : { ...image, data: undefined, width: undefined, height: undefined, nodes: undefined, error: `Komodo: ${reason}` };
  }

  private fallback(images: PreviewImage[], reason: () => string): PreviewImage[] {
    if (this.logged !== reason()) this.options.log(`Komodo: ${reason()}; rendering with layoutlib`);
    this.logged = reason();
    return images.map((image) => this.refusedCard(image, reason()));
  }
}
