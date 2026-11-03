import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveKomodo } from "../src/komodoDistribution.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function distribution(stdout: unknown, exit = 0, stderr = ""): string {
  const home = mkdtempSync(path.join(tmpdir(), "komodo-resolution-"));
  homes.push(home);
  mkdirSync(path.join(home, "bin"));
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  writeFileSync(path.join(home, "bin/elide"), `#!/bin/sh\nprintf '%s\\n' ${quote(JSON.stringify(stdout))}\nprintf '%s\\n' ${quote(stderr)} >&2\nexit ${exit}\n`, { mode: 0o755 });
  return home;
}

function identity() {
  return {
    schemaVersion: 1, component: "komodo", status: "resolved", version: "0.2.0",
    executable: process.execPath, bundle: "/managed/komodo", pluginDirectory: "/managed/komodo/plugins",
    javaHome: "/jdk/25", protocol: { lsp: 1, dap: 1, preview: 2 }, capabilities: ["lsp", "dap", "preview"],
  };
}

test("explicit developer builds remain authoritative, including invalid overrides", async () => {
  const home = distribution(identity());
  expect((await resolveKomodo(process.execPath, "/missing/elide")).executable).toBe(process.execPath);
  await expect(resolveKomodo("/missing/komodo", home)).rejects.toMatchObject({ status: "override" });
  await expect(resolveKomodo("komodo", home)).rejects.toMatchObject({ status: "override" });
  const notExecutable = path.join(home, "not-executable");
  writeFileSync(notExecutable, "not executable");
  chmodSync(notExecutable, 0o644);
  await expect(resolveKomodo(notExecutable, home)).rejects.toMatchObject({ status: "override" });
});

test("unknown version labels do not impose guessed floors, and preview incompatibility is retained for its consumer", async () => {
  for (const preview of [undefined, 1, 3, "2"]) {
    const data = { ...identity(), version: "development", protocol: { lsp: 1, dap: 1, preview } };
    const resolved = await resolveKomodo(undefined, distribution(data));
    // Analysis/debug compatibility remains usable; dropping this field would incorrectly enable preview consumers.
    expect(resolved.protocol?.preview).toBe(preview);
  }
  const data = { ...identity(), capabilities: ["lsp", "dap"] };
  const resolved = await resolveKomodo(undefined, distribution(data));
  expect(resolved.capabilities?.includes("preview")).toBe(false);
});

test("nonzero missing results are actionable but never trigger an install or PATH fallback", async () => {
  const home = distribution({ schemaVersion: 1, component: "komodo", status: "missing", code: "not-installed", message: "Install Komodo explicitly." }, 1);
  // A second invocation would fail instead of returning the missing result.
  const bin = path.join(home, "bin/elide");
  writeFileSync(bin, `#!/bin/sh\ncase "$*" in\n  'komodo resolve --json') echo '{"schemaVersion":1,"component":"komodo","status":"missing","message":"Install Komodo explicitly."}'; exit 1 ;;\n  *) echo 'unexpected installation' >&2; exit 99 ;;\nesac\n`, { mode: 0o755 });
  await expect(resolveKomodo(undefined, home)).rejects.toMatchObject({ status: "missing" });
});

test("incompatible schemas, capabilities and non-absolute paths fail before launching", async () => {
  for (const change of [{ schemaVersion: 2 }, { protocol: { lsp: 2, dap: 1 } }, { capabilities: ["lsp"] }, { javaHome: "relative/jdk" }]) {
    await expect(resolveKomodo(undefined, distribution({ ...identity(), ...change }))).rejects.toMatchObject({ status: "incompatible" });
  }
  await expect(resolveKomodo(undefined, distribution(identity(), 1, "verification failed"))).rejects.toThrow("verification failed");
});

test("old Elide script fallback requests an upgrade without silently changing engines", async () => {
  const home = distribution(null, 2);
  writeFileSync(path.join(home, "bin/elide"), `#!/bin/sh\necho "No file or script named 'komodo'" >&2\nexit 2\n`, { mode: 0o755 });
  await expect(resolveKomodo(undefined, home)).rejects.toMatchObject({ status: "upgrade" });
});
