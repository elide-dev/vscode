import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AndroidDatabaseLineReader, AndroidDatabaseSession, encodeAndroidDatabaseRequest, listAndroidDatabasePackages, parseAndroidDatabaseHello,
  parseAndroidDatabaseResponse, type AndroidDatabaseOptions,
} from "../src/androidDatabase.js";

const roots: string[] = [];
const sessions: AndroidDatabaseSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const root of roots.splice(0)) {
    const calls = path.join(root, "calls");
    if (existsSync(calls)) {
      // One cleanup per session, however often it reinstalled its helper.
      const installs = new Set(readFileSync(calls, "utf8").trim().split("\n").map((line) => /ELIDE_DATABASE_READY_[a-f0-9]+/.exec((JSON.parse(line) as string[]).at(-1) ?? "")?.[0]).filter(Boolean)).size;
      if (installs) await waitForFile(path.join(root, "cleaned"), installs);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

interface Fixture {
  root: string;
  options: AndroidDatabaseOptions;
  calls(): string[][];
  requests(): { action: string; database?: string; sql?: string }[];
  session(overrides?: Partial<AndroidDatabaseOptions>): AndroidDatabaseSession;
  response(value: unknown): void;
}

/**
 * Real child-process pipes and signals, with POSIX parsing of adb's joined remote argv and the actual installer
 * script. Only Android framework commands/the inspector are simulated; this is not a SQL evaluator.
 */
function fixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "elide database 'quoted'-"));
  roots.push(root);
  mkdirSync(path.join(root, "app"));
  const adb = path.join(root, "fake adb.cjs");
  const helperDex = path.join(root, "inspector.dex");
  writeFileSync(helperDex, Buffer.from([0x64, 0x65, 0x78, 0x0a, 0, 255, 13, 10, 128]));
  writeFileSync(path.join(root, "user"), "10");
  writeFileSync(adb, String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const root = __dirname;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, "calls"), JSON.stringify(args) + "\n");
