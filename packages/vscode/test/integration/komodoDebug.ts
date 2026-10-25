/**
 * Komodo's debugger (runner.ts, `ELIDE_TEST_SCENARIO=komodo-debug`: a copy of `samples/ktjvm` on Komodo's language
 * server, every other extension disabled): `Elide: Run (debug)` runs `elide run --debugger` and attaches with
 * `komodo-kotlin`, the default adapter of a Komodo folder, served by `komodo-lsp-k2 --dap`. The session stops at a
 * Kotlin line breakpoint in the real file, shows a local, evaluates, steps a line and runs the program to its end.
 */
import assert from "node:assert/strict";
import { connect } from "node:net";
import path from "node:path";
import * as vscode from "vscode";
import type { ElideExtensionApi as ElideApi } from "../../src/extension.js";
import { log, waitFor } from "./helpers.js";

const KOMODO_DEBUG_TYPE = "komodo-kotlin";

interface DapVariable {
  name: string;
  value: string;
  variablesReference: number;
}

/** A DAP message the adapter sent; `event` and `body` are set on events. */
interface DapMessage {
  type: string;
  event?: string;
  body?: { threadId?: number; reason?: string; exitCode?: number };
}

interface StackFrame {
  id: number;
  line: number;
  source?: { path?: string };
}

