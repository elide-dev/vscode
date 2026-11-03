import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { mock } from "bun:test";
import { TimelineNode } from "@elide/ide-core";
import { StaleBuildRecordError } from "../../src/composeProcessing.js";

class Disposable {
  constructor(private readonly close: () => void = () => {}) {}
  dispose(): void { this.close(); }
}
class EventEmitter<T> {
  private listeners = new Set<(value: T) => unknown>();
  event = (listener: (value: T) => unknown) => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };
  fire(value: T): void { for (const listener of this.listeners) listener(value); }
  dispose(): void { this.listeners.clear(); }
}
const scenario = process.argv[2];
const native = scenario?.startsWith("komodo-") === true;
const processing = ["processing", "processor-failure", "processing-recovery", "superseded-processing", "stale-paint"].includes(scenario!);
/** Scenarios whose webview acknowledges every gallery it receives, as soon as it arrives. */
const acknowledging = processing || ["cold-initialization", "inspect", "replay", "rename", "session-lost", "restore"].includes(scenario!);
/** Scenarios whose error notifications are recorded rather than failing the run. */
const notifying = native || ["availability", "sync-failure"].includes(scenario!);
const changed = new EventEmitter<unknown>();
const received = new EventEmitter<unknown>();
const disposed = new EventEmitter<void>();
const renamed = new EventEmitter<unknown>();
const deleted = new EventEmitter<unknown>();
const workspaceChanged = new EventEmitter<void>();
const availabilityChanged = new EventEmitter<void>();
let nativeAvailable = scenario !== "komodo-missing";
let nativeReason = "Komodo is missing; install a compatible Komodo through Elide, then sync.";
const noopEvent = () => new Disposable();
const messages: Record<string, unknown>[] = [];
const commands = new Map<string, () => unknown>();
/** `executeCommand` calls, such as `setContext`. */
const contexts: unknown[][] = [];
/** Error notifications of the `notifying` scenarios. */
const shown: string[] = [];
const warnings: string[] = [];
/** Titles of `withProgress` calls. */
const progress: string[] = [];
/** Files opened in an editor by source navigation. */
const opened: string[] = [];
let panels = 0;
let reveals = 0;
const fileUri = (fsPath: string) => ({ scheme: "file", fsPath, toString: () => `file://${fsPath}` });
const uri = fileUri("/app/src/main/Gallery.kt");
const folder = { name: "app", uri: { fsPath: "/app", toString: () => "file:///app" } };
let text = "package sample\n@Preview fun Gallery() {}";
const document = { uri, languageId: "kotlin", getText: () => text, positionAt: (offset: number) => ({ offset }),
  save: async () => { throw new Error("preview must not save unsaved editor text"); } };