if (args[1] === "offline") { console.error("error: device offline"); process.exit(1); }
if (args[2] !== "shell" || args[3] !== "-T") throw new Error("Binary stdin needs shell-v2 without a PTY");
const decoded = spawnSync("/bin/sh", ["-c", "set -- " + args.slice(4).join(" ") + "; printf '%s\\0' \"$@\""], { encoding: "utf8", cwd: root });
if (decoded.status !== 0) { console.error(decoded.stderr); process.exit(1); }
const command = decoded.stdout.split("\0").slice(0, -1);
const behavior = fs.existsSync(path.join(root, "behavior")) ? JSON.parse(fs.readFileSync(path.join(root, "behavior"), "utf8")) : {};
process.on("SIGTERM", () => { fs.writeFileSync(path.join(root, "killed"), "yes"); process.exit(0); });
if (command[0] === "am") {
  if (behavior.hangUser) { fs.writeFileSync(path.join(root, "waiting-user"), "yes"); fs.watch(root, () => {}); }
  else console.log(fs.readFileSync(path.join(root, "user"), "utf8"));
} else if (command[0] === "cmd") {
  if (command.join(" ") !== "cmd package list packages -3 --user 10") throw new Error("Unsafe package discovery user");
  console.log(fs.existsSync(path.join(root, "packages")) ? fs.readFileSync(path.join(root, "packages"), "utf8") : "package:com.example.z\npackage:com.example.app\npackage:com.example.z");
  if (behavior.switchUser) fs.writeFileSync(path.join(root, "user"), "11");
} else if (command[0] === "sh") {
  // The run-as probe: one answer per package argument, as the device-side loop prints them.
  if (command[1] !== "-c" || !command[2].includes('run-as "$p" --user 10 true') || command[3] !== "sh") throw new Error("Unexpected probe " + JSON.stringify(command));
  for (const name of command.slice(4)) {
    if (behavior.probe === "garbage") console.log("maybe " + name);
    else if (name.endsWith(".release")) console.log("no " + name + " run-as: package not debuggable: " + name);
    else console.log("ok " + name);
  }
} else if (command[0] === "run-as") {
  if (command[2] !== "--user" || command[3] !== "10" || command[4] !== "sh" || command[5] !== "-c") throw new Error("Unsafe run-as user/command");
  const script = command[6];
  if (script.startsWith("rm -f ")) {
    const result = spawnSync("/bin/sh", ["-c", script], { cwd: path.join(root, "app"), encoding: "utf8" });
    fs.appendFileSync(path.join(root, "cleaned"), "yes\n");
    process.exit(result.status || 0);
  }
  if (script.startsWith("grep -q dev.elide.inspector.DatabaseInspector /proc/4242/cmdline")) {
    fs.appendFileSync(path.join(root, "remote-killed"), "yes\n");
    process.exit(0);
  }
  if (command[1] === "com.example.release") { console.error("run-as: package not debuggable: com.example.release"); process.exit(1); }
  if (command[1] === "com.example.missing") { console.error("run-as: unknown package: com.example.missing"); process.exit(1); }
  if (command[1] === "com.example.unsupported") { console.log("usage: run-as <package-name> <command> [<args>]"); process.exit(0); }
  if (script.startsWith("set -eu;")) {
    const child = spawn("/bin/sh", ["-c", script], { cwd: path.join(root, "app"), stdio: ["inherit", "pipe", "pipe"] });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.on("close", code => process.exit(code ?? 1));
  } else {
    const match = /^\[ -f '(cache\/elide-database-[a-f0-9]{32}\/inspector\.dex)' \] \|\| \{ printf '%s\\n' ELIDE_DATABASE_MISSING >&2; exit 3; \}; CLASSPATH='\1' exec app_process \/ dev\.elide\.inspector\.DatabaseInspector$/.exec(script);
    if (!match) throw new Error("Unexpected helper shell command: " + script);
    const helper = path.join(root, "app", match[1]);
    if (!fs.existsSync(helper)) { console.error("ELIDE_DATABASE_MISSING"); process.exit(3); }
    if ((fs.statSync(helper).mode & 0o222) !== 0) throw new Error("Writable DEX");
    // One long-lived helper: hello, then one response line per request line, until end of input.
    fs.appendFileSync(path.join(root, "helpers"), "started\n");
    process.stdout.write(JSON.stringify({ ready: true, protocol: behavior.protocol ?? 2, pid: 4242 }) + "\n");
    let buffered = "";
    let busy = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
      buffered += chunk;
      for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
        const { id, ...request } = JSON.parse(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        fs.appendFileSync(path.join(root, "requests"), JSON.stringify(request) + "\n");
        fs.appendFileSync(path.join(root, "ids"), id + "\n");
        const now = fs.existsSync(path.join(root, "behavior")) ? JSON.parse(fs.readFileSync(path.join(root, "behavior"), "utf8")) : {};
        // A helper stuck in SQL: it neither answers nor exits at end of input.
        if (now.hang) { busy = true; fs.watch(root, () => {}); fs.writeFileSync(path.join(root, "waiting-query"), "yes"); return; }
        if (now.flood) { process.stdout.write("x".repeat(4 * 1024 * 1024 + 1)); return; }
        if (now.noisy) process.stderr.write("linker: harmless warning\n".repeat(10000));
        if (now.garbage) { process.stdout.write("not json\n"); continue; }
        if (now.wrongId) { process.stdout.write(JSON.stringify({ ok: true, id: id + 1, databases: [] }) + "\n"); continue; }
        if (fs.existsSync(path.join(root, "response"))) {
          process.stdout.write(fs.readFileSync(path.join(root, "response"), "utf8").replace("{", '{"id":' + id + ",") + "\n");
          continue;
        }
        const defaults = {
          databases: { ok: true, databases: ["app.db"] },
          schema: { ok: true, objects: [{ name: "items", type: "table", sql: "CREATE TABLE items(id INTEGER)" }] },
          query: { ok: true, columns: ["id"], rows: [[1]], hasMore: false },
          execute: { ok: true, changes: 1 },
        };
        process.stdout.write(JSON.stringify({ ...defaults[request.action], id }) + "\n");
      }
    });
    process.stdin.on("end", () => { if (!busy) process.exit(0); });
  }
} else throw new Error("Unexpected remote command " + JSON.stringify(command));
`);
  chmodSync(adb, 0o755);
  const options = { adb, device: "serial;$(touch serial-injected)", packageName: "com.example.app", helperDex };
  return {
    root,
    options,
    calls: () => existsSync(path.join(root, "calls")) ? readFileSync(path.join(root, "calls"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]) : [],
    requests: () => existsSync(path.join(root, "requests")) ? readFileSync(path.join(root, "requests"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [],
    session(overrides) {
      const session = new AndroidDatabaseSession({ ...options, ...overrides });
      sessions.push(session);
      return session;
    },
    response(value) { writeFileSync(path.join(root, "response"), JSON.stringify(value)); },
  };
}

async function waitForFile(file: string, count = 1): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const check = () => {
    if (existsSync(file) && readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length >= count) resolve();
  };
  // Directory watch events can arrive before a marker's contents or be coalesced by Bun on Linux.
  // Poll the durable marker instead, including append-only markers that count completed cleanups.
  const watcher = watchFile(file, { interval: 10 }, check);
  watcher.on("error", reject);
  // Keep the same bounded failure deadline; polling does not extend a broken fixture's lifetime.
  const deadline = AbortSignal.timeout(3_000);
  const expired = () => reject(new Error(`Timed out waiting for ${file}`));
  deadline.addEventListener("abort", expired, { once: true });
  try {
    check();
    await promise;
  } finally {
    deadline.removeEventListener("abort", expired);
    unwatchFile(file, check);
  }
}

describe.skipIf(process.platform === "win32")("Android database transport safety", () => {
  test("streams a fresh read-only DEX and keeps SQL, database names and serials out of shell evaluation", async () => {
    const fake = fixture();
    const session = fake.session();
    const database = "odd ' $(touch database-injected).db";
    const sql = "SELECT '$(touch sql-injected); `id`', '\"quoted\"'";
    await session.query(database, sql);
    expect(fake.requests()).toEqual([{ action: "query", database, sql, limit: 100, offset: 0 }]);
    const firstCalls = fake.calls();
    expect(firstCalls.every((args) => args[1] === fake.options.device)).toBe(true);
    expect(firstCalls.some((args) => args.join(" ").includes(sql) || args.join(" ").includes(database))).toBe(false);
    const cache = path.join(fake.root, "app", "cache");
    const firstDirectory = readdirSync(cache)[0]!;
    const helper = path.join(cache, firstDirectory, "inspector.dex");
    expect(readFileSync(helper)).toEqual(readFileSync(fake.options.helperDex));
    expect(statSync(helper).mode & 0o777).toBe(0o400);
    await session.execute("app.db", "UPDATE items SET id = 2");
    expect(fake.calls().filter((args) => args.at(-1)?.includes("ELIDE_DATABASE_READY_"))).toHaveLength(1);
    const second = fake.session();
    await second.databases();
    expect(readdirSync(cache)).toHaveLength(2);
    expect(existsSync(path.join(fake.root, "serial-injected"))).toBe(false);
    expect(existsSync(path.join(fake.root, "database-injected"))).toBe(false);
    expect(existsSync(path.join(fake.root, "sql-injected"))).toBe(false);
    session.dispose();
    await waitForFile(path.join(fake.root, "cleaned"));
    expect(existsSync(helper)).toBe(false);
    expect(readdirSync(cache)).toHaveLength(1);
  });

  test("rejects unsafe identifiers, traversal and oversized requests before starting adb", async () => {
    const fake = fixture();
    expect(() => fake.session({ packageName: "com.example;touch bad" })).toThrow("application ID");
    expect(() => fake.session({ user: -1 })).toThrow("user");
    const session = fake.session();
    for (const database of ["../secret.db", "nested/../../secret.db", "/data/private.db", "x\\secret.db", "a\0.db", "a//b"]) {
      await expect(session.schema(database)).rejects.toThrow("database path");
    }
    await expect(session.query("app.db", " ")).rejects.toThrow("SQL");
    await expect(session.query("app.db", "€".repeat(22_000))).rejects.toThrow("64 KiB");
    await expect(session.query("app.db", "SELECT 1", 501)).rejects.toThrow("page size");
    await expect(session.query("app.db", "SELECT 1", 100, 1_000_001)).rejects.toThrow("offset");
    expect(fake.calls()).toEqual([]);
  });

  test("pins a secondary user, refuses mismatched selection and rejects a later profile switch", async () => {
    const fake = fixture();
    await expect(fake.session({ user: 0 }).databases()).rejects.toThrow("not the current user 10");
    expect(fake.calls().some((args) => args.at(-1)?.includes("ELIDE_DATABASE_READY_"))).toBe(false);
    const session = fake.session({ user: 10 });
    await session.databases();
    writeFileSync(path.join(fake.root, "user"), "11");
    await expect(session.query("app.db", "SELECT 1")).rejects.toThrow("changed from 10 to 11");
    expect(fake.requests()).toHaveLength(1);
  });

  test("discovers only third-party packages for the current user and rejects malformed/user-racing discovery", async () => {
    const fake = fixture();
    expect(await listAndroidDatabasePackages(fake.options.adb, fake.options.device)).toEqual([{ packageName: "com.example.app", user: 10 }, { packageName: "com.example.z", user: 10 }]);
    writeFileSync(path.join(fake.root, "packages"), "package:com.example.app;id");
    await expect(listAndroidDatabasePackages(fake.options.adb, fake.options.device)).rejects.toThrow("unsupported response");
    writeFileSync(path.join(fake.root, "packages"), "package:com.example.app");
    writeFileSync(path.join(fake.root, "behavior"), JSON.stringify({ switchUser: true }));
    await expect(listAndroidDatabasePackages(fake.options.adb, fake.options.device)).rejects.toThrow("changed during package discovery");
  });

  test("keeps the discovered package's user pinned while the application picker is open", async () => {
    const fake = fixture();
    const [selected] = await listAndroidDatabasePackages(fake.options.adb, fake.options.device);
    expect(selected?.user).toBe(10);
    writeFileSync(path.join(fake.root, "user"), "11");
    const session = fake.session({ packageName: selected!.packageName, user: selected!.user });
    await expect(session.databases()).rejects.toThrow("Selected Android user 10 is not the current user 11");
    expect(fake.calls().some((args) => args.at(-1)?.includes("ELIDE_DATABASE_READY_"))).toBe(false);
    expect(fake.requests()).toEqual([]);
  });

  test("asks run-as which applications it opens, in batches, and never offers a release build as openable", async () => {
    const fake = fixture();
    const many = Array.from({ length: 150 }, (_, index) => `com.example.generated${String(index).padStart(3, "0")}`);
    writeFileSync(path.join(fake.root, "packages"), ["com.example.app", "com.example.release", ...many].map((name) => `package:${name}`).join("\n"));
    const packages = await listAndroidDatabasePackages(fake.options.adb, fake.options.device);
    expect(packages).toHaveLength(152);
    expect(packages.find((item) => item.packageName === "com.example.release")).toEqual({
      packageName: "com.example.release", user: 10, refusal: "run-as: package not debuggable: com.example.release", notDebuggable: true,
    });
    expect(packages.filter((item) => item.refusal)).toHaveLength(1);
    const probes = fake.calls().filter((args) => args[4] === "'sh'");
    expect(probes.length).toBeGreaterThan(1);
    expect(probes.every((args) => args.join(" ").length < 4096)).toBe(true);
    writeFileSync(path.join(fake.root, "behavior"), JSON.stringify({ probe: "garbage" }));
    await expect(listAndroidDatabasePackages(fake.options.adb, fake.options.device)).rejects.toThrow("run-as check returned an unsupported response");
  });

  test("reports debuggability, missing applications, unsupported run-as and offline devices", async () => {
    const fake = fixture();
    for (const [packageName, message] of [["com.example.release", "debuggable build"], ["com.example.missing", "Install this application"], ["com.example.unsupported", "never falls back"]]) {
      await expect(fake.session({ packageName }).databases()).rejects.toThrow(message);
    }
    await expect(fake.session({ device: "offline" }).databases()).rejects.toThrow("Reconnect");
    writeFileSync(path.join(fake.root, "user"), "Current user: unknown");
    await expect(fake.session().databases()).rejects.toThrow("no owner-profile fallback");
  });

  test("preserves lossless cells and accepts noisy stderr without accepting malformed result shapes", async () => {
    const fake = fixture();
    const session = fake.session();
    writeFileSync(path.join(fake.root, "behavior"), JSON.stringify({ noisy: true }));
    const cells = [null, "text €", 3.5, { type: "integer", value: "9223372036854775807" }, { type: "blob", base64: "AP8=" }, 1e20];
    fake.response({ ok: true, columns: ["a", "b", "c", "d", "e", "f"], rows: [cells], hasMore: true });
    expect(await session.query("app.db", "SELECT * FROM items", 1)).toEqual({ columns: ["a", "b", "c", "d", "e", "f"], rows: [cells], hasMore: true });
    for (const value of [{ type: "integer", value: "9223372036854775808" }, { type: "blob", base64: "A===" }, "x".repeat(256 * 1024 + 1), true]) {
      fake.response({ ok: true, columns: ["value"], rows: [[value]], hasMore: false });
      await expect(session.query("app.db", "SELECT value")).rejects.toThrow("malformed or oversized query");
    }
    writeFileSync(path.join(fake.root, "response"), '{"ok":true,"columns":["value"],"rows":[[1e400]],"hasMore":false}');
    await expect(session.query("app.db", "SELECT value")).rejects.toThrow("malformed");
    fake.response({ ok: true, columns: ["value"], rows: [[1, 2]], hasMore: false });
    await expect(session.query("app.db", "SELECT value")).rejects.toThrow("malformed");
    fake.response({ ok: true, columns: ["value"], rows: [[1], [2]], hasMore: false });
    await expect(session.query("app.db", "SELECT value", 1)).rejects.toThrow("malformed");
    fake.response({ ok: true, databases: ["../private.db"] });
    await expect(session.databases()).rejects.toThrow("malformed");
    fake.response({ ok: false, error: "SQLite database is locked; retry after the app transaction completes" });
    await expect(session.schema("app.db")).rejects.toThrow("database is locked");
  });

  test("caps stdout instead of parsing a partial or unbounded response", async () => {
    const fake = fixture();
    writeFileSync(path.join(fake.root, "behavior"), JSON.stringify({ flood: true }));
    await expect(fake.session().databases()).rejects.toThrow("bounded response size");
  });

  test("one helper serves every request; a helper out of step is replaced, an application error is not", async () => {
    const fake = fixture();
    const session = fake.session();
    await session.databases();
    await session.schema("app.db");
    await session.query("app.db", "SELECT 1");
    const helpers = () => readFileSync(path.join(fake.root, "helpers"), "utf8").trim().split("\n").length;
    expect(helpers()).toBe(1);
    expect(readFileSync(path.join(fake.root, "ids"), "utf8").trim().split("\n")).toEqual(["1", "2", "3"]);
    fake.response({ ok: false, error: "no such table: missing" });
    await expect(session.query("app.db", "SELECT * FROM missing")).rejects.toThrow("no such table");
    expect(helpers()).toBe(1);
    rmSync(path.join(fake.root, "response"));
    for (const [behavior, message] of [[{ garbage: true }, "invalid JSON"], [{ wrongId: true }, "answered request 7 instead of 6"]] as const) {
      writeFileSync(path.join(fake.root, "behavior"), JSON.stringify(behavior));
      await expect(session.databases()).rejects.toThrow(message);
    }
    writeFileSync(path.join(fake.root, "behavior"), "{}");
    expect(await session.databases()).toEqual(["app.db"]);
    expect(helpers()).toBe(3);
    expect(fake.calls().filter((args) => args.at(-1)?.includes("ELIDE_DATABASE_READY_"))).toHaveLength(1);
  });

  test("refuses a helper speaking another protocol", async () => {
    const fake = fixture();
    writeFileSync(path.join(fake.root, "behavior"), JSON.stringify({ protocol: 1 }));
    await expect(fake.session().databases()).rejects.toThrow("protocol 1, not 2");
  });

  test("cancel stops a helper stuck in SQL on the device, keeps the DEX and serves the next request", async () => {
    const fake = fixture();
    writeFileSync(path.join(fake.root, "behavior"), JSON.stringify({ hang: true }));
    const session = fake.session();
    const outcomes = Promise.allSettled([session.query("app.db", "SELECT 1"), session.schema("app.db")]);
    await waitForFile(path.join(fake.root, "waiting-query"));
    session.cancel();
    for (const result of await outcomes) expect(result.status === "rejected" && result.reason.name).toBe("AbortError");
    await waitForFile(path.join(fake.root, "remote-killed"));
    await waitForFile(path.join(fake.root, "killed"));
    writeFileSync(path.join(fake.root, "behavior"), "{}");
    expect(await session.databases()).toEqual(["app.db"]);
    expect(fake.calls().filter((args) => args.at(-1)?.includes("ELIDE_DATABASE_READY_"))).toHaveLength(1);
    expect(existsSync(path.join(fake.root, "cleaned"))).toBe(false);
  });

  test("reinstalls a helper the system deleted from the app cache when it next starts one", async () => {
    const fake = fixture();
    const session = fake.session();
    await session.databases();
    const cache = path.join(fake.root, "app", "cache");
    // Clear cache can leave the directory behind; the reinstall must tolerate it.
    rmSync(path.join(cache, readdirSync(cache)[0]!, "inspector.dex"));
    writeFileSync(path.join(fake.root, "behavior"), JSON.stringify({ garbage: true }));
    await expect(session.databases()).rejects.toThrow("invalid JSON");
    writeFileSync(path.join(fake.root, "behavior"), "{}");
    expect(await session.databases()).toEqual(["app.db"]);
    expect(fake.calls().filter((args) => args.at(-1)?.includes("ELIDE_DATABASE_READY_"))).toHaveLength(2);
  });

  test("frames requests and responses as single lines with bounded size", () => {
    const reader = new AndroidDatabaseLineReader(8);
    expect(reader.push(Buffer.from("ab"))).toEqual([]);
    expect(reader.push(Buffer.from("c\n\nde\nf")).map(String)).toEqual(["abc", "", "de"]);
    expect(reader.push(Buffer.from("\n")).map(String)).toEqual(["f"]);
    expect(() => reader.push(Buffer.from("123456789"))).toThrow("bounded response size (8 bytes)");
    const line = encodeAndroidDatabaseRequest(7, { action: "query", database: "a.db", sql: "SELECT 'x\ny'", limit: 1, offset: 0 });
    expect(line.indexOf("\n")).toBe(line.length - 1);
    expect(JSON.parse(line)).toEqual({ id: 7, action: "query", database: "a.db", sql: "SELECT 'x\ny'", limit: 1, offset: 0 });
    expect(() => encodeAndroidDatabaseRequest(1, { action: "execute", database: "a.db", sql: "x".repeat(512 * 1024) })).toThrow("512 KiB");
    expect(parseAndroidDatabaseHello(Buffer.from('{"ready":true,"protocol":2,"pid":31}'))).toBe(31);
    expect(() => parseAndroidDatabaseHello(Buffer.from('{"ready":true,"protocol":2,"pid":-1}'))).toThrow("process ID");
    expect(() => parseAndroidDatabaseHello(Buffer.from([0xff]))).toThrow("invalid UTF-8");
    expect(parseAndroidDatabaseResponse(Buffer.from('{"ok":true,"id":3,"changes":2}'), 3, { action: "execute", database: "a.db", sql: "DELETE FROM t" })).toMatchObject({ changes: 2 });
    expect(() => parseAndroidDatabaseResponse(Buffer.from('{"ok":true,"id":2,"changes":2}'), 3, { action: "execute", database: "a.db", sql: "DELETE FROM t" })).toThrow("instead of 3");
  });

  test("dispose aborts running and queued requests, kills the child, removes its DEX and never restarts", async () => {
    const fake = fixture();
    writeFileSync(path.join(fake.root, "behavior"), JSON.stringify({ hang: true }));
    const session = fake.session();
    const operations = [session.query("app.db", "SELECT 1"), session.execute("app.db", "DELETE FROM items"), session.schema("app.db")];
    const outcomes = Promise.allSettled(operations);
    await waitForFile(path.join(fake.root, "waiting-query"));
    expect(fake.requests()).toHaveLength(1);
    session.dispose();
    for (const result of await outcomes) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason.name).toBe("AbortError");
    }
    await waitForFile(path.join(fake.root, "killed"));
    await waitForFile(path.join(fake.root, "cleaned"));
    expect(readdirSync(path.join(fake.root, "app", "cache"))).toHaveLength(0);
    await expect(session.databases()).rejects.toThrow("disposed");
    expect(fake.requests()).toHaveLength(1);
    session.dispose();
  });

  test("cancels pending user discovery and never installs a helper after disposal", async () => {
    const fake = fixture();
    writeFileSync(path.join(fake.root, "behavior"), JSON.stringify({ hangUser: true }));
    const session = fake.session();
    const outcomes = Promise.allSettled([session.databases(), session.databases()]);
    await waitForFile(path.join(fake.root, "waiting-user"));
    session.dispose();
    expect((await outcomes).every((result) => result.status === "rejected")).toBe(true);
    await waitForFile(path.join(fake.root, "killed"));
    expect(fake.calls()).toHaveLength(1);
    const controller = new AbortController();
    controller.abort();
    await expect(listAndroidDatabasePackages(fake.options.adb, fake.options.device, controller.signal)).rejects.toThrow("cancelled");
    expect(fake.calls()).toHaveLength(1);
  });
});
