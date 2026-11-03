import { createHash } from "node:crypto";
import path from "node:path";
import {
  TimelineNode,
  composePreviewAnnotations,
  composePreviewApplications,
  composePreviewBuildTargets,
  formatDuration,
  liveStatus,
  observeCommands,
  parseElideOutputLine,
  resolveElideDistribution,
  type AndroidTargetModel,
  type ProjectModel,
  type TimelineLine,
} from "@elide/ide-core";
import * as vscode from "vscode";
import { AndroidStackSourceIndex, parseAndroidStackFrame, type AndroidStackLocation } from "./androidStackSource.js";
import { ComposeBackend, ComposeBackends, isPreviewKeyEvent, type CompileMessage, type PreviewBuild, type PreviewGallery, type PreviewKeyEvent, type PreviewRequest } from "./composeBackend.js";
import { firstCompilerError } from "./composeCompiler.js";
import { KomodoBackend, KomodoSessionArbiter } from "./composeKomodo.js";
import { StaleBuildRecordError } from "./composeProcessing.js";
import type { PreviewImage, PreviewLayoutNode } from "./composeRender.js";
import { previewHtml } from "./composePreviewHtml.js";
import { inspectableNodes, type PreviewSourceTarget } from "./composeSource.js";
import { readConfig } from "./config.js";
import { ensureComposeRuntime, installedComposeRuntime } from "./composeRuntime.js";
import type { ElideUi } from "./output.js";
import type { ElideProject, ElideWorkspace } from "./projects.js";
import { runObservedElide } from "./tasks.js";

const previewInput = /\.(?:kt|java|xml|pkl)$/;
/** Build output lines the panel keeps for its Build log; the activity log has every line. */
const LOG_LINES = 2_000;
/** Compiler errors quoted in a failed build's diagnostics. */
const QUOTED_ERRORS = 20;
/** A live engine's frames reach the webview at most this often: each publication reposts and hashes every card. */
const PUSH_INTERVAL_MS = 50;
/** Hashes of unacknowledged publications kept, should the webview skip acknowledgements while it is hidden. */
const UNACKNOWLEDGED = 16;
const VIEW_TYPE = "elide.composePreview";
/**
 * Workspace state key of the previewed file's renames, old URI to new. A hidden panel's webview is not running, so it
 * misses the rename's `source` message and a window reload restores its stale state: the restore follows these.
 * Cleared once a running webview has the current source again.
 */
const RENAMES_KEY = "elide.composePreview.renames";

/** `work`, or its rejection with `signal`'s reason once `signal` aborts first. */
function cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const abort = () => reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  return promise;
}

/**
 * The compiler errors of a failed build as Elide printed them: each `error:` line with the `In file:` location that
 * follows it.
 */
export function buildErrors(lines: readonly TimelineLine[]): string[] {
  const errors: string[] = [];
  for (const [index, line] of lines.entries()) {
    const parsed = parseElideOutputLine(line.text);
    if (parsed?.kind !== "diagnostic" || parsed.severity !== "error") continue;
    const location = lines[index + 1]?.text.startsWith("In file:") ? `\n  ${lines[index + 1]!.text}` : "";
    errors.push(`error: ${parsed.message}${location}`);
    if (errors.length === QUOTED_ERRORS) break;
  }
  return errors;
}

export function ownedBy(workspace: ElideWorkspace, folder: vscode.WorkspaceFolder, uri: vscode.Uri): boolean {
  if (uri.scheme !== "file" || !previewInput.test(uri.fsPath)) return false;
  return workspace.projectFor(uri.fsPath)?.folder.uri.toString() === folder.uri.toString();
}

