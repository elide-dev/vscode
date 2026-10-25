import { describe, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

describe("Compose backend lifecycle", () => {
  for (const [name, fixture, scenario] of [
    ["prewarm observes renderer failure while compiler discovery is pending", "composeBackendLifecycle", "prewarm-failure"],
    ["shutdown drains compiler setup before removing its workspace", "composeBackendLifecycle", "dispose-setup"],
    ["concurrent previews render their own source generations", "composeBackendLifecycle", "concurrent-generations"],
    ["processing confirms galleries, recovers declarations and reuses exact reverts", "composeBackendLifecycle", "processing-verification"],
    ["verification cannot certify a render of superseded generated output", "composeBackendLifecycle", "processing-publication"],
    ["cold initialization compiles dependencies before a single processing baseline", "composeBackendLifecycle", "cold-baseline"],
    ["saved Inspect bypasses build galleries and tracks published instrumentation", "composeBackendLifecycle", "inspect-seeded"],
    ["cached galleries initialize the confirmed compiler's renderer alongside processing", "composeBackendLifecycle", "renderer-generation"],
    ["a replacement renderer keeps the pool size the last gallery needed", "composeBackendLifecycle", "renderer-weight"],
    ["a new backend removes the workspaces of exited hosts and keeps those of running ones", "composeBackendLifecycle", "sweep"],
    ["a gallery with a failed card is rendered again, never stored or replayed", "composeBackendLifecycle", "error-gallery"],
    ["a gallery is stored under the JDK that rendered it, not one starting meanwhile", "composeBackendLifecycle", "renderer-identity"],
    ["prewarm stops once a panel uses its backend", "composeBackendLifecycle", "prewarm-yields"],
    ["a keep-alive of months keeps the unused backend instead of dropping it at once", "composeBackendLifecycle", "keep-alive"],
    ["a selection compiles its appendices and renders and stores only its previews, apart from the file's gallery", "composeBackendLifecycle", "selection"],
    ["managed Compose modules share cold worker initialization", "composeCompilerLifecycle", "managed-compose"],
    ["custom Kotlin plugins retain their project-local worker", "composeCompilerLifecycle", "custom-plugin"],
    ["Elide's bundled Kotlin plugins share one worker across workspace members", "composeCompilerLifecycle", "bundled-plugins"],
    ["a resource or R class rebuild keeps the warm compiler and recompiles only affected units", "composeCompilerLifecycle", "rebase"],
    ["a new Kotlin toolchain stops the replaced compiler's worker", "composeCompilerLifecycle", "toolchain-switch"],
    ["a failed shard preserves its diagnostic and permits a fresh renderer", "composeRenderLifecycle", "failure"],
    ["the render pool follows the gallery: JVMs join when started and idle surplus stops", "composeRenderLifecycle", "resize"],
    ["a selection's render reaches every shard and keeps the pool the file's gallery needs", "composeRenderLifecycle", "methods"],
    ["a failed or abandoned warm-up stops only its own JVM", "composeRenderLifecycle", "warmup-failure"],
    ["a long shard that reports each image is not hung; a quiet one is", "composeRenderLifecycle", "progress"],
    ["compiler shutdown drains its last protocol response and blames a crash, not the distribution", "composeWorkerLifecycle", "exit"],
    ["a compile that timed out gets a longer deadline on its next attempt instead of the same one", "composeWorkerLifecycle", "timeout"],
  ]) {
    test(name!, () => {
      // Bun module replacements are process-wide; keep the real modules in other test files intact.
      execFileSync(process.execPath, [fileURLToPath(new URL(`./fixtures/${fixture}.ts`, import.meta.url)), scenario!],
        { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
    }, 15_000);
  }
});
