import { expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, watch } from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitKotlinAnalysis, probeSourceRoot, type KotlinLspCommands } from "../src/kotlinAnalysis.ts";

const READINESS = ["start_debug_server", "intellij.java.resolveLaunch", "set-highwatermark-file", "wait-for-highwatermark"];
const PENDING = Symbol("pending");

function server(commands: () => readonly string[], execute: KotlinLspCommands["execute"]): KotlinLspCommands {
  return { list: async () => commands(), execute };
}

test("debugging waits for the import before the index watermark, and for a watermark written after it is set", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "elide-analysis-"));
  const watermark = path.join(directory, "server", "watermark");
  const calls: string[] = [];
  const starting = Promise.withResolvers<void>();
  const waiting = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  let initialized = false;
  let probes = 0;
  let setAt: string | undefined;
  try {
    const ready = awaitKotlinAnalysis(server(() => {
      if (!initialized) starting.resolve();
      return initialized ? READINESS : [];
    }, async (command, ...args) => {
      calls.push(command);
      if (command === "intellij.java.resolveLaunch") {
        if (++probes < 3) throw new Error("No module found for uri: 'file:///app/src/main/kotlin'");
        return {};
      }
      if (command === "set-highwatermark-file") {
        setAt = readFileSync(watermark, "utf8");
        return null;
      }
      // The mark to reach is the one on disk when the wait begins, written after the file was set.
      expect(Number(readFileSync(watermark, "utf8"))).toBe(args[0] as number);
      waiting.resolve();
      return reached.promise;
    }), { probe: "file:///app/src/main/kotlin", watermark, signal: new AbortController().signal, pollMs: 1 });
    await starting.promise;
    expect(calls).toEqual([]);
    initialized = true;
    await waiting.promise;
    expect(calls).toEqual(["intellij.java.resolveLaunch", "intellij.java.resolveLaunch", "intellij.java.resolveLaunch", "set-highwatermark-file", "wait-for-highwatermark"]);
    expect(setAt).toBe("");
    expect(await Promise.race([ready, Promise.resolve(PENDING)])).toBe(PENDING);
    reached.resolve();
    expect(await ready).toBe("ready");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a watermark the server has not seen is written again with a later mark, and cancelling ends the wait", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "elide-analysis-"));
  const watermark = path.join(directory, "watermark");
  const waiting = Promise.withResolvers<number>();
  const cancel = new AbortController();
  try {
    const ready = awaitKotlinAnalysis(server(() => READINESS, async (command, ...args) => {
      if (command !== "wait-for-highwatermark") return null;
      waiting.resolve(args[0] as number);
      return Promise.withResolvers<void>().promise;
    }), { watermark, signal: cancel.signal, rewriteMs: 1 });
    const mark = await waiting.promise;
    const watcher = watch(directory);
    try {
      await once(watcher, "change");
    } finally {
      watcher.close();
    }
    expect(Number(readFileSync(watermark, "utf8"))).toBeGreaterThan(mark);
    cancel.abort(new Error("cancelled"));
    await expect(ready).rejects.toThrow("cancelled");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("servers without readiness commands and roots they never import do not hold debugging forever", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "elide-analysis-"));
  const signal = new AbortController().signal;
  try {
    const old = awaitKotlinAnalysis(server(() => ["start_debug_server"], async () => { throw new Error("unexpected command"); }), {
      watermark: path.join(directory, "old"), signal,
    });
    expect(await old).toBe("unsupported");
    const elsewhere = awaitKotlinAnalysis(server(() => READINESS, async (command) => {
      if (command === "intellij.java.resolveLaunch") throw new Error("No file found for uri: 'file:///elsewhere'");
      return null;
    }), { probe: "file:///elsewhere", watermark: path.join(directory, "elsewhere"), signal, pollMs: 1, importTimeoutMs: 0 });
    expect(await elsewhere).toBe("unimported");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the import probe is an existing source root, the debugged project's first", () => {
  const model = (root: string) => ({
    modules: [{ contentRoots: [{ path: root, sourceRoots: [
      { path: `${root}/src/main/res`, kind: "resource" },
      { path: `${root}/src/main/java`, kind: "source" },
      { path: `${root}/src/main/kotlin`, kind: "source" },
    ] }] }],
  }) as never;
  const existing = new Set(["/lib/src/main/res", "/lib/src/main/kotlin", "/app/src/main/kotlin"]);
  expect(probeSourceRoot([model("/app"), model("/lib")], (p) => existing.has(p))).toBe("/app/src/main/kotlin");
  expect(probeSourceRoot([undefined, model("/lib")], (p) => existing.has(p))).toBe("/lib/src/main/kotlin");
  expect(probeSourceRoot([model("/gone")], (p) => existing.has(p))).toBeUndefined();
});