const webview = { html: "", options: {}, postMessage: async (message: Record<string, unknown>) => {
  messages.push(message);
  if (acknowledging && message.type === "images" && (scenario !== "stale-paint" || message.revision === 1)) {
    queueMicrotask(() => received.fire({ type: "painted", revision: message.revision, publication: message.publication }));
  }
  // A webview busy with frames: each acknowledgement arrives after newer frames were posted.
  if (scenario === "animation" && message.type === "images") {
    setTimeout(() => received.fire({ type: "painted", revision: message.revision, publication: message.publication }), 20);
  }
  return true;
}, onDidReceiveMessage: received.event };
/** Like VS Code's panel: once disposed (before onDidDispose runs), its webview and view state throw. */
let panelDisposed = false;
const panel = {
  title: "",
  reveal: () => { reveals++; },
  get visible() {
    if (panelDisposed) throw new Error("Webview is disposed");
    return true;
  },
  onDidChangeViewState: noopEvent,
  get webview() {
    if (panelDisposed) throw new Error("Webview is disposed");
    return webview;
  },
  onDidDispose: disposed.event,
  dispose: () => {
    if (panelDisposed) return;
    panelDisposed = true;
    disposed.fire();
  },
};
class Range { constructor(readonly start: unknown, readonly end: unknown) {} }
/** Problems entries of the preview's diagnostic collection, by file. */
const problems = new Map<string, unknown[]>();
let serializer: { deserializeWebviewPanel(panel: unknown, state: unknown): Promise<void> } | undefined;
mock.module("vscode", () => ({
  Disposable, EventEmitter, Range, ViewColumn: { One: 1, Beside: 2 }, TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
  Diagnostic: class { constructor(readonly range: unknown, readonly message: string, readonly severity: number) {} },
  DiagnosticSeverity: { Error: 0, Warning: 1 },
  Uri: { file: fileUri, parse: (value: string) => value.startsWith("file://") ? fileUri(value.slice("file://".length)) : { scheme: value.split(":")[0], fsPath: "", toString: () => value } },
  commands: {
    registerCommand: (name: string, callback: () => unknown) => { commands.set(name, callback); return new Disposable(); },
    executeCommand: async (...args: unknown[]) => { contexts.push(args); },
  },
  languages: { createDiagnosticCollection: () => ({
    clear: () => problems.clear(), set: (file: { fsPath: string }, entries: unknown[]) => problems.set(file.fsPath, entries), dispose() {},
  }) },
  ProgressLocation: { Notification: 15, Window: 10 },
  window: { activeTextEditor: { document }, createWebviewPanel: () => { panels++; return panel; }, onDidChangeActiveTextEditor: noopEvent,
    onDidChangeWindowState: noopEvent,
    registerWebviewPanelSerializer: (_viewType: string, value: typeof serializer) => { serializer = value; return new Disposable(); },
    withProgress: (options: { title: string }, task: (progress: { report(value: unknown): void }, token: unknown) => unknown) => {
      progress.push(options.title);
      return task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => new Disposable() });
    },
    showTextDocument: async (opening: typeof document) => {
      opened.push(opening.uri.fsPath);
      return { revealRange() {} };
    },
    showWarningMessage: (message: string) => { warnings.push(message); },
    showErrorMessage: (message: string) => {
      if (!notifying) throw new Error(message);
      shown.push(message);
    } },
  workspace: { isTrusted: true, textDocuments: [document], openTextDocument: async () => document,
    fs: { stat: async (file: { fsPath: string }) => {
      if (file.fsPath !== uri.fsPath) throw new Error("EntryNotFound");
      return {};
    } },
    onDidChangeTextDocument: changed.event, onDidSaveTextDocument: noopEvent, onDidCreateFiles: noopEvent,
    onDidDeleteFiles: deleted.event, onDidRenameFiles: renamed.event, onDidGrantWorkspaceTrust: noopEvent,
    onDidChangeConfiguration: noopEvent },
}));
const prewarming = scenario === "prewarm-close" || scenario === "prewarm-failure";
mock.module("../../src/config.js", () => ({ readConfig: () => ({ composePreviewPrewarm: prewarming, composePreviewKeepAlive: 1,
  composePreviewEngine: native ? "komodo" : "layoutlib" }) }));
const runtimeGate = Promise.withResolvers<object>();
let runtimeEntered = false;
mock.module("../../src/composeRuntime.js", () => ({
  installedComposeRuntime: async () => {
    if (!prewarming) return undefined;
    runtimeEntered = true;
    return scenario === "prewarm-failure" ? {} : runtimeGate.promise;
  },
  ensureComposeRuntime: async (_root: string, signal: AbortSignal) => {
    runtimeEntered = true;
    const aborted = Promise.withResolvers<never>();
    signal.addEventListener("abort", () => aborted.reject(signal.reason), { once: true });
    return Promise.race([runtimeGate.promise, aborted.promise]);
  },
}));
let builds = 0;
let starts = 0;
let previews = 0;
let obtained = 0;
const buildGates: PromiseWithResolvers<number | undefined>[] = [];
/** Each build's cancellation signal. */
const buildSignals: AbortSignal[] = [];
const verifyGates: PromiseWithResolvers<boolean>[] = [];
const confirmed = new Set<string>();
const initialization = Promise.withResolvers<void>();
let warming = false;
let inspections = 0;
const invocations: { options?: Record<string, unknown> }[] = [];
mock.module("../../src/tasks.js", () => ({ runObservedElide: async (_project: unknown, _command: unknown, invocation: { options?: Record<string, unknown> }, options: { signal: AbortSignal }) => {
  builds++;
  invocations.push(invocation);
  const gate = Promise.withResolvers<number | undefined>();
  buildGates.push(gate);
  buildSignals.push(options.signal);
  options.signal.addEventListener("abort", () => gate.resolve(undefined), { once: true });
  return gate.promise;
} }));
/** The preview's source files of `preview` calls. */
const requested: string[] = [];
/** A layout node calling `Gallery` in Gallery.kt, which the inspector's Open source opens. */
const galleryNode = { id: "call", name: "Gallery", x: 0, y: 0, width: 1, height: 1,
  source: { fileName: "Gallery.kt", packageHash: -1, lineNumber: 2, offset: text.indexOf("Gallery()"), length: "Gallery".length } };
