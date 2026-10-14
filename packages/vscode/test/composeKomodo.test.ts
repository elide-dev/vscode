import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { KomodoRenderer, KomodoUnavailable, komodoEntries } from "../src/composeKomodo.js";

/** A stand-in daemon: announces `protocol`, answers configure and entries as komodo-preview does, then pushes a frame. */
async function fakeDaemon(protocol: number, crash = false): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "komodo-fake-"));
  const file = path.join(directory, "komodo-preview");
  await writeFile(file, `#!/usr/bin/env node
const out = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
if (process.argv[2] !== "--protocol-only") process.exit(3);
out({ event: "ready", protocol: ${protocol}, engine: "komodo", host: "desktop", features: ["push", "multiEntry"], kotlin: "2.5.0-Beta1" });
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let i = buffer.indexOf("\\n"); i >= 0; i = buffer.indexOf("\\n")) {
    const command = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (${crash}) process.exit(1);
    if (command.command === "configure" && command.host === "layoutlib") out({ event: "error", kind: "configure", message: "no layoutlib host", fallback: true });
    else if (command.command === "configure") out({ event: "configured", module: "main" });
    else if (command.command === "entries") {
      out({ event: "entries", hosted: [command.entries[0].id], refused: command.entries.slice(1).map((e) => e.id) });
      out({ event: "frame", entry: command.entries[0].id, sequence: 1, width: 2, height: 3, png: "UE5H" });
    }
  }
});
`);
  await chmod(file, 0o755);
  return file;
}

describe("Komodo engine", () => {
  test("names one entry per card, with numeric @Preview parameters and the provider's expansion index", () => {
    const previews = [
      { methodFQN: "app.MainKt.Card", previewId: "p0", name: "Card", previewParams: { widthDp: "240", name: "light", showBackground: "true" }, methodParams: [] },
      { methodFQN: "app.MainKt.Names", previewId: "p1", name: "Names", previewParams: {}, methodParams: [{ provider: "app.NamesProvider" }] },
    ];
    const images = [
      { id: "p0:0", name: "Card", detail: "" }, { id: "p1:0", name: "Names", detail: "" }, { id: "p1:1", name: "Names", detail: "" },
      { id: "unknown:0", name: "?", detail: "" },
    ];
    expect(komodoEntries(images, previews)).toEqual([
      { id: "p0:0", previewId: "p0", method: "app.MainKt.Card", parameters: { widthDp: 240, name: "light", showBackground: true }, methodParameter: null },
      { id: "p1:0", previewId: "p1", method: "app.MainKt.Names", parameters: {}, methodParameter: { provider: "app.NamesProvider", index: 0 } },
      { id: "p1:1", previewId: "p1", method: "app.MainKt.Names", parameters: {}, methodParameter: { provider: "app.NamesProvider", index: 1 } },
    ]);
  });

  test("handshakes protocol 2, relays refusals with fallback and receives pushed frames", async () => {
    const daemon = await KomodoRenderer.start(await fakeDaemon(2), [], () => {}, 10_000);
    try {
      expect(daemon.ready.protocol).toBe(2);
      daemon.send({ command: "configure", host: "layoutlib" });
      const refusal = await daemon.next((event) => event.event === "error", 5_000);
      expect(refusal.fallback).toBe(true);
      daemon.send({ command: "configure", host: "desktop" });
      expect((await daemon.next((event) => event.event === "configured", 5_000)).module).toBe("main");
      const frame = daemon.next((event) => event.event === "frame", 5_000);
      daemon.send({ command: "entries", entries: [{ id: "a" }, { id: "b" }] });
      const entries = await daemon.next((event) => event.event === "entries", 5_000);
      expect(entries).toMatchObject({ hosted: ["a"], refused: ["b"] });
      expect(await frame).toMatchObject({ entry: "a", png: "UE5H" });
    } finally {
      daemon.dispose();
    }
  });

  test("refuses a protocol 1 daemon and fails waiters when the daemon dies", async () => {
    await expect(KomodoRenderer.start(await fakeDaemon(1), [], () => {}, 10_000)).rejects.toBeInstanceOf(KomodoUnavailable);
    const daemon = await KomodoRenderer.start(await fakeDaemon(2, true), [], () => {}, 10_000);
    const answer = daemon.next((event) => event.event === "configured", 5_000);
    daemon.send({ command: "configure" });
    await expect(answer).rejects.toThrow("exited");
    expect(daemon.alive).toBe(false);
  });
});