export async function runKomodoDebugScenario(): Promise<void> {
  const sample = process.env.ELIDE_TEST_SAMPLE!;
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "sample workspace folder open");
  assert.equal(vscode.workspace.getConfiguration("elide", folder).get("kotlinLsp.server"), "komodo");

  // The adapter needs the manifest and launcher the folder's sync hands to Komodo's server.
  const elide = vscode.extensions.all.find((e) => e.id.endsWith(".elide"));
  const activity = await waitFor("extension activity api", () => (elide?.exports as ElideApi | undefined)?.activity, 60_000, 500);
  const komodoStep = await waitFor("a sync that started Komodo", () => activity.getChildren()
    .filter((op) => op.label.startsWith("Sync ") && !op.running)
    .flatMap((op) => op.children)
    .find((step) => step.label === "Starting the Komodo language server" && /· (started|reloaded)$/.test(step.detail ?? "")), 300_000, 1_000);
  log("Komodo:", komodoStep.detail);

  // Every DAP event of the Komodo sessions, by session.
  const events = new Map<string, DapMessage[]>();
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory(KOMODO_DEBUG_TYPE, {
    createDebugAdapterTracker: (session) => ({
      onDidSendMessage: (message: DapMessage) => {
        if (message.type !== "event") return;
        const list = events.get(session.id) ?? [];
        list.push(message);
        events.set(session.id, list);
      },
    }),
  });
  try {
    const mainKt = vscode.Uri.file(path.join(sample, "src", "main", "sample", "Main.kt"));
    const document = await vscode.workspace.openTextDocument(mainKt);
    await vscode.window.showTextDocument(document, { preview: false });
    // `println(greeting(words))`: `words` is in scope, and the line after it is main's end.
    const bpLine = document.getText().split("\n").findIndex((line) => line.includes("println(greeting(words))"));
    assert.ok(bpLine > 0, "breakpoint line in Main.kt");
    vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(mainKt, new vscode.Position(bpLine, 0)))]);

    const sessionStarted = new Promise<vscode.DebugSession>((resolve) => {
      const listener = vscode.debug.onDidStartDebugSession((session) => {
        if (session.type !== KOMODO_DEBUG_TYPE) return;
        listener.dispose();
        resolve(session);
      });
    });
    const started = await vscode.debug.startDebugging(folder, { type: "elide", request: "launch", name: "Elide: Run (debug)" });
    assert.equal(started, false, "the `elide` pseudo-session never starts itself");
    const session = await Promise.race([sessionStarted, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no ${KOMODO_DEBUG_TYPE} session within 180s`)), 180_000))]);
    log("attach session started:", session.type, session.name, "port", session.configuration.port);
    assert.equal(session.configuration.request, "attach");
    assert.equal(session.configuration.hostName, "127.0.0.1");
    const ended = new Promise<void>((resolve) => {
      const listener = vscode.debug.onDidTerminateDebugSession((s) => {
        if (s.id !== session.id) return;
        listener.dispose();
        resolve();
      });
    });

    const sessionEvents = () => events.get(session.id) ?? [];
    const nextStop = async (after: number, what: string) => waitFor(what, () => sessionEvents().slice(after).find((e) => e.event === "stopped"), 120_000, 200);
    const topFrame = async (threadId: number) => {
      const trace: { stackFrames: StackFrame[] } = await session.customRequest("stackTrace", { threadId, startFrame: 0, levels: 1 });
      const top = trace.stackFrames[0];
      assert.ok(top, "a stack frame");
      return top;
    };

    // 1. The breakpoint binds in Kotlin source and stops in the real file, on its line.
    const hit = await nextStop(0, "stopped at the breakpoint");
    const threadId = hit.body?.threadId;
    assert.equal(typeof threadId, "number", "the stopped event names its thread");
    assert.equal(hit.body?.reason, "breakpoint");
    const top = await topFrame(threadId!);
    log("stopped in", top.source?.path, "line", top.line);
    assert.equal(top.source?.path, mainKt.fsPath, "the top frame is the real Main.kt");
    assert.equal(top.line, bpLine + 1, "the top frame is on the breakpoint line");

    // 2. The local `words` and its elements, and an evaluation in the frame.
    const { scopes }: { scopes: { name: string; variablesReference: number }[] } = await session.customRequest("scopes", { frameId: top.id });
    const variables = async (reference: number) => {
      const response: { variables: DapVariable[] } = await session.customRequest("variables", { variablesReference: reference });
      return response.variables;
    };
    const locals = (await Promise.all(scopes.map((scope) => variables(scope.variablesReference)))).flat();
    const words = locals.find((variable) => variable.name === "words");
    assert.ok(words, `a local \`words\` among ${locals.map((v) => v.name).join(", ")}`);
    // The list's string form or, a level or two down, its elements show the values `listOf` received.
    const seen = [words.value];
    let pending = words.variablesReference > 0 ? [words.variablesReference] : [];
    for (let depth = 0; depth < 2 && pending.length > 0 && !seen.some((value) => value.includes("Hello")); depth++) {
      const children = (await Promise.all(pending.map(variables))).flat();
      seen.push(...children.map((child) => child.value));
      pending = children.map((child) => child.variablesReference).filter((reference) => reference > 0);
    }
    log("words =", words.value);
    assert.ok(seen.some((value) => value.includes("Hello")), `\`words\` holds "Hello": ${JSON.stringify(seen.slice(0, 10))}`);
    const size: { result: string } = await session.customRequest("evaluate", { expression: "words.size", frameId: top.id, context: "watch" });
    log("words.size =", size.result);
    assert.match(size.result, /\b2\b/);

    // 3. Step over the line: the next stop is further down main.
    const beforeStep = sessionEvents().length;
    await session.customRequest("next", { threadId });
    const stepped = await nextStop(beforeStep, "stopped after next");
    const afterStep = await topFrame(stepped.body?.threadId ?? threadId!);
    log("stepped to line", afterStep.line);
    assert.equal(afterStep.source?.path, mainKt.fsPath);
    assert.ok(afterStep.line > top.line, `next advanced past line ${top.line}, to ${afterStep.line}`);

    // 4. Continue: the program runs to its end, the session ends and so does the JVM Elide started.
    await session.customRequest("continue", { threadId });
    await Promise.race([ended, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the session did not end within 60s of continue")), 60_000))]);
    // An attached adapter sends no `exited`: JDWP's VM death carries no exit code (Elide reports it in its terminal).
    assert.ok(sessionEvents().some((e) => e.event === "terminated"), "the adapter reported the debuggee's end");
    const port = Number(session.configuration.port);
    await waitFor(`the debuggee's JDWP port ${port} closed`, () => new Promise<boolean>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(false); });
      socket.once("error", () => resolve(true));
    }), 30_000, 500);
    log("komodo debug ok");
  } finally {
    tracker.dispose();
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  }
}