let pushImages: (images: unknown[]) => void = () => {};
let compiled: (outcome: { failed: boolean; messages: unknown[] }) => void = () => {};
let sessionLost = () => {};
const backend = {
  engine: native ? "komodo" : "layoutlib",
  prepareSession: async () => {
    if (scenario === "komodo-incompatible") {
      workspace.rejectKomodoPreview("Unsupported Komodo preview protocol; install a compatible Komodo, then sync.");
      throw new Error(nativeReason);
    }
  },
  compiler: { ready: true, seeded: false, processingRequired: processing, processingStats: { stubs: 0, apt: 0 },
    needsWarmup: scenario === "cold-initialization",
    supports: () => true, sources: async (documents: ReadonlyMap<string, string>) => ({ files: [documents] }) },
  get needsWarmup() { return backend.compiler.needsWarmup; },
  get processingRequired() { return backend.compiler.processingRequired; },
  startRenderer: async () => { starts++; },
  disposed: false,
  onImages: (listener: typeof pushImages) => { pushImages = listener; return () => {}; },
  onCompile: (listener: typeof compiled) => { compiled = listener; return () => {}; },
  onInputReset: () => () => {},
  onSessionLost: (listener: () => void) => { sessionLost = listener; return () => {}; },
  keyboardSupported: () => false,
  blur: () => false,
  pointer: () => false,
  edit: () => {},
  compiles: () => true,
  latestImages: (images: unknown) => images,
  prewarm: async () => { throw new Error("renderer startup failed"); },
  configure: async () => {
    if (scenario === "stale-record" && !invocations.at(-1)?.options?.["no-cache"]) throw new StaleBuildRecordError("/app/kotlinc.args", "it compiles into /elsewhere");
    return false;
  },
  preview: async (request: { documents: ReadonlyMap<string, string>; sourceFile: string; inspect?: boolean }) => {
    previews++;
    requested.push(request.sourceFile);
    if (request.inspect) inspections++;
    const source = request.documents.get(uri.fsPath)!;
    if (scenario === "processing-recovery" && source.includes("declaration") && !confirmed.has(source)) throw new Error("old generated declaration");
    const live = scenario === "animation" ? { live: true, nodes: [galleryNode] } : {};
    return { images: [{ id: "gallery", data: source, width: 1, height: 1, ...live }], verified: !processing || confirmed.has(source), reused: false };
  },
  verify: async (request: { documents: ReadonlyMap<string, string> }) => {
    backend.compiler.processingStats.stubs++;
    const gate = Promise.withResolvers<boolean>();
    verifyGates.push(gate);
    const result = await gate.promise;
    confirmed.add(request.documents.get(uri.fsPath)!);
    if (result) backend.compiler.processingStats.apt++;
    return result;
  },
  warm: async () => {
    warming = true;
    await initialization.promise;
    backend.compiler.needsWarmup = false;
  },
};
// `ComposeBackend` is the base class the Komodo engine extends; the session never constructs it here.
// Load after the VS Code mock above; a static import would resolve the real extension API outside an extension host.
const { isPreviewKeyEvent, PREVIEW_KEY_NAMES } = await import("../../src/composeBackend.js");
mock.module("../../src/composeBackend.js", () => ({ isPreviewKeyEvent, PREVIEW_KEY_NAMES, ComposeBackend: class {}, ComposeBackends: class {
  acquire() { return backend; }
  obtain() { obtained++; return backend; }
  idle() {}
  release() {}
  retain() {}
  retireEngine(engine: string) { if (backend.engine === engine) backend.disposed = true; }
  dispose() {}
} }));
mock.module("../../src/composeKomodo.js", () => ({
  KomodoBackend: class { static [Symbol.hasInstance](value: unknown) { return value === backend && native; } },
  KomodoSessionArbiter: class {},
}));
// The session resolves the CLI before running it, whether or not the host has one installed; `runObservedElide` is
// mocked, so any file at `bin/elide` stands in.
const elideHome = mkdtempSync(path.join(tmpdir(), "elide-compose-home-"));
process.on("exit", () => rmSync(elideHome, { recursive: true, force: true }));
mkdirSync(path.join(elideHome, "bin"));
writeFileSync(path.join(elideHome, "bin", "elide"), "");
process.env.ELIDE_HOME = elideHome;
// Load after registering mocks: exercise the real session at its VS Code and backend boundaries.
const { registerComposePreview } = await import("../../src/composePreview.js");
const target = { name: "app", kind: "apk", sourceSets: ["main"] };
const model = {
  root: "/app", name: "app", members: [], kotlin: { compose: true }, android: { targets: [target] },
  modules: [{ name: "app.main", sourceSet: "main", kind: "source", sourcePaths: ["src/main/**/*.kt"],
    runtimeModuleDeps: [], runtimeClassPath: [], compilationTargets: ["compile-kotlin-main"] }],
};
const syncing = scenario === "sync-wait" || scenario === "sync-failure";
const project: { root: string; folder: typeof folder; model?: typeof model } = { root: "/app", folder, ...(syncing ? {} : { model }) };
const sync = { running: syncing, error: undefined as string | undefined };
const workspace = { projects: [project], projectFor: () => project, projectAt: () => project, onDidChange: workspaceChanged.event,
  isSyncing: () => sync.running, lastError: () => sync.error,
  get komodoPreviewAvailable() { return nativeAvailable; },
  onDidChangeKomodoAvailability: availabilityChanged.event,
  requireKomodoPreview: async () => { if (!nativeAvailable) throw new Error(nativeReason); },
  rejectKomodoPreview: (reason: string) => { nativeReason = reason; nativeAvailable = false; availabilityChanged.fire(); },
};
const roots: TimelineNode[] = [];
/** The Activity view's Cancel of each operation. */
const cancels: (() => void)[] = [];
const logged: string[] = [];
/** The extension's workspace state. */
const workspaceState = new Map<string, unknown>();
const RENAMES_KEY = "elide.composePreview.renames";
const registration = registerComposePreview(workspace as never, { log: (line: string) => logged.push(line), activity: {
  start: (label: string, options?: { cancel?: () => void }) => {
    const root = TimelineNode.root(label);
    roots.push(root);
    if (options?.cancel) cancels.push(options.cancel);
    return root;
  },
} } as never, { globalStorageUri: { fsPath: "/cache" }, asAbsolutePath: (value: string) => value, workspaceState: {
  get: (key: string) => workspaceState.get(key),
  update: async (key: string, value: unknown) => { if (value === undefined) workspaceState.delete(key); else workspaceState.set(key, value); },
} } as never);
const paints: { verifying: boolean; contentHash: string; processing?: { stubs: number; apt: number } }[] = [];
const errors: { source: string; message: string }[] = [];
registration.api.onDidPaint((paint) => paints.push(paint));
registration.api.onDidError((error) => errors.push(error));
async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`Timed out: ${JSON.stringify({ builds, starts, previews, messages })}`);
}
/** Let the first preview build finish and its gallery paint. */
async function firstPaint(): Promise<void> {
  runtimeGate.resolve({});
  await until(() => builds === 1);
  buildGates[0]!.resolve(0);
  await until(() => paints.some((paint) => !paint.verifying));
}
const lastImages = () => messages.findLast((message) => message.type === "images")!;
try {
  if (scenario === "restore") {
    let closed = 0;
    await serializer!.deserializeWebviewPanel({ dispose: () => { closed++; } }, { source: "file:///app/src/main/Missing.kt", fitted: true });
    assert.equal(closed, 1, "a preview whose file is gone is closed, not left empty");
    assert.deepEqual(warnings, ["Elide: the Compose preview of Missing.kt was not restored: Missing.kt no longer exists."]);
    // Renamed Old.kt to Moved.kt while shown, then to Gallery.kt while hidden: the webview saved Moved.kt.
    workspaceState.set(RENAMES_KEY, { "file:///app/src/main/Old.kt": "file:///app/src/main/Moved.kt", "file:///app/src/main/Moved.kt": uri.toString() });
    await serializer!.deserializeWebviewPanel(panel, { source: "file:///app/src/main/Moved.kt", fitted: true });
    await until(() => runtimeEntered);
  } else if (!native && !["availability", "sync-wait", "sync-failure", "layoutlib-native-loss"].includes(scenario!)) {
    if (!prewarming) await commands.get("elide.androidComposePreview")!();
    await until(() => runtimeEntered);
  }
  if (scenario === "komodo-missing") {
    await commands.get("elide.androidComposePreview")!();
    assert.match(shown[0]!, /Komodo is missing/);
    assert.equal(panels, 0);
    assert.equal(runtimeEntered, false);
    assert.equal(builds, 0);
    nativeAvailable = true;
    availabilityChanged.fire();
    await commands.get("elide.androidComposePreview")!();
    await until(() => runtimeEntered);
    assert.equal(panels, 1, "sync recovery can open a native preview without reloading");
  } else if (scenario === "komodo-incompatible") {
    await commands.get("elide.androidComposePreview")!();
    await until(() => panelDisposed);
    await commands.get("elide.androidComposePreview")!();
    assert.equal(panels, 1, "protocol failure stays disabled until compatibility refresh");
    assert.equal(runtimeEntered, false);
    assert.equal(builds, 0);
    assert.equal(starts, 0);
    assert.equal(backend.disposed, true);
    assert.match(shown[0]!, /Unsupported Komodo preview protocol/);
  } else if (scenario === "komodo-loss" || scenario === "layoutlib-native-loss") {
    await commands.get("elide.androidComposePreview")!();
    await until(() => runtimeEntered);
    nativeAvailable = false;
    availabilityChanged.fire();
    runtimeGate.resolve({});
    if (native) {
      await until(() => panelDisposed);
      await sleep(20);
      assert.equal(builds, 0, "availability loss cancels a runtime await before the build starts");
      assert.equal(previews, 0);
      assert.equal(backend.disposed, true);
      assert.equal(registration.api.pointer("live", "down", 1, 1), false);
    } else {
      await until(() => builds === 1);
      assert.equal(panelDisposed, false, "layoutlib remains open on native availability loss");
      assert.equal(backend.disposed, false);
    }
  } else if (scenario === "availability") {
    assert.deepEqual(contexts.at(-1), ["setContext", "elide.composePreviewAvailable", true], "a preview source of a synced Android app offers the editor button");
    text = "package sample\nclass MainActivity";
    changed.fire({ document, contentChanges: [{}] });
    await until(() => contexts.at(-1)?.[2] === false);
    assert.deepEqual(contexts.at(-1), ["setContext", "elide.composePreviewAvailable", false], "editing the previews away hides the button");
    await commands.get("elide.androidComposePreview")!();
    assert.match(shown.at(-1) ?? "", /^Elide: Gallery\.kt declares no @Preview functions\./);
    assert.equal(builds, 0, "a source without previews never builds");
    assert.equal(panels, 0, "nor opens a panel");
  } else if (scenario === "prewarm-close") {
    registration.disposable.dispose();
    runtimeGate.resolve({});
    await sleep(0);
    assert.equal(obtained, 0, "a pending prewarm must not recreate a backend after extension disposal");
  } else if (scenario === "prewarm-failure") {
    await until(() => logged.length > 0);
    assert.match(logged[0]!, /^Compose preview prewarm for Gallery\.kt failed: renderer startup failed$/, "a failed prewarm is reported, not swallowed");
  } else if (scenario === "stale-record") {
    runtimeGate.resolve({});
    await until(() => builds === 1);
    buildGates[0]!.resolve(0);
    await until(() => messages.some((message) => message.type === "status" && message.state === "error"));
    const failure = messages.findLast((message) => message.type === "status")!;
    assert.equal((failure.action as { id: string } | undefined)?.id, "rebuildNoCache", "a stale build record offers a rebuild without the cache");
    assert.equal(invocations[0]!.options, undefined, "an ordinary preview build uses the build cache");
    received.fire({ type: "action", id: "rebuildNoCache" });
    await until(() => builds === 2);
    assert.deepEqual(invocations[1]!.options, { "no-cache": true });
    buildGates[1]!.resolve(0);
    await until(() => messages.some((message) => message.type === "images"));
  } else if (scenario === "close") {
    panel.dispose();
    runtimeGate.resolve({});
    await until(() => !roots[0]!.running);
    assert.equal(builds, 0, "closing during runtime preparation must not start an Elide build");
    assert.equal(starts, 0, "closing during runtime preparation must not start a renderer");
  } else if (scenario === "failed-build") {
    runtimeGate.resolve({});
    await until(() => builds === 1);
    buildGates[0]!.resolve(1);
    await until(() => messages.some((message) => message.type === "status" && message.state === "error"));
    changed.fire({ document, contentChanges: [{ text: "edited" }] });
    await until(() => builds === 2 || messages.some((message) => message.type === "images" && message.revision === 2));
    assert.equal(builds, 2, "a live edit after a failed build must verify resources before confirming images");
    buildGates[1]!.resolve(0);
    await until(() => messages.some((message) => message.type === "images" && message.revision === 2));
  } else if (scenario === "cold-initialization") {
    runtimeGate.resolve({});
    await until(() => builds === 1 && paints.length > 0);
    buildGates[0]!.resolve(0);
    await until(() => warming);
    assert.ok(paints.every((paint) => paint.verifying), "stored first paint stays provisional during compiler initialization");
    assert.equal(verifyGates.length, 0, "processing cannot run against the seeded dependency baseline");
    initialization.resolve();
    await until(() => paints.some((paint) => !paint.verifying));
    assert.equal(backend.compiler.needsWarmup, false, "confirmation means first-edit compilation is initialized");
    assert.equal(roots[0]!.children.find((step) => step.label === "Initialize compiler")?.state, "succeeded");
  } else if (scenario === "inspect") {
    runtimeGate.resolve({});
    await until(() => builds === 1);
    buildGates[0]!.resolve(0);
    await until(() => paints.some((paint) => !paint.verifying));
    received.fire({ type: "inspect", enabled: true });
    await until(() => inspections > 0 && messages.some((message) => message.type === "images" && message.revision === 2));
    assert.equal(builds, 1, "Inspect requires an instrumented preview, not a no-op saved-source rebuild");
    assert.equal(text, "package sample\n@Preview fun Gallery() {}", "Inspect must work without a live edit");
  } else if (processing) {
    runtimeGate.resolve({});
    await until(() => builds === 1);
    buildGates[0]!.resolve(0);
    await until(() => verifyGates.length === 1 && paints.length > 0);
    assert.equal(paints[0]!.verifying, true, "build completion alone cannot confirm a kapt gallery");
    verifyGates[0]!.resolve(false);
    await until(() => paints.some((paint) => !paint.verifying));
    const initial = paints.at(-1)!;
    assert.match(initial.contentHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(initial.processing, { stubs: 1, apt: 0 });
    const baselinePaints = paints.length;
    text += scenario === "processing-recovery" ? "\n// declaration" : "\n// body";
    changed.fire({ document, contentChanges: [{ text }] });
    await until(() => verifyGates.length === 2);
    if (scenario === "stale-paint") {
      const optimistic = messages.findLast((message) => message.type === "images")!;
      verifyGates[1]!.resolve(true);
      await until(() => messages.some((message) => message.type === "images" && message.publication !== optimistic.publication && message.revision === 2));
      const corrected = messages.findLast((message) => message.type === "images")!;
      received.fire({ type: "painted", revision: optimistic.revision, publication: optimistic.publication });
      assert.equal(paints.length, baselinePaints, "an old gallery acknowledgement must not report corrected pixels as painted");
      received.fire({ type: "painted", revision: corrected.revision, publication: corrected.publication });
      assert.equal(paints.length, baselinePaints + 1);
      assert.equal(paints.at(-1)!.verifying, false);
    } else if (scenario === "processor-failure") {
      verifyGates[1]!.reject(new Error("Room: missing_live_column"));
      await until(() => errors.length === 1);
      assert.match(errors[0]!.message, /missing_live_column/);
      assert.equal(errors[0]!.source, uri.fsPath);
      assert.equal(paints.slice(baselinePaints).some((paint) => !paint.verifying), false, "a processor error cannot confirm stale pixels");
      assert.ok(messages.some((message) => message.type === "status" && message.state === "error" && String(message.text).includes("missing_live_column")));
    } else if (scenario === "superseded-processing") {
      text += "\n// newest";
      changed.fire({ document, contentChanges: [{ text }] });
      const boundary = messages.length;
      verifyGates[1]!.resolve(true);
      await until(() => verifyGates.length === 3);
      assert.equal(messages.slice(boundary).some((message) => message.type === "images" && message.revision === 2), false,
        "obsolete processing cannot replace the newer revision's pixels");
      verifyGates[2]!.resolve(false);
      await until(() => paints.at(-1)?.verifying === false);
      assert.equal(errors.length, 0);
    } else {
      if (scenario === "processing") {
        assert.equal(paints.at(-1)!.verifying, true, "live pixels must paint while kapt is checking");
        verifyGates[1]!.resolve(false);
      } else verifyGates[1]!.resolve(true);
      await until(() => paints.length > baselinePaints && paints.at(-1)?.verifying === false);
      assert.notEqual(paints.at(-1)!.contentHash, initial.contentHash);
      assert.deepEqual(paints.at(-1)!.processing, { stubs: 2, apt: scenario === "processing-recovery" ? 1 : 0 });
      assert.equal(errors.length, 0, "an optimistic declaration failure must recover through processing");
    }
  } else if (scenario === "animation") {
    await firstPaint();
    const paintsBefore = paints.length;
    const publishedBefore = messages.filter((message) => message.type === "images").length;
    let frame = 0;
    const frames = setInterval(() => pushImages([{ id: "gallery", name: "Gallery", detail: "", data: `frame ${++frame}`, width: 1, height: 1, live: true, nodes: [galleryNode] }]), 5);
    try {
      await sleep(300);
      const published = messages.filter((message) => message.type === "images").length - publishedBefore;
      assert.ok(published <= 300 / 50 + 2, `frames every 5 ms are posted at most every 50 ms, not ${published} times in 300 ms`);
      assert.ok(paints.length > paintsBefore, "acknowledgements arriving after newer frames still report paints");
      received.fire({ type: "navigate", revision: lastImages().revision, imageId: "gallery", nodeId: "call" });
      await until(() => opened.length === 1);
      assert.equal(await registration.api.openSource("gallery", "call"), true);
      assert.deepEqual(opened, [uri.fsPath, uri.fsPath], "Open source works while frames arrive");
    } finally {
      clearInterval(frames);
    }
  } else if (scenario === "replay") {
    await firstPaint();
    await sleep(20);
    const settled = paints.length;
    const shown = lastImages();
    received.fire({ type: "painted", revision: shown.revision, publication: shown.publication });
    // A webview reload replays the gallery, and acknowledges it again.
    received.fire({ type: "ready" });
    await sleep(20);
    assert.equal(paints.length, settled, "a replayed publication is not a new paint");
    received.fire({ type: "inspect", enabled: true });
    await until(() => inspections > 0 && paints.length > settled);
    await sleep(20);
    const inspected = paints.length;
    registration.api.setInspect(false);
    await sleep(20);
    assert.equal(paints.length, inspected, "turning Inspect off re-shows the painted gallery without a new paint");
    compiled({ failed: true, messages: [{ file: uri.fsPath, line: 2, column: 1, text: "Unresolved reference: Galery", level: "error" }] });
    assert.deepEqual([...problems.keys()], [uri.fsPath]);
    // A frame pushed while the program does not compile paints, and the status keeps the compile error.
    pushImages([{ id: "gallery", name: "Gallery", detail: "", data: "frame", width: 1, height: 1 }]);
    await until(() => paints.length > inspected);
    received.fire({ type: "ready" });
    await sleep(20);
    const status = messages.findLast((message) => message.type === "status")!;
    assert.equal(status.state, "error");
    assert.equal(status.text, "Live preview does not compile: Unresolved reference: Galery");
    panel.dispose();
    assert.equal(problems.size, 0, "closing the preview clears its Problems");
  } else if (scenario === "reveal") {
    await commands.get("elide.androidComposePreview")!();
    assert.equal(panels, 1, "opening the previewed file's preview again keeps its panel");
    assert.equal(reveals, 1);
    runtimeGate.resolve({});
    await until(() => builds === 1);
    await sleep(20);
    assert.equal(builds, 1, "and does not build again");
  } else if (scenario === "rename") {
    await firstPaint();
    const screens = fileUri("/app/src/main/Screens.kt");
    renamed.fire({ files: [{ oldUri: uri, newUri: screens }] });
    await until(() => requested.at(-1) === screens.fsPath);
    assert.equal(panel.title, "Compose: Screens.kt");
    assert.ok(messages.some((message) => message.type === "source" && message.uri === screens.toString()), "a window reload restores the renamed file");
    assert.deepEqual(workspaceState.get(RENAMES_KEY), { [uri.toString()]: screens.toString() }, "so does one after a rename the hidden webview missed");
    assert.equal(builds, 1, "a renamed Kotlin file is a live edit");
    renamed.fire({ files: [{ oldUri: fileUri("/app/src/main"), newUri: fileUri("/app/src/ui") }] });
    await until(() => builds === 2 && requested.at(-1) === "/app/src/ui/Screens.kt");
    buildGates[1]!.resolve(0);
    await until(() => !roots.at(-1)!.running);
    assert.deepEqual(workspaceState.get(RENAMES_KEY), { [uri.toString()]: screens.toString(), [screens.toString()]: "file:///app/src/ui/Screens.kt" });
    received.fire({ type: "ready" });
    assert.equal(workspaceState.get(RENAMES_KEY), undefined, "a running webview saves the current source itself");
    deleted.fire({ files: [fileUri("/app/src")] });
    const status = messages.findLast((message) => message.type === "status")!;
    assert.equal(status.state, "error");
    assert.match(String(status.text), /^Screens\.kt was deleted\./);
  } else if (scenario === "session-lost") {
    await firstPaint();
    const { revision } = lastImages();
    const previewed = previews;
    sessionLost();
    await until(() => (lastImages().revision as number) > (revision as number));
    assert.ok(previews > previewed, "a lost live session is previewed again");
    assert.equal(builds, 1, "without a build");
  } else if (scenario === "sync-wait" || scenario === "sync-failure") {
    const opening = commands.get("elide.androidComposePreview")!();
    await until(() => progress.length > 0);
    assert.equal(progress[0], "Elide: waiting for the sync of app to preview Gallery.kt…");
    assert.equal(panels, 0, "the preview waits for the running sync");
    sync.running = false;
    if (scenario === "sync-wait") project.model = model;
    else sync.error = "elide.pkl: unknown field";
    workspaceChanged.fire();
    await opening;
    if (scenario === "sync-wait") {
      assert.equal(panels, 1, "and opens once it finishes");
      await until(() => runtimeEntered);
    } else {
      assert.deepEqual(shown, ["Elide: The sync of app failed: elide.pkl: unknown field"]);
      assert.equal(panels, 0);
    }
  } else if (scenario === "restore") {
    assert.equal(panels, 0, "the restored panel is reused");
    assert.equal(panel.title, "Compose: Gallery.kt");
    assert.deepEqual(webview.options, { enableScripts: true, localResourceRoots: [] });
    received.fire({ type: "ready" });
    assert.ok(messages.some((message) => message.type === "source" && message.uri === uri.toString()));
    assert.equal(workspaceState.get(RENAMES_KEY), undefined);
    await firstPaint();
  } else if (scenario === "cancel") {
    cancels[0]!();
    await until(() => !roots[0]!.running);
    assert.equal(roots[0]!.state, "cancelled");
    assert.equal(builds, 0);
    assert.match(String(messages.findLast((message) => message.type === "status")!.text), /^Preview cancelled\./);
  } else if (scenario === "rebuild") {
    runtimeGate.resolve({});
    await until(() => builds === 1);
    received.fire({ type: "refresh" });
    assert.equal(buildSignals[0]!.aborted, true, "Rebuild stops the build it supersedes");
    await until(() => builds === 2);
    buildGates[1]!.resolve(0);
    await until(() => messages.some((message) => message.type === "images" && message.revision === 2));
    assert.equal(errors.length, 0);
  } else if (scenario === "delete-during-build") {
    runtimeGate.resolve({});
    await until(() => builds === 1);
    deleted.fire({ files: [uri] });
    assert.equal(buildSignals[0]!.aborted, true, "deleting the previewed file stops its build");
    buildGates[0]!.resolve(0);
    await until(() => !roots[0]!.running);
    await sleep(20);
    assert.match(String(messages.findLast((message) => message.type === "status")!.text), /^Gallery\.kt was deleted\./,
      "the stopped build does not replace the deletion status");
  } else if (scenario === "log-replay") {
    runtimeGate.resolve({});
    await until(() => builds === 1);
    buildGates[0]!.resolve(1);
    await until(() => messages.some((message) => message.type === "status" && message.state === "error"));
    received.fire({ type: "ready" });
    await sleep(150);
    // The Build log as the webview shows it.
    const log: string[] = [];
    for (const message of messages) if (message.type === "log") {
      if (message.reset) log.length = 0;
      log.push(...message.lines as string[]);
    }
    assert.equal(log.filter((line) => line.startsWith("Build failed")).length, 1, "a webview reload replays each log line once");
  } else throw new Error(`Unknown scenario: ${scenario}`);
  console.log(`PASS ${scenario}`);
} finally {
  registration.disposable.dispose();
}
