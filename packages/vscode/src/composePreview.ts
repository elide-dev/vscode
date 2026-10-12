import path from "node:path";
import { composePreviewBuildTargets, resolveElideDistribution, type AndroidTargetModel, type ProjectModel } from "@elide/ide-core";
import * as vscode from "vscode";
import { ComposeBackends, type ComposeBackend, type PreviewBuild, type PreviewRequest } from "./composeBackend.js";
import type { PreviewImage } from "./composeRender.js";
import { previewHtml } from "./composePreviewHtml.js";
import { resolvePreviewSource, type PreviewSourceTarget } from "./composeSource.js";
import { readConfig } from "./config.js";
import { ensureComposeRuntime, installedComposeRuntime } from "./composeRuntime.js";
import type { ElideProject, ElideWorkspace } from "./projects.js";
import { executeElideTask, taskExitCode } from "./tasks.js";

const previewInput = /\.(?:kt|java|xml|pkl)$/;

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

/** Android applications that can supply the resource context for previews in `project`'s workspace folder. */
function previewApps(workspace: ElideWorkspace, project: ElideProject) {
  return workspace.projects.filter((item) => item.folder.uri.toString() === project.folder.uri.toString())
    .flatMap((item) => (item.model?.android?.targets ?? []).filter((target) => target.kind === "apk")
      .map((target) => ({ label: target.name, description: item.model?.name ?? item.root, project: item, target })));
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
    private readonly context: vscode.ExtensionContext,
    private readonly backends: ComposeBackends,
    private readonly project: ElideProject,
    private readonly artifact: AndroidTargetModel,
    private readonly source: vscode.Uri,
    private readonly paints: vscode.EventEmitter<ComposePreviewPaint>,
  ) {
    this.backend = backends.acquire(backendKey(project, artifact));
    this.panel = vscode.window.createWebviewPanel("elide.composePreview", `Compose: ${path.basename(source.fsPath)}`, vscode.ViewColumn.Beside,
      { enableScripts: true, localResourceRoots: [] });
    this.subscriptions.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((message: unknown) => {
        if (!message || typeof message !== "object" || !("type" in message)) return;
        if (message.type === "ready") {
          this.status(this.lastStatus, this.statusState);
          this.publishImages(true);
          void this.panel.webview.postMessage({ type: "invalidate", revision: this.revision });
        }
        if (message.type === "refresh") this.schedule(true);
        if (message.type === "navigate" && "revision" in message && message.revision === this.revision
          && this.imageRevision === this.revision && "imageId" in message && "nodeId" in message
          && typeof message.imageId === "string" && typeof message.nodeId === "string") {
          void this.navigate(message.imageId, message.nodeId, this.revision);
        }
        if (message.type === "painted" && "revision" in message && message.revision === this.revision
          && this.imageRevision === this.revision && this.failedRevision !== this.revision && this.images.length) {
          const errors = this.images.filter((image) => image.error).length;
          const elapsed = Math.round(performance.now() - this.detectedAt);
          this.summary = `${this.images.length - errors} rendered${errors ? ` · ${errors} failed (open Details)` : ""} · ${elapsed} ms · host layoutlib`;
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

  private status(text: string, state: "working" | "ready" | "error" = "working"): void {
    this.lastStatus = text;
    this.statusState = state;
    if (!this.closed) void this.panel.webview.postMessage({ type: "status", text, state,
      retained: state !== "ready" && this.images.some((image) => image.data) });
  }

  private renderedStatus(): void {
    if (this.summary) this.status(`${this.summary} · ${this.verifying ? "verifying build…" : "live edits"}`,
      this.verifying ? "working" : this.images.some((image) => image.error) ? "error" : "ready");
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

  private async build(model: ProjectModel, artifact: AndroidTargetModel, models: readonly ProjectModel[]): Promise<void> {
    this.task = await executeElideTask(this.workspace, this.project, "build", { args: composePreviewBuildTargets(model, artifact, models) },
      { reveal: vscode.TaskRevealKind.Silent, panel: vscode.TaskPanelKind.Dedicated, focus: false });
    if (this.closed) {
      this.task?.terminate();
      throw new Error("Compose preview closed.");
    }
    if (!this.task || await taskExitCode(this.task) !== 0) throw new Error("Preview build failed; see the Elide task terminal.");
    this.task = undefined;
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

  private async refresh(): Promise<void> {
    if (this.closed || this.building) return;
    this.building = true;
    this.pending = false;
    const revision = this.revision;
    const backend = this.backend;
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
        const runtime = await ensureComposeRuntime(this.context.globalStorageUri.fsPath, this.controller.signal, (text) => this.status(text));
        const renderer = backend.startRenderer(runtime, javaFor(model));
        renderer.catch(() => {});
        this.status(`Preparing ${artifact.name} preview classes and resources…`);
        let buildFailed = false;
        const built = this.build(model, artifact, build.models).catch((error: unknown) => {
          buildFailed = true;
          throw error;
        });
        built.catch(() => {});
        // While Elide confirms the build, paint a stored gallery of these exact inputs, or render
        // from a warm compiler or the last build's classes.
        const provisional = (async () => {
          if (!backend.compiler) await backend.configure(build, request.documents, false);
          const images = await backend.preview(request, false);
          return images && !buildFailed ? this.show(images, revision, true, request) : false;
        })().catch(() => false);
        await built;
        this.warmPending = true;
        const shown = await provisional;
        if (this.closed) return;
        const changed = await backend.configure(build, request.documents, true);
        this.model = model;
        if (this.closed || revision !== this.revision) return;
        if (shown && !changed) {
          this.verifying = false;
          this.renderedStatus();
          if (this.summary) {
            const failed = this.images.filter((image) => image.error).length;
            this.paints.fire({ source: this.source.fsPath, images: this.images.length, failed, elapsedMs: Math.round(performance.now() - this.detectedAt), verifying: false });
          }
          this.warm(request);
          return;
        }
        await renderer;
      }
      if (!await this.show(await backend.preview(request), revision, false, request)) return;
      this.warm(request);
    } catch (error) {
      if (!this.closed && revision === this.revision) {
        this.failedRevision = revision;
        this.verifying = false;
        this.summary = undefined;
        this.status(`Preview failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    } finally {
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
    this.controller.abort();
    this.task?.terminate();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.panel.dispose();
    this.backends.release(this.backend);
  }
}

export function registerComposePreview(workspace: ElideWorkspace, context: vscode.ExtensionContext): { disposable: vscode.Disposable; api: ElideComposePreviewApi } {
  const cacheRoot = context.globalStorageUri.fsPath;
  const backends = new ComposeBackends(cacheRoot, context.asAbsolutePath("media/compose"), () => readConfig().composePreviewKeepAlive * 60_000);
  const paints = new vscode.EventEmitter<ComposePreviewPaint>();
  const prewarmed = new vscode.EventEmitter<string>();
  let session: PreviewSession | undefined;
  /** Workspace folder → backend key of the application last chosen for its previews. */
  const chosen = new Map<string, string>();
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
    if (!project?.model?.android) return;
    const apps = previewApps(workspace, project);
    const app = apps.length === 1 ? apps[0] : apps.find((item) => backendKey(item.project, item.target) === chosen.get(project.folder.uri.toString()));
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
      if (!project?.model?.android) throw new Error("Sync the Android project before opening a Compose preview.");
      if (!await editor.document.save()) return;
      const apps = previewApps(workspace, project);
      const app = apps.length === 1 ? apps[0] : await vscode.window.showQuickPick(apps, { placeHolder: "Android resource context for this preview (no APK installation)" });
      if (!app) { if (!apps.length) throw new Error("Declare an AndroidApk resource context, or open the workspace containing this library's consuming Android application."); return; }
      chosen.set(project.folder.uri.toString(), backendKey(app.project, app.target));
      session?.dispose();
      session = new PreviewSession(workspace, context, backends, app.project, app.target, editor.document.uri, paints);
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
    for (const subscription of subscriptions) subscription.dispose();
  });
  return { disposable, api: { onDidPaint: paints.event, onDidPrewarm: prewarmed.event } };
}

