import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// Isolate module mocks from the backend and other extension tests in this process.
for (const scenario of ["close", "failed-build", "prewarm-close", "prewarm-failure", "stale-record", "processing", "processor-failure", "processing-recovery", "superseded-processing", "stale-paint", "cold-initialization", "inspect", "availability",
  "animation", "replay", "reveal", "rename", "session-lost", "sync-wait", "sync-failure", "restore", "cancel", "rebuild", "log-replay", "delete-during-build"]) {
  test(`Compose session lifecycle: ${scenario}`, () => {
    const result = spawnSync(process.execPath, [new URL("./fixtures/composePreviewLifecycle.ts", import.meta.url).pathname, scenario], {
      encoding: "utf8", timeout: 10_000,
    });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  });
}