/** Editor text of the folder's open sources, over disk, plus the previewed file's package. */
async function previewRequest(workspace: ElideWorkspace, folder: vscode.WorkspaceFolder, source: vscode.Uri): Promise<PreviewRequest> {
  const document = await vscode.workspace.openTextDocument(source);
  const documents = new Map(vscode.workspace.textDocuments.filter((item) => ownedBy(workspace, folder, item.uri))
    .map((item) => [item.uri.fsPath, item.getText()]));
  const packageName = /^\s*package\s+([\w.`]+)/m.exec(documents.get(source.fsPath) ?? document.getText())?.[1]?.replaceAll("`", "") ?? "";
  return { documents, sourceFile: source.fsPath, packageName };
}

export function previewBuild(workspace: ElideWorkspace, project: ElideProject, model: ProjectModel, artifact: AndroidTargetModel): PreviewBuild {
  return {
    model, artifact,
    models: workspace.projects.flatMap((item) => item.model ? [item.model] : []),
    bin: resolveElideDistribution({ explicitHome: readConfig(project.folder).home }).bin,
  };
}

export function javaFor(model: ProjectModel): string {
  return model.jdk ? path.join(model.jdk.home, "bin", process.platform === "win32" ? "java.exe" : "java") : "java";
}

export function backendKey(project: ElideProject, artifact: AndroidTargetModel): string {
  return `${project.root}\0${artifact.name}`;
}

/** The application supplying the resource context for previews of `file`: its nearest consumer in the same folder. */
export function previewApp(workspace: ElideWorkspace, project: ElideProject, file: string): { project: ElideProject; target: AndroidTargetModel } | undefined {
  const models = workspace.projects.filter((item) => item.folder.uri.toString() === project.folder.uri.toString()).flatMap((item) => item.model ? [item.model] : []);
  for (const { model, target } of composePreviewApplications(file, models)) {
    const app = workspace.projectAt(model.root);
    if (app) return { project: app, target };
  }
  return undefined;
}

/** A gallery the panel displayed, or verification confirming one it displayed. */
export interface ComposePreviewPaint {
  source: string;
  images: number;
  failed: number;
  /** Since the change (or panel opening) that requested it. */
  elapsedMs: number;
  /** These images are provisional until the build or annotation processing finishes. */
  verifying: boolean;
  /** Hash of the actual displayed image data, including retained pixels on failed cards. */
  contentHash: string;
  /** Each card's displayed image data hashed, by card id: which cards a live engine's push or input changed. */
  cards: Record<string, string>;
  /** These exact inputs came from a previously confirmed stored gallery. */
  reused: boolean;
  /** Cumulative processing passes in this compiler, for scoped integration measurements. */
  processing?: { stubs: number; apt: number };
  /** Selectable measured layouts and their resolved project source files in this publication. */
  inspection: { enabled: boolean; images: number; sources: string[];
    layouts: Record<string, { width: number; height: number; nodes: PreviewLayoutNode[] }> };
  /** Ids of the cards a live engine renders (pushed frames, pointer input); empty with the snapshot engine. */
  live: string[];
  /** Live cards whose native daemon advertises browser keyboard input. */
  keyboard: string[];
}

export interface ComposePreviewError {
  source: string;
  message: string;
}

/** A recovery the panel offers beside an error that the next ordinary build cannot fix. */
interface StatusAction {
  id: "rebuildNoCache";
  label: string;
  detail: string;
}

/** A stack frame in a card's Details text that resolves to a project source: line index and UTF-16 span. */
interface ErrorLink {
  line: number;
  start: number;
  end: number;
}

const STALE_RECORD_ACTION: StatusAction = {
  id: "rebuildNoCache",
  label: "Rebuild without cache",
  detail: "The build cache restored build records of another checkout or an older build, so an ordinary rebuild restores them again. Rebuild without the cache to rewrite them.",
};

/** Hash of the displayed image data, including retained pixels on failed cards (ComposePreviewPaint.contentHash), and per card. */
function imagesHash(images: readonly PreviewImage[]): { contentHash: string; cards: Record<string, string> } {
  const digest = createHash("sha256");
  const cards: Record<string, string> = {};
  for (const image of images) {
    const card = `${image.id}\0${image.data ?? ""}\0`;
    digest.update(card);
    cards[image.id] = createHash("sha256").update(card).digest("hex");
  }
  return { contentHash: digest.digest("hex"), cards };
}

/** Project frames in the cards' Details, resolved against the exact source text the preview compiled. */
async function errorFrames(images: readonly PreviewImage[], files: readonly ReadonlyMap<string, string>[]): Promise<{ links: Record<string, ErrorLink[]>; targets: Map<string, AndroidStackLocation> }> {
  const links: Record<string, ErrorLink[]> = {};
  const targets = new Map<string, AndroidStackLocation>();
  if (!images.some((image) => image.error)) return { links, targets };
  const contents = new Map(files.flatMap((unit) => [...unit]));
  const index = new AndroidStackSourceIndex(async () => [...contents.keys()], async (file) => contents.get(file)!);
  for (const image of images) {
    for (const [line, text] of (image.error ?? "").split("\n").entries()) {
      const frame = parseAndroidStackFrame(text);
      const location = frame && await index.resolve(frame);
      if (!frame || !location) continue;
      const found = links[image.id] ??= [];
      targets.set(`${image.id}\0${found.length}`, location);
      found.push({ line, start: frame.start, end: frame.end });
    }
  }
  return { links, targets };
}

/** Compose preview events; consumed by the extension-host integration test. */
export interface ElideComposePreviewApi {
  readonly onDidPaint: vscode.Event<ComposePreviewPaint>;
  readonly onDidError: vscode.Event<ComposePreviewError>;
  /** A background prewarm finished for the backend of this key. */
  readonly onDidPrewarm: vscode.Event<string>;
  /** Apply the same inspection request as the gallery's Inspect control. */
  setInspect(enabled: boolean): void;
  /** Send pointer input to a live card, in its image pixels, as the panel does; false when no live card has this id. */
  pointer(imageId: string, action: "down" | "up" | "move", x: number, y: number): boolean;
  /** Focus one keyboard-capable live card; undefined releases its held keys and native focus. */
  focusInput(imageId: string | undefined): boolean;
  /** Forward a browser key only to the currently focused card. */
  keyboard(imageId: string, event: PreviewKeyEvent): boolean;
  /** Open a layout node's call site as the inspector's Open source does; false when it has none. */
  openSource(imageId: string, nodeId: string): Promise<boolean>;
}

/** Host-side layoutlib rendering. A session never installs an APK or communicates with a device. */
class PreviewSession implements vscode.Disposable {
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];
  /** Stops the running preview build. */
  private stopBuild: AbortController | undefined;
  /** The next build bypasses the build cache, which restored stale records. */
  private noCache = false;
  private building = false;
  private pending = false;
  private closed = false;
  private lastStatus = "Starting preview…";
  private statusState: "working" | "ready" | "error" = "working";
  /** Epoch milliseconds the phase the status names began, for the panel's elapsed-time counter. */
  private statusSince: number | undefined;
  private statusAction: StatusAction | undefined;
  /** The status row's line when it is not the first line of the status text. */
  private statusHeadline: string | undefined;
  /** The current refresh: its steps time the summary shown once its images paint. */
  private trace: TimelineNode | undefined;
  /** The latest preview build, whose log the panel's "Open in editor" shows. */
  private buildStep: TimelineNode | undefined;
  /** Build output the panel's Build log holds, replayed when the webview reloads. */
  private readonly logLines: string[] = [];
  /** Lines not yet posted to the webview; batched, since a build can print thousands. */
  private logQueue: string[] = [];
  private logReset = false;
  private logTimer: NodeJS.Timeout | undefined;
  private images: PreviewImage[] = [];
  /** Inspectable call sites by `imageId\0nodeId`, resolved against `sourceFiles`: the compiler inputs of the shown revision. */
  private sourceTargets = new Map<string, PreviewSourceTarget>();
  private sourceFiles: readonly ReadonlyMap<string, string>[] = [];
  /** Linked frames of each card's Details, by image ID; `frameTargets` holds their sources by `imageId\0index`. */
  private errorLinks: Record<string, ErrorLink[]> = {};
  private frameTargets = new Map<string, AndroidStackLocation>();
  private failedRevision = -1;
  private model: ProjectModel | undefined;
  private rebuild = true;
  private revision = 0;
  private imageRevision = -1;
  private imagePublication = 0;
  /** The first publication of the shown gallery; later ones carry a live engine's pushed frames of it. */
  private galleryPublication = 0;
  /** The newest publication the webview acknowledged: replaying it (focus, view state, Inspect off) paints nothing new. */
  private paintedPublication = 0;
  /** Hashes of the shown gallery's unacknowledged publications: what each one's acknowledgement reports as painted. */
  private readonly publications = new Map<number, { contentHash: string; cards: Record<string, string> }>();
  /** A live engine's coalesced frames, published at `pushedAt` + {@link PUSH_INTERVAL_MS}. */
  private pushTimer: NodeJS.Timeout | undefined;
  private pushedAt = 0;
  /** Time to the shown gallery's first paint, which the summary reports while pushed frames repaint it. */
  private paintedIn = 0;
  /** A live engine's compile failure, shown over the rendered summary until the next change or a successful compile. */
  private compileFailure: string | undefined;
  private detectedAt = performance.now();
  /** Painted images await build or annotation-processing verification. */
  private verifying = false;
  /** Hashes of the latest publication. */
  private contentHash = "";
  private cards: Record<string, string> = {};
  private reused = false;
  private summary: string | undefined;
  private inspecting = false;
  private focusedInput: string | undefined;
  private readonly heldKeys = new Set<string>();
  /** Invalidates queued webview events when scenes or panel input availability change. */
  private inputEpoch = 0;
  private browserFocus: number | undefined;
  private readonly backend: ComposeBackend;
  private readonly panel: vscode.WebviewPanel;

  constructor(
    private readonly workspace: ElideWorkspace,
    private readonly ui: ElideUi,
    private readonly context: vscode.ExtensionContext,
    private readonly backends: ComposeBackends,
    private readonly project: ElideProject,
    private readonly artifact: AndroidTargetModel,
    private source: vscode.Uri,
    private readonly paints: vscode.EventEmitter<ComposePreviewPaint>,
    private readonly errors: vscode.EventEmitter<ComposePreviewError>,
    /** Compiler diagnostics of preview builds, shown in the Problems view. */
    private readonly diagnostics: vscode.DiagnosticCollection,
    /** The panel of a preview restored after a window reload. */
    restored?: vscode.WebviewPanel,
  ) {
    this.backend = backends.acquire(backendKey(project, artifact));
    this.subscriptions.push(
      new vscode.Disposable(this.backend.onImages((images) => this.pushImages(images))),
      new vscode.Disposable(this.backend.onCompile((outcome) => this.compiled(outcome.failed, outcome.messages))),
      new vscode.Disposable(this.backend.onInputReset((imageId) => {
        if (imageId === undefined || imageId === this.focusedInput) this.resetInput();
      })),
      // The cards are frozen until a refresh starts a new session.
      new vscode.Disposable(this.backend.onSessionLost(() => this.schedule(false))),
    );
    const title = `Compose: ${path.basename(source.fsPath)}`;
    const options = { enableScripts: true, localResourceRoots: [] };
    if (restored) {
      restored.title = title;
      restored.webview.options = options;
    }
    this.panel = restored ?? vscode.window.createWebviewPanel(VIEW_TYPE, title, vscode.ViewColumn.Beside, options);
    this.subscriptions.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.onDidChangeViewState(() => {
        if (!this.panel.visible) this.resetInput();
        else this.publishImages(true);
      }),
      vscode.window.onDidChangeWindowState(({ focused }) => {
        if (!focused) this.resetInput();
        else if (this.panel.visible) this.publishImages(true);
      }),
      this.panel.webview.onDidReceiveMessage((message: unknown) => {
        if (!message || typeof message !== "object" || !("type" in message)) return;
        if (message.type === "ready") {
          this.resetInput();
          this.status(this.lastStatus, this.statusState, this.statusSince, this.statusAction, this.statusHeadline);
          void this.panel.webview.postMessage({ type: "log", reset: true, lines: this.logLines });
          // The replay holds the lines still queued for the next flush.
          this.logQueue = [];
          this.logReset = false;
          // Restoring the panel after a window reload needs the previewed file. The webview now saves it.
          void this.panel.webview.postMessage({ type: "source", uri: this.source.toString() });
          if (this.context.workspaceState.get(RENAMES_KEY)) void this.context.workspaceState.update(RENAMES_KEY, undefined);
          this.publishImages(true);
          void this.panel.webview.postMessage({ type: "invalidate", revision: this.revision });
        }
        if (message.type === "refresh") this.schedule(true);
        if (message.type === "action" && "id" in message && message.id === "rebuildNoCache" && this.statusAction?.id === message.id) {
          this.noCache = true;
          this.schedule(true);
        }
        if (message.type === "inspect" && "enabled" in message && typeof message.enabled === "boolean") this.setInspect(message.enabled);
        if (message.type === "pointer" && "epoch" in message && message.epoch === this.inputEpoch
          && "imageId" in message && "action" in message && "x" in message && "y" in message
          && typeof message.imageId === "string" && (message.action === "down" || message.action === "up" || message.action === "move")
          && typeof message.x === "number" && typeof message.y === "number") {
          this.pointer(message.imageId, message.action, message.x, message.y);
        }
        if (message.type === "focusInput" && "epoch" in message && message.epoch === this.inputEpoch
          && "focus" in message && typeof message.focus === "number" && "imageId" in message) {
          if (typeof message.imageId === "string") {
            if (this.focusInput(message.imageId)) this.browserFocus = message.focus;
            else void this.panel.webview.postMessage({ type: "inputBlur", epoch: this.inputEpoch, focus: message.focus });
          } else if (message.imageId === null && message.focus === this.browserFocus) this.focusInput(undefined);
        }
        if (message.type === "keyboard" && "epoch" in message && message.epoch === this.inputEpoch
          && "focus" in message && message.focus === this.browserFocus
          && "imageId" in message && typeof message.imageId === "string" && "event" in message && isPreviewKeyEvent(message.event)) {
          this.keyboard(message.imageId, message.event);
        }
        if (message.type === "openLog") void this.ui.activity.openLog(this.buildStep ?? this.trace);
        if (message.type === "showActivity") void vscode.commands.executeCommand("elide.showActivity");
        // Not tied to a publication: a live engine's pushed frames can repaint the card many times a second.
        if (message.type === "navigate" && "revision" in message && message.revision === this.revision
          && this.imageRevision === this.revision && "imageId" in message && "nodeId" in message
          && typeof message.imageId === "string" && typeof message.nodeId === "string") {
          void this.navigate(message.imageId, message.nodeId, this.revision);
        }
        if (message.type === "openFrame" && "revision" in message && message.revision === this.revision
          && this.imageRevision === this.revision && "imageId" in message && "link" in message
          && typeof message.imageId === "string" && typeof message.link === "number") {
          void this.openFrame(message.imageId, message.link, this.revision);
        }
        if (message.type === "painted" && "revision" in message && message.revision === this.revision
          && "publication" in message && typeof message.publication === "number"
          && this.imageRevision === this.revision && this.failedRevision !== this.revision && this.images.length) {
          this.painted(message.publication);
        }
      }),
      vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
        const compiler = this.backend.compiler;
        if (contentChanges.length && this.owns(document.uri) && /\.(kt|java)$/.test(document.uri.fsPath)) {
          if (compiler && !this.backend.compiles(document.uri.fsPath)) this.suspend("Save to rebuild the preview's source inputs.");
          else {
            // A live engine starts compiling now; the refresh scheduled below then finds the edit already applied.
            this.backend.edit(document.uri.fsPath, document.getText());
            this.schedule(false);
          }
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (this.owns(document.uri) && (/\.(xml|pkl)$/.test(document.uri.fsPath)
          || this.backend.compiler && !this.backend.compiles(document.uri.fsPath))) this.schedule(true);
      }),
      vscode.workspace.onDidCreateFiles(({ files }) => {
        for (const uri of files) if (this.owns(uri)) this.schedule(!this.backend.compiles(uri.fsPath));
      }),
      vscode.workspace.onDidDeleteFiles(({ files }) => {
        if (files.some((uri) => this.contains(uri))) {
          this.suspend(`${path.basename(this.source.fsPath)} was deleted. Restore it to preview it again.`, "error");
          return;
        }
        for (const uri of files) if (this.owns(uri)) this.schedule(!this.backend.compiles(uri.fsPath));
      }),
      vscode.workspace.onDidRenameFiles(({ files }) => {
        let rebuild: boolean | undefined;
        for (const { oldUri, newUri } of files) {
          if (this.contains(oldUri)) {
            const previous = this.source.toString();
            this.source = vscode.Uri.file(path.join(newUri.fsPath, path.relative(oldUri.fsPath, this.source.fsPath)));
            this.panel.title = `Compose: ${path.basename(this.source.fsPath)}`;
            void this.panel.webview.postMessage({ type: "source", uri: this.source.toString() });
            this.recordRename(previous, this.source.toString());
            // A moved folder moves other sources too: the build has to see them in their new place.
            rebuild ||= !this.owns(oldUri);
          }
          if (this.owns(oldUri) || this.owns(newUri)) {
            rebuild ||= !this.backend.compiles(oldUri.fsPath) || !this.backend.compiles(newUri.fsPath);
          }
        }
        if (rebuild !== undefined) this.schedule(rebuild);
      }),
      workspace.onDidChangeKomodoAvailability(() => {
        if (this.backend.engine !== "komodo" || workspace.komodoPreviewAvailable) return;
        const file = this.source.fsPath;
        this.dispose();
        void workspace.requireKomodoPreview(file).catch((error: unknown) => {
          void vscode.window.showWarningMessage(`Elide: Compose preview stopped: ${error instanceof Error ? error.message : String(error)}`);
        });
      }),
      workspace.onDidChange(() => {
        if (!workspace.projectAt(project.root)) this.dispose();
        else if (this.model && workspace.projectAt(project.root)?.model !== this.model) this.schedule(true);
      }),
    );
    this.panel.webview.html = previewHtml();
    this.schedule(true);
  }

  get open(): boolean { return !this.closed; }

  /** Whether this session previews `source` with `artifact` of `project`. */
  previews(project: ElideProject, artifact: AndroidTargetModel, source: vscode.Uri): boolean {
    return this.project.root === project.root && this.artifact.name === artifact.name && this.source.toString() === source.toString();
  }

  /** Show the panel where the user left it. */
  reveal(): void {
    this.panel.reveal();
  }

  /**
   * Lets a window reload restore the renamed source. Each rename drops the new name's own entry (the file is there
   * again), so the entries never form a cycle.
   */
  private recordRename(from: string, to: string): void {
    const renames: Record<string, string> = { ...this.context.workspaceState.get<Record<string, string>>(RENAMES_KEY), [from]: to };
    delete renames[to];
    void this.context.workspaceState.update(RENAMES_KEY, renames);
  }

  setInspect(enabled: boolean): void {
    if (this.closed || this.inspecting === enabled) return;
    if (enabled) this.resetInput();
    this.inspecting = enabled;
    void this.panel.webview.postMessage({ type: "inspect", enabled });
    if (enabled) this.schedule(false);
    // The webview drops a gallery older than the failed revision it shows: refresh without the instrumentation instead.
    else if (this.failedRevision === this.revision) this.schedule(false);
    else this.publishImages();
  }

  /** Pointer input for a live card, as the panel forwards it while not inspecting. */
  pointer(imageId: string, action: "down" | "up" | "move", x: number, y: number): boolean {
    if (this.closed || this.inspecting || !this.panel.visible || this.imageRevision !== this.revision
      || !this.images.some((image) => image.id === imageId && image.live && image.data && !image.error)) return false;
    if (action === "down" && this.backend.keyboardSupported(imageId)) this.focusInput(imageId);
    return this.backend.pointer(imageId, action, x, y);
  }

  /** The inspector's Open source for a node of the shown publication. */
  openSource(imageId: string, nodeId: string): Promise<boolean> {
    return this.imageRevision === this.revision ? this.navigate(imageId, nodeId, this.revision) : Promise.resolve(false);
  }

  focusInput(imageId: string | undefined): boolean {
    if (this.closed) return false;
    if (imageId !== undefined && (!this.panel.visible || this.inspecting || this.imageRevision !== this.revision
      || !this.images.some((image) => image.id === imageId && image.live && image.data && !image.error)
      || !this.backend.keyboardSupported(imageId))) return false;
    if (imageId === this.focusedInput) return true;
    if (this.focusedInput !== undefined) this.backend.blur(this.focusedInput);
    if (this.browserFocus !== undefined) {
      void this.panel.webview.postMessage({ type: "inputBlur", epoch: this.inputEpoch, focus: this.browserFocus });
    }
    this.focusedInput = imageId;
    this.browserFocus = undefined;
    this.heldKeys.clear();
    return true;
  }

  keyboard(imageId: string, event: PreviewKeyEvent): boolean {
    if (this.closed || this.focusedInput !== imageId || !isPreviewKeyEvent(event)) return false;
    if (this.inspecting || !this.panel.visible || !this.backend.keyboardSupported(imageId)) {
      this.resetInput();
      return false;
    }
    const key = event.code || event.key;
    if ((event.action === "up" || event.repeat) && !this.heldKeys.has(key)) return false;
    if (!this.backend.keyboard(imageId, event)) return false;
    if (event.action === "down") this.heldKeys.add(key);
    else this.heldKeys.delete(key);
    return true;
  }

  private resetInput(): void {
    this.focusInput(undefined);
    this.inputEpoch++;
    if (!this.closed) void this.panel.webview.postMessage({ type: "inputReset", epoch: this.inputEpoch });
  }

  private owns(uri: vscode.Uri): boolean {
    return ownedBy(this.workspace, this.project.folder, uri);
  }

  /** `uri` is the previewed file or a folder containing it. */
  private contains(uri: vscode.Uri): boolean {
    const relative = path.relative(uri.fsPath, this.source.fsPath);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }

  private schedule(rebuild: boolean): void {
    if (this.closed) return;
    // A rebuild supersedes the running build: stop it rather than wait for output nothing uses.
    if (rebuild && this.building) this.stopBuild?.abort();
    this.resetInput();
    this.revision++;
    this.detectedAt = performance.now();
    this.rebuild ||= rebuild;
    this.pending = true;
    this.summary = undefined;
    this.compileFailure = undefined;
    // Invalidate work already in flight, including images still being decoded in the webview.
    void this.panel.webview.postMessage({ type: "invalidate", revision: this.revision });
    this.status(this.backend.compiler?.ready && !this.rebuild ? "Updating preview…" : "Preparing preview compiler and resources…");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), 0);
  }

  /** Show no gallery for the current revision and refresh nothing until the next change: `text` says what has to happen. */
  private suspend(text: string, state: "working" | "error" = "working"): void {
    if (this.closed) return;
    // Nothing uses the running build's output, and its progress would replace `text`.
    this.stopBuild?.abort();
    this.resetInput();
    this.revision++;
    this.pending = false;
    this.summary = undefined;
    clearTimeout(this.timer);
    void this.panel.webview.postMessage({ type: "invalidate", revision: this.revision });
    this.status(text, state);
  }

  private status(text: string, state: "working" | "ready" | "error" = "working", since?: number, action?: StatusAction, headline?: string): void {
    this.lastStatus = text;
    this.statusState = state;
    this.statusSince = since;
    this.statusAction = action;
    this.statusHeadline = headline;
    if (!this.closed) void this.panel.webview.postMessage({ type: "status", text, state, since,
      retained: state !== "ready" && this.images.some((image) => image.data), ...(action ? { action } : {}), ...(headline ? { headline } : {}) });
  }

  /** The painted summary, the phases of the refresh that took long enough to matter, and what happens next. */
  private renderedStatus(): void {
    if (!this.summary) return;
    if (this.compileFailure) {
      this.status(this.compileFailure, "error");
      return;
    }
    const phases = (this.trace?.children ?? []).filter((step) => step.durationMs >= 50 && (step.state === "succeeded" || step.state === "failed"))
      .map((step) => `${step.label.toLowerCase()} ${formatDuration(step.durationMs)}`);
    this.status(`${this.summary}${phases.length ? ` · ${phases.join(", ")}` : ""} · host layoutlib · ${this.verifying
      ? this.buildStep?.running ? "verifying build…" : "verifying annotation processing…" : "live edits"}`,
      this.verifying ? "working" : this.images.some((image) => image.error) ? "error" : "ready",
      this.verifying ? this.buildStep?.running ? this.buildStep.startedAt : this.trace?.children.findLast((step) => step.running)?.startedAt : undefined);
  }

  /** The webview painted `publication`: the first acknowledgement of a publication of the shown gallery reports its paint. */
  private painted(publication: number): void {
    const shown = this.publications.get(publication);
    if (!shown || publication < this.galleryPublication || publication <= this.paintedPublication) return;
    for (const key of this.publications.keys()) if (key <= publication) this.publications.delete(key);
    const elapsed = Math.round(performance.now() - this.detectedAt);
    // Pushed frames repaint the gallery; its summary keeps the time to its first paint.
    if (this.paintedPublication < this.galleryPublication) this.paintedIn = elapsed;
    this.paintedPublication = publication;
    const errors = this.images.filter((image) => image.error).length;
    this.summary = `${this.images.length - errors} rendered in ${formatDuration(this.paintedIn)}${errors ? ` · ${errors} failed (open Details)` : ""}`;
    this.renderedStatus();
    this.emitPaint(elapsed, shown);
  }

  private emitPaint(elapsedMs = Math.round(performance.now() - this.detectedAt), { contentHash, cards } = { contentHash: this.contentHash, cards: this.cards }): void {
    const processing = this.backend.compiler?.processingStats;
    this.paints.fire({
      source: this.source.fsPath, images: this.images.length, failed: this.images.filter((image) => image.error).length,
      elapsedMs, verifying: this.verifying, contentHash, cards: { ...cards }, reused: this.reused,
      inspection: { enabled: this.inspecting, images: this.images.filter((image) => image.nodes?.length).length,
        sources: [...new Set([...this.sourceTargets.values()].map((target) => target.file))].sort(),
        layouts: Object.fromEntries(this.images.filter((image) => image.width && image.height)
          .map((image) => [image.id, { width: image.width!, height: image.height!, nodes: image.nodes ?? [] }])) },
      live: this.images.filter((image) => image.live).map((image) => image.id),
      keyboard: this.images.filter((image) => image.live && !image.error && this.backend.keyboardSupported(image.id)).map((image) => image.id),
      ...(processing ? { processing: { ...processing } } : {}),
    });
  }

  private confirm(revision: number): void {
    if (this.closed || revision !== this.revision || revision === this.failedRevision) return;
    this.verifying = false;
    this.renderedStatus();
    if (this.summary) this.emitPaint();
  }

  private fail(error: unknown, revision: number): void {
    if (this.closed || revision !== this.revision) return;
    const message = error instanceof Error ? error.message : String(error);
    this.failedRevision = revision;
    this.verifying = false;
    this.summary = undefined;
    this.appendLog(message);
    // The first line of a compiler failure only names the unit; the row shows the first error and Details the rest.
    const compilerError = firstCompilerError(message);
    this.status(`Preview failed: ${message}`, "error", undefined, error instanceof StaleBuildRecordError ? STALE_RECORD_ACTION : undefined,
      compilerError && `Preview failed: ${compilerError}`);
    this.errors.fire({ source: this.source.fsPath, message });
  }

  /** Queue a build output line for the panel's Build log; posted in batches. */
  private appendLog(line: string): void {
    this.logLines.push(line);
    if (this.logLines.length > LOG_LINES) this.logLines.splice(0, this.logLines.length - LOG_LINES);
    this.logQueue.push(line);
    this.logTimer ??= setTimeout(() => this.flushLog(), 100);
  }

  private resetLog(): void {
    this.logLines.length = 0;
    this.logQueue = [];
    this.logReset = true;
    this.logTimer ??= setTimeout(() => this.flushLog(), 0);
  }

  /** Post queued log lines and, while a build runs with nothing painted yet, what it has done so far. */
  private flushLog(): void {
    this.logTimer = undefined;
    if (this.closed) return;
    void this.panel.webview.postMessage({ type: "log", reset: this.logReset, lines: this.logQueue });
    this.logQueue = [];
    this.logReset = false;
    const build = this.buildStep;
    if (!build?.running || this.summary || this.stopBuild?.signal.aborted) return;
    const command = build.children.at(-1);
    const task = command?.children.findLast((child) => !child.running);
    const progress = [liveStatus(build), command?.detail, task && `last: ${task.label} (${formatDuration(task.durationMs)})`].filter(Boolean).join(" · ");
    this.status(`Building ${this.artifact.name} preview inputs${progress ? ` · ${progress}` : "…"}`, "working", build.startedAt);
  }

  /**
   * Cards a live engine updated after their gallery was shown: replaced in place within the same revision, as a new publication
   * whose paint reports the pushed pixels.
   */
  private pushImages(images: PreviewImage[]): void {
    if (this.closed || this.imageRevision !== this.revision) return;
    const updated = new Map(images.map((image) => [image.id, image]));
    let changed = false;
    this.images = this.images.map((image) => {
      const next = updated.get(image.id);
      if (!next) return image;
      changed = true;
      for (const key of this.sourceTargets.keys()) if (key.startsWith(`${image.id}\0`)) this.sourceTargets.delete(key);
      // The shown revision's sources: a pushed frame (input, animation) runs the program its gallery compiled.
      return { ...next, nodes: next.error ? [] : inspectableNodes(next, this.sourceFiles, this.sourceTargets) };
    });
    if (!changed || this.pushTimer) return;
    const wait = this.pushedAt + PUSH_INTERVAL_MS - performance.now();
    if (wait <= 0) {
      this.publish();
      return;
    }
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      if (!this.closed && this.imageRevision === this.revision) this.publish();
    }, wait);
  }

  /** Post the images as a new publication, recording what its acknowledgement reports as painted. */
  private publish(): void {
    ({ contentHash: this.contentHash, cards: this.cards } = imagesHash(this.images));
    this.imagePublication++;
    this.publications.set(this.imagePublication, { contentHash: this.contentHash, cards: this.cards });
    // A hidden webview acknowledges nothing; keep the newest.
    for (const key of this.publications.keys()) if (this.publications.size > UNACKNOWLEDGED) this.publications.delete(key);
    this.pushedAt = performance.now();
    this.publishImages();
  }

  /** A live engine's compile outcome replaces the preview's Problems (the newest compile owns them); a success clears them. */
  private compiled(failed: boolean, messages: CompileMessage[]): void {
    if (this.closed) return;
    const collection = this.diagnostics;
    collection.clear();
    if (!failed) {
      this.compileFailure = undefined;
      this.renderedStatus();
      return;
    }
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const message of messages) {
      if (!message.file) continue;
      const line = Math.max(0, (message.line ?? 1) - 1);
      const column = Math.max(0, (message.column ?? 1) - 1);
      const diagnostic = new vscode.Diagnostic(new vscode.Range(line, column, line, column + 1), message.text,
        message.level === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
      diagnostic.source = "Komodo";
      byFile.set(message.file, [...byFile.get(message.file) ?? [], diagnostic]);
    }
    for (const [file, diagnostics] of byFile) collection.set(vscode.Uri.file(file), diagnostics);
    const first = messages.find((message) => message.level === "error") ?? messages[0];
    this.compileFailure = `Live preview does not compile: ${first?.text ?? "see Problems"}`;
    this.status(this.compileFailure, "error");
  }

  private publishImages(replay = false): void {
    if (this.focusedInput !== undefined && !this.images.some((image) => image.id === this.focusedInput && image.live && !image.error)) this.resetInput();
    if (!this.closed) void this.panel.webview.postMessage({ type: "images", images: this.images, errorLinks: this.errorLinks,
      revision: this.imageRevision, publication: this.imagePublication, inputEpoch: this.inputEpoch,
      keyboard: this.images.filter((image) => image.live && !image.error && this.backend.keyboardSupported(image.id)).map((image) => image.id),
      ...(replay ? { currentRevision: this.revision } : {}) });
  }

  /** Publish images for `revision` unless a newer change superseded them. */
  private async show(gallery: PreviewGallery, revision: number, verifying: boolean, request: PreviewRequest): Promise<boolean> {
    if (this.closed || revision !== this.revision || revision === this.failedRevision) return false;
    const { images } = gallery;
    if (!images.length) throw new Error("No compiled @Preview functions found in this file.");
    const sources = await this.backend.compiler?.sources(request.documents);
    const files = sources?.files ?? [];
    const frames = await errorFrames(images, files);
    if (this.closed || revision !== this.revision || revision === this.failedRevision) return false;
    const targets = new Map<string, PreviewSourceTarget>();
    this.verifying = verifying;
    this.reused = gallery.reused;
    this.summary = undefined;
    // A failing component keeps its own last good pixels; other successful cards can still update.
    const previous = new Map(this.images.map((image) => [image.id, image]));
    // A live engine's frames since it built this gallery (pushed while the gallery was on its way, so not applied above).
    this.images = this.backend.latestImages(images).map((image) => {
      const retained = image.error ? previous.get(image.id) : undefined;
      if (retained?.data) return { ...image, data: retained.data, width: retained.width, height: retained.height, nodes: [] };
      return { ...image, nodes: inspectableNodes(image, files, targets) };
    });
    this.sourceTargets = targets;
    this.sourceFiles = files;
    this.errorLinks = frames.links;
    this.frameTargets = frames.targets;
    this.imageRevision = revision;
    // Frames pushed for the replaced gallery are in these images already.
    clearTimeout(this.pushTimer);
    this.pushTimer = undefined;
    this.publications.clear();
    this.galleryPublication = this.imagePublication + 1;
    this.publish();
    return true;
  }

  /**
   * Build what the preview renders as a step of `trace`. The build runs as a process of its own, not a task: VS Code
   * saves dirty editors before every task, and a preview works from unsaved editor text. The panel's Build log, its
   * status line, the Elide output channel and the Activity view follow the build, its compiler diagnostics go to
   * the Problems view, and a failure quotes the compiler's errors.
   */
  private async build(model: ProjectModel, artifact: AndroidTargetModel, models: readonly ProjectModel[], trace: TimelineNode, signal: AbortSignal): Promise<void> {
    const step = trace.start("Build");
    this.buildStep = step;
    this.resetLog();
    this.status(`Building ${artifact.name} preview inputs…`, "working", step.startedAt);
    const stop = new AbortController();
    this.stopBuild = stop;
    const noCache = this.noCache;
    this.noCache = false;
    let code: number | undefined;
    try {
      code = await runObservedElide(this.project, "build", { args: composePreviewBuildTargets(model, artifact, models), ...(noCache ? { options: { "no-cache": true } } : {}) }, {
        signal: AbortSignal.any([signal, stop.signal]),
        diagnostics: this.diagnostics,
        onCommand: observeCommands(() => step, (line) => {
          this.appendLog(line);
          this.ui.log(line);
        }),
      });
    } catch (error) {
      step.end("failed", error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      if (this.stopBuild === stop) this.stopBuild = undefined;
    }
    if (this.closed) {
      step.end("cancelled", "preview closed");
      throw new Error("Compose preview closed.");
    }
    if (code === 0) {
      step.end("succeeded");
      if (!this.summary && !stop.signal.aborted) this.status(`Built ${artifact.name} preview inputs in ${formatDuration(step.durationMs)}; rendering…`);
      return;
    }
    if (code === undefined) {
      step.end("cancelled", "stopped");
      throw new Error("The preview build was stopped. Rebuild to try again.");
    }
    const errors = buildErrors(step.lines());
    const count = `${errors.length}${errors.length === QUOTED_ERRORS ? "+" : ""} error${errors.length === 1 ? "" : "s"}`;
    step.end("failed", `exit ${code}${errors.length ? ` · ${count}` : ""}`);
    throw new Error([
      `Build failed after ${formatDuration(step.durationMs)}: elide build exited with ${code}.`,
      ...errors,
      "Open the Build log for the complete output; compiler errors are listed in the Problems view.",
    ].join("\n"));
  }

  /**
   * Bring the gallery up to date with the editor. A refresh that builds is an operation of the Activity view, since
   * it can take a while and fail in the build; a live edit's compile-and-render is timed for the status line only.
   */
  private async refresh(): Promise<void> {
    if (this.closed || this.building) return;
    this.building = true;
    this.pending = false;
    const revision = this.revision;
    const backend = this.backend;
    // The Activity view's Cancel stops whichever step runs; the backend finishes a step it started under its own locks.
    const cancel = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, cancel.signal]);
    const trace = this.rebuild || !backend.compiler
      ? this.ui.activity.start(`Compose preview: ${path.basename(this.source.fsPath)}`, { detail: this.artifact.name, cancel: () => cancel.abort() })
      : TimelineNode.root("Compose preview update");
    this.trace = trace;
    let outcome: "succeeded" | "failed" | "cancelled" = "cancelled";
    let failure: string | undefined;
    let preparing = false;
    try {
      if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before executing Compose previews.");
      if (backend instanceof KomodoBackend) {
        await this.workspace.requireKomodoPreview(this.source.fsPath);
        signal.throwIfAborted();
        await backend.prepareSession(this.source.fsPath, false, signal);
        signal.throwIfAborted();
      }
      const model = this.workspace.projectAt(this.project.root)?.model;
      if (!model) throw new Error("Sync the Android project before previewing.");
      const artifact = model.android?.targets.find((target) => target.name === this.artifact.name);
      if (!artifact) throw new Error(`Android artifact ${this.artifact.name} no longer exists. Reopen the preview.`);
      const request = { ...await previewRequest(this.workspace, this.project.folder, this.source), inspect: this.inspecting };
      if (this.closed) return;
      signal.throwIfAborted();
      let gallery: PreviewGallery | undefined;
      if (this.rebuild || !backend.compiler) {
        preparing = true;
        this.rebuild = false;
        const build = previewBuild(this.workspace, this.project, model, artifact);
        const runtime = await trace.run("Compose runtime", () =>
          // A suspended revision's status stays until the next change.
          ensureComposeRuntime(this.context.globalStorageUri.fsPath, signal, (text) => { if (revision === this.revision || this.pending) this.status(text); }));
        if (this.closed) return;
        signal.throwIfAborted();
        const starting = trace.start("Start renderer");
        const renderer = backend.startRenderer(runtime, javaFor(model), composePreviewAnnotations(request.documents.get(request.sourceFile) ?? ""));
        renderer.then(() => starting.end(), (error: unknown) => starting.end("failed", error instanceof Error ? error.message : String(error)));
        let buildFailed = false;
        const built = this.build(model, artifact, build.models, trace, signal).catch((error: unknown) => {
          buildFailed = true;
          throw error;
        });
        built.catch(() => {});
        // While Elide confirms the build, paint a stored gallery of these exact inputs, or render
        // from a warm compiler or the last build's classes.
        const early = trace.start("Preview from the last build");
        const provisional = (async () => {
          if (!backend.compiler) await backend.configure(build, request.documents, false);
          const provisionalGallery = await backend.preview(request, false, early);
          return provisionalGallery && !buildFailed && await this.show(provisionalGallery, revision, true, request)
            ? provisionalGallery : undefined;
        })().then(
          (shown) => {
            early.end(shown ? "succeeded" : "skipped", shown ? undefined : "nothing to show before the build");
            return shown;
          },
          (error: unknown) => {
            // Never built, or the build is rewriting its outputs: the gallery waits for the build instead.
            early.end("skipped", error instanceof Error ? error.message : String(error));
            return undefined;
          },
        );
        await built;
        const provisionalGallery = await provisional;
        if (this.closed) return;
        const changed = await trace.run("Prepare compiler", () => cancellable(backend.configure(build, request.documents, true), signal));
        preparing = false;
        this.model = model;
        if (this.closed || revision !== this.revision) return;
        if (provisionalGallery && !changed) gallery = provisionalGallery;
        await trace.run("Wait for renderer", () => cancellable(renderer, signal));
      }
      if (this.closed || revision !== this.revision) return;
      if (backend.needsWarmup) {
        this.status("Initializing preview compiler…");
        await trace.run("Initialize compiler", () => cancellable(backend.warm(request), signal));
        if (this.closed || revision !== this.revision) return;
        // The provisional build classes and their metadata are not the instrumented baseline.
        gallery = undefined;
      }
      if (!gallery) {
        try {
          gallery = await backend.preview(request, true, trace);
        } catch (error) {
          if (this.closed || revision !== this.revision) return;
          // A declaration edit can make the last generated sources uncompilable. Processing must
          // still run, then compile the edited declarations with their new generated counterparts.
          if (!backend.processingRequired) throw error;
          this.status("Verifying annotation processing…");
          await cancellable(backend.verify(request, trace), signal);
          if (this.closed || revision !== this.revision) return;
          gallery = await backend.preview(request, true, trace);
        }
        if (!await this.show(gallery, revision, !gallery.verified, request)) return;
      }
      while (!gallery.verified) {
        if (!this.summary) this.status("Verifying annotation processing…");
        else this.renderedStatus();
        const changed = await cancellable(backend.verify(request, trace), signal);
        if (this.closed || revision !== this.revision) return;
        if (changed) {
          gallery = await backend.preview(request, true, trace);
          if (!await this.show(gallery, revision, !gallery.verified, request)) return;
        } else break;
      }
      this.confirm(revision);
      outcome = "succeeded";
    } catch (error) {
      if (backend instanceof KomodoBackend && !backend.disposed) backend.preempt("The preview did not complete; refresh to try again.");
      // A failed resource/build setup cannot be repaired by compiling only the next Kotlin edit.
      if (preparing) this.rebuild = true;
      if (!this.closed && revision === this.revision && cancel.signal.aborted) {
        // Not a failure: the next refresh rebuilds whatever the cancel interrupted.
        failure = "cancelled";
        this.rebuild = true;
        this.failedRevision = revision;
        this.verifying = false;
        this.summary = undefined;
        this.status("Preview cancelled. Rebuild to try again.", "error");
      } else if (!this.closed && revision === this.revision) {
        outcome = "failed";
        failure = error instanceof Error ? error.message.split("\n")[0] : String(error);
        this.fail(error, revision);
      }
    } finally {
      trace.end(outcome, failure ?? (outcome === "cancelled" ? this.closed ? "preview closed" : "superseded by a newer change" : undefined));
      this.building = false;
      if (!this.closed && this.pending) { clearTimeout(this.timer); void this.refresh(); }
    }
  }

  /** Opens a node's call site, selecting its range; false when it has none or its file's text is no longer what was compiled. */
  private async navigate(imageId: string, nodeId: string, revision: number): Promise<boolean> {
    const target = this.sourceTargets.get(`${imageId}\0${nodeId}`);
    if (!target || this.closed || revision !== this.revision || revision === this.failedRevision) return false;
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target.file));
      if (this.closed || revision !== this.revision || document.getText() !== target.content) return false;
      const selection = new vscode.Range(document.positionAt(target.offset), document.positionAt(target.offset + target.length));
      const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, selection, preview: true });
      editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      return true;
    } catch (error) {
      if (!this.closed) void vscode.window.showWarningMessage(`Cannot open Compose source: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async openFrame(imageId: string, link: number, revision: number): Promise<void> {
    const target = this.frameTargets.get(`${imageId}\0${link}`);
    if (!target || this.closed || revision !== this.revision) return;
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target.file));
      if (this.closed || revision !== this.revision) return;
      const position = new vscode.Position(Math.min(target.line, document.lineCount - 1), 0);
      const selection = new vscode.Range(position, position);
      const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, selection, preview: true });
      editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch (error) {
      if (!this.closed) void vscode.window.showWarningMessage(`Cannot open Compose source: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  dispose(): void {
    if (this.closed) return;
    // VS Code disposes the panel before onDidDispose: release native focus/held keys without touching its webview.
    if (this.focusedInput !== undefined) this.backend.blur(this.focusedInput);
    this.focusedInput = undefined;
    this.browserFocus = undefined;
    this.heldKeys.clear();
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.logTimer);
    clearTimeout(this.pushTimer);
    this.controller.abort();
    for (const subscription of this.subscriptions) subscription.dispose();
    // The panel's build and live compile errors; nothing refreshes them once it is closed.
    this.diagnostics.clear();
    this.panel.dispose();
    this.backends.release(this.backend);
  }
}

