import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { composePreviewBuildTargets, observeCommands, type AndroidTargetModel, type ProjectModel, type TimelineNode } from "@elide/ide-core";
import * as vscode from "vscode";
import {
  composableDeclarations, jvmFacade, parseReference, previewWrapper,
  type ComposableDeclaration, type PreviewConfiguration, type PreviewWrapper,
} from "./composeAgentSource.js";
import type { CompileMessage, ComposeBackend, ComposeBackends, PreviewGallery, PreviewKeyEvent, PreviewRequest } from "./composeBackend.js";
import { KomodoBackend, type KomodoSessionArbiter } from "./composeKomodo.js";
import { backendKey, buildErrors, javaFor, ownedBy, previewApp, previewBuild } from "./composePreview.js";
import { StaleBuildRecordError } from "./composeProcessing.js";
import type { CompiledPreview, PreviewImage, PreviewLayoutNode } from "./composeRender.js";
import { ensureComposeRuntime } from "./composeRuntime.js";
import { inspectableNodes, layoutTree, type PreviewSourceTarget } from "./composeSource.js";
import { readConfig } from "./config.js";
import type { McpContent } from "./mcpServer.js";
import type { ElideUi } from "./output.js";
import type { ElideProject, ElideWorkspace } from "./projects.js";
import { runObservedElide } from "./tasks.js";

/** What the Compose preview shares with the agent service: its backend pool and the window's Komodo session arbiter. */
export interface AgentPreviewHost {
  backends: ComposeBackends;
  arbiter: KomodoSessionArbiter;
  cacheRoot: string;
}

export interface AgentPreviewItem {
  reference: string;
  /** Kotlin expressions by parameter name, compiled in the composable's file. */
  arguments?: Readonly<Record<string, string>>;
  preview?: PreviewConfiguration;
}

export interface AgentRenderOptions {
  composables: readonly AgentPreviewItem[];
  /** Defaults for every item's configuration. */
  preview?: PreviewConfiguration;
  /** A theme composable every generated wrapper calls the composable in. */
  theme?: string;
  live?: boolean;
  rebuild?: boolean;
  /** Report each card's layout tree (default true). */
  layout?: boolean;
}

export type AgentActionType = "tap" | "longPress" | "drag" | "scroll" | "type" | "key" | "wait";

export interface AgentAction {
  type: AgentActionType;
  x?: number;
  y?: number;
  /** A layout node id of the card's last report (`n3`): its center. */
  node?: string;
  toX?: number;
  toY?: number;
  toNode?: string;
  dx?: number;
  dy?: number;
  text?: string;
  key?: string;
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
  durationMs?: number;
}

/** A report line for a node of a card's layout tree. */
interface AgentNode {
  id: string;
  node: PreviewLayoutNode;
  depth: number;
  location?: string;
}

/** One composable placed in a group: the previews (methods) rendering it, and its generated wrapper if any. */
interface Placement {
  reference: string;
  /** Its position in the agent's request: cards are reported in that order. */
  order: number;
  declaration: ComposableDeclaration;
  methods: Set<string>;
  wrapper?: PreviewWrapper;
}

/** One backend's share of a session: the previews it renders over one application's resources. */
interface Group {
  key: string;
  app: { project: ElideProject; target: AndroidTargetModel };
  backend: ComposeBackend;
  /** The agent's Komodo backend (live cards); undefined for layoutlib snapshots. */
  komodo: KomodoBackend | undefined;
  sourceFile: string;
  files: string[];
  appendices: Map<string, string>;
  previews: CompiledPreview[];
  placements: Placement[];
  /** The compiler inputs of the last render, for layout source locations. */
  units: readonly ReadonlyMap<string, string>[];
  /** Original text length per appended file: a location past it is in the generated wrapper. */
  originals: Map<string, number>;
  /** Program texts the backend was last given (live engines push what changed). */
  texts: Map<string, string>;
  latest: Map<string, PreviewImage>;
  frameAt: Map<string, number>;
  compileFailure?: CompileMessage[];
  lost: boolean;
  subscriptions: (() => void)[];
  released: boolean;
}

interface AgentCard {
  id: string;
  group: Group;
  imageId: string;
  placement: Placement;
  nodes: AgentNode[];
}

interface AgentSession {
  id: string;
  live: boolean;
  groups: Group[];
  cards: Map<string, AgentCard>;
  idle?: NodeJS.Timeout;
  closed: boolean;
  queue: Promise<unknown>;
  /** Aborted by the close: stops the session's queued and running calls. */
  closing: AbortController;
}

/** Live sessions an agent leaves unused this long are closed: the Komodo session is the window's one. */
const SESSION_IDLE_MS = 10 * 60_000;
/** Pushed frames count as settled after this long without another. */
const SETTLE_QUIET_MS = 300;
/** How long input waits for the frame it causes. */
const INPUT_FRAME_MS = 2_000;
const DEFAULT_SETTLE_MS = 3_000;
/** An edit pushed to a live session compiles within this long (Komodo: 0.3-4.4 s measured). */
const COMPILE_WAIT_MS = 45_000;
const LAYOUT_NODES = 400;
const SOURCE_EXCLUDES = "{**/.dev/**,**/build/**,**/node_modules/**,**/.git/**,**/bazel-*/**}";
const PAUSED_PANELS = "An agent is using the Komodo preview session";

