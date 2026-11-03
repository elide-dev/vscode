import { describe, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

describe("Sync lifecycle", () => {
  for (const [name, scenario] of [
    ["an install failure fails the sync; only rejected classifier flags are retried without them", "install-failure"],
    ["a member's manifest that failed its root's sync makes the root stale once fixed", "member-manifest"],
    ["the manifests Add Workspace Member writes are not taken for edits; a later edit is", "own-writes"],
    ["the status shows the worst state of all folders, whichever sync finished last", "status"],
    ["a removed folder leaves no manifest error, rerun or folder state behind", "remove-folder"],
    ["a folder added to the window syncs only if its sync.onStartup allows", "added-folder"],
    ["a cancel while the Kotlin LSP is configured ends the sync cancelled, without a reload", "late-cancel"],
    ["the window's JDK for symbol resolution is its first folder's, whichever folder syncs last", "window-jdk"],
    ["settings the model is resolved with mark it stale; a new elide.home re-syncs and restarts Komodo", "settings"],
    ["disabled Komodo never fails project sync, rewrites preferences or blocks unrelated JetBrains projects", "komodo-disabled"],
    ["a sync running when the window closes ends without logging to the closed output channel", "dispose"],
  ]) {
    test(name!, () => {
      // Bun module replacements are process-wide; keep the real modules in other test files intact.
      execFileSync(process.execPath, [fileURLToPath(new URL("./fixtures/syncLifecycle.ts", import.meta.url)), scenario!],
        { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
    }, 15_000);
  }
});
