import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { mock } from "bun:test";
import type { PreviewImage } from "../../src/composeRender.js";

const scenario = process.argv[2];
const remove = fs.rm;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "elide-compose-backend-test-"));
// Backend workspaces stay inside the test's directory.
mock.module("node:os", () => ({ ...os, tmpdir: () => root }));
const factoryEntered = Promise.withResolvers<void>();
const factoryGate = Promise.withResolvers<void>();
const removed = Promise.withResolvers<void>();
const events: string[] = [];
let backendDirectory: string | undefined;
mock.module("node:fs/promises", () => ({ ...fs, rm: async (file: string, options: Parameters<typeof remove>[1]) => {
  if (file === backendDirectory) {
    events.push("remove-backend");
    await remove(file, options);
    removed.resolve();
  } else await remove(file, options);
} }));
mock.module("@elide/ide-core", () => ({ composePreviewInputs: async () => ({}), composePreviewAnnotations: () => 1 }));
mock.module("../../src/composeCompiler.js", () => ({ ComposeCompiler: class {
  static async create(_bin: string, _cwd: string, _inputs: unknown, directory: string) {
    backendDirectory = directory;
    factoryEntered.resolve();
    await factoryGate.promise;
    const privateDirectory = path.join(directory, "compiler-test");
    await fs.mkdir(privateDirectory, { recursive: true });
    await fs.writeFile(path.join(privateDirectory, "classes"), "generation");
    events.push("factory-finished");
    return { dispose() {}, remove: () => remove(privateDirectory, { recursive: true, force: true }),
      sources: async () => ({}), seed: async () => false };
  }
} }));
/** A render JVM pool the backend started: the JDK and initial weight it was created with. */
class FakeRenderer {
  alive = true;
  /** The last gallery's weight, as the real renderer learns it. */
  weight = 0;
  constructor(readonly java: string, readonly initialWeight: number | undefined) {}
  abandonWarmups() {}
  dispose() { this.alive = false; }
  render(_inputs: unknown, _sourceFile: string, _packageName: string, methods?: readonly string[]): Promise<PreviewImage[]> { return renderGallery(this, methods); }
}
const renderers: FakeRenderer[] = [];
let renderGallery = async (_renderer: FakeRenderer, _methods?: readonly string[]): Promise<PreviewImage[]> => [];
// A copy of the real module: the replacement below would otherwise also replace what it spreads.
const render = { ...await import("../../src/composeRender.js") };
mock.module("../../src/composeRender.js", () => ({
  ...render,
  helperDigest: async () => "helpers",
  ComposeRenderer: { create: async (_runtime: unknown, java: string, _helpers: string, _cache: string, _directory: string, _signal: AbortSignal,
    options: { weight?: number } = {}) => {
    const renderer = new FakeRenderer(java, options.weight);
    renderers.push(renderer);
    return renderer;
  } },
}));
// Backend dependencies must be replaced before the real module captures their constructors.
const { ComposeBackend, ComposeBackends, ImageStore } = await import("../../src/composeBackend.js");
const backend = new ComposeBackend("test", root, root, new ImageStore(path.join(root, "images")));
const runtime = { rendererJar: "renderer.jar", rendererClassPath: ["renderer.jar"], layoutlibPath: "layoutlib" };
/** A compiler whose published classes are `source`'s, needing no processing. */
const publishedCompiler = (source = "saved") => ({
  ready: true, needsWarmup: false, publishedInstrumented: false, fingerprint: "build", processingRequired: false,
  publishedSources: source, inputs: {},
  sources: async (documents: ReadonlyMap<string, string>) => ({ key: documents.get("Gallery.kt") ?? "saved" }),
  update: async () => {}, publish: async () => {}, dispose() {}, remove: async () => {},
});
/** Backend state of a started renderer, for scenarios substituting the renderer itself: galleries are keyed by its identity. */
const started = () => ({ rendererIdentity: Promise.resolve("renderer"), rendererSetup: { identity: Promise.resolve("renderer") } });
const build = { bin: "elide", model: { root }, artifact: {}, models: [] };
const request = { documents: new Map<string, string>(), sourceFile: "Gallery.kt", packageName: "sample" };
try {
  if (scenario === "prewarm-failure") {
    const configure = Promise.withResolvers<boolean>();
    const failure = new Error("renderer startup diagnostic");
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    backend.startRenderer = async () => { throw failure; };
    backend.configure = () => configure.promise;
    try {
      const result = backend.prewarm(build as never, {} as never, "java", request).then(() => undefined, (error: unknown) => error);
      await sleep(20);
      configure.resolve(false);
      assert.equal(await result, failure, "renderer startup failures remain visible to the caller");
      assert.deepEqual(unhandled, [], "renderer rejection must be observed while compiler discovery is pending");
    } finally {
      configure.resolve(false);
      process.off("unhandledRejection", onUnhandled);
    }
  } else if (scenario === "dispose-setup") {
    const configured = backend.configure(build as never, request.documents, false).then(() => undefined, (error: unknown) => error);
    await factoryEntered.promise;
    backend.dispose();
    await sleep(20);
    factoryGate.resolve();
    const failure = await configured;
    await removed.promise;
    assert.ok(failure instanceof Error, "shutdown must reject an in-flight compiler setup");
    assert.deepEqual(events, ["factory-finished", "remove-backend"], "workspace removal waits for in-flight writes and candidate cleanup");
    await assert.rejects(fs.stat(backendDirectory!), { code: "ENOENT" });
    await assert.rejects(backend.configure(build as never, request.documents, false));
    await assert.rejects(backend.startRenderer({} as never, "java"));
  } else if (scenario === "concurrent-generations") {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const updated = Promise.withResolvers<void>();
    let compiled = "old";
    const compiler = {
      ready: true,
      publishedSources: "old",
      inputs: {},
      sources: async (documents: ReadonlyMap<string, string>) => ({ key: documents.get("Gallery.kt")! }),
      update: async (sources: { key: string }) => { compiled = sources.key; updated.resolve(); },
      publish: async () => { compiler.publishedSources = compiled; },
      dispose() {},
    };
    let first = true;
    const renderer = {
      alive: true,
      abandonWarmups() {},
      async render() {
        if (first) {
          first = false;
          entered.resolve();
          await release.promise;
        }
        return [{ id: "gallery", name: compiler.publishedSources, detail: "sample.Gallery" }];
      },
      dispose() {},
    };
    // Substitute process-backed dependencies, retaining the real backend queues and preview API.
    Object.assign(backend, { current: compiler, renderer });
    const oldRequest = { ...request, documents: new Map([["Gallery.kt", "old"]]) };
    const newRequest = { ...request, documents: new Map([["Gallery.kt", "new"]]) };
    const holding = backend.preview(oldRequest);
    await entered.promise;
    const newer = backend.preview(newRequest);
    await updated.promise;
    await sleep(0); // New classes are queued for publication behind the active render.
    const older = backend.preview(oldRequest);
    await sleep(0); // This request sees the old published key, but renders after publication.
    release.resolve();
    const [heldImages, newImages, oldImages] = await Promise.all([holding, newer, older]);
    assert.equal(heldImages.images[0]?.name, "old");
    assert.equal(newImages.images[0]?.name, "new", "each caller must render its requested source generation");
    assert.equal(oldImages.images[0]?.name, "old", "a queued publication must not substitute another request's sources");
  } else if (scenario === "cold-baseline" || scenario === "inspect-seeded") {
    const compiled = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let source = "saved";
    let verified: string | undefined;
    let updates = 0;
    let verifications = 0;
    let publications = 0;
    const compiler = {
      ready: true, seeded: true, publishedInstrumented: false, fingerprint: "build", processingRequired: true,
      publishedSources: "saved", inputs: {},
      get needsWarmup() { return this.seeded; },
      sources: async (documents: ReadonlyMap<string, string>) => ({ key: documents.get("Gallery.kt") ?? "saved" }),
      isVerified: (key: string) => verified === key,
      async update(sources: { key: string }, warm: boolean) {
        assert.equal(warm, true, "cold setup explicitly compiles every seeded workspace unit");
        updates++;
        source = sources.key;
        this.seeded = false;
        compiled.resolve();
        if (scenario === "inspect-seeded") await release.promise;
      },
      async verify(sources: { key: string }) {
        assert.equal(this.seeded, false, "kapt must not initialize against soon-to-be-replaced build dependencies");
        verifications++;
        verified = sources.key;
        return false;
      },
      async publish() {
        publications++;
        this.publishedSources = source;
        this.publishedInstrumented = !this.seeded;
      },
      dispose() {},
    };
    const stored = new Map<string, unknown>();
    const renderer = {
      alive: true,
      abandonWarmups() {},
      async render() {
        return [{ id: "gallery", name: "saved", detail: "sample.Gallery",
          nodes: compiler.publishedInstrumented ? [{ id: "library", name: "JourneyCard", x: 0, y: 0, width: 10, height: 10 }] : [] }];
      },
      dispose() {},
    };
    Object.assign(backend, {
      current: compiler, renderer, ...started(), publishedVerified: true,
      store: { get: async (key: string) => stored.get(key), set: async (key: string, value: unknown) => { stored.set(key, value); } },
    });
    const buildGallery = await backend.preview(request);
    assert.equal(buildGallery.images[0]?.nodes?.length, 0);
    assert.equal(stored.size, 1, "seeded build pixels can be retained for fast first paint");
    assert.equal(await backend.preview({ ...request, inspect: true }, false), undefined, "early Inspect cannot render build classes");
    const warming = backend.warm(request);
    await compiled.promise;
    if (scenario === "inspect-seeded") {
      assert.equal((await backend.preview(request)).reused, true, "in-flight compiler flags cannot relabel the published build gallery");
      const inspecting = backend.preview({ ...request, inspect: true });
      release.resolve();
      const inspected = await inspecting;
      assert.equal(inspected.images[0]?.nodes?.[0]?.name, "JourneyCard", "saved Inspect renders the instrumented library without an edit");
    }
    await warming;
    await backend.warm(request);
    const inspected = await backend.preview({ ...request, inspect: true });
    assert.equal(inspected.images[0]?.nodes?.length, 1);
    assert.equal(inspected.verified, true);
    assert.equal((await backend.preview({ ...request, inspect: true })).reused, true);
    assert.deepEqual({ updates, verifications, publications }, { updates: 1, verifications: 1, publications: 1 },
      "cold setup and Inspect share a single instrumented, processed baseline");
    assert.equal(stored.size, 2, "build and instrumented metadata occupy distinct stored galleries");
    compiler.seeded = true;
    compiler.publishedInstrumented = false;
    const restored = await backend.preview(request);
    assert.equal(restored.reused, true);
    assert.equal(restored.images[0]?.nodes?.length, 1, "a cold backend replays the confirmed instrumented gallery before initialization");
  } else if (scenario === "renderer-generation") {
    const rendering = Promise.withResolvers<void>();
    const verifying = Promise.withResolvers<void>();
    const releaseRender = Promise.withResolvers<void>();
    const releaseVerify = Promise.withResolvers<void>();
    let verified = false;
    let renders = 0;
    const compiler = {
      ready: true, seeded: false, publishedInstrumented: true, fingerprint: "build", processingRequired: true,
      publishedSources: "saved", inputs: { generation: "provisional" },
      get needsWarmup() { return this.seeded; },
      sources: async () => ({ key: "saved" }),
      isVerified: () => verified,
      async update() { this.seeded = false; },
      async verify() {
        verifying.resolve();
        await releaseVerify.promise;
        verified = true;
        return false;
      },
      async publish() { this.publishedInstrumented = !this.seeded; },
      dispose() {},
    };
    const renderer = {
      alive: true,
      abandonWarmups() {},
      async render(inputs: { generation: string }) {
        renders++;
        if (inputs.generation === "confirmed") {
          assert.equal(next.publishedInstrumented, true, "never prime the candidate's uninstrumented seed");
          rendering.resolve();
          await releaseRender.promise;
        }
        return [{ id: "gallery", name: "saved", detail: "sample.Gallery" }];
      },
      dispose() {},
    };
    Object.assign(backend, { current: compiler, renderer, ...started(), publishedVerified: true });
    await backend.preview(request);
    const next = { ...compiler, seeded: true, publishedInstrumented: false, inputs: { generation: "confirmed" },
      get needsWarmup() { return this.seeded; } };
    Object.assign(backend, { current: next });
    assert.equal((await backend.preview(request)).reused, true, "equivalent pixels can satisfy the new compiler's initial paint");
    await sleep(0);
    assert.equal(renders, 1, "cached first paint must not prime a seeded classpath that initialization discards");
    let finished = false;
    const warming = backend.warm(request).then(() => { finished = true; });
    await Promise.all([rendering.promise, verifying.promise]);
    assert.equal(finished, false, "readiness waits for the actual instrumented compiler's renderer");
    releaseVerify.resolve();
    releaseRender.resolve();
    await warming;
    assert.equal(renders, 2, "new private classpaths initialize once even when old JVMs rendered another compiler");
    assert.equal((await backend.preview(request)).reused, true);
    await backend.warm(request);
    assert.equal(renders, 2, "warm cache hits must not repeat renderer initialization");
  } else if (scenario === "processing-verification" || scenario === "processing-publication") {
    let compiled = "initial";
    let generated = "old";
    let publishedGenerated = "old";
    let verified: string | undefined;
    let updates = 0;
    let verifications = 0;
    let publications = 0;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const verifiedEntered = Promise.withResolvers<void>();
    const stored = new Map<string, unknown>();
    const compiler = {
      ready: true, seeded: false, fingerprint: "build", processingRequired: true,
      publishedSources: "initial", inputs: {},
      sources: async (documents: ReadonlyMap<string, string>) => ({ key: documents.get("Gallery.kt")! }),
      isVerified: (key: string) => verified === key,
      async update(sources: { key: string }) {
        updates++;
        if (sources.key === "declaration" && generated === "old") throw new Error("outdated generated declaration");
        compiled = sources.key;
      },
      async verify(sources: { key: string }) {
        verifications++;
        if (sources.key === "invalid") throw new Error("Room: invalid query");
        const changed = (sources.key === "declaration" || scenario === "processing-publication") && generated === "old";
        if (changed) generated = "new";
        await this.update(sources);
        verified = sources.key;
        verifiedEntered.resolve();
        return changed || compiler.publishedSources !== sources.key;
      },
      async publish() {
        publications++;
        compiler.publishedSources = compiled;
        publishedGenerated = generated;
      },
      dispose() {},
    };
    const renderer = {
      alive: true,
      abandonWarmups() {},
      async render() {
        const generation = publishedGenerated;
        if (scenario === "processing-publication") {
          entered.resolve();
          await release.promise;
        }
        return [{ id: "gallery", name: `${compiler.publishedSources}:${generation}`, detail: "sample.Gallery" }];
      },
      dispose() {},
    };
    Object.assign(backend, {
      current: compiler, renderer, ...started(),
      store: { get: async (key: string) => stored.get(key), set: async (key: string, value: unknown) => { stored.set(key, value); } },
    });
    const forSource = (source: string) => ({ ...request, documents: new Map([["Gallery.kt", source]]) });
    if (scenario === "processing-publication") {
      const optimistic = backend.preview(forSource("initial"));
      await entered.promise;
      const verification = backend.verify(forSource("initial"));
      await verifiedEntered.promise;
      release.resolve();
      assert.equal((await optimistic).verified, false, "a completed processor pass does not verify still-published old classes");
      assert.equal(await verification, true);
      assert.equal(stored.size, 0, "the render completed before publication must never persist");
      const corrected = await backend.preview(forSource("initial"));
      assert.equal(corrected.images[0]?.name, "initial:new");
      assert.equal(corrected.verified, true);
    } else {
      const initial = await backend.preview(forSource("initial"));
      assert.equal(initial.verified, false);
      assert.equal(stored.size, 0, "optimistic images remain private");
      assert.equal(await backend.verify(forSource("initial")), false);
      assert.equal(stored.size, 1, "same-stub confirmation persists the already rendered gallery");
      const initialCounts = { updates, verifications, publications };
      assert.equal((await backend.preview(forSource("initial"))).reused, true);
      assert.equal(await backend.verify(forSource("initial")), true, "verification selects confirmed pixels without regenerating classes");
      assert.deepEqual({ updates, verifications, publications }, initialCounts, "confirmed galleries skip both compile and processing");

      await assert.rejects(backend.preview(forSource("declaration")), /outdated generated declaration/);
      assert.equal(await backend.verify(forSource("declaration")), true, "processing recovers a failed optimistic compile");
      const declaration = await backend.preview(forSource("declaration"));
      assert.equal(declaration.images[0]?.name, "declaration:new");
      assert.equal(declaration.verified, true);

      const invalid = await backend.preview(forSource("invalid"));
      assert.equal(invalid.verified, false);
      const confirmedCount = stored.size;
      await assert.rejects(backend.verify(forSource("invalid")), /Room: invalid query/);
      assert.equal(stored.size, confirmedCount, "processor failures cannot persist an optimistic gallery");
      const beforeRevert = { updates, verifications, publications };
      const reverted = await backend.preview(forSource("initial"));
      assert.equal(reverted.reused, true);
      assert.equal(reverted.verified, true);
      assert.equal(reverted.images[0]?.name, "initial:old");
      assert.equal(await backend.verify(forSource("initial")), true);
      assert.deepEqual({ updates, verifications, publications }, beforeRevert, "reverting must not alter the compiler or run kapt");

      backend.configure = async () => false;
      backend.startRenderer = async () => {};
      await assert.rejects(backend.prewarm(build as never, {} as never, "java", forSource("invalid")), /Room: invalid query/,
        "prewarm must not silently bless or persist failing processor output");
      assert.equal(stored.size, confirmedCount);
    }
  } else if (scenario === "renderer-weight") {
    renderGallery = async (renderer) => {
      renderer.weight = 12;
      return [{ id: "gallery", name: "Gallery", detail: "sample.Gallery" }];
    };
    await backend.startRenderer(runtime, "java", 1);
    Object.assign(backend, { current: publishedCompiler() });
    await backend.preview(request);
    renderers[0]!.alive = false;
    await backend.startRenderer(runtime, "java", 1);
    assert.deepEqual(renderers.map((renderer) => renderer.initialWeight), [1, 12],
      "a renderer replacing a failed one starts as many JVMs as the last gallery needed, not one per annotation");
  } else if (scenario === "sweep") {
    const day = 24 * 60 * 60 * 1000;
    const workspace = async (name: string, age = 0) => {
      const directory = path.join(root, name);
      await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, "classes"), "");
      const time = (Date.now() - age) / 1000;
      for (const file of [path.join(directory, "classes"), directory]) await fs.utimes(file, time, time);
      return directory;
    };
    const exists = (directory: string) => fs.stat(directory).then(() => true, () => false);
    const exited = spawnSync(process.execPath, ["--version"]).pid;
    const dead = await workspace(`elide-compose-${exited}-AbC123`);
    const unowned = await workspace("elide-compose-GhI789", 2 * day);
    const kept = [
      // Another window's workspace.
      await workspace(`elide-compose-${process.ppid}-DeF456`, 2 * day),
      // An older version's workspace still in use.
      await workspace("elide-compose-JkL012"),
      await workspace("elide-compose-render-test-MnO345", 2 * day),
    ];
    await backend.startRenderer(runtime, "java");
    for (const deadline = Date.now() + 5_000; await exists(dead) || await exists(unowned);) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the exited host's workspaces to be removed");
      await sleep(10);
    }
    for (const directory of kept) assert.equal(await exists(directory), true, `${path.basename(directory)} must be kept`);
    const own = (await fs.readdir(root)).filter((name) => name.startsWith(`elide-compose-${process.pid}-`));
    assert.equal(own.length, 1, "the backend's own workspace names its host");
  } else if (scenario === "error-gallery") {
    let renders = 0;
    let timingOut = true;
    renderGallery = async () => {
      renders++;
      return [timingOut
        ? { id: "gallery", name: "Gallery", detail: "sample.Gallery", error: "java.util.concurrent.TimeoutException" }
        : { id: "gallery", name: "Gallery", detail: "sample.Gallery", data: "pixels", width: 1, height: 1 }];
    };
    const store = new ImageStore(path.join(root, "images"));
    const backends: InstanceType<typeof ComposeBackend>[] = [];
    const fresh = async () => {
      const next = new ComposeBackend("test", root, root, store);
      backends.push(next);
      await next.startRenderer(runtime, "java");
      Object.assign(next, { current: publishedCompiler() });
      return next;
    };
    try {
      const first = await fresh();
      assert.match((await first.preview(request)).images[0]?.error ?? "", /TimeoutException/);
      assert.equal((await first.preview(request)).reused, false, "the same backend renders a failed gallery again");
      timingOut = false;
      const retried = await (await fresh()).preview(request);
      assert.deepEqual({ renders, reused: retried.reused, error: retried.images[0]?.error }, { renders: 3, reused: false, error: undefined },
        "a fresh backend renders the gallery again instead of replaying the failed card");
      // The store writes in the background.
      for (const deadline = Date.now() + 5_000; !(await fs.readdir(path.join(root, "images")).catch(() => [])).some((file) => file.endsWith(".json"));) {
        if (Date.now() > deadline) throw new Error("timed out waiting for the gallery to be stored");
        await sleep(5);
      }
      assert.equal((await (await fresh()).preview(request)).reused, true, "a gallery without failed cards is replayed");

      await fs.writeFile(path.join(root, "images", "legacy.json"),
        JSON.stringify([{ id: "gallery", name: "Gallery", detail: "sample.Gallery", error: "TimeoutException" }]));
      assert.equal(await store.get("legacy"), undefined, "galleries with failed cards stored by earlier versions are not replayed");
    } finally {
      for (const created of backends) created.dispose();
    }
  } else if (scenario === "renderer-identity") {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    renderGallery = async (renderer) => {
      if (renderer.java === "jdk-a") {
        entered.resolve();
        await release.promise;
      }
      return [{ id: "gallery", name: renderer.java, detail: "sample.Gallery", data: "pixels", width: 1, height: 1 }];
    };
    const stored = new Map<string, PreviewImage[]>();
    Object.assign(backend, {
      store: { get: async (key: string) => stored.get(key), set: async (key: string, images: PreviewImage[]) => { stored.set(key, images); } },
    });
    await backend.startRenderer(runtime, "jdk-a");
    Object.assign(backend, { current: publishedCompiler() });
    const rendering = backend.preview(request);
    await entered.promise;
    const switching = backend.startRenderer(runtime, "jdk-b");
    release.resolve();
    assert.equal((await rendering).images[0]?.name, "jdk-a");
    await switching;
    const switched = await backend.preview(request);
    assert.deepEqual({ reused: switched.reused, name: switched.images[0]?.name }, { reused: false, name: "jdk-b" },
      "a gallery the old JDK rendered while the new one was starting is never replayed as the new JDK's");
    assert.deepEqual([...stored.values()].map((images) => images[0]?.name).sort(), ["jdk-a", "jdk-b"]);
  } else if (scenario === "prewarm-yields") {
    const warming = Promise.withResolvers<void>();
    const warmed = Promise.withResolvers<void>();
    const calls: string[] = [];
    Object.assign(backend, {
      startRenderer: async () => {}, configure: async () => true,
      preview: async () => { calls.push("preview"); return { images: [], verified: true, reused: false }; },
      warm: async () => {
        calls.push("warm");
        warming.resolve();
        await warmed.promise;
      },
      verify: async () => { calls.push("verify"); return true; },
      prime: async () => { calls.push("prime"); },
    });
    const backends = new ComposeBackends(root, root, () => 60_000, () => backend);
    const prewarming = backend.prewarm(build as never, runtime, "java", request);
    await warming.promise;
    assert.equal(backends.acquire("test"), backend);
    warmed.resolve();
    await prewarming;
    assert.deepEqual(calls, ["preview", "warm"], "the opened panel compiles and renders its own editor text");
    backends.dispose();
  } else if (scenario === "keep-alive") {
    let minutes = 1;
    const backends = new ComposeBackends(root, root, () => minutes * 60_000, () => backend);
    backends.idle(backends.obtain("test"));
    // A user's "never": longer than a timer can wait.
    minutes = 99_999;
    backends.rearm();
    await sleep(30);
    assert.equal(backend.disposed, false, "a keep-alive beyond the timer limit keeps the backend");
    backends.dispose();
    assert.equal(backend.disposed, true);
  } else if (scenario === "selection") {
    const calls: (readonly string[] | undefined)[] = [];
    renderGallery = async (_renderer, methods) => {
      calls.push(methods);
      return [{ id: methods ? `${methods.join("+")}:0` : "all:0", name: "Gallery", detail: "sample.Gallery", data: "pixels", width: 1, height: 1 }];
    };
    await backend.startRenderer(runtime, "java");
    let compiled = "text";
    const compiler = { ...publishedCompiler("text"), update: async (sources: { key: string }) => { compiled = sources.key; },
      publish: async () => { compiler.publishedSources = compiled; } };
    Object.assign(backend, { current: compiler });
    const preview = (methodFQN: string) => ({ methodFQN, previewId: methodFQN, name: methodFQN, previewParams: {}, methodParams: [] });
    const full = { ...request, documents: new Map([["Gallery.kt", "text"]]) };
    const wrapped = { ...full, selection: { appendices: new Map([["Gallery.kt", "\nwrapper"]]), previews: [preview("sample.B"), preview("sample.A")], files: [] } };
    const plain = { ...full, selection: { appendices: new Map<string, string>(), previews: [preview("sample.A")], files: [] } };
    assert.equal((await backend.preview(full)).images[0]?.id, "all:0");
    const selected = await backend.preview(wrapped);
    assert.equal(compiler.publishedSources, "text\nwrapper", "the appendix is compiled after the file's editor text");
    assert.deepEqual(selected.images.map((image) => image.id), ["sample.A+sample.B:0"]);
    assert.equal((await backend.preview(plain)).reused, false, "a selection never replays the full file's gallery of the same sources");
    assert.equal(compiler.publishedSources, "text");
    assert.deepEqual(calls, [undefined, ["sample.A", "sample.B"], ["sample.A"]], "the renderer receives the selected methods, sorted");
    const replayed = [await backend.preview(full), await backend.preview(plain)];
    assert.deepEqual(replayed.map((gallery) => [gallery.reused, gallery.images[0]?.id]), [[true, "all:0"], [true, "sample.A:0"]],
      "each request replays its own gallery");
    assert.equal(calls.length, 3);
  } else throw new Error(`Unknown scenario: ${scenario}`);
} finally {
  factoryGate.resolve();
  backend.dispose();
  await remove(root, { recursive: true, force: true });
  if (backendDirectory) await remove(backendDirectory, { recursive: true, force: true });
}