/** Named keys an agent can press, in the browser `KeyboardEvent` vocabulary the live engine takes. */
const NAMED_KEYS = new Set(["Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", "Tab", "Escape",
  "Home", "End", "PageUp", "PageDown", "Insert", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal?.aborted) {
    reject(signal.reason);
    return promise;
  }
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  return promise;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 1-based line and column of `offset` in `text`. */
function position(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let start = 0;
  for (let index = text.indexOf("\n"); index >= 0 && index < offset; index = text.indexOf("\n", index + 1)) {
    line++;
    start = index + 1;
  }
  return { line, column: offset - start + 1 };
}

/** `text` with 1-based line numbers from `first`. */
function numbered(text: string, first: number): string {
  return text.split("\n").map((line, index) => `${String(first + index).padStart(5)}  ${line}`).join("\n");
}

/** Browser `code` of a printable character on a US layout, as the live engine maps physical keys; empty when it has none. */
function keyCode(character: string): string {
  if (/^[a-z]$/i.test(character)) return `Key${character.toUpperCase()}`;
  if (/^[0-9]$/.test(character)) return `Digit${character}`;
  if (character === " ") return "Space";
  return "";
}

/**
 * Renders composables for AI agents (the Compose preview MCP tools): a composable is named by code reference; one without
 * `@Preview`, or one given arguments or a configuration, is called from a generated wrapper appended to its own file for the
 * preview compile only. Snapshot cards come from the shared layoutlib backend; live cards from an agent-owned Komodo backend,
 * kept warm between calls and holding the window's one Komodo session while it renders or a live session is open.
 */
export class ComposeAgentPreviews implements vscode.Disposable {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly rendering = new Set<AbortController>();
  private readonly idleKomodo = new Map<string, { backend: ComposeBackend; timer: NodeJS.Timeout }>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("elide-compose-agent");
  private nextSession = 1;
  private nextCard = 1;
  private files: { at: number; files: Promise<string[]> } | undefined;
  private disposed = false;

  constructor(private readonly workspace: ElideWorkspace, private readonly ui: ElideUi, private readonly host: AgentPreviewHost) {}

  /** Live sessions, for the close command. */
  get liveSessions(): number {
    return [...this.sessions.values()].filter((session) => !session.closed).length;
  }

  async render(options: AgentRenderOptions, signal: AbortSignal, progress: (text: string) => void): Promise<McpContent[]> {
    this.ready();
    const controller = new AbortController();
    const cancel = AbortSignal.any([signal, controller.signal]);
    this.rendering.add(controller);
    try {
      cancel.throwIfAborted();
      return await this.renderSession(options, controller, cancel, progress);
    } finally {
      this.rendering.delete(controller);
    }
  }

  private async renderSession(options: AgentRenderOptions, controller: AbortController, cancel: AbortSignal,
    progress: (text: string) => void): Promise<McpContent[]> {
    if (!options.composables.length) throw new Error("Name at least one composable.");
    const engine = readConfig().composePreviewEngine;
    const theme = options.theme ? await this.theme(options.theme) : undefined;
    const resolved = await Promise.all(options.composables.map(async (item, order) => ({ item, order, ...await this.declaration(item.reference) })));
    const byGroup = new Map<string, { app: { project: ElideProject; target: AndroidTargetModel }; items: typeof resolved }>();
    for (const entry of resolved) {
      const app = await this.application(entry.declaration.file, cancel);
      const key = backendKey(app.project, app.target);
      const groupKey = engine === "komodo" ? key : `${key}\0${entry.declaration.file}`;
      const group = byGroup.get(groupKey) ?? { app, items: [] };
      group.items.push(entry);
      byGroup.set(groupKey, group);
    }
    if (engine === "komodo" && byGroup.size > 1) {
      throw new Error("The komodo engine hosts one application's composables per session; these need several. Render each application's composables in its own call.");
    }
    const session: AgentSession = { id: `s${this.nextSession++}`, live: options.live === true, groups: [], cards: new Map(), closed: false,
      queue: Promise.resolve(), closing: new AbortController() };
    const names = resolved.map((entry) => entry.declaration.name).join(", ");
    const trace = this.ui.activity.start(`Agent Compose preview: ${names}`, { detail: engine, cancel: () => controller.abort() });
    try {
      for (const [, { app, items }] of byGroup) {
        cancel.throwIfAborted();
        session.groups.push(await this.group(app, engine === "komodo", items.map((entry) => ({
          reference: entry.item.reference, order: entry.order, declaration: entry.declaration, text: entry.text,
          arguments: entry.item.arguments ?? {}, configuration: { ...options.preview, ...entry.item.preview },
        })), theme));
      }
      for (const group of session.groups) await this.renderGroup(group, options.rebuild === true, cancel, trace, progress);
      const content = await this.report(session, this.allCards(session), options.layout !== false);
      cancel.throwIfAborted();
      trace.end("succeeded");
      if (session.live) {
        this.sessions.set(session.id, session);
        this.touch(session);
      } else this.close(session);
      return content;
    } catch (error) {
      trace.end(cancel.aborted ? "cancelled" : "failed", message(error).split("\n")[0]);
      this.close(session);
      throw error;
    }
  }

  /** Pointer and keyboard input to a live card, then its settled frame. */
  async interact(sessionId: string, cardId: string, actions: readonly AgentAction[], settleMs = DEFAULT_SETTLE_MS, signal: AbortSignal): Promise<McpContent[]> {
    const session = this.session(sessionId);
    return this.serialized(session, signal, async (signal) => {
      const card = session.cards.get(cardId);
      if (!card) throw new Error(`Session ${sessionId} has no card ${cardId}; its cards: ${[...session.cards.keys()].join(", ")}.`);
      const group = card.group;
      if (!group.komodo) {
        throw new Error("This card is a snapshot: the layoutlib engine renders no live cards. Set elide.android.composePreview.engine to komodo for interactive previews.");
      }
      let image = group.latest.get(card.imageId);
      if (group.lost || !image?.live || image.error) {
        // Taken over by a preview panel, or its session closed: render it again first.
        await this.renderGroup(group, false, signal, undefined, () => {});
        image = group.latest.get(card.imageId);
        if (!image?.live || image.error) throw new Error(`Card ${cardId} is not live: ${image?.error ?? "it has no frame"}`);
      }
      // A close during that render released the group: it must not hold the arbiter again.
      signal.throwIfAborted();
      this.host.arbiter.setActive(group.komodo, true);
      const backend = group.backend;
      const point = (x: number | undefined, y: number | undefined, node: string | undefined, what: string) => {
        if (node !== undefined) {
          const found = card.nodes.find((candidate) => candidate.id === node);
          if (!found) throw new Error(`Card ${cardId} has no layout node ${node} in its last report.`);
          return { x: Math.round(found.node.x + found.node.width / 2), y: Math.round(found.node.y + found.node.height / 2) };
        }
        if (typeof x !== "number" || typeof y !== "number") throw new Error(`${what} needs x and y (image pixels) or a node.`);
        return { x, y };
      };
      const pointer = (action: "down" | "up" | "move" | "scroll", x: number, y: number, dx?: number, dy?: number) => {
        if (!backend.pointer(card.imageId, action, x, y, dx, dy)) throw new Error(`Card ${cardId} no longer takes input (its session was replaced); call compose_preview_refresh.`);
      };
      const key = (name: string, modifiers: AgentAction) => {
        for (const action of ["down", "up"] as const) {
          const event: PreviewKeyEvent = { action, key: name, code: NAMED_KEYS.has(name) ? name : keyCode(name),
            shiftKey: modifiers.shift === true || /^[A-Z]$/.test(name), ctrlKey: modifiers.ctrl === true, altKey: modifiers.alt === true,
            metaKey: modifiers.meta === true, repeat: false };
          if (!backend.keyboard(card.imageId, event)) throw new Error(`Card ${cardId} takes no keyboard input (an older Komodo, or it lost focus); tap a text field first.`);
        }
      };
      const inputAt = performance.now();
      for (const action of actions) {
        signal.throwIfAborted();
        switch (action.type) {
          case "tap": {
            const at = point(action.x, action.y, action.node, "tap");
            pointer("down", at.x, at.y);
            await sleep(40, signal);
            pointer("up", at.x, at.y);
            break;
          }
          case "longPress": {
            const at = point(action.x, action.y, action.node, "longPress");
            pointer("down", at.x, at.y);
            await sleep(action.durationMs ?? 700, signal);
            pointer("up", at.x, at.y);
            break;
          }
          case "drag": {
            const from = point(action.x, action.y, action.node, "drag");
            const to = point(action.toX, action.toY, action.toNode, "drag's end (toX/toY or toNode)");
            const duration = action.durationMs ?? 300;
            const steps = Math.max(2, Math.round(duration / 16));
            pointer("down", from.x, from.y);
            for (let step = 1; step <= steps; step++) {
              await sleep(duration / steps, signal);
              pointer("move", Math.round(from.x + (to.x - from.x) * step / steps), Math.round(from.y + (to.y - from.y) * step / steps));
            }
            pointer("up", to.x, to.y);
            break;
          }
          case "scroll": {
            const at = point(action.x, action.y, action.node, "scroll");
            pointer("scroll", at.x, at.y, action.dx ?? 0, action.dy ?? 0);
            break;
          }
          case "type":
            if (!action.text) throw new Error("type needs text.");
            for (const character of action.text) key(character === "\n" ? "Enter" : character, action);
            break;
          case "key":
            if (!action.key || !(NAMED_KEYS.has(action.key) || [...action.key].length === 1)) {
              throw new Error(`key needs a single character or one of ${[...NAMED_KEYS].join(", ")}.`);
            }
            key(action.key, action);
            break;
          case "wait":
            await sleep(action.durationMs ?? 500, signal);
            break;
          default:
            throw new Error(`Unknown action ${String(action.type)}.`);
        }
      }
      await this.settle(group, [card.imageId], settleMs, signal, inputAt);
      return this.report(session, [card], true);
    });
  }

  /** Renders the session's composables again from the current source text (an agent's edits on disk or in editors). */
  async refresh(sessionId: string, signal: AbortSignal, progress: (text: string) => void): Promise<McpContent[]> {
    const session = this.session(sessionId);
    return this.serialized(session, signal, async (signal) => {
      for (const group of session.groups) {
        group.placements.forEach((placement) => this.revalidate(placement));
        await this.renderGroup(group, false, signal, undefined, progress);
      }
      return this.report(session, this.allCards(session), true);
    });
  }

  closeSession(sessionId: string): string {
    const session = this.session(sessionId);
    this.close(session);
    return `Closed session ${sessionId}.`;
  }

  /** Live sessions and renders still opening one: the close-sessions command, or a window going away. */
  closeAll(): number {
    const pending = this.rendering.size;
    for (const controller of this.rendering) controller.abort(new Error("The agent preview render was closed."));
    const sessions = [...this.sessions.values()];
    for (const session of sessions) this.close(session);
    return sessions.length + pending;
  }

  /** Top-level composables of a file or the workspace, with the reference that names each. */
  async list(file: string | undefined, query: string | undefined): Promise<string> {
    const files = file ? [await this.file(file)] : await this.kotlinFiles();
    const needle = query?.toLowerCase();
    const lines: string[] = [];
    let total = 0;
    for (const candidate of files) {
      const text = await this.text(candidate);
      if (!text.includes("Composable")) continue;
      for (const declaration of composableDeclarations(text, candidate)) {
        if (needle && !declaration.name.toLowerCase().includes(needle) && !declaration.packageName.toLowerCase().includes(needle)) continue;
        total++;
        if (lines.length >= 200) continue;
        const parameters = declaration.parameters.map((parameter) => `${parameter.vararg ? "vararg " : ""}${parameter.name}: ${parameter.type}${parameter.defaultValue !== undefined ? " = …" : ""}`);
        const reference = declaration.packageName ? `${declaration.packageName}.${declaration.name}` : declaration.name;
        lines.push(`- ${reference} — ${vscode.workspace.asRelativePath(candidate, false)}:${declaration.line}${declaration.visibility === "public" ? "" : ` (${declaration.visibility})`}`
          + `${declaration.previews ? " @Preview" : ""}\n  ${declaration.receiver ? `${declaration.receiver}.` : ""}${declaration.name}(${parameters.join(", ")})`);
      }
    }
    if (!total) return `No top-level @Composable functions${needle ? ` matching "${query}"` : ""} in ${file ?? "the workspace"}.`;
    return `${total} composable${total === 1 ? "" : "s"}${total > lines.length ? ` (first ${lines.length} shown; narrow with query or file)` : ""}:\n${lines.join("\n")}`;
  }

  dispose(): void {
    this.disposed = true;
    this.closeAll();
    for (const { backend, timer } of this.idleKomodo.values()) {
      clearTimeout(timer);
      backend.dispose();
    }
    this.idleKomodo.clear();
    this.diagnostics.dispose();
  }

  private ready(): void {
    if (this.disposed) throw new Error("The Elide extension is shutting down.");
    if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before rendering Compose previews: they run the project's code.");
  }

  private session(id: string): AgentSession {
    const session = this.sessions.get(id);
    if (!session || session.closed) throw new Error(`No live preview session ${id}; render with live: true to open one.`);
    return session;
  }

  /** Runs a call's `work` after the session's earlier ones, with `signal` also aborted by the close; the session idles from its end. */
  private serialized<T>(session: AgentSession, signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const run = session.queue.then(async () => {
      if (session.closed) throw new Error(`No live preview session ${session.id}; it was closed.`);
      clearTimeout(session.idle);
      try {
        return await work(AbortSignal.any([signal, session.closing.signal]));
      } finally {
        if (!session.closed) this.touch(session);
      }
    });
    session.queue = run.catch(() => {});
    return run;
  }

  private touch(session: AgentSession): void {
    clearTimeout(session.idle);
    session.idle = setTimeout(() => this.close(session), SESSION_IDLE_MS);
    session.idle.unref();
  }

  private close(session: AgentSession): void {
    if (session.closed) return;
    session.closed = true;
    session.closing.abort(new Error(`Session ${session.id} was closed.`));
    clearTimeout(session.idle);
    this.sessions.delete(session.id);
    for (const group of session.groups) this.release(group);
  }

  /** A composable's file, its text and declaration, from a reference such as `pkg.Name`, `Name` or `src/…/File.kt#Name`. */
  private async declaration(reference: string): Promise<{ declaration: ComposableDeclaration; text: string }> {
    const parsed = parseReference(reference);
    const files = parsed.file ? [await this.file(parsed.file)] : await this.kotlinFiles();
    const found: { declaration: ComposableDeclaration; text: string }[] = [];
    for (const file of files) {
      const text = await this.text(file);
      if (!text.includes(parsed.name)) continue;
      for (const declaration of composableDeclarations(text, file)) {
        if ((parsed.name && declaration.name !== parsed.name) || (parsed.packageName !== undefined && declaration.packageName !== parsed.packageName)
          || (parsed.line !== undefined && declaration.line !== parsed.line)) continue;
        found.push({ declaration, text });
      }
    }
    if (!found.length) {
      throw new Error(`No top-level @Composable function ${reference} in ${parsed.file ?? "this workspace's Kotlin sources"}. `
        + "Name it as package.Function, Function, or path/to/File.kt#Function (compose_preview_list shows the composables).");
    }
    if (found.length > 1) {
      throw new Error(`${reference} names ${found.length} composables; name one:\n${found.map(({ declaration }) =>
        `- ${vscode.workspace.asRelativePath(declaration.file, false)}#${declaration.name}:${declaration.line}`).join("\n")}`);
    }
    return found[0]!;
  }

  /**
   * The theme to wrap composables in: a workspace composable, or (not in the workspace's sources, such as a library's
   * `androidx.compose.material3.MaterialTheme`) called by its qualified name with the content as its trailing lambda.
   */
  private async theme(reference: string): Promise<ComposableDeclaration> {
    try {
      return (await this.declaration(reference)).declaration;
    } catch (error) {
      const parsed = parseReference(reference);
      if (parsed.file || !parsed.packageName) throw error;
      return { name: parsed.name, packageName: parsed.packageName, file: "", offset: 0, line: 0, visibility: "public", typeParameters: [],
        parameters: [{ name: "content", type: "@Composable () -> Unit", vararg: false, annotations: [] }], previews: false, annotations: ["Composable"] };
    }
  }

  /** Absolute path of a file named relative to a workspace folder (or absolute). */
  private async file(name: string): Promise<string> {
    const candidates = path.isAbsolute(name) ? [name] : (vscode.workspace.workspaceFolders ?? []).map((folder) => path.join(folder.uri.fsPath, name));
    for (const candidate of candidates) {
      if (await stat(candidate).then((stats) => stats.isFile(), () => false)) return path.normalize(candidate);
    }
    throw new Error(`${name} is not a file in this workspace.`);
  }

  private async kotlinFiles(): Promise<string[]> {
    let listed = this.files;
    if (!listed || performance.now() - listed.at > 10_000) {
      const files = Promise.resolve(vscode.workspace.findFiles("**/*.kt", SOURCE_EXCLUDES)).then((uris) => uris.map((uri) => uri.fsPath)
        .filter((file) => this.workspace.projectFor(file) !== undefined).sort());
      files.catch(() => {});
      listed = this.files = { at: performance.now(), files };
    }
    return listed.files;
  }

  /** Editor text of a file, else its saved text. */
  private async text(file: string): Promise<string> {
    return vscode.workspace.textDocuments.find((document) => document.uri.scheme === "file" && document.uri.fsPath === file)?.getText()
      ?? await readFile(file, "utf8");
  }

  /** The application previewing `file`; a folder's first sync still running is waited for. */
  private async application(file: string, signal: AbortSignal): Promise<{ project: ElideProject; target: AndroidTargetModel }> {
    signal.throwIfAborted();
    let project = this.workspace.projectFor(file);
    if (project && !project.model && this.workspace.isSyncing(project.folder)) {
      const folder = project.folder;
      const { promise, resolve } = Promise.withResolvers<void>();
      const subscription = this.workspace.onDidChange(() => setTimeout(() => {
        if (!this.workspace.isSyncing(folder)) resolve();
      }, 0));
      signal.addEventListener("abort", () => resolve(), { once: true });
      await promise;
      subscription.dispose();
      signal.throwIfAborted();
      project = this.workspace.projectFor(file);
    }
    if (!project) throw new Error(`${vscode.workspace.asRelativePath(file, false)} belongs to no Elide project of this window.`);
    if (!project.model) throw new Error(`Sync ${path.basename(project.root)} first: it has no project model.`);
    const app = previewApp(this.workspace, project, file);
    if (!app) throw new Error(`No Android application in this workspace folder packages ${path.basename(file)}. Declare an AndroidApk that includes its source set or depends on its library, then sync.`);
    return app;
  }

  /** A backend's share of a session: the generated wrappers and the previews selected for its composables. */
  private async group(app: { project: ElideProject; target: AndroidTargetModel }, komodo: boolean,
    items: { reference: string; order: number; declaration: ComposableDeclaration; text: string; arguments: Readonly<Record<string, string>>; configuration: PreviewConfiguration }[],
    theme: ComposableDeclaration | undefined): Promise<Group> {
    const key = backendKey(app.project, app.target);
    const placements: Placement[] = [];
    const previews: CompiledPreview[] = [];
    const appendices = new Map<string, string>();
    const originals = new Map<string, number>();
    const seen = new Set<string>();
    for (const item of items) {
      const { declaration } = item;
      const facade = jvmFacade(item.text, declaration.file);
      const configured = Object.values(item.configuration).some((value) => value !== undefined);
      const placement: Placement = { reference: item.reference, order: item.order, declaration, methods: new Set() };
      placements.push(placement);
      if (declaration.previews && !Object.keys(item.arguments).length && !configured && !theme) {
        // Its own @Preview configurations, as discovery reports them.
        const method = `${facade}.${declaration.name}`;
        const discovered = komodo
          ? (await this.workspace.komodoPreviews(declaration.file)).previews.filter((preview) => preview.methodFQN === method)
          : [{ methodFQN: method, previewId: method, name: declaration.name, previewParams: {}, methodParams: [] }];
        if (!discovered.length) throw new Error(`Komodo reports no @Preview for ${method}; the file may not compile.`);
        placement.methods.add(method);
        for (const preview of discovered) if (!seen.has(preview.previewId)) {
          seen.add(preview.previewId);
          previews.push(preview);
        }
        continue;
      }
      const wrapper = previewWrapper({ target: declaration, facade, arguments: item.arguments, theme,
        configuration: { showBackground: true, ...item.configuration }, annotate: !komodo });
      placement.wrapper = wrapper;
      placement.methods.add(wrapper.methodFQN);
      if (seen.has(wrapper.methodFQN)) continue;
      seen.add(wrapper.methodFQN);
      if (!originals.has(declaration.file)) originals.set(declaration.file, item.text.length);
      appendices.set(declaration.file, (appendices.get(declaration.file) ?? "") + wrapper.text);
      previews.push({ methodFQN: wrapper.methodFQN, previewId: wrapper.methodFQN, name: declaration.name, previewParams: wrapper.previewParams, methodParams: [] });
    }
    const files = [...new Set(items.map((item) => item.declaration.file))];
    const backend = komodo ? this.komodoBackend(key) : this.host.backends.acquire(key);
    const group: Group = {
      key, app, backend, komodo: backend instanceof KomodoBackend ? backend : undefined, sourceFile: files[0]!, files: files.slice(1),
      appendices, previews, placements, units: [], originals,
      texts: new Map(), latest: new Map(), frameAt: new Map(), lost: false, subscriptions: [], released: false,
    };
    group.subscriptions.push(
      backend.onImages((images) => {
        for (const image of images) {
          group.latest.set(image.id, image);
          group.frameAt.set(image.id, performance.now());
        }
      }),
      backend.onCompile((outcome) => { group.compileFailure = outcome.failed ? outcome.messages : undefined; }),
      backend.onSessionLost(() => { group.lost = true; }),
    );
    return group;
  }

  /** A wrapper is generated from the declaration it was resolved to; an edit that changes the declaration fails here, not in the compile. */
  private revalidate(placement: Placement): void {
    if (!placement.wrapper) return;
    const text = vscode.workspace.textDocuments.find((document) => document.uri.fsPath === placement.declaration.file)?.getText();
    if (text === undefined) return;
    const current = composableDeclarations(text, placement.declaration.file).find((declaration) => declaration.name === placement.declaration.name);
    if (!current) throw new Error(`${placement.reference} is no longer a top-level composable of ${path.basename(placement.declaration.file)}; render it again.`);
  }

  /** The agent's Komodo backend for an application: the warm one of an earlier call, else a new one outside the panel pool. */
  private komodoBackend(key: string): ComposeBackend {
    const idle = this.idleKomodo.get(key);
    if (idle && !idle.backend.disposed) {
      clearTimeout(idle.timer);
      this.idleKomodo.delete(key);
      return idle.backend;
    }
    return this.host.backends.detached(key);
  }

  private release(group: Group): void {
    if (group.released) return;
    group.released = true;
    for (const unsubscribe of group.subscriptions) unsubscribe();
    if (!group.komodo) {
      this.host.backends.release(group.backend);
      return;
    }
    for (const image of group.latest.keys()) group.backend.blur(image);
    this.host.arbiter.setActive(group.komodo, false);
    const previous = this.idleKomodo.get(group.key);
    if (this.disposed || group.backend.disposed || (previous && previous.backend !== group.backend)) {
      group.backend.dispose();
      return;
    }
    const keepAlive = readConfig().composePreviewKeepAlive * 60_000;
    if (keepAlive <= 0) {
      group.backend.dispose();
      return;
    }
    const timer = setTimeout(() => {
      if (this.idleKomodo.get(group.key)?.backend === group.backend) this.idleKomodo.delete(group.key);
      group.backend.dispose();
    }, Math.min(keepAlive, 0x7fff_ffff));
    timer.unref();
    this.idleKomodo.set(group.key, { backend: group.backend, timer });
  }

  /**
   * The request for a group: the folder's editor texts, with every program file's current text (a file the agent changed on
   * disk included, waiting for VS Code to reload an unmodified editor of it, which the language server compiles from).
   */
  private async request(group: Group): Promise<PreviewRequest> {
    const folder = group.app.project.folder;
    const program = [group.sourceFile, ...group.files];
    for (const file of program) {
      const disk = await readFile(file, "utf8");
      let document = vscode.workspace.textDocuments.find((item) => item.uri.scheme === "file" && item.uri.fsPath === file);
      // The language server compiles open documents: open the program's files so their text reaches it.
      document ??= await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      if (!document.isDirty && document.getText() !== disk) await this.reloaded(document, disk);
    }
    const documents = new Map(vscode.workspace.textDocuments.filter((item) => ownedBy(this.workspace, folder, item.uri))
      .map((item) => [item.uri.fsPath, item.getText()] as const));
    for (const file of program) if (!documents.has(file)) documents.set(file, await readFile(file, "utf8"));
    const packageName = /^\s*package\s+([\w.`]+)/m.exec(documents.get(group.sourceFile) ?? "")?.[1]?.replaceAll("`", "") ?? "";
    return { documents, sourceFile: group.sourceFile, packageName, inspect: true,
      selection: { appendices: group.appendices, previews: group.previews, files: group.files } };
  }

  /** Waits (briefly) for VS Code to reload an unmodified document whose file changed on disk. */
  private async reloaded(document: vscode.TextDocument, disk: string): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const subscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === document && document.getText() === disk) resolve();
    });
    const timer = setTimeout(resolve, 3_000);
    await promise;
    clearTimeout(timer);
    subscription.dispose();
  }

  /** Prepares the group's backend (renderer, compiler; a build when there is none yet or `rebuild`) and renders its selection. */
  private async renderGroup(group: Group, rebuild: boolean, signal: AbortSignal, trace: TimelineNode | undefined, progress: (text: string) => void): Promise<void> {
    const queueKey = group.komodo ? `komodo\0${group.key}` : group.key;
    const previous = this.queues.get(queueKey) ?? Promise.resolve();
    const run = previous.then(() => this.renderNow(group, rebuild, signal, trace, progress));
    const settled = run.catch(() => {});
    this.queues.set(queueKey, settled);
    void settled.then(() => { if (this.queues.get(queueKey) === settled) this.queues.delete(queueKey); });
    return run;
  }

  private async renderNow(group: Group, rebuild: boolean, signal: AbortSignal, trace: TimelineNode | undefined, progress: (text: string) => void): Promise<void> {
    signal.throwIfAborted();
    const { backend } = group;
    const project = this.workspace.projectAt(group.app.project.root);
    const model = project?.model;
    if (!project || !model) throw new Error(`Sync ${path.basename(group.app.project.root)} before previewing.`);
    const artifact = model.android?.targets.find((target) => target.name === group.app.target.name);
    if (!artifact) throw new Error(`Android artifact ${group.app.target.name} no longer exists; render again.`);
    const step = <T>(label: string, work: () => Promise<T>): Promise<T> => {
      progress(label);
      return trace ? trace.run(label, () => work()) : work();
    };
    progress("Reading sources");
    const request = await this.request(group);
    const build = previewBuild(this.workspace, project, model, artifact);
    const runtime = await step("Compose runtime", () => ensureComposeRuntime(this.host.cacheRoot, signal, progress));
    await backend.startRenderer(runtime, javaFor(model), group.previews.length);
    let built = false;
    if (rebuild) {
      await this.build(project, model, artifact, build.models, signal, trace, progress);
      built = true;
    }
    try {
      await step("Prepare compiler", () => backend.configure(build, request.documents, built));
    } catch (error) {
      // Never built, or a build is rewriting its outputs: build, then derive the compiler from what it wrote.
      if (built || error instanceof StaleBuildRecordError) throw error;
      await this.build(project, model, artifact, build.models, signal, trace, progress);
      await step("Prepare compiler", () => backend.configure(build, request.documents, true));
    }
    signal.throwIfAborted();
    if (backend.needsWarmup) await step("Initialize compiler", () => backend.warm(request));
    if (group.komodo) {
      // A session closed meanwhile released the group: it must not hold the arbiter again.
      signal.throwIfAborted();
      this.host.arbiter.setActive(group.komodo, true);
    }
    // A live session pushes the changed text (no live card: nothing is pushed) and compiles it before its cards change.
    const changed = group.komodo && [...group.latest.values()].some((image) => image.live && !image.error)
      && [...group.texts].some(([file, text]) => request.documents.get(file) !== text);
    const compiled = changed ? this.compiled(group, signal) : undefined;
    // The frames shown before the push: the edit's reload frame can still show them (Komodo), and does not count as its frame.
    const before = compiled ? new Map([...group.latest].map(([id, image]) => [id, image.data] as const)) : undefined;
    group.compileFailure = undefined;
    let gallery: PreviewGallery;
    try {
      gallery = await step("Render", () => this.preview(backend, request, trace));
    } catch (error) {
      compiled?.cancel();
      throw this.located(error, group, request);
    }
    group.lost = false;
    for (const file of [group.sourceFile, ...group.files]) group.texts.set(file, request.documents.get(file)!);
    for (const image of backend.latestImages(gallery.images)) {
      group.latest.set(image.id, image);
      group.frameAt.set(image.id, performance.now());
    }
    // The edit's frames follow its compile: wait for them as for input's (a failed compile renders none).
    let compiledAt: number | undefined;
    if (compiled) {
      progress("Compiling the edit");
      compiledAt = await compiled.done;
      signal.throwIfAborted();
    }
    if (group.komodo) await this.settle(group, [...group.latest.keys()], DEFAULT_SETTLE_MS, signal, compiledAt, before);
    const effective = new Map(request.documents);
    for (const [file, appendix] of group.appendices) effective.set(file, (effective.get(file) ?? "") + appendix);
    group.units = (await backend.compiler?.sources(effective))?.files ?? [effective];
  }

  /** Renders `request`, confirming annotation processing as a preview panel does. */
  private async preview(backend: ComposeBackend, request: PreviewRequest, trace: TimelineNode | undefined): Promise<PreviewGallery> {
    let gallery: PreviewGallery;
    try {
      gallery = await this.inspected(backend, request, trace);
    } catch (error) {
      if (!backend.processingRequired) throw error;
      await backend.verify(request, trace);
      gallery = await this.inspected(backend, request, trace);
    }
    while (!gallery.verified && await backend.verify(request, trace)) gallery = await this.inspected(backend, request, trace);
    return gallery;
  }

  /** With layout sources when the build's bytecode allows; pixels without them otherwise. */
  private async inspected(backend: ComposeBackend, request: PreviewRequest, trace: TimelineNode | undefined): Promise<PreviewGallery> {
    try {
      return await backend.preview(request, true, trace);
    } catch (error) {
      if (!request.inspect || !/Layout inspection requires preview source instrumentation/.test(message(error))) throw error;
      return backend.preview({ ...request, inspect: false }, true, trace);
    }
  }

  /** When a live engine reports the compile of the edit being pushed, if it succeeds (undefined: it failed, or never came). */
  private compiled(group: Group, signal: AbortSignal): { done: Promise<number | undefined>; cancel: () => void } {
    const { promise, resolve } = Promise.withResolvers<number | undefined>();
    const timer = setTimeout(() => resolve(undefined), COMPILE_WAIT_MS);
    const unsubscribe = group.backend.onCompile((outcome) => resolve(outcome.failed ? undefined : performance.now()));
    const aborted = () => resolve(undefined);
    signal.addEventListener("abort", aborted, { once: true });
    const done = promise.finally(() => {
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener("abort", aborted);
    });
    return { done, cancel: () => resolve(undefined) };
  }

  /**
   * Until no listed card received a frame for {@link SETTLE_QUIET_MS}, at most `maxMs`. After input sent from `inputAt` on, the
   * quiet period starts with its first frame (with `before`, the first whose pixels differ from those), which recomposition can
   * take longer than that period to produce; input that changes nothing renders none, and waits {@link INPUT_FRAME_MS} at most.
   */
  private async settle(group: Group, imageIds: readonly string[], maxMs: number, signal: AbortSignal, inputAt?: number,
    before?: ReadonlyMap<string, string | undefined>): Promise<void> {
    const start = performance.now();
    const deadline = start + maxMs;
    const latest = () => Math.max(0, ...imageIds.map((id) => group.frameAt.get(id) ?? 0));
    const redrawn = (since: number) => imageIds.some((id) => (group.frameAt.get(id) ?? 0) >= since
      && (!before || group.latest.get(id)?.data !== before.get(id)));
    if (inputAt !== undefined) while (!redrawn(inputAt) && performance.now() < Math.min(deadline, start + INPUT_FRAME_MS)) await sleep(20, signal);
    for (;;) {
      const quietUntil = Math.max(start, latest()) + SETTLE_QUIET_MS;
      const now = performance.now();
      if (now >= quietUntil || now >= deadline) return;
      await sleep(Math.min(quietUntil, deadline) - now, signal);
    }
  }

  /** A compile failure inside a generated wrapper shows the wrapper, numbered as the compiler numbers it. */
  private located(error: unknown, group: Group, request: PreviewRequest): Error {
    const text = message(error);
    const wrappers = [...group.appendices].map(([file, appendix]) => {
      const original = request.documents.get(file) ?? "";
      const first = original.split("\n").length;
      return `${vscode.workspace.asRelativePath(file, false)}, lines ${first}+ (generated wrapper, appended for the preview only):\n${numbered(appendix, first)}`;
    });
    return new Error(wrappers.length ? `${text}\n\n${wrappers.join("\n\n")}` : text, { cause: error });
  }

  /** Runs the build of the application's preview inputs (no APK, no device), as a step of `trace`. */
  private async build(project: ElideProject, model: ProjectModel, artifact: AndroidTargetModel, models: readonly ProjectModel[], signal: AbortSignal,
    trace: TimelineNode | undefined, progress: (text: string) => void): Promise<void> {
    progress(`Building ${artifact.name} preview inputs`);
    const step = trace?.start("Build");
    const root = step ?? this.ui.activity.start(`Agent Compose preview build: ${artifact.name}`);
    let code: number | undefined;
    try {
      code = await runObservedElide(project, "build", { args: composePreviewBuildTargets(model, artifact, models) }, {
        signal, diagnostics: this.diagnostics, onCommand: observeCommands(() => root, (line) => this.ui.log(line)),
      });
    } catch (error) {
      root.end("failed", message(error));
      throw error;
    }
    if (code === 0) {
      root.end("succeeded");
      return;
    }
    if (code === undefined) {
      root.end("cancelled", "stopped");
      throw new Error("The preview build was stopped.");
    }
    const errors = buildErrors(root.lines());
    root.end("failed", `exit ${code}`);
    throw new Error([`elide build exited with ${code} building ${artifact.name}'s preview inputs.`, ...errors].join("\n"));
  }

  /** Every card of the session, in the order the agent named their composables (a composable's variants in render order). */
  private allCards(session: AgentSession): AgentCard[] {
    return session.groups.flatMap((group) => this.cards(session, group)).sort((left, right) => left.placement.order - right.placement.order);
  }

  /** The group's cards: one per rendered image of a selected method, keeping card ids across renders. */
  private cards(session: AgentSession, group: Group): AgentCard[] {
    const result: AgentCard[] = [];
    for (const placement of group.placements) {
      for (const image of group.latest.values()) {
        if (!placement.methods.has(image.detail) && !(image.detail === "" && [...placement.methods].some((method) => image.id.startsWith(`${method}:`)))) continue;
        let card = [...session.cards.values()].find((candidate) => candidate.group === group && candidate.imageId === image.id && candidate.placement === placement);
        if (!card) {
          card = { id: `c${this.nextCard++}`, group, imageId: image.id, placement, nodes: [] };
          session.cards.set(card.id, card);
        }
        result.push(card);
      }
    }
    return result;
  }

  private async report(session: AgentSession, cards: readonly AgentCard[], layout: boolean): Promise<McpContent[]> {
    const content: McpContent[] = [];
    const engine = cards[0]?.group.komodo ? "komodo" : "layoutlib";
    const header = session.live && !session.closed
      ? `Live session ${session.id} (${engine} engine): pass its id and a card id to compose_preview_interact (input) or compose_preview_refresh (after editing the source); close it with compose_preview_close when done.`
      : `Rendered with the ${engine} engine${session.live ? "" : " (one-shot; render with live: true for an interactive session)"}.`;
    const failures = [...new Set(cards.map((card) => card.group))].flatMap((group) => group.compileFailure ?? []);
    content.push({ type: "text", text: [header, ...failures.length ? [`The edit does not compile; the cards show the last program that did:\n${failures
      .map((failure) => `- ${failure.file ? `${vscode.workspace.asRelativePath(failure.file, false)}:${failure.line ?? 0}:${failure.column ?? 0}: ` : ""}${failure.level}: ${failure.text}`).join("\n")}`] : []].join("\n\n") });
    if (!cards.length) content.push({ type: "text", text: "No card rendered: the renderer reported no preview for the selection." });
    for (const card of cards) {
      const image = card.group.latest.get(card.imageId);
      const declaration = card.placement.declaration;
      const lines = [`### ${card.id} · ${image?.name ?? declaration.name} — ${card.placement.reference}`];
      const where = `${vscode.workspace.asRelativePath(declaration.file, false)}:${declaration.line}`;
      if (card.placement.wrapper) {
        const values = card.placement.wrapper.arguments.map((argument) => `${argument.name} = ${argument.value}${argument.source === "placeholder" ? " (placeholder)" : ""}`);
        lines.push(`Composable at ${where}, called by the generated preview ${card.placement.wrapper.name}(${values.length ? `): ${declaration.name}(${values.join(", ")})` : `): ${declaration.name}()`}.`);
      } else lines.push(`Its own @Preview at ${where}${image?.id.endsWith(":0") ? "" : ` (variant ${image?.id.slice(image.id.lastIndexOf(":") + 1)})`}.`);
      if (!image) lines.push("No frame.");
      else if (image.error) lines.push(`Failed: ${image.error}`);
      else lines.push(`${image.width ?? "?"}×${image.height ?? "?"} px${image.live ? ", live" : ", snapshot"}.`);
      card.nodes = [];
      if (image?.data && !image.error && layout) {
        const targets = new Map<string, PreviewSourceTarget>();
        const nodes = inspectableNodes(image, card.group.units, targets) ?? [];
        const tree = layoutTree(nodes);
        card.nodes = tree.map(({ node, depth }, index) => {
          const target = targets.get(`${image.id}\0${node.id}`);
          let location: string | undefined;
          if (target) {
            const original = card.group.originals.get(target.file);
            const at = position(target.content, target.offset);
            location = original !== undefined && target.offset >= original
              ? "generated wrapper"
              : `${vscode.workspace.asRelativePath(target.file, false)}:${at.line}:${at.column}`;
          }
          return { id: `n${index + 1}`, node, depth, location };
        });
        if (image.layoutError) lines.push(`Layout unavailable: ${image.layoutError}`);
        else if (!card.nodes.length) lines.push("Layout: no inspectable nodes (code compiled without Compose source information shows bounds only on live cards).");
        else {
          lines.push("Layout (image pixels: x,y width×height; call site):");
          for (const entry of card.nodes.slice(0, LAYOUT_NODES)) {
            const { node } = entry;
            lines.push(`${"  ".repeat(entry.depth)}${entry.id} ${node.name} ${node.x},${node.y} ${node.width}×${node.height}${entry.location ? ` — ${entry.location}` : ""}`);
          }
          if (card.nodes.length > LAYOUT_NODES) lines.push(`… ${card.nodes.length - LAYOUT_NODES} more nodes omitted.`);
        }
      }
      content.push({ type: "text", text: lines.join("\n") });
      if (image?.data && !image.error) content.push({ type: "image", data: image.data, mimeType: "image/png" });
    }
    if (cards.some((card) => card.group.komodo) && session.live && !session.closed) {
      content.push({ type: "text", text: `While this session is open, the Compose preview panel shows "${PAUSED_PANELS}"; close the session to resume it.` });
    }
    return content;
  }
}
