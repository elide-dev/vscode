import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { ElideFailureReport, LineSplitter, type ElideRecord } from "@elide/ide-core";

interface Message {
  type: string;
  secret?: string;
  pid?: number;
  record?: ElideRecord;
  exitCode?: number | null;
  aborted?: boolean;
}

async function run(script: string, options: { env?: NodeJS.ProcessEnv; argv?: string[]; cancel?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "elide-task-runner-"));
  const bin = path.join(root, "elide");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const messages: Message[] = [];
  const ready = Promise.withResolvers<void>();
  const server = createServer((socket) => {
    const lines = new LineSplitter((line) => {
      const message = JSON.parse(line) as Message;
      messages.push(message);
      if (message.type === "record" && message.record?.type === "task-started") ready.resolve();
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => lines.push(chunk));
    socket.on("end", () => socket.end());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test endpoint");
  const child = spawn(process.execPath, [new URL("../src/taskRunner.ts", import.meta.url).pathname,
    String(address.port), "test-secret", "build app", bin, ...(options.argv ?? ["build", "app"])], {
    cwd: root,
    env: { ...process.env, ...options.env, ELIDE_TASK_RUNNER_ELECTRON_RUN_AS_NODE: "null" },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 15_000,
  });
  const exit = once(child, "close");
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end("typed input\n");
  try {
    if (options.cancel) {
      await Promise.race([ready.promise, exit.then(() => { throw new Error("Task exited before becoming cancellable"); })]);
      child.kill("SIGTERM");
    }
    const [code, signal] = await exit;
    const closed = once(server, "close");
    server.close();
    await closed;
    return { code, signal, stdout, stderr, messages };
  } finally {
    child.kill("SIGKILL");
    if (server.listening) server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("native task output and stdin survive structured progress, and failure records keep their exit code", async () => {
  const result = await run(`
read answer
printf 'program: %s\\n' "$answer"
printf '{"type":"task-started","task":"compile","message":"Compile app","time":0}\\n' >&2
printf '{"type":"task-progress","task":"compile","message":"Compiling","progress":1,"total":2,"time":1}\\n' >&2
printf '{"type":"message","level":"error","text":"Compiler rejected app","time":2}\\n' >&2
printf '{"type":"task-finished","task":"compile","message":"Compile app","outcome":"failure","durationMs":20,"time":3}\\n' >&2
exit 7`, { env: { NO_COLOR: undefined, FORCE_COLOR: "1" } });
  expect(result.code).toBe(7);
  expect(result.stdout).toContain("program: typed input\n");
  expect(result.stderr).toContain("\x1b[31m");
  expect(stripVTControlCharacters(result.stderr)).toContain("error: Compiler rejected app");
  expect(result.stderr).not.toContain('{"type":');
  expect(result.messages[0]).toMatchObject({ type: "start", secret: "test-secret" });
  expect(result.messages.at(-1)).toMatchObject({ type: "end", exitCode: 7, aborted: false });
  const failure = new ElideFailureReport();
  for (const message of result.messages) if (message.record) failure.record(message.record);
  expect(failure.failure).toEqual({ errors: 1, error: "Compiler rejected app" });
  expect(result.messages.filter((message) => message.record?.type === "task-progress").map((message) => message.record)).toEqual([
    { type: "task-progress", task: "compile", message: "Compiling", progress: 1, total: 2, time: 1 },
  ]);
});

test("rendered terminal progress respects NO_COLOR", async () => {
  const result = await run(`printf '{"type":"build-finished","outcome":"success","durationMs":20,"time":0}\\n' >&2`, { env: { NO_COLOR: "1", FORCE_COLOR: "1" } });
  expect(result.code).toBe(0);
  expect(result.stderr).toBe(stripVTControlCharacters(result.stderr));
});

test("CLI color opt-outs apply to progress but program arguments do not change CLI styling", async () => {
  const script = `printf '{"type":"build-finished","outcome":"success","durationMs":20,"time":0}\\n' >&2`;
  const env = { NO_COLOR: undefined, FORCE_COLOR: "1" };
  const plain = await run(script, { env, argv: ["build", "--no-color", "app"] });
  expect(plain.code).toBe(0);
  expect(plain.stderr).toBe(stripVTControlCharacters(plain.stderr));
  const programFlag = await run(script, { env, argv: ["run", "app", "--", "--no-color"] });
  expect(programFlag.code).toBe(0);
  expect(programFlag.stderr).toContain("\x1b[32m");
});

test("cancelling a native task closes output pipes held by a stubborn descendant", async () => {
  const result = await run(`
(trap '' TERM; sleep 60) &
printf '{"type":"task-started","task":"wait","message":"Waiting","time":0}\\n' >&2
wait`, { cancel: true });
  expect(result.messages.at(-1)).toMatchObject({ type: "end", aborted: true });
  expect(result.code === 0 && result.signal === null).toBe(false);
}, 20_000);
