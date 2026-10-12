import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { composePreviewBuildTargets, composePreviewInputs, resolveElideDistribution, type AndroidTargetModel, type ProjectModel } from "@elide/ide-core";
import * as vscode from "vscode";
import { ComposeCompiler } from "./composeCompiler.js";
import { ComposeRenderer, type PreviewImage } from "./composeRender.js";
import { readConfig } from "./config.js";
import { ensureComposeRuntime } from "./composeRuntime.js";
import type { ElideProject, ElideWorkspace } from "./projects.js";
import { executeElideTask, taskExitCode } from "./tasks.js";

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
  private images: PreviewImage[] = [];
  private compiler: ComposeCompiler | undefined;
  private renderer: ComposeRenderer | undefined;
  private directory: string | undefined;
  private model: ProjectModel | undefined;
  private rebuild = true;
  private revision = 0;
  private imageRevision = -1;
  private detectedAt = performance.now();
  private readonly panel: vscode.WebviewPanel;

  constructor(
    private readonly workspace: ElideWorkspace,
    private readonly context: vscode.ExtensionContext,
    private readonly project: ElideProject,
    private readonly artifact: AndroidTargetModel,
    private readonly source: vscode.Uri,
  ) {
    this.panel = vscode.window.createWebviewPanel("elide.composePreview", `Compose: ${path.basename(source.fsPath)}`, vscode.ViewColumn.Beside,
      { enableScripts: true, localResourceRoots: [] });
    this.subscriptions.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((message: unknown) => {
        if (!message || typeof message !== "object" || !("type" in message)) return;
        if (message.type === "ready") { this.status(this.lastStatus); this.publishImages(); }
        if (message.type === "refresh") this.schedule(true);
        if (message.type === "painted" && "revision" in message && message.revision === this.revision
          && this.imageRevision === this.revision && this.images.length) {
          const errors = this.images.filter((image) => image.error).length;
          const elapsed = Math.round(performance.now() - this.detectedAt);
          this.status(`${this.images.length - errors} rendered${errors ? ` · ${errors} failed (see diagnostics below)` : ""} · ${elapsed} ms · host layoutlib · live edits`);
        }
      }),
      vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
        if (contentChanges.length && this.owns(document.uri) && /\.(kt|java)$/.test(document.uri.fsPath)) {
          if (this.compiler && !this.compiler.supports(document.uri.fsPath)) {
            this.revision++;
            this.pending = false;
            clearTimeout(this.timer);
            void this.panel.webview.postMessage({ type: "invalidate", revision: this.revision });
            this.status(this.compiler.requiresBuild(document.uri.fsPath)
              ? "Save to regenerate annotation-processor sources and rebuild the preview."
              : "Save to rebuild the preview's source inputs.");
          } else this.schedule(false);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (this.owns(document.uri) && (/\.(xml|pkl)$/.test(document.uri.fsPath)
          || this.compiler && !this.compiler.supports(document.uri.fsPath))) this.schedule(true);
      }),
      vscode.workspace.onDidCreateFiles(({ files }) => {
        for (const uri of files) if (this.owns(uri)) this.schedule(!this.compiler?.supports(uri.fsPath));
      }),
      vscode.workspace.onDidDeleteFiles(({ files }) => {
        for (const uri of files) if (this.owns(uri)) this.schedule(!this.compiler?.supports(uri.fsPath));
      }),
      vscode.workspace.onDidRenameFiles(({ files }) => {
        for (const { oldUri, newUri } of files) if (this.owns(oldUri) || this.owns(newUri)) {
          this.schedule(!this.compiler?.supports(oldUri.fsPath) || !this.compiler.supports(newUri.fsPath));
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

  private owns(uri: vscode.Uri): boolean {
    if (uri.scheme !== "file" || !/\.(kt|java|xml|pkl)$/.test(uri.fsPath)) return false;
    const owner = this.workspace.projectFor(uri.fsPath);
    return owner?.folder.uri.toString() === this.project.folder.uri.toString();
  }

  private schedule(rebuild: boolean): void {
    if (this.closed) return;
    this.revision++;
    this.detectedAt = performance.now();
    this.rebuild ||= rebuild;
    this.pending = true;
    // Invalidate work already in flight, including images still being decoded in the webview.
    void this.panel.webview.postMessage({ type: "invalidate", revision: this.revision });
    this.status(this.compiler && !this.rebuild ? "Updating preview…" : "Preparing preview compiler and resources…");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), 0);
  }

  private status(text: string): void {
    this.lastStatus = text;
    if (!this.closed) void this.panel.webview.postMessage({ type: "status", text });
  }

  private publishImages(): void {
    if (!this.closed) void this.panel.webview.postMessage({ type: "images", images: this.images, revision: this.imageRevision });
  }

  private async refresh(): Promise<void> {
    if (this.closed || this.building) return;
    this.building = true;
    this.pending = false;
    const revision = this.revision;
    try {
      if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before executing Compose previews.");
      const model = this.workspace.projectAt(this.project.root)?.model;
      if (!model) throw new Error("Sync the Android project before previewing.");
      const artifact = model.android?.targets.find((target) => target.name === this.artifact.name);
      if (!artifact) throw new Error(`Android artifact ${this.artifact.name} no longer exists. Reopen the preview.`);
      if (this.rebuild || !this.compiler || !this.renderer) {
        this.rebuild = false;
        await this.releaseBackend();
        const models = this.workspace.projects.flatMap((project) => project.model ? [project.model] : []);
        const buildTargets = composePreviewBuildTargets(model, artifact, models);
        const java = model.jdk ? path.join(model.jdk.home, "bin", process.platform === "win32" ? "java.exe" : "java") : "java";
        const runtime = await ensureComposeRuntime(this.context.globalStorageUri.fsPath, this.controller.signal, (text) => this.status(text));
        this.status(`Preparing ${artifact.name} preview classes and resources…`);
        this.task = await executeElideTask(this.workspace, this.project, "build", { args: buildTargets },
          { reveal: vscode.TaskRevealKind.Silent, panel: vscode.TaskPanelKind.Dedicated, focus: false });
        if (this.closed) { this.task?.terminate(); return; }
        if (!this.task || await taskExitCode(this.task) !== 0) throw new Error("Preview build failed; see the Elide task terminal.");
        this.task = undefined;
        if (this.closed) return;
        this.directory = await mkdtemp(path.join(tmpdir(), "elide-compose-"));
        const inputs = await composePreviewInputs(model, artifact, models);
        const bin = resolveElideDistribution({ explicitHome: readConfig(this.project.folder).home }).bin;
        this.compiler = await ComposeCompiler.create(bin, this.project.root, inputs, this.directory, this.controller.signal);
        this.renderer = await ComposeRenderer.create(runtime, java, this.context.asAbsolutePath("media/compose"), this.directory, this.controller.signal);
        this.model = model;
      }
      const document = await vscode.workspace.openTextDocument(this.source);
      const snapshots = new Map(vscode.workspace.textDocuments.filter((item) => this.owns(item.uri))
        .map((item) => [item.uri.fsPath, item.getText()]));
      const packageName = /^\s*package\s+([\w.`]+)/m.exec(snapshots.get(this.source.fsPath) ?? document.getText())?.[1]?.replaceAll("`", "") ?? "";
      await this.compiler.update(snapshots);
      if (this.closed || revision !== this.revision) return;
      if (!this.renderer.alive) {
        const java = model.jdk ? path.join(model.jdk.home, "bin", process.platform === "win32" ? "java.exe" : "java") : "java";
        const runtime = await ensureComposeRuntime(this.context.globalStorageUri.fsPath, this.controller.signal, (text) => this.status(text));
        this.renderer.dispose();
        this.renderer = await ComposeRenderer.create(runtime, java, this.context.asAbsolutePath("media/compose"), this.directory!, this.controller.signal);
      }
      const images = await this.renderer.render(this.compiler.inputs, this.source.fsPath, packageName);
      if (this.closed || revision !== this.revision) return;
      if (!images.length) throw new Error("No compiled @Preview functions found in this file.");
      this.images = images;
      this.imageRevision = revision;
      this.publishImages();
    } catch (error) {
      if (!this.closed && revision === this.revision) {
        this.images = [];
        this.imageRevision = revision;
        this.publishImages();
        this.status(`Preview failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      this.task = undefined;
      this.building = false;
      if (this.closed) await this.releaseBackend();
      else if (this.pending) { clearTimeout(this.timer); void this.refresh(); }
    }
  }

  private async releaseBackend(): Promise<void> {
    this.compiler?.dispose();
    this.renderer?.dispose();
    this.compiler = undefined;
    this.renderer = undefined;
    const directory = this.directory;
    this.directory = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.controller.abort();
    this.task?.terminate();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.panel.dispose();
    if (!this.building) void this.releaseBackend();
  }
}

export function registerComposePreview(workspace: ElideWorkspace, context: vscode.ExtensionContext): vscode.Disposable {
  let session: PreviewSession | undefined;
  const command = vscode.commands.registerCommand("elide.androidComposePreview", async () => {
    try {
      if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before building a preview.");
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== "kotlin" || editor.document.uri.scheme !== "file") throw new Error("Open a Kotlin source file containing @Preview functions.");
      const project = workspace.projectFor(editor.document.uri.fsPath);
      if (!project?.model?.android) throw new Error("Sync the Android project before opening a Compose preview.");
      if (!await editor.document.save()) return;
      const apps = workspace.projects.filter((item) => item.folder.uri.toString() === project.folder.uri.toString())
        .flatMap((item) => (item.model?.android?.targets ?? []).filter((target) => target.kind === "apk")
          .map((target) => ({ label: target.name, description: item.model?.name ?? item.root, project: item, target })));
      const app = apps.length === 1 ? apps[0] : await vscode.window.showQuickPick(apps, { placeHolder: "Android resource context for this preview (no APK installation)" });
      if (!app) { if (!apps.length) throw new Error("Declare an AndroidApk resource context, or open the workspace containing this library's consuming Android application."); return; }
      session?.dispose();
      session = new PreviewSession(workspace, context, app.project, app.target, editor.document.uri);
    } catch (error) {
      void vscode.window.showErrorMessage(`Elide: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return new vscode.Disposable(() => { command.dispose(); session?.dispose(); });
}

function previewHtml(): string {
  const nonce = randomBytes(18).toString("base64");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><style nonce="${nonce}">
body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); padding: 12px; }
button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 6px 12px; cursor: pointer; }
#status, pre { white-space: pre-wrap; overflow-wrap: anywhere; } #previews { display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start; }
article { max-width: 100%; border: 1px solid var(--vscode-panel-border); padding: 12px; box-sizing: border-box; }
h2 { font-size: 14px; margin: 0 0 8px; } small { display: block; margin-bottom: 12px; overflow-wrap: anywhere; }
img { display: block; max-width: 100%; height: auto; } .fit img { max-height: 70vh; object-fit: contain; object-position: left top; }
pre { color: var(--vscode-errorForeground); }
</style></head><body><button id="refresh">Rebuild preview</button> <button id="fit">Fit previews</button><p id="status" role="status">Starting preview…</p><main id="previews"></main><script nonce="${nonce}">
const api = acquireVsCodeApi(); const gallery = document.getElementById('previews'); const fit = document.getElementById('fit');
let fitted = api.getState()?.fitted === true;
function applyFit() { document.body.classList.toggle('fit', fitted); fit.textContent = fitted ? 'Actual size' : 'Fit previews'; }
applyFit(); fit.onclick = () => { fitted = !fitted; api.setState({fitted}); applyFit(); };
document.getElementById('refresh').onclick = () => api.postMessage({type:'refresh'});
let revision = -1;
window.addEventListener('message', async ({data}) => {
  if(data.type === 'status') document.getElementById('status').textContent = data.text;
  if(data.type === 'invalidate') { revision = data.revision; gallery.setAttribute('aria-busy', 'true'); }
  if(data.type === 'images' && data.revision >= revision) {
    revision = data.revision;
    const cards = []; const decoded = [];
    for (const preview of data.images) {
      const card = document.createElement('article'); const title = document.createElement('h2'); title.textContent = preview.name; card.append(title);
      const detail = document.createElement('small'); detail.textContent = preview.detail; card.append(detail);
      if (preview.data) {
        const image = document.createElement('img'); image.alt = preview.name;
        image.src = 'data:image/png;base64,' + preview.data; card.append(image);
        decoded.push(image.decode().catch(() => { image.alt = 'Could not decode preview image'; }));
      }
      if (preview.error) { const error = document.createElement('pre'); error.textContent = preview.error; card.append(error); }
      cards.push(card);
    }
    await Promise.all(decoded);
    if (revision !== data.revision) return;
    gallery.replaceChildren(...cards);
    gallery.setAttribute('aria-busy', 'false');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (revision === data.revision) api.postMessage({type:'painted', revision});
    }));
  }
});
api.postMessage({type:'ready'});
</script></body></html>`;
}
