import path from "node:path";
import {
  TimelineNode,
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
import { ComposeBackend, ComposeBackends, type CompileMessage, type PreviewBuild, type PreviewRequest } from "./composeBackend.js";
import { KomodoBackend } from "./composeKomodo.js";
import type { PreviewImage } from "./composeRender.js";
import { previewHtml } from "./composePreviewHtml.js";
import { resolvePreviewSource, type PreviewSourceTarget } from "./composeSource.js";
import { readConfig } from "./config.js";
import { ensureComposeRuntime, installedComposeRuntime } from "./composeRuntime.js";
import type { ElideUi } from "./output.js";
import type { ElideProject, ElideWorkspace } from "./projects.js";
import { executeObservedElideTask } from "./tasks.js";

const previewInput = /\.(?:kt|java|xml|pkl)$/;
/** Build output lines the panel keeps for its Build log; the activity log has every line. */
const LOG_LINES = 2_000;
/** Compiler errors quoted in a failed build's diagnostics. */
const QUOTED_ERRORS = 20;

/**
 * The compiler errors of a failed build as Elide printed them: each `error:` line with the `In file:` location that
 * follows it.
 */
function buildErrors(lines: readonly TimelineLine[]): string[] {
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

function ownedBy(workspace: ElideWorkspace, folder: vscode.WorkspaceFolder, uri: vscode.Uri): boolean {
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

function previewBuild(workspace: ElideWorkspace, project: ElideProject, model: ProjectModel, artifact: AndroidTargetModel): PreviewBuild {
  return {
    model, artifact,
    models: workspace.projects.flatMap((item) => item.model ? [item.model] : []),
    bin: resolveElideDistribution({ explicitHome: readConfig(project.folder).home }).bin,
  };
}

function javaFor(model: ProjectModel): string {
  return model.jdk ? path.join(model.jdk.home, "bin", process.platform === "win32" ? "java.exe" : "java") : "java";
}

function backendKey(project: ElideProject, artifact: AndroidTargetModel): string {
  return `${project.root}\0${artifact.name}`;
}

/** The application supplying the resource context for previews of `file`: its nearest consumer in the same folder. */
function previewApp(workspace: ElideWorkspace, project: ElideProject, file: string): { project: ElideProject; target: AndroidTargetModel } | undefined {
  const models = workspace.projects.filter((item) => item.folder.uri.toString() === project.folder.uri.toString()).flatMap((item) => item.model ? [item.model] : []);
  for (const { model, target } of composePreviewApplications(file, models)) {
    const app = workspace.projectAt(model.root);
    if (app) return { project: app, target };
  }
  return undefined;
}

/** A gallery the panel displayed, or the build confirming one it displayed. */
export interface ComposePreviewPaint {
  source: string;
  images: number;
  failed: number;
  /** Since the change (or panel opening) that requested it. */
  elapsedMs: number;
  /** The images came from classes the running build may still replace. */
  verifying: boolean;
}

/** Compose preview events; consumed by the extension-host integration test. */
export interface ElideComposePreviewApi {
  readonly onDidPaint: vscode.Event<ComposePreviewPaint>;
  /** A background prewarm finished for the backend of this key. */
  readonly onDidPrewarm: vscode.Event<string>;
}

/** Host-side layoutlib rendering. A session never installs an APK or communicates with a device. */
class PreviewSession implements vscode.Disposable {
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];
  private task: vscode.TaskExecution | undefined;
  private building = false;
  private pending = false;
  private closed = false;
  private lastStatus = "Starting preview…";
  private statusState: "working" | "ready" | "error" = "working";
  /** Epoch milliseconds the phase the status names began, for the panel's elapsed-time counter. */
  private statusSince: number | undefined;
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
  private sourceTargets = new Map<string, PreviewSourceTarget>();
  private failedRevision = -1;
  private model: ProjectModel | undefined;
  private rebuild = true;
  private revision = 0;
  private imageRevision = -1;
  private detectedAt = performance.now();
  /** Painted images came from classes the running build may still replace. */
  private verifying = false;
  private summary: string | undefined;
  /** A build completed since the backend last refreshed its incremental compiler state. */
  private warmPending = false;
  private readonly backend: ComposeBackend;
  private readonly panel: vscode.WebviewPanel;

  constructor(
    private readonly workspace: ElideWorkspace,
    private readonly ui: ElideUi,
    private readonly context: vscode.ExtensionContext,
    private readonly backends: ComposeBackends,
    private readonly project: ElideProject,
    private readonly artifact: AndroidTargetModel,
    private readonly source: vscode.Uri,
    private readonly paints: vscode.EventEmitter<ComposePreviewPaint>,
  ) {
    this.backend = backends.acquire(backendKey(project, artifact));
    this.subscriptions.push(
      new vscode.Disposable(this.backend.onImages((images) => this.pushImages(images))),
      new vscode.Disposable(this.backend.onCompile((outcome) => this.compiled(outcome.failed, outcome.messages))),
    );
    this.panel = vscode.window.createWebviewPanel("elide.composePreview", `Compose: ${path.basename(source.fsPath)}`, vscode.ViewColumn.Beside,
      { enableScripts: true, localResourceRoots: [] });
    this.subscriptions.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((message: unknown) => {
        if (!message || typeof message !== "object" || !("type" in message)) return;
        if (message.type === "ready") {
          this.status(this.lastStatus, this.statusState, this.statusSince);
          void this.panel.webview.postMessage({ type: "log", reset: true, lines: this.logLines });
          this.publishImages(true);
          void this.panel.webview.postMessage({ type: "invalidate", revision: this.revision });
        }
        if (message.type === "refresh") this.schedule(true);
        if (message.type === "openLog") void this.ui.activity.openLog(this.buildStep ?? this.trace);
        if (message.type === "showActivity") void vscode.commands.executeCommand("elide.showActivity");
        if (message.type === "navigate" && "revision" in message && message.revision === this.revision
          && this.imageRevision === this.revision && "imageId" in message && "nodeId" in message
          && typeof message.imageId === "string" && typeof message.nodeId === "string") {
          void this.navigate(message.imageId, message.nodeId, this.revision);
        }
        if (message.type === "painted" && "revision" in message && message.revision === this.revision
          && this.imageRevision === this.revision && this.failedRevision !== this.revision && this.images.length) {
          const errors = this.images.filter((image) => image.error).length;
          const elapsed = Math.round(performance.now() - this.detectedAt);
          this.summary = `${this.images.length - errors} rendered in ${formatDuration(elapsed)}${errors ? ` · ${errors} failed (open Details)` : ""}`;
          this.renderedStatus();
          this.paints.fire({ source: this.source.fsPath, images: this.images.length, failed: errors, elapsedMs: elapsed, verifying: this.verifying });
        }
      }),
      vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
        const compiler = this.backend.compiler;
        if (contentChanges.length && this.owns(document.uri) && /\.(kt|java)$/.test(document.uri.fsPath)) {
          if (compiler && !compiler.supports(document.uri.fsPath)) {
            this.revision++;
            this.pending = false;
            this.summary = undefined;
            clearTimeout(this.timer);
            void this.panel.webview.postMessage({ type: "invalidate", revision: this.revision });
            this.status(compiler.requiresBuild(document.uri.fsPath)
              ? "Save to regenerate annotation-processor sources and rebuild the preview."
              : "Save to rebuild the preview's source inputs.");
          } else this.schedule(false);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        const compiler = this.backend.compiler;
        if (this.owns(document.uri) && (/\.(xml|pkl)$/.test(document.uri.fsPath)
          || compiler && !compiler.supports(document.uri.fsPath))) this.schedule(true);
      }),
      vscode.workspace.onDidCreateFiles(({ files }) => {
        for (const uri of files) if (this.owns(uri)) this.schedule(!this.backend.compiler?.supports(uri.fsPath));
      }),
      vscode.workspace.onDidDeleteFiles(({ files }) => {
        for (const uri of files) if (this.owns(uri)) this.schedule(!this.backend.compiler?.supports(uri.fsPath));
      }),
      vscode.workspace.onDidRenameFiles(({ files }) => {
        for (const { oldUri, newUri } of files) if (this.owns(oldUri) || this.owns(newUri)) {
          const compiler = this.backend.compiler;
          this.schedule(!compiler?.supports(oldUri.fsPath) || !compiler.supports(newUri.fsPath));
        }
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

  private owns(uri: vscode.Uri): boolean {
    return ownedBy(this.workspace, this.project.folder, uri);
  }

  private schedule(rebuild: boolean): void {
    if (this.closed) return;
    this.revision++;
    this.detectedAt = performance.now();
    this.rebuild ||= rebuild;
    this.pending = true;
    this.summary = undefined;
    // Invalidate work already in flight, including images still being decoded in the webview.
    void this.panel.webview.postMessage({ type: "invalidate", revision: this.revision });
    this.status(this.backend.compiler?.ready && !this.rebuild ? "Updating preview…" : "Preparing preview compiler and resources…");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), 0);
  }

  private status(text: string, state: "working" | "ready" | "error" = "working", since?: number): void {
    this.lastStatus = text;
    this.statusState = state;
    this.statusSince = since;
    if (!this.closed) void this.panel.webview.postMessage({ type: "status", text, state, since,
      retained: state !== "ready" && this.images.some((image) => image.data) });
  }

  /** The painted summary, the phases of the refresh that took long enough to matter, and what happens next. */
  private renderedStatus(): void {
    if (!this.summary) return;
    const phases = (this.trace?.children ?? []).filter((step) => step.durationMs >= 50 && (step.state === "succeeded" || step.state === "failed"))
      .map((step) => `${step.label.toLowerCase()} ${formatDuration(step.durationMs)}`);
    this.status(`${this.summary}${phases.length ? ` · ${phases.join(", ")}` : ""} · host layoutlib · ${this.verifying ? "verifying build…" : "live edits"}`,
      this.verifying ? "working" : this.images.some((image) => image.error) ? "error" : "ready",
      this.verifying && this.buildStep?.running ? this.buildStep.startedAt : undefined);
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
    if (!build?.running || this.summary) return;
    const command = build.children.at(-1);
    const task = command?.children.findLast((child) => !child.running);
    const progress = [liveStatus(build), command?.detail, task && `last: ${task.label} (${formatDuration(task.durationMs)})`].filter(Boolean).join(" · ");
    this.status(`Building ${this.artifact.name} preview inputs${progress ? ` · ${progress}` : "…"}`, "working", build.startedAt);
  }

  /** Cards a live engine updated after their gallery was shown: replaced in place within the same revision. */
  private pushImages(images: PreviewImage[]): void {
    if (this.closed || this.imageRevision !== this.revision) return;
    const updated = new Map(images.map((image) => [image.id, image]));
    let changed = false;
    this.images = this.images.map((image) => {
      const next = updated.get(image.id);
      if (!next) return image;
      changed = true;
      return { ...next, nodes: [] };
    });
    if (changed) this.publishImages();
  }

  /** A live engine's compile outcome: its messages in Problems (`elide-compose-preview`), cleared by the next success. */
  private compiled(failed: boolean, messages: CompileMessage[]): void {
    const collection = composeDiagnostics;
    if (!collection || this.closed) return;
    collection.clear();
    if (!failed) {
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
    this.status(`Live preview does not compile: ${first?.text ?? "see Problems"}`, "error");
  }

  private publishImages(replay = false): void {
    if (!this.closed) void this.panel.webview.postMessage({ type: "images", images: this.images, revision: this.imageRevision,
      ...(replay ? { currentRevision: this.revision } : {}) });
  }

  /** Publish images for `revision` unless a newer change superseded them. */
  private async show(images: PreviewImage[], revision: number, verifying: boolean, request: PreviewRequest): Promise<boolean> {
    if (this.closed || revision !== this.revision || revision === this.failedRevision) return false;
    if (!images.length) throw new Error("No compiled @Preview functions found in this file.");
    const sources = await this.backend.compiler?.sources(request.documents);
    if (this.closed || revision !== this.revision || revision === this.failedRevision) return false;
    const targets = new Map<string, PreviewSourceTarget>();
    this.verifying = verifying;
    // A failing component keeps its own last good pixels; other successful cards can still update.
    const previous = new Map(this.images.map((image) => [image.id, image]));
    this.images = images.map((image) => {
      const retained = image.error ? previous.get(image.id) : undefined;
      if (retained?.data) return { ...image, data: retained.data, width: retained.width, height: retained.height, nodes: [] };
      // Keep inspectable call sites in project sources, not Compose's implementation internals.
      const nodes = image.nodes?.filter((node) => {
        const target = node.source && sources && resolvePreviewSource(node.source, sources.files);
        if (!target) return false;
        targets.set(`${image.id}\0${node.id}`, target);
        return true;
      });
      return { ...image, nodes };
    });
    this.sourceTargets = targets;
    this.imageRevision = revision;
    this.publishImages();
    return true;
  }

  /**
   * Build what the preview renders as a step of `trace`. The task terminal stays hidden; the panel's Build log, its
   * status line and the Activity view follow the build instead, and a failure quotes the compiler's errors.
   */
  private async build(model: ProjectModel, artifact: AndroidTargetModel, models: readonly ProjectModel[], trace: TimelineNode): Promise<void> {
    const step = trace.start("Build");
    this.buildStep = step;
    this.resetLog();
    this.status(`Building ${artifact.name} preview inputs…`, "working", step.startedAt);
    const { execution, exitCode } = await executeObservedElideTask(this.project, "build", { args: composePreviewBuildTargets(model, artifact, models) },
      { reveal: vscode.TaskRevealKind.Silent, panel: vscode.TaskPanelKind.Dedicated, focus: false },
      observeCommands(() => step, (line) => this.appendLog(line)));
    this.task = execution;
    if (this.closed) {
      execution.terminate();
      step.end("cancelled", "preview closed");
      throw new Error("Compose preview closed.");
    }
    const code = await exitCode;
    this.task = undefined;
    if (code === 0) {
      step.end("succeeded");
      if (!this.summary) this.status(`Built ${artifact.name} preview inputs in ${formatDuration(step.durationMs)}; rendering…`);
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

  /** Once per build, after the images it produced are shown: get the next edit's compile warm. */
  private warm(request: PreviewRequest): void {
    if (!this.warmPending) return;
    this.warmPending = false;
    const revision = this.revision;
    const enrich = this.backend.compiler?.seeded;
    this.backend.warm(request).then(async () => {
      // Last-build classes paint immediately; their private compile adds source locations afterwards.
      if (enrich && !this.closed && revision === this.revision) {
        await this.show(await this.backend.preview(request), revision, false, request);
      }
    }).catch(() => {});
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
    const trace = this.rebuild || !backend.compiler
      ? this.ui.activity.start(`Compose preview: ${path.basename(this.source.fsPath)}`, { detail: this.artifact.name, cancel: () => this.task?.terminate() })
      : TimelineNode.root("Compose preview update");
    this.trace = trace;
    let outcome: "succeeded" | "failed" | "cancelled" = "cancelled";
    let failure: string | undefined;
    try {
      if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before executing Compose previews.");
      const model = this.workspace.projectAt(this.project.root)?.model;
      if (!model) throw new Error("Sync the Android project before previewing.");
      const artifact = model.android?.targets.find((target) => target.name === this.artifact.name);
      if (!artifact) throw new Error(`Android artifact ${this.artifact.name} no longer exists. Reopen the preview.`);
      const request = await previewRequest(this.workspace, this.project.folder, this.source);
      if (this.rebuild || !backend.compiler) {
        this.rebuild = false;
        const build = previewBuild(this.workspace, this.project, model, artifact);
        const runtime = await trace.run("Compose runtime", () =>
          ensureComposeRuntime(this.context.globalStorageUri.fsPath, this.controller.signal, (text) => this.status(text)));
        const starting = trace.start("Start renderer");
        const renderer = backend.startRenderer(runtime, javaFor(model));
        renderer.then(() => starting.end(), (error: unknown) => starting.end("failed", error instanceof Error ? error.message : String(error)));
        let buildFailed = false;
        const built = this.build(model, artifact, build.models, trace).catch((error: unknown) => {
          buildFailed = true;
          throw error;
        });
        built.catch(() => {});
        // While Elide confirms the build, paint a stored gallery of these exact inputs, or render
        // from a warm compiler or the last build's classes.
        const early = trace.start("Preview from the last build");
        const provisional = (async () => {
          if (!backend.compiler) await backend.configure(build, request.documents, false);
          const images = await backend.preview(request, false, early);
          return images && !buildFailed ? this.show(images, revision, true, request) : false;
        })().then(
          (shown) => {
            early.end(shown ? "succeeded" : "skipped", shown ? undefined : "nothing to show before the build");
            return shown;
          },
          (error: unknown) => {
            // Never built, or the build is rewriting its outputs: the gallery waits for the build instead.
            early.end("skipped", error instanceof Error ? error.message : String(error));
            return false;
          },
        );
        await built;
        this.warmPending = true;
        const shown = await provisional;
        if (this.closed) return;
        const changed = await trace.run("Prepare compiler", () => backend.configure(build, request.documents, true));
        this.model = model;
        if (this.closed || revision !== this.revision) return;
        if (shown && !changed) {
          this.verifying = false;
          outcome = "succeeded";
          trace.end("succeeded");
          this.renderedStatus();
          if (this.summary) {
            const failed = this.images.filter((image) => image.error).length;
            this.paints.fire({ source: this.source.fsPath, images: this.images.length, failed, elapsedMs: Math.round(performance.now() - this.detectedAt), verifying: false });
          }
          this.warm(request);
          return;
        }
        await trace.run("Wait for renderer", () => renderer);
      }
      if (!await this.show(await backend.preview(request, true, trace), revision, false, request)) return;
      outcome = "succeeded";
      this.warm(request);
    } catch (error) {
      if (!this.closed && revision === this.revision) {
        outcome = "failed";
        failure = error instanceof Error ? error.message.split("\n")[0] : String(error);
        this.failedRevision = revision;
        this.verifying = false;
        this.summary = undefined;
        this.status(`Preview failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    } finally {
      trace.end(outcome, failure ?? (outcome === "cancelled" ? "superseded by a newer change" : undefined));
      this.task = undefined;
      this.building = false;
      if (!this.closed && this.pending) { clearTimeout(this.timer); void this.refresh(); }
    }
  }

  private async navigate(imageId: string, nodeId: string, revision: number): Promise<void> {
    const target = this.sourceTargets.get(`${imageId}\0${nodeId}`);
    if (!target || this.closed || revision !== this.revision || revision === this.failedRevision) return;
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target.file));
      if (this.closed || revision !== this.revision || document.getText() !== target.content) return;
      const selection = new vscode.Range(document.positionAt(target.offset), document.positionAt(target.offset + target.length));
      const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, selection, preview: true });
      editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch (error) {
      if (!this.closed) void vscode.window.showWarningMessage(`Cannot open Compose source: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.logTimer);
    this.controller.abort();
    this.task?.terminate();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.panel.dispose();
    this.backends.release(this.backend);
  }
}

/** Compile messages of the live (Komodo) engine; one collection for the extension. */
let composeDiagnostics: vscode.DiagnosticCollection | undefined;

export function registerComposePreview(workspace: ElideWorkspace, ui: ElideUi, context: vscode.ExtensionContext): { disposable: vscode.Disposable; api: ElideComposePreviewApi } {
  const cacheRoot = context.globalStorageUri.fsPath;
  composeDiagnostics = vscode.languages.createDiagnosticCollection("elide-compose-preview");
  const elideBin = (): string | undefined => {
    try { return resolveElideDistribution({ explicitHome: readConfig().home }).bin; } catch { return undefined; }
  };
  const backends = new ComposeBackends(cacheRoot, context.asAbsolutePath("media/compose"), () => readConfig().composePreviewKeepAlive * 60_000,
    (key, root, helpers, store) => readConfig().composePreviewEngine === "komodo"
      ? new KomodoBackend(key, root, helpers, store, {
        path: () => readConfig().composePreviewKomodoPath,
        fallback: () => readConfig().composePreviewKomodoFallback,
        log: (line) => ui.log(line),
      }, elideBin)
      : new ComposeBackend(key, root, helpers, store),
    () => readConfig().composePreviewEngine);
  const paints = new vscode.EventEmitter<ComposePreviewPaint>();
  const prewarmed = new vscode.EventEmitter<string>();
  let session: PreviewSession | undefined;
  let prewarmTimer: NodeJS.Timeout | undefined;
  let prewarming: Promise<void> = Promise.resolve();

  /** Warm the backend the next Open Compose Preview of the focused file would use. */
  const prewarm = async (): Promise<void> => {
    const config = readConfig();
    if (!config.composePreviewPrewarm || config.composePreviewKeepAlive <= 0 || !vscode.workspace.isTrusted || session?.open) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "kotlin" || editor.document.uri.scheme !== "file") return;
    if (!/@\w*Preview\b|androidx\.compose\.ui\.tooling\.preview\./.test(editor.document.getText())) return;
    const project = workspace.projectFor(editor.document.uri.fsPath);
    if (!project?.model) return;
    const app = previewApp(workspace, project, editor.document.uri.fsPath);
    const model = app?.project.model;
    if (!app || !model) return;
    const runtime = await installedComposeRuntime(cacheRoot);
    if (!runtime || session?.open) return;
    const key = backendKey(app.project, app.target);
    const backend = backends.obtain(key);
    backends.idle(backend);
    await backend.prewarm(previewBuild(workspace, app.project, model, app.target), runtime, javaFor(model),
      await previewRequest(workspace, project.folder, editor.document.uri));
    prewarmed.fire(key);
  };
  const schedulePrewarm = (): void => {
    clearTimeout(prewarmTimer);
    prewarmTimer = setTimeout(() => { prewarming = prewarming.then(prewarm).catch(() => {}); }, 300);
  };

  const command = vscode.commands.registerCommand("elide.androidComposePreview", async () => {
    try {
      if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before building a preview.");
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== "kotlin" || editor.document.uri.scheme !== "file") throw new Error("Open a Kotlin source file containing @Preview functions.");
      const project = workspace.projectFor(editor.document.uri.fsPath);
      if (!project?.model) throw new Error("Sync the project before opening a Compose preview.");
      if (!await editor.document.save()) return;
      const app = previewApp(workspace, project, editor.document.uri.fsPath);
      if (!app) throw new Error("No Android application in this workspace folder packages this file. Declare an AndroidApk that includes its source set or depends on its library, then sync.");
      session?.dispose();
      session = new PreviewSession(workspace, ui, context, backends, app.project, app.target, editor.document.uri, paints);
    } catch (error) {
      void vscode.window.showErrorMessage(`Elide: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const subscriptions = [
    command,
    paints,
    prewarmed,
    vscode.window.onDidChangeActiveTextEditor(schedulePrewarm),
    vscode.workspace.onDidGrantWorkspaceTrust(schedulePrewarm),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("elide.android.composePreview")) return;
      backends.rearm();
      schedulePrewarm();
    }),
    workspace.onDidChange(() => {
      backends.retain((key) => workspace.projects.some((project) => project.model?.android?.targets.some((target) => backendKey(project, target) === key)));
      schedulePrewarm();
    }),
  ];
  schedulePrewarm();
  const disposable = new vscode.Disposable(() => {
    clearTimeout(prewarmTimer);
    session?.dispose();
    backends.dispose();
    composeDiagnostics?.dispose();
    composeDiagnostics = undefined;
    for (const subscription of subscriptions) subscription.dispose();
  });
  return { disposable, api: { onDidPaint: paints.event, onDidPrewarm: prewarmed.event } };
}

