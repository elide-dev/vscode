import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sweepAbandonedInstalls } from "../src/composeRuntime.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Compose runtime cache", () => {
  test("removes staging directories of installs abandoned by an exited host, never one in progress or the runtime", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "compose-runtime-"));
    roots.push(root);
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const staging = async (name: string, stale: boolean) => {
      const directory = path.join(root, name);
      await mkdir(directory);
      await writeFile(path.join(directory, "layoutlib-runtime.jar.part"), "partial");
      if (stale) {
        await utimes(path.join(directory, "layoutlib-runtime.jar.part"), old, old);
        await utimes(directory, old, old);
      }
    };
    await staging("compose-a-r1.install-abc123", true);
    await staging("compose-a-r1.install-def456", false);
    await staging("compose-a-r1", true);
    await sweepAbandonedInstalls(root);
    expect((await readdir(root)).sort()).toEqual(["compose-a-r1", "compose-a-r1.install-def456"]);
  });

  test("tolerates a cache without runtimes", async () => {
    await sweepAbandonedInstalls(path.join(tmpdir(), "compose-runtime-missing-0f3a"));
  });
});
