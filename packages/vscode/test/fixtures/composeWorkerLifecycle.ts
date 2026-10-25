import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mock } from "bun:test";

const scenario = process.argv[2];
const fakeChild = () => Object.assign(new EventEmitter(), {
  stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
});
let child = fakeChild();
mock.module("node:child_process", () => ({ ...childProcess, spawn: () => child }));
// Install the child-process replacement before loading the real persistent-worker transport.
const { ComposeWorker } = await import("../../src/composeWorker.js");

if (scenario === "exit") {
  const worker = new ComposeWorker("elide", "kotlinc", ".", new AbortController().signal);
  const answering = child;
  child = fakeChild();
  const unanswered = new ComposeWorker("elide", "kotlinc", ".", new AbortController().signal);
  try {
    const response = worker.request([]);
    // ChildProcess permits exit before its stdio streams finish delivering buffered data.
    answering.emit("exit", 1, null);
    answering.stderr.write("late compiler diagnostic\n");
    answering.stdout.write(Buffer.from([2, 24, 1]));
    answering.emit("close", 1, null);
    assert.deepEqual(await response, { exitCode: 0, output: "", requestId: 1, wasCancelled: false });
    assert.equal(worker.alive, false);
    const crash = await worker.request([]).then(() => undefined, (error: unknown) => error);
    assert.ok(crash instanceof Error);
    assert.match(crash.message, /late compiler diagnostic/);
    assert.doesNotMatch(crash.message, /persistent workers/, "a worker that answered before supports the protocol: blame the crash, not Elide's version");

    const never = unanswered.request([]);
    child.emit("close", 2, null);
    await assert.rejects(never, /must support persistent workers/, "a worker that never answers may not speak the protocol");
  } finally {
    worker.dispose();
    unanswered.dispose();
  }
} else if (scenario === "timeout") {
  // The worker's deadline is its only timer: record it and expire it on demand.
  let deadline: { delay: number; expire: () => void } | undefined;
  globalThis.setTimeout = ((expire: () => void, delay: number) => {
    deadline = { delay, expire };
    return { unref() {} };
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
  const signal = new AbortController().signal;
  /** One attempt on a fresh worker, as the compiler makes after a timeout: the deadline it got and how it ended. */
  const attempt = async (cwd: string, tool: "kotlinc" | "javac" = "kotlinc", answer = false) => {
    child = fakeChild();
    const worker = new ComposeWorker("elide", tool, cwd, signal);
    try {
      const response = worker.request([]);
      const { delay, expire } = deadline!;
      if (answer) child.stdout.write(Buffer.from([2, 24, 1]));
      else expire();
      return { delay, error: await response.then(() => undefined, (error: unknown) => (error as Error).message) };
    } finally {
      worker.dispose();
    }
  };
  const first = await attempt("/large");
  assert.equal(first.delay, 120_000);
  assert.match(first.error!, /kotlinc worker timed out after 120 s; the next attempt allows 240 s\./);
  // A cold compile slower than the deadline is not repeated under the same deadline until the user gives up.
  assert.deepEqual([(await attempt("/large")).delay, (await attempt("/large")).delay], [240_000, 480_000]);
  const capped = await attempt("/large");
  assert.equal(capped.delay, 960_000);
  assert.match(capped.error!, /timed out after 960 s\.\n/, "a hung worker still fails, without promising a longer retry");
  assert.equal((await attempt("/large")).delay, 960_000);
  // Only the worker that timed out waits longer: other directories and tools keep the default.
  assert.equal((await attempt("/small")).delay, 120_000);
  assert.equal((await attempt("/large", "javac")).delay, 120_000);
  const answered = await attempt("/fast", "kotlinc", true);
  assert.deepEqual(answered, { delay: 120_000, error: undefined });
  assert.equal((await attempt("/fast")).delay, 120_000, "an answered request raises nothing");
} else throw new Error(`Unknown scenario ${scenario}`);
