import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { ImageStore } from "../src/composeBackend.js";
import type { ComposeCompiler } from "../src/composeCompiler.js";
import { KOMODO_PAUSED, KomodoBackend, KomodoRenderer, KomodoSessionArbiter, KomodoUnavailable, komodoEntries, previewDeclarations, type KomodoOptions } from "../src/composeKomodo.js";
import type { CompiledPreview, PreviewImage } from "../src/composeRender.js";
import type { ComposeRuntime } from "../src/composeRuntime.js";

/** An authenticated session fixture; no child process is involved. */
async function fakeSession(protocol: number, crash = false) {
  const sockets = new Set<Socket>();
  const lines: string[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    let authenticated = false;
    const out = (event: object) => socket.write(`${JSON.stringify(event)}\n`);
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        lines.push(line);
        if (!authenticated) {
          if (line !== "session-token") { socket.destroy(); return; }
          authenticated = true;
          out({ event: "ready", protocol, host: "layoutlib", compiler: "workspace", pid: process.pid });
          continue;
        }
        const command = JSON.parse(line);
        if (crash) { socket.destroy(); return; }
        if (command.command === "configure" && command.host === "layoutlib") out({ event: "error", kind: "configure", message: "no layoutlib host", fallback: true });
        else if (command.command === "configure") out({ event: "configured", module: "main" });
        else if (command.command === "entries") {
          out({ event: "entries", hosted: [command.entries[0].id], refused: command.entries.slice(1).map((e: { id: string }) => e.id) });
          out({ event: "frame", entry: command.entries[0].id, sequence: 1, width: 2, height: 3, png: "UE5H" });
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture port");
  return {
    port: address.port, lines, sockets,
    close: () => { for (const socket of sockets) socket.destroy(); server.close(); },
  };
}

describe("Komodo engine", () => {
  test("names a plain preview's card and leaves a provider's values for the daemon to expand", () => {
    const previews = [
      { methodFQN: "app.MainKt.Card", previewId: "p0", name: "Card", previewParams: { widthDp: "240", name: "light", showBackground: "true" }, methodParams: [] },
      { methodFQN: "app.MainKt.Names", previewId: "p1", name: "Names", previewParams: {}, methodParams: [{ provider: "app.NamesProvider", limit: "2" }] },
    ];
    expect(komodoEntries(previews)).toEqual([
      { id: "p0:0", previewId: "p0", method: "app.MainKt.Card", parameters: { widthDp: 240, name: "light", showBackground: true }, previewParams: previews[0]!.previewParams, methodParameter: null },
      { id: "p1", previewId: "p1", method: "app.MainKt.Names", parameters: {}, previewParams: {}, methodParameter: { provider: "app.NamesProvider", limit: "2" } },
    ]);
  });

  test("needs a new discovery for declaration edits, not for body edits", () => {
    const file = "package app\n\n@Preview(widthDp = 240)\n@Composable\nfun Card() {\n  val label = \"one\"\n  Text(label)\n}\n";
    expect(previewDeclarations(file.replace("\"one\"", "\"two\"").replace("Text(label)", "Column { Text(label) }"))).toBe(previewDeclarations(file));
    expect(previewDeclarations(file.replace("widthDp = 240", "widthDp = 320"))).not.toBe(previewDeclarations(file));
    expect(previewDeclarations(file.replace("fun Card()", "fun Card(@PreviewParameter(NamesProvider::class) name: String)"))).not.toBe(previewDeclarations(file));
    expect(previewDeclarations(`${file}\n@Preview\n@Composable\nfun Other() {}\n`)).not.toBe(previewDeclarations(file));
  });

  test("handshakes protocol 2, relays refusals with fallback and receives pushed frames", async () => {
    const session = await fakeSession(2);
    const daemon = await KomodoRenderer.connect(session.port, "session-token", () => {}, 10_000);
    try {
      expect(daemon.ready.protocol).toBe(2);
      expect(session.lines[0]).toBe("session-token");
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
      session.close();
    }
  });

  test("refuses an old protocol and fails waiters when the session closes", async () => {
    const old = await fakeSession(1);
    try {
      await expect(KomodoRenderer.connect(old.port, "session-token", () => {}, 10_000)).rejects.toBeInstanceOf(KomodoUnavailable);
    } finally { old.close(); }
    const session = await fakeSession(2, true);
    try {
      const daemon = await KomodoRenderer.connect(session.port, "session-token", () => {}, 10_000);
      const answer = daemon.next((event) => event.event === "configured", 5_000);
      daemon.send({ command: "configure" });
      await expect(answer).rejects.toThrow("closed");
      expect(daemon.alive).toBe(false);
    } finally { session.close(); }
  });

  test("disposal closes only its socket and the server can serve another session", async () => {
    const session = await fakeSession(2);
    try {
      const first = await KomodoRenderer.connect(session.port, "session-token", () => {}, 10_000);
      const socket = [...session.sockets][0]!;
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      first.dispose();
      await closed;
      expect(first.alive).toBe(false);
      const next = await KomodoRenderer.connect(session.port, "session-token", () => {}, 10_000);
      expect(next.alive).toBe(true);
      next.dispose();
    } finally { session.close(); }
  });

  test("authentication failure rejects the handshake", async () => {
    const session = await fakeSession(2);
    try {
      await expect(KomodoRenderer.connect(session.port, "wrong-token", () => {}, 10_000)).rejects.toThrow("closed");
      expect(session.lines).toEqual(["wrong-token"]);
    } finally { session.close(); }
  });
});

type Command = Record<string, unknown> & { command: string };

/** A protocol-2 session server as the language server runs it: every connection is one session, and every command is recorded. */
async function fakeDaemon(options: {
  features?: string[]; renders?: (id: string) => boolean;
  ready?: (out: (event: object) => void) => void;
  configure?: (command: Command, out: (event: object) => void) => void;
} = {}) {
  const connections: { commands: Command[]; out: (event: object) => void; socket: Socket }[] = [];
  const hooks: { command?: (command: Command, out: (event: object) => void) => void } = {};
  const server = createServer((socket) => {
    // Cancellation can race a deliberately delayed response in these lifecycle fixtures.
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    const out = (event: object) => socket.write(`${JSON.stringify(event)}\n`);
    const connection = { commands: [] as Command[], out, socket };
    connections.push(connection);
    let buffer = "";
    let authenticated = false;
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (!authenticated) {
          authenticated = true;
          if (options.ready) options.ready(out);
          else out({ event: "ready", protocol: 2, host: "layoutlib", compiler: "workspace-fir", features: options.features ?? ["reconfigure", "texts"] });
          continue;
        }
        const command = JSON.parse(line) as Command;
        connection.commands.push(command);
        if (command.command === "configure") {
          if (options.configure) options.configure(command, out);
          else out({ event: "configured", module: "main" });
        }
        if (command.command === "entries") {
          const ids = (command.entries as { id: string }[]).map((entry) => entry.id);
          out({ event: "entries", hosted: ids, refused: [] });
          for (const id of ids.filter(options.renders ?? (() => true))) out({ event: "frame", entry: id, sequence: 1, width: 2, height: 3, png: "UE5H" });
        }
        hooks.command?.(command, out);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture port");
  return {
    port: address.port, connections, hooks,
    commands: (name: string) => connections.flatMap((connection) => connection.commands.filter((command) => command.command === name)),
    close: () => { for (const connection of connections) connection.socket.destroy(); server.close(); },
  };
}

/** The inputs of a preview compiler whose project classes were published under `published`. */
function fakeCompiler(published: string): ComposeCompiler {
  const inputs = { namespace: "app", resourceApkPath: "/build/resources.apk", classPath: ["/libs/compose.jar", published], projectClassPath: [published], sourceSelections: {} };
  return { fingerprint: published, inputs, currentInputs: inputs, compileClassPath: ["/libs/compose.jar"], supports: () => true } as unknown as ComposeCompiler;
}

/** The engine over a stand-in compiler; `replaceCompiler` is what `configure` does when a build replaces it. */
class TestBackend extends KomodoBackend {
  protected override readonly firstFrameMs = 200;
  stub: ComposeCompiler | undefined = fakeCompiler("/old/published");
  override get compiler(): ComposeCompiler | undefined { return this.stub; }
  replaceCompiler(next: ComposeCompiler): Promise<void> {
    const previous = this.stub!;
    this.stub = next;
    return Promise.resolve(this.retire(previous));
  }
}

/** Resolves once the client closed this server-side connection. */
function serverClosed(socket: Socket): Promise<void> {
  return socket.destroyed ? Promise.resolve() : new Promise((resolve) => socket.once("close", () => resolve()));
}

const file = "/nonexistent/app/src/main/kotlin/app/Main.kt";
const card = "package app\n\n@Preview\n@Composable\nfun Card() {\n  Text(\"one\")\n}\n";
const preview = (name: string): CompiledPreview => ({ methodFQN: `app.MainKt.${name}`, previewId: name, name, previewParams: {}, methodParams: [] });
const request = (text: string) => ({ documents: new Map([[file, text]]), sourceFile: file, packageName: "app" });
const runtime = { rendererJar: "/runtime/renderer.jar", layoutlibPath: "/runtime/layoutlib", rendererClassPath: [] } as ComposeRuntime;

describe("Komodo engine sessions", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

  async function engine(daemon: { port: number; close(): void }, options: Partial<KomodoOptions> = {}) {
    const backend = new TestBackend("key", "/nonexistent/cache", "/nonexistent/helpers", new ImageStore("/nonexistent/images"), {
      previews: async () => ({ previews: [preview("Card"), preview("Other")], errors: [] }),
      session: async () => ({ protocol: 2, port: daemon.port, token: "session-token" }),
      sync: async () => {},
      log: () => {},
      ...options,
    });
    cleanups.push(() => { backend.dispose(); daemon.close(); });
    await backend.startRenderer(runtime);
    return backend;
  }

  test("disposing during the ready handshake closes the socket without waiting for ready", async () => {
    const authenticating = Promise.withResolvers<void>();
    const daemon = await fakeDaemon({ ready: () => authenticating.resolve() });
    const backend = await engine(daemon);
    const result = backend.preview(request(card)).catch((error: unknown) => error);
    await authenticating.promise;
    backend.dispose();
    await serverClosed(daemon.connections[0]!.socket);
    expect(await result).toBeInstanceOf(Error);
    expect(daemon.commands("configure")).toEqual([]);
  });

  for (const reused of [false, true]) test(`disposing during ${reused ? "reused" : "initial"} configuration cannot publish a late gallery`, async () => {
    const configuring = Promise.withResolvers<(event: object) => void>();
    let hold = !reused;
    const daemon = await fakeDaemon({
      configure: (_command, out) => {
        if (hold) configuring.resolve(out);
        else out({ event: "configured", module: "main" });
      },
    });
    let previews = [preview("Card")];
    const backend = await engine(daemon, { previews: async () => ({ previews, errors: [] }) });
    if (reused) await backend.preview(request(card));
    const published: unknown[] = [];
    backend.onCompile((outcome) => published.push(outcome));
    hold = true;
    previews = [preview("Card"), preview("New")];
    const result = backend.preview(request(`${card}\n@Preview\nfun New() {}\n`)).catch((error: unknown) => error);
    const out = await configuring.promise;
    backend.dispose();
    out({ event: "compile", outcome: "failure", messages: [{ level: "error", text: "obsolete compile" }] });
    out({ event: "configured", module: "main" });
    expect(await result).toBeInstanceOf(Error);
    await serverClosed(daemon.connections[0]!.socket);
    expect(published).toEqual([]);
    expect(daemon.commands("entries")).toHaveLength(reused ? 1 : 0);
  });

  test("disposing while the session request is pending never connects its late endpoint", async () => {
    const opening = Promise.withResolvers<void>();
    const endpoint = Promise.withResolvers<{ protocol: number; port: number; token: string }>();
    const daemon = await fakeDaemon();
    const backend = await engine(daemon, {
      session: () => { opening.resolve(); return endpoint.promise; },
    });
    const result = backend.preview(request(card)).catch((error: unknown) => error);
    await opening.promise;
    backend.dispose();
    endpoint.resolve({ protocol: 2, port: daemon.port, token: "session-token" });
    expect(await result).toBeInstanceOf(Error);
    expect(daemon.connections).toEqual([]);
  });

  test("a retired session's delayed synchronization failure never publishes diagnostics into its replacement", async () => {
    const syncing = Promise.withResolvers<void>();
    const synchronized = Promise.withResolvers<void>();
    let hold = false;
    const daemon = await fakeDaemon();
    const backend = await engine(daemon, {
      sync: async () => {
        if (!hold) return;
        hold = false;
        syncing.resolve();
        await synchronized.promise;
      },
    });
    await backend.preview(request(card));
    const failures: unknown[] = [];
    backend.onCompile((outcome) => { if (outcome.failed) failures.push(outcome); });
    hold = true;
    backend.edit(file, card.replace("one", "two"));
    await syncing.promise;
    await backend.replaceCompiler(fakeCompiler("/new/published"));
    synchronized.reject(new Error("old language server stopped"));
    const gallery = await backend.preview(request(card.replace("one", "two")));
    expect(gallery.images.every((image) => image.live)).toBe(true);
    expect(daemon.connections).toHaveLength(2);
    expect(failures).toEqual([]);
  });

  test("preempting a panel during configuration closes its unpublished session and returns paused cards", async () => {
    const configuring = Promise.withResolvers<void>();
    const daemon = await fakeDaemon({ configure: () => configuring.resolve() });
    const arbiter = new KomodoSessionArbiter();
    const panel = await engine(daemon, { arbiter });
    const agent = await engine(daemon, { arbiter, role: "agent" });
    const pending = panel.preview(request(card));
    await configuring.promise;
    arbiter.setActive(agent, true);
    expect(arbiter.claim(agent)).toBe(true);
    const gallery = await pending;
    expect(gallery.images.map((image) => image.error)).toEqual([KOMODO_PAUSED, KOMODO_PAUSED]);
    await serverClosed(daemon.connections[0]!.socket);
    expect(daemon.commands("entries")).toEqual([]);
  });

  test("a replaced compiler's session receives no edit and closes, and the next preview configures over the new inputs", async () => {
    const daemon = await fakeDaemon();
    let syncing: PromiseWithResolvers<void> | undefined;
    const backend = await engine(daemon, { sync: async () => { await syncing?.promise; } });
    await backend.preview(request(card));
    // An edit waiting for the language server's buffers when a save's build replaces the compiler and deletes its classes.
    syncing = Promise.withResolvers();
    backend.edit(file, card.replace("one", "two"));
    const retired = backend.replaceCompiler(fakeCompiler("/new/published"));
    syncing.resolve();
    syncing = undefined;
    await retired;
    backend.edit(file, card.replace("one", "three"));
    const gallery = await backend.preview(request(card.replace("one", "three")));
    expect(daemon.commands("sources")).toEqual([]);
    // The retired session's process may still read the deleted inputs: it is not reconfigured.
    expect(daemon.connections).toHaveLength(2);
    await serverClosed(daemon.connections[0]!.socket);
    const configures = daemon.commands("configure");
    expect(configures.map((command) => command.projectClassPath)).toEqual([["/old/published"], ["/new/published"]]);
    expect((configures[1]!.texts as Record<string, string>)[file]).toContain("three");
    expect(gallery.images.map((image) => image.live)).toEqual([true, true]);
  });

  test("a replaced compiler's classes outlive the compile its session is running", async () => {
    const daemon = await fakeDaemon();
    const backend = await engine(daemon);
    await backend.preview(request(card));
    const sent = Promise.withResolvers<void>();
    daemon.hooks.command = (command) => { if (command.command === "sources") sent.resolve(); };
    backend.edit(file, card.replace("one", "two"));
    await sent.promise;
    let retired = false;
    const retiring = backend.replaceCompiler(fakeCompiler("/new/published")).then(() => { retired = true; });
    await sleep(100);
    expect(retired).toBe(false);
    daemon.connections[0]!.out({ event: "compile", outcome: "success", messages: [] });
    await retiring;
    await serverClosed(daemon.connections[0]!.socket);
  });

  test("a session that closes on its own fails its cards with the reason and asks for one new preview", async () => {
    const daemon = await fakeDaemon();
    const backend = await engine(daemon);
    const gallery = await backend.preview(request(card));
    const published: PreviewImage[] = [];
    backend.onImages((images) => published.push(...images));
    let lost = 0;
    const closed = Promise.withResolvers<void>();
    backend.onSessionLost(() => { lost++; closed.resolve(); });
    daemon.connections[0]!.out({ event: "error", message: "IrGenerationExtensionException: NoSuchFileException /old/published\n\tat Compiler" });
    daemon.connections[0]!.socket.end();
    await closed.promise;
    expect(lost).toBe(1);
    expect(published.map((image) => [image.id, image.error])).toEqual(["Card:0", "Other:0"].map((id) =>
      [id, "Komodo: the preview session closed (IrGenerationExtensionException: NoSuchFileException /old/published)"]));
    expect(backend.latestImages(gallery.images).every((image) => image.error && !image.live)).toBe(true);
    expect(backend.pointer("Card:0", "down", 1, 1)).toBe(false);
    // The panel's preview reconnects; closing it on purpose is no lost session.
    const again = await backend.preview(request(card));
    expect(daemon.connections).toHaveLength(2);
    expect(again.images.map((image) => image.live)).toEqual([true, true]);
    backend.dispose();
    expect(lost).toBe(1);
  });

  test("a card without a first frame fails alone and the session stays live", async () => {
    const daemon = await fakeDaemon({ renders: (id) => id !== "Other:0" });
    const backend = await engine(daemon);
    const gallery = await backend.preview(request(card));
    expect(gallery.images[0]!.live).toBe(true);
    expect(gallery.images[1]!.error).toStartWith("Komodo: no frame was rendered within");
    expect(backend.pointer("Card:0", "down", 1, 1)).toBe(true);
    expect(backend.pointer("Other:0", "down", 1, 1)).toBe(false);
    const pushed = Promise.withResolvers<Command>();
    daemon.hooks.command = (command) => { if (command.command === "sources") pushed.resolve(command); };
    backend.edit(file, card.replace("one", "two"));
    expect((await pushed.promise).files).toEqual({ [file]: card.replace("one", "two") });
    expect(daemon.connections).toHaveLength(1);
  });

  test("a preview declared while the file has errors is discovered once a body edit fixes them", async () => {
    const daemon = await fakeDaemon();
    const answers = [
      { previews: [preview("Card")], errors: [] },
      { previews: [preview("Card"), preview("New")], errors: [{ message: "Expecting ')'" }] },
      { previews: [preview("Card"), preview("New")], errors: [] },
    ];
    let discoveries = 0;
    const backend = await engine(daemon, { previews: async () => answers[discoveries++]! });
    await backend.preview(request(card));
    const added = `${card}\n@Preview\n@Composable\nfun New() {\n  Text(\n}\n`;
    expect((await backend.preview(request(added))).images.map((image) => image.id)).toEqual(["Card:0"]);
    const fixed = (await backend.preview(request(added.replace("Text(\n", "Text(\"new\")\n")))).images;
    expect(discoveries).toBe(3);
    expect(fixed.map((image) => [image.id, image.live])).toEqual([["Card:0", true], ["New:0", true]]);
  });

  test("a delta rejected while a preview discovers configures the same session again after it", async () => {
    const daemon = await fakeDaemon();
    const discovering = Promise.withResolvers<void>();
    let discoveries = 0;
    const backend = await engine(daemon, {
      previews: async () => {
        if (discoveries++ === 0) return { previews: [preview("Card"), preview("Other")], errors: [] };
        await discovering.promise;
        return { previews: [preview("Card")], errors: [] };
      },
    });
    const other = `${card}\n@Preview\n@Composable\nfun Other() {}\n`;
    await backend.preview(request(other));
    daemon.hooks.command = (command, out) => {
      if (command.command !== "sources") return;
      out({ event: "error", kind: "rejected", restartRequired: true, message: "Other was removed" });
      // Events are handled in order: this compile outcome tells the test that the rejection was.
      out({ event: "compile", outcome: "success", messages: [] });
    };
    const rejected = Promise.withResolvers<void>();
    backend.onCompile(() => rejected.resolve());
    const recovered = Promise.withResolvers<void>();
    backend.onImages((images) => { if (images.length === 1 && images[0]!.live) recovered.resolve(); });
    const removing = backend.preview(request(card));
    await rejected.promise;
    discovering.resolve();
    expect((await removing).images.map((image) => image.id)).toEqual(["Card:0"]);
    await recovered.promise;
    expect(daemon.connections).toHaveLength(1);
    expect(daemon.commands("configure")).toHaveLength(2);
    expect((daemon.commands("configure")[1]!.texts as Record<string, string>)[file]).toBe(card);
  });

  const wrapper = "\n\n@Composable\nfun ElideAgentPreview_1() {\n  Card()\n}\n";
  const selected = (text: string) => ({ ...request(text),
    selection: { appendices: new Map([[file, wrapper]]), previews: [preview("ElideAgentPreview_1")], files: [] as string[] } });

  test("a selection hosts its previews without discovery and configures its appendices", async () => {
    const daemon = await fakeDaemon({ features: ["reconfigure", "texts", "appendices"] });
    let discoveries = 0;
    const backend = await engine(daemon, { previews: async () => { discoveries++; return { previews: [preview("Card")], errors: [] }; } });
    const gallery = await backend.preview(selected(card));
    expect(discoveries).toBe(0);
    expect(gallery.images.map((image) => [image.id, image.live])).toEqual([["ElideAgentPreview_1:0", true]]);
    const [configure] = daemon.commands("configure");
    expect(configure!.appendices).toEqual({ [file]: wrapper });
    expect((configure!.texts as Record<string, string>)[file]).toBe(card);
    expect((daemon.commands("entries")[0]!.entries as { method: string }[]).map((entry) => entry.method)).toEqual(["app.MainKt.ElideAgentPreview_1"]);
    // A full-file request is another session's program.
    await backend.preview(request(card));
    expect(discoveries).toBe(1);
    expect(daemon.commands("configure")[1]!.appendices).toBeUndefined();
  });

  test("a daemon without appendices fails a selection with the upgrade", async () => {
    const daemon = await fakeDaemon();
    const backend = await engine(daemon);
    const failure = await backend.preview(selected(card)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KomodoUnavailable);
    expect((failure as Error).message).toContain("newer Komodo");
    expect(daemon.commands("configure")).toEqual([]);
  });

  test("an agent preempts the panel, which pauses and resumes once the agent is done", async () => {
    const daemon = await fakeDaemon({ features: ["reconfigure", "texts", "appendices"] });
    const arbiter = new KomodoSessionArbiter();
    const panel = await engine(daemon, { arbiter });
    const agent = await engine(daemon, { arbiter, role: "agent" });
    await panel.preview(request(card));
    const pushed: PreviewImage[] = [];
    panel.onImages((images) => pushed.push(...images));
    let lost = 0;
    panel.onSessionLost(() => lost++);
    arbiter.setActive(agent, true);
    await agent.preview(selected(card));
    expect(pushed.map((image) => [image.id, image.error])).toEqual([["Card:0", KOMODO_PAUSED], ["Other:0", KOMODO_PAUSED]]);
    expect(lost).toBe(0);
    await serverClosed(daemon.connections[0]!.socket);
    // The paused panel shows why and opens no session.
    const paused = await panel.preview(request(card));
    expect(paused.images.map((image) => [image.id, image.error])).toEqual([["Card:0", KOMODO_PAUSED], ["Other:0", KOMODO_PAUSED]]);
    expect(daemon.connections).toHaveLength(2);
    arbiter.setActive(agent, false);
    expect(lost).toBe(1);
    // The panel previews again and takes the session from the inactive agent.
    const agentCards: PreviewImage[] = [];
    agent.onImages((images) => agentCards.push(...images));
    const resumed = await panel.preview(request(card));
    expect(resumed.images.map((image) => image.live)).toEqual([true, true]);
    expect(daemon.connections).toHaveLength(3);
    expect(agentCards.map((image) => image.id)).toEqual(["ElideAgentPreview_1:0"]);
    expect(agentCards[0]!.error).toContain("took the preview session");
    expect(agent.pointer("ElideAgentPreview_1:0", "down", 1, 1)).toBe(false);
  });

  test("a panel an agent preempts while it hosts its cards shows them paused, not failed", async () => {
    const daemon = await fakeDaemon({ features: ["reconfigure", "texts", "appendices"], renders: () => false });
    const arbiter = new KomodoSessionArbiter();
    const panel = await engine(daemon, { arbiter });
    const agent = await engine(daemon, { arbiter, role: "agent" });
    const hosting = Promise.withResolvers<void>();
    daemon.hooks.command = (command) => { if (command.command === "entries") hosting.resolve(); };
    const previewing = panel.preview(request(card));
    await hosting.promise;
    arbiter.setActive(agent, true);
    expect(arbiter.claim(agent)).toBe(true);
    const gallery = await previewing;
    expect(gallery.images.map((image) => [image.id, image.error])).toEqual([["Card:0", KOMODO_PAUSED], ["Other:0", KOMODO_PAUSED]]);
    expect(panel.paused).toBe(true);
  });

  test("a panel behind an agent in use pauses without claiming; scroll reaches a live card", async () => {
    const daemon = await fakeDaemon({ features: ["reconfigure", "texts", "appendices"] });
    const arbiter = new KomodoSessionArbiter();
    const agent = await engine(daemon, { arbiter, role: "agent" });
    const panel = await engine(daemon, { arbiter });
    arbiter.setActive(agent, true);
    await agent.preview(selected(card));
    const pointed = Promise.withResolvers<Command>();
    daemon.hooks.command = (command) => { if (command.command === "pointer") pointed.resolve(command); };
    expect(agent.pointer("ElideAgentPreview_1:0", "scroll", 1, 2, 0, -40)).toBe(true);
    expect(await pointed.promise).toMatchObject({ entry: "ElideAgentPreview_1:0", action: "scroll", x: 1, y: 2, dx: 0, dy: -40 });
    let lost = 0;
    panel.onSessionLost(() => lost++);
    const paused = await panel.preview(request(card));
    expect(paused.images.every((image) => image.error === KOMODO_PAUSED)).toBe(true);
    expect(daemon.connections).toHaveLength(1);
    agent.dispose();
    expect(lost).toBe(1);
    expect((await panel.preview(request(card))).images.map((image) => image.live)).toEqual([true, true]);
  });
});