export function registerComposePreview(workspace: ElideWorkspace, ui: ElideUi, context: vscode.ExtensionContext): {
  disposable: vscode.Disposable; api: ElideComposePreviewApi;
  agentHost: { backends: ComposeBackends; arbiter: KomodoSessionArbiter; cacheRoot: string };
} {
  const cacheRoot = context.globalStorageUri.fsPath;
  const arbiter = new KomodoSessionArbiter();
  const backends = new ComposeBackends(cacheRoot, context.asAbsolutePath("media/compose"), () => readConfig().composePreviewKeepAlive * 60_000,
    (key, root, helpers, store, role) => readConfig().composePreviewEngine === "komodo"
      ? new KomodoBackend(key, root, helpers, store, {
        previews: (file) => workspace.komodoPreviews(file),
        session: (file) => workspace.komodoPreviewSession(file),
        sync: (files) => workspace.komodoPreviewSync(files),
        log: (line) => ui.log(line),
        unavailable: (reason) => workspace.rejectKomodoPreview(reason),
        arbiter,
        role,
      })
      : new ComposeBackend(key, root, helpers, store),
    () => readConfig().composePreviewEngine);
  const paints = new vscode.EventEmitter<ComposePreviewPaint>();
  const prewarmed = new vscode.EventEmitter<string>();
  const errors = new vscode.EventEmitter<ComposePreviewError>();
  const diagnostics = vscode.languages.createDiagnosticCollection("elide-compose-preview");
  let session: PreviewSession | undefined;
  let prewarmTimer: NodeJS.Timeout | undefined;
  let prewarming: Promise<void> = Promise.resolve();
  /** The last prewarm failure logged; focus changes retry prewarming, and each distinct failure is logged once. */
  let prewarmFailure: string | undefined;
  let disposed = false;
  /** Last value of `elide.composePreviewAvailable`, which shows Open Compose Preview in the editor title. */
  let available: boolean | undefined;
  let availabilityTimer: NodeJS.Timeout | undefined;

  /** The application rendering `editor`'s file: a Kotlin source declaring previews, in a synced app's preview closure. */
  const previewable = (editor: vscode.TextEditor | undefined): { project: ElideProject; target: AndroidTargetModel } | undefined => {
    const document = editor?.document;
    if (!document || document.languageId !== "kotlin" || document.uri.scheme !== "file" || !composePreviewAnnotations(document.getText())) return undefined;
    const project = workspace.projectFor(document.uri.fsPath);
    return project?.model ? previewApp(workspace, project, document.uri.fsPath) : undefined;
  };
  const updateAvailability = (): void => {
    clearTimeout(availabilityTimer);
    const value = !disposed && (readConfig().composePreviewEngine !== "komodo" || workspace.komodoPreviewAvailable)
      && previewable(vscode.window.activeTextEditor) !== undefined;
    if (value === available) return;
    available = value;
    void vscode.commands.executeCommand("setContext", "elide.composePreviewAvailable", value);
  };

  /** Warm the backend the next Open Compose Preview of the focused file would use. */
  const prewarm = async (): Promise<void> => {
    const config = readConfig();
    if (disposed || !config.composePreviewPrewarm || config.composePreviewKeepAlive <= 0 || !vscode.workspace.isTrusted || session?.open) return;
    const editor = vscode.window.activeTextEditor;
    const app = previewable(editor);
    const model = app?.project.model;
    if (!editor || !app || !model) return;
    const runtime = await installedComposeRuntime(cacheRoot);
    if (!runtime || disposed || session?.open) return;
    // previewApp keeps the application in the file's workspace folder.
    const request = await previewRequest(workspace, app.project.folder, editor.document.uri);
    if (readConfig().composePreviewEngine === "komodo") await workspace.requireKomodoPreview(editor.document.uri.fsPath);
    if (disposed || session?.open) return;
    const key = backendKey(app.project, app.target);
    const backend = backends.obtain(key);
    const file = path.basename(editor.document.uri.fsPath);
    try {
      if (backend instanceof KomodoBackend) await backend.prepareSession(editor.document.uri.fsPath);
      if (backend.disposed || disposed || session?.open) return;
      // The first warm-up of a large project can take a minute: say so where background work shows.
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Warming Compose preview for ${file}` }, (progress) =>
        backend.prewarm(previewBuild(workspace, app.project, model, app.target), runtime, javaFor(model), request, (step) => progress.report({ message: step })));
    } catch (error) {
      if (backend instanceof KomodoBackend && !backend.disposed) backend.preempt("Preview prewarm did not complete.");
      // Expiry, a model change or shutdown stopped this backend: nothing failed.
      if (backend.disposed || disposed) return;
      throw new Error(`Compose preview prewarm for ${file} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      // The keep-alive period counts from the end of the warm-up, which could otherwise outlast it.
      backends.idle(backend);
    }
    prewarmFailure = undefined;
    if (!disposed) prewarmed.fire(key);
  };
  const schedulePrewarm = (): void => {
    clearTimeout(prewarmTimer);
    if (disposed) return;
    prewarmTimer = setTimeout(() => {
      prewarming = prewarming.then(prewarm).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!disposed && message !== prewarmFailure) ui.log(message);
        prewarmFailure = message;
      });
    }, 300);
  };

  /** Resolves once no sync of `folder` runs, or when `token` is cancelled. */
  const syncEnded = (folder: vscode.WorkspaceFolder, token: vscode.CancellationToken): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const listeners = [token.onCancellationRequested(() => resolve()), workspace.onDidChange(() => {
      // A superseded sync reports its end, then starts again in the same task.
      setTimeout(() => { if (!workspace.isSyncing(folder)) resolve(); }, 0);
    })];
    return promise.finally(() => { for (const listener of listeners) listener.dispose(); });
  };
  /**
   * The application previewing `source`. A folder's first sync can still be running (the window just opened): wait for it
   * rather than fail. Undefined when the user cancels that wait.
   */
  const previewTarget = async (source: vscode.Uri): Promise<{ project: ElideProject; target: AndroidTargetModel } | undefined> => {
    let project = workspace.projectFor(source.fsPath);
    if (project && !project.model && workspace.isSyncing(project.folder)) {
      const folder = project.folder;
      const waited = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true,
        title: `Elide: waiting for the sync of ${folder.name} to preview ${path.basename(source.fsPath)}…` }, async (_progress, token) => {
        await syncEnded(folder, token);
        return !token.isCancellationRequested;
      });
      if (!waited) return undefined;
      project = workspace.projectFor(source.fsPath);
      const failure = workspace.lastError(folder);
      if (!project?.model && failure) throw new Error(`The sync of ${folder.name} failed: ${failure}`);
    }
    if (!project?.model) throw new Error("Sync the project before opening a Compose preview.");
    const app = previewApp(workspace, project, source.fsPath);
    if (!app) throw new Error("No Android application in this workspace folder packages this file. Declare an AndroidApk that includes its source set or depends on its library, then sync.");
    return app;
  };

  const command = vscode.commands.registerCommand("elide.androidComposePreview", async () => {
    try {
      if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before building a preview.");
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== "kotlin" || editor.document.uri.scheme !== "file") throw new Error("Open a Kotlin source file containing @Preview functions.");
      // Building cannot find previews the source does not declare; say so before spending a build on it.
      if (readConfig().composePreviewEngine === "komodo") await workspace.requireKomodoPreview(editor.document.uri.fsPath);
      if (!composePreviewAnnotations(editor.document.getText())) {
        throw new Error(`${path.basename(editor.document.uri.fsPath)} declares no @Preview functions. Annotate a composable with @Preview, or with a multipreview annotation whose name contains "Preview", to preview it.`);
      }
      const source = editor.document.uri;
      const app = await previewTarget(source);
      if (!app || disposed) return;
      if (readConfig().composePreviewEngine === "komodo") await workspace.requireKomodoPreview(source.fsPath);
      if (disposed) return;
      // The open panel keeps its place, gallery and state; its Rebuild button builds again.
      if (session?.open && session.previews(app.project, app.target, source)) {
        session.reveal();
        return;
      }
      session?.dispose();
      session = new PreviewSession(workspace, ui, context, backends, app.project, app.target, source, paints, errors, diagnostics);
    } catch (error) {
      void vscode.window.showErrorMessage(`Elide: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  // Reopen the preview a window reload closed: its webview state names the previewed file.
  const serializer = vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
    deserializeWebviewPanel: async (panel: vscode.WebviewPanel, state: unknown) => {
      let source = state && typeof state === "object" && "source" in state && typeof state.source === "string" ? state.source : undefined;
      // A panel renamed while hidden saved its old source. The bound only guards against a corrupted record.
      const renames = context.workspaceState.get<Record<string, string>>(RENAMES_KEY) ?? {};
      for (let hops = Object.keys(renames).length; hops > 0 && source !== undefined && renames[source] !== undefined; hops--) source = renames[source];
      const saved = source === undefined ? undefined : vscode.Uri.parse(source);
      if (saved?.scheme !== "file") {
        panel.dispose();
        return;
      }
      const file = path.basename(saved.fsPath);
      try {
        if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before building a preview.");
        await vscode.workspace.fs.stat(saved).then(undefined, () => { throw new Error(`${file} no longer exists.`); });
        if (readConfig().composePreviewEngine === "komodo") await workspace.requireKomodoPreview(saved.fsPath);
        const app = await previewTarget(saved);
        if (readConfig().composePreviewEngine === "komodo") await workspace.requireKomodoPreview(saved.fsPath);
        // The user opened another preview meanwhile; there is one at a time.
        if (!app || disposed || session?.open) {
          panel.dispose();
          return;
        }
        session = new PreviewSession(workspace, ui, context, backends, app.project, app.target, saved, paints, errors, diagnostics, panel);
      } catch (error) {
        panel.dispose();
        void vscode.window.showWarningMessage(`Elide: the Compose preview of ${file} was not restored: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
  const subscriptions = [
    command,
    serializer,
    paints,
    errors,
    diagnostics,
    prewarmed,
    workspace.onDidChangeKomodoAvailability(() => {
      if (!workspace.komodoPreviewAvailable) {
        clearTimeout(prewarmTimer);
        backends.retireEngine("komodo");
      } else schedulePrewarm();
      updateAvailability();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      updateAvailability();
      schedulePrewarm();
    }),
    vscode.workspace.onDidChangeTextDocument(({ document }) => {
      if (document !== vscode.window.activeTextEditor?.document) return;
      clearTimeout(availabilityTimer);
      availabilityTimer = setTimeout(updateAvailability, 300);
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(schedulePrewarm),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("elide.android.composePreview")) return;
      session?.focusInput(undefined);
      backends.rearm();
      schedulePrewarm();
      updateAvailability();
    }),
    workspace.onDidChange(() => {
      backends.retain((key) => workspace.projects.some((project) => project.model?.android?.targets.some((target) => backendKey(project, target) === key)));
      updateAvailability();
      schedulePrewarm();
    }),
  ];
  updateAvailability();
  schedulePrewarm();
  const disposable = new vscode.Disposable(() => {
    disposed = true;
    clearTimeout(prewarmTimer);
    clearTimeout(availabilityTimer);
    session?.dispose();
    backends.dispose();
    for (const subscription of subscriptions) subscription.dispose();
  });
  return { disposable, agentHost: { backends, arbiter, cacheRoot }, api: { onDidPaint: paints.event, onDidError: errors.event, onDidPrewarm: prewarmed.event,
    setInspect: (enabled) => session?.setInspect(enabled),
    pointer: (imageId, action, x, y) => session?.pointer(imageId, action, x, y) ?? false,
    focusInput: (imageId) => session?.focusInput(imageId) ?? false,
    keyboard: (imageId, event) => session?.keyboard(imageId, event) ?? false,
    openSource: (imageId, nodeId) => session?.openSource(imageId, nodeId) ?? Promise.resolve(false) } };
}

