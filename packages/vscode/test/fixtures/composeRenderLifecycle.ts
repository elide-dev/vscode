import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { mock } from "bun:test";
import type { ComposeRenderer as Renderer } from "../../src/composeRender.js";

const scenario = process.argv[2];
const remove = fs.rm;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "elide-compose-render-test-"));
const cleanupGate = Promise.withResolvers<void>();
const cleanupFinished = Promise.withResolvers<void>();
let delayedCleanup = false;
let failRender = scenario === "failure";
let requests = 0;
/** Previews the fake renderers discover; each shard answers for the ones the request assigns it. */
let previews = 0;
/** Answers the held warm-up of the warmup-failure scenario. */
let release: (() => void) | undefined;
/** progress: each fake shard reports every image this many ms apart before answering; undefined answers at once. */
let pace: number | undefined;
/** progress: the fake shard goes quiet instead of answering. */
let hang = false;
const received: { child: number; shardIndex: number; shardCount: number; affinity: Record<string, number>; methods: string[] | null }[] = [];
const children: Array<EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: Writable; kill: () => boolean; killed: boolean }> = [];
mock.module("node:os", () => ({ ...os, availableParallelism: () => 4 }));
mock.module("node:fs/promises", () => ({ ...fs, rm: async (file: string, options: Parameters<typeof remove>[1]) => {
  const delay = failRender && String(file).endsWith(path.join("worker-1", "images-1"));
  if (delay) { delayedCleanup = true; await cleanupGate.promise; }
  await remove(file, options);
  if (delay) cleanupFinished.resolve();
} }));
mock.module("node:child_process", () => ({ ...childProcess, spawn: () => {
  const index = children.length;
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: undefined as unknown as Writable,
    killed: false,
    kill() {
      if (!child.killed) {
        child.killed = true;
        queueMicrotask(() => child.emit("close", null, "SIGKILL"));
      }
      return true;
    },
  });
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    const request = JSON.parse(String(chunk));
    callback();
    received.push({ child: index, shardIndex: request.shardIndex, shardCount: request.shardCount, affinity: request.affinity, methods: request.methods });
    // warmup-failure: the second JVM's whole-gallery warm-up fails; the third's first one waits for `release`.
    const warmup = scenario === "warmup-failure" && index > 0 && request.shardCount === 1;
    // As RenderServer does: a request's methods filter the discovered previews before sharding.
    const discovered = Array.from({ length: previews }, (_, preview) => ({
      methodFQN: `sample.Preview${preview}`, previewId: `p${preview}`, name: `Preview${preview}`, previewParams: {}, methodParams: [],
    })).filter((preview) => !request.methods || request.methods.includes(preview.methodFQN));
    const results = discovered.filter((_, preview) => preview % request.shardCount === request.shardIndex)
      .map((preview) => ({ id: `${preview.previewId}:0`, previewId: preview.previewId, error: "not rendered by the fake" }));
    const respond = () => child.stdout.write(`${JSON.stringify({ id: request.id, previews: discovered, screenshotResults: results })}\n`);
    if (warmup && index === 1) {
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, globalError: "warm-up failure" })}\n`));
    } else if (warmup && index === 2 && !release) {
      // Held: the warm-up is still reading the gallery's classes.
      release = respond;
    } else if (hang) {
      // A hung JVM: neither progress nor an answer.
    } else if (pace !== undefined) {
      const delay = pace;
      void (async () => {
        for (let image = 0; image < results.length; image++) {
          await sleep(delay);
          child.stdout.write(`${JSON.stringify({ id: request.id, progress: true })}\n`);
        }
        await sleep(delay);
        respond();
      })();
    } else if (!failRender) {
      queueMicrotask(respond);
    } else if (++requests === 2) {
      queueMicrotask(() => {
        children[1]!.stderr.write("layoutlib original stderr\n");
        children[1]!.stdout.write(`${JSON.stringify({ id: request.id, globalError: "original preview rendering failure" })}\n`);
      });
    }
  } });
  children.push(child);
  queueMicrotask(() => child.stdout.write('{"ready":true}\n'));
  return child;
} }));
// Worker and filesystem modules must be replaced before loading the real renderer.
const { ComposeRenderer, helperDigest } = await import("../../src/composeRender.js");
const runtime = { rendererJar: "renderer.jar", rendererClassPath: ["renderer.jar"], layoutlibPath: "layoutlib" };
const helperDirectory = path.join(root, "helpers");
let renderer: Renderer | undefined;
/** The renderer's private JVM list: their protocol streams settle asynchronously, so the steps below wait on state, not time. */
interface Pool { workers: { started: boolean; joined: boolean; warming: boolean }[] }
const pool = () => {
  // Test-only view of private state the public API deliberately hides.
  const internals = renderer as unknown as Pool;
  return internals.workers;
};
async function until(what: string, condition: () => boolean): Promise<void> {
  for (const deadline = Date.now() + 5_000; !condition();) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(2);
  }
}
try {
  await fs.mkdir(helperDirectory);
  for (const name of ["CompileRenderer.java", "DiscoverPreviews.java", "RenderServer.java"]) await fs.writeFile(path.join(helperDirectory, name), "helper");
  const classes = path.join(root, "compose-helpers", (await helperDigest(runtime, helperDirectory)).slice(0, 24));
  await fs.mkdir(classes, { recursive: true });
  await fs.writeFile(path.join(classes, "RenderServer.class"), "compiled helper");
  await fs.writeFile(path.join(classes, "ready"), "");
  const directory = path.join(root, "workspace");
  const inputs = { classPath: [], projectClassPath: [], sourceSelections: {}, namespace: "sample", resourceApkPath: "resources.apk" };
  if (scenario === "failure") {
    renderer = await ComposeRenderer.create(runtime, "java", helperDirectory, root, directory, new AbortController().signal, { weight: 8 });
    assert.equal(children.length, 2, "a large expected gallery starts several JVMs up front");
    const failure = await renderer.render(inputs, "Gallery.kt", "sample").then(() => undefined, (error: unknown) => error);
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /original preview rendering failure/);
    assert.match(failure.message, /layoutlib original stderr/);
    assert.equal(renderer.alive, false);
    assert.ok(children.every((child) => child.killed), "a failed gallery stops all shards");
    cleanupGate.resolve();
    await cleanupFinished.promise;
    failRender = false;
    renderer = await ComposeRenderer.create(runtime, "java", helperDirectory, root, directory, new AbortController().signal);
    assert.deepEqual(await renderer.render(inputs, "Gallery.kt", "sample"), [], "a replacement renderer can render after the failure");
  } else if (scenario === "warmup-failure") {
    renderer = await ComposeRenderer.create(runtime, "java", helperDirectory, root, directory, new AbortController().signal, { quietMs: 40 });
    previews = 8;
    await renderer.render(inputs, "Gallery.kt", "sample");
    await until("the new JVM to start", () => pool().every((worker) => worker.started));
    assert.equal((await renderer.render(inputs, "Gallery.kt", "sample")).length, 8);
    await until("the failed warm-up to leave the pool", () => renderer!.size === 1);
    assert.equal(renderer.alive, true, "a failed warm-up never fails the renderer");
    assert.deepEqual(children.map((child) => child.killed), [false, true], "only the warming JVM stops");
    assert.equal(renderer.size, 1, "and it leaves the pool");
    assert.equal((await renderer.render(inputs, "Gallery.kt", "sample")).length, 8, "joined JVMs keep painting");
    assert.equal(renderer.size, 2, "the next render starts a replacement");
    await until("the replacement to start", () => pool().every((worker) => worker.started));
    await renderer.render(inputs, "Gallery.kt", "sample");
    await until("its warm-up request to arrive", () => release !== undefined);
    renderer.abandonWarmups();
    assert.equal(children[2]!.killed, false, "publication never kills a warm-up: restarting JVMs while typing burns CPU");
    release!();
    await until("the abandoned warm-up to finish", () => !pool().some((worker) => worker.warming));
    assert.equal(pool().every((worker) => worker.joined), false, "a warm-up of abandoned classes does not join");
    received.length = 0;
    await renderer.render(inputs, "Gallery.kt", "sample");
    assert.equal(pool().some((worker) => worker.warming), false, "no warm-up starts while publications continue");
    await sleep(50);
    await renderer.render(inputs, "Gallery.kt", "sample");
    await until("the warm-up after the pause to join", () => pool().every((worker) => worker.joined));
    assert.deepEqual(received.map(({ child, shardCount }) => [child, shardCount]), [[0, 1], [0, 1], [2, 1]], "it warms up once publications pause");
    assert.equal(children[0]!.killed, false);
    assert.equal(children.length, 3, "no replacement JVM was started");
    assert.equal(renderer.size, 2);
    assert.equal(renderer.alive, true);
    assert.equal((await renderer.render(inputs, "Gallery.kt", "sample")).length, 8);
  } else if (scenario === "progress") {
    renderer = await ComposeRenderer.create(runtime, "java", helperDirectory, root, directory, new AbortController().signal, { stallMs: 100 });
    previews = 4;
    pace = 40;
    const started = performance.now();
    assert.equal((await renderer.render(inputs, "Gallery.kt", "sample")).length, 4, "a shard reporting each image may outlast the stall limit");
    assert.ok(performance.now() - started > 150, "the fake shard took longer than the stall limit");
    assert.equal(renderer.alive, true);
    hang = true;
    await assert.rejects(renderer.render(inputs, "Gallery.kt", "sample"), /timed out/, "a JVM that goes quiet still counts as hung");
    assert.equal(renderer.alive, false);
  } else if (scenario === "methods") {
    renderer = await ComposeRenderer.create(runtime, "java", helperDirectory, root, directory, new AbortController().signal, { surplusIdleMs: 20 });
    previews = 8;
    assert.equal((await renderer.render(inputs, "Gallery.kt", "sample")).length, 8);
    assert.equal(received[0]!.methods, null, "a full-file render names no methods");
    await until("the new JVM to start", () => pool().every((worker) => worker.started));
    await renderer.render(inputs, "Gallery.kt", "sample");
    await until("the warm-up to join", () => pool().every((worker) => worker.joined));
    const weight = renderer.weight;
    received.length = 0;
    const selected = await renderer.render(inputs, "Gallery.kt", "sample", ["sample.Preview3"]);
    assert.deepEqual(selected.map((image) => image.id), ["p3:0"], "only the selected preview renders");
    assert.ok(received.length > 0 && received.every((request) => JSON.stringify(request.methods) === JSON.stringify(["sample.Preview3"])),
      "every shard request carries the selection");
    assert.equal(renderer.weight, weight, "a selection's render keeps the file gallery's weights");
    await sleep(60);
    assert.equal(renderer.size, 2, "and the pool the file's gallery needs");
  } else {
    renderer = await ComposeRenderer.create(runtime, "java", helperDirectory, root, directory, new AbortController().signal, { surplusIdleMs: 20 });
    assert.equal(children.length, 1, "a small expected gallery starts one JVM");
    previews = 8;
    assert.equal((await renderer.render(inputs, "Gallery.kt", "sample")).length, 8, "the running JVM renders the whole gallery");
    assert.deepEqual(received.map(({ child, shardCount }) => [child, shardCount]), [[0, 1]]);
    assert.equal(renderer.size, 2, "a larger gallery starts another JVM, capped at half the cores");
    await until("the new JVM to start", () => pool().every((worker) => worker.started));
    received.length = 0;
    assert.equal((await renderer.render(inputs, "Gallery.kt", "sample")).length, 8);
    await until("the warm-up to join", () => pool().every((worker) => worker.joined));
    assert.deepEqual(received.map(({ child, shardIndex, shardCount }) => [child, shardIndex, shardCount]), [[0, 0, 1], [1, 0, 1]],
      "a started JVM first renders the whole gallery alone, in the background");
    received.length = 0;
    assert.equal((await renderer.render(inputs, "Gallery.kt", "sample")).length, 8);
    // Shards write their requests after creating their output folders, in either order.
    assert.deepEqual(received.map(({ child, shardIndex, shardCount }) => [child, shardIndex, shardCount]).sort(), [[0, 0, 2], [1, 1, 2]], "then it takes shards");
    assert.deepEqual(received[0]!.affinity, received[1]!.affinity, "every shard computes the same assignment");
    assert.deepEqual(received[0]!.affinity, Object.fromEntries(Array.from({ length: 8 }, (_, preview) => [`p${preview}`, 0])));
    previews = 2;
    await renderer.render(inputs, "Gallery.kt", "sample");
    assert.equal(renderer.size, 2, "surplus JVMs stay until they idle");
    await until("the idle surplus JVM to stop", () => renderer!.size === 1);
    assert.equal(renderer.size, 1, "an idle surplus JVM stops");
    assert.equal(children[1]!.killed, true);
    assert.equal(renderer.alive, true, "stopping surplus never fails the renderer");
    received.length = 0;
    assert.equal((await renderer.render(inputs, "Gallery.kt", "sample")).length, 2);
    assert.deepEqual(received.map(({ child, shardCount }) => [child, shardCount]), [[0, 1]]);
  }
} finally {
  cleanupGate.resolve();
  if (delayedCleanup) await cleanupFinished.promise;
  renderer?.dispose();
  await remove(root, { recursive: true, force: true });
}
