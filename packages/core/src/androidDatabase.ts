import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";

/** SQLite integers outside JavaScript's exact range and binary values are never coerced to numbers/text. */
export type AndroidDatabaseCell = null | string | number | { type: "integer"; value: string } | { type: "blob"; base64: string };

export interface AndroidDatabaseObject {
  name: string;
  type: "table" | "view" | "index" | "trigger";
  sql: string | null;
}

export interface AndroidDatabaseResult {
  columns: string[];
  rows: AndroidDatabaseCell[][];
  hasMore: boolean;
}

export interface AndroidDatabaseOptions {
  adb: string;
  device: string;
  packageName: string;
  /** Packaged, precompiled inspector.dex; streamed directly into the application's private cache. */
  helperDex: string;
  /** If supplied, must match the explicitly resolved current Android user. */
  user?: number;
}

/** One inspector request; the session adds the id that its response must echo. */
export type AndroidDatabaseRequest = { action: "databases" }
  | { action: "schema"; database: string }
  | { action: "query"; database: string; sql: string; limit: number; offset: number }
  | { action: "execute"; database: string; sql: string };

const PACKAGE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_CELL = 256 * 1024;
const MAX_SQL = 64 * 1024;
const MAX_INPUT = 512 * 1024;
const MAX_DEX = 16 * 1024 * 1024;
const MAX_COLUMNS = 256;
const MAX_OFFSET = 1_000_000;
const REQUEST_TIMEOUT = 20_000;

function abortError(): Error {
  const error = new Error("The Android database operation was cancelled; the session may have been disposed.");
  error.name = "AbortError";
  return error;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function nonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`Invalid ${label}.`);
}

function validateConnection(adb: string, device: string): void {
  nonempty(adb, "adb executable path");
  nonempty(device, "Android device serial");
}

function validUser(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 21474;
}

function validateDatabase(database: unknown): asserts database is string {
  if (typeof database !== "string" || !database || Buffer.byteLength(database, "utf8") > 4096
    || /[\u0000-\u001f\u007f\\]/.test(database) || database.startsWith("/")
    || database.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid database path: select a database relative to the application's databases directory, without traversal.");
  }
}

function validateSql(sql: unknown): asserts sql is string {
  if (typeof sql !== "string" || !sql.trim() || sql.includes("\0") || Buffer.byteLength(sql, "utf8") > MAX_SQL) {
    throw new Error("SQL must be nonempty, contain no NUL, and fit within 64 KiB of UTF-8.");
  }
}

/** adb shell joins remote argv verbatim even though the host never invokes a shell. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function remoteArgs(device: string, command: string[]): string[] {
  // Shell-v2 without a PTY preserves binary bytes and forwards stdin EOF; exec-out does not forward EOF.
  return ["-s", device, "shell", "-T", ...command.map(quote)];
}

/** How to get past `run-as: package not debuggable`, the refusal a release build of an app always meets. */
export const ANDROID_DATABASE_DEBUGGABLE_HINT = "run-as only opens debuggable builds: install a build whose merged manifest sets android:debuggable=\"true\" (an Elide APK with `release = false` on an Elide release that marks such builds debuggable, or a Gradle debug build).";

const HELPER_MISSING = "ELIDE_DATABASE_MISSING";

function diagnostic(context: string, detail: string): Error {
  const text = detail.trim().slice(-16 * 1024);
  let advice = "";
  if (/not debuggable/i.test(text)) advice = ` ${ANDROID_DATABASE_DEBUGGABLE_HINT}`;
  else if (/unknown package|not installed|package .* unknown/i.test(text)) advice = " Install this application for the selected Android user.";
  else if (/device offline|device .*not found|no devices|device disconnected/i.test(text)) advice = " Reconnect the selected device and ensure adb reports it online.";
  else if (/unauthorized/i.test(text)) advice = " Unlock the device and authorize USB debugging.";
  else if (/run-as.*(?:usage|unknown option|invalid option)|usage: run-as|(?:unknown|invalid) option.*--user|exec.*--user/i.test(text)) {
    advice = " This device must support run-as PACKAGE --user USER; database inspection never falls back to the owner profile.";
  }
  return new Error(`${context}: ${text || "adb returned no diagnostic"}.${advice}`);
}

interface ProcessOptions {
  adb: string;
  args: string[];
  context: string;
  signal?: AbortSignal;
  input?: string | Readable;
  timeout?: number;
  maxOutput?: number;
}

/** Owns all pipes and cancellation. stderr is a bounded diagnostic tail, not part of the JSON protocol. */
function runAdb(options: ProcessOptions): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  if (options.signal?.aborted) {
    if (typeof options.input !== "string") options.input?.destroy();
    reject(abortError());
    return promise;
  }
  const source = typeof options.input === "string" ? undefined : options.input;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(options.adb, options.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
  } catch (error) {
    source?.destroy();
    reject(diagnostic(options.context, error instanceof Error ? error.message : String(error)));
    return promise;
  }
  const stdin = child.stdin;
  const output: Buffer[] = [];
  let outputBytes = 0;
  let inputBytes = 0;
  let stderr = Buffer.alloc(0);
  let finished = false;
  let inputError: Error | undefined;
  const stop = () => {
    source?.unpipe(stdin);
    source?.destroy();
    stdin.destroy();
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    const force = setTimeout(() => child.kill("SIGKILL"), 500);
    force.unref();
    child.once("close", () => clearTimeout(force));
  };
  const finish = (error?: Error, value?: string) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancelled);
    if (error) {
      stop();
      reject(error);
    } else {
      source?.destroy();
      resolve(value ?? "");
    }
  };
  const cancelled = () => finish(abortError());
  const timer = setTimeout(() => finish(new Error(`${options.context} timed out. Check the device connection or simplify the SQL; a timed-out write may already have committed.`)), options.timeout ?? REQUEST_TIMEOUT);
  timer.unref();
  options.signal?.addEventListener("abort", cancelled, { once: true });
  child.once("error", (error) => finish(diagnostic(options.context, error.message)));
  child.stdout.on("data", (chunk: Buffer) => {
    if (finished) return;
    outputBytes += chunk.length;
    if (outputBytes > (options.maxOutput ?? MAX_OUTPUT)) {
      finish(new Error(`${options.context} exceeded the bounded response size (${options.maxOutput ?? MAX_OUTPUT} bytes). Select fewer rows/columns or smaller values; data was not silently truncated.`));
      return;
    }
    output.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (finished) return;
    stderr = Buffer.concat([stderr, chunk]).subarray(-16 * 1024);
  });
  // EPIPE often means run-as rejected the app. Wait for its useful diagnostic instead of masking it.
  stdin.on("error", (error: Error) => { inputError = error; });
  child.once("close", (code, signal) => {
    if (finished) return;
    let stdout: string;
    try {
      stdout = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(output, outputBytes));
    } catch {
      finish(new Error(`${options.context} returned invalid UTF-8 instead of the inspector protocol.`));
      return;
    }
    if (code !== 0 || inputError) {
      finish(diagnostic(options.context, stderr.toString("utf8") || stdout || inputError?.message || `adb exited with ${signal ?? code}`));
    } else {
      finish(undefined, stdout);
    }
  });
  if (source) {
    source.on("error", (error) => finish(diagnostic("Reading the bundled database inspector", error.message)));
    source.on("data", (chunk: Buffer) => {
      inputBytes += chunk.length;
      if (inputBytes > MAX_DEX) finish(new Error("The bundled database inspector exceeds the 16 MiB helper limit."));
    });
    source.pipe(stdin);
  } else {
    stdin.end(options.input);
  }
  // Closing the check/listener race also prevents an already-disposed session from retaining a process.
  if (options.signal?.aborted) cancelled();
  return promise;
}

async function currentUser(adb: string, device: string, signal?: AbortSignal): Promise<number> {
  const output = await runAdb({ adb, args: remoteArgs(device, ["am", "get-current-user"]), signal, context: "Resolving the current Android user", maxOutput: 64 * 1024 });
  const text = output.trim();
  const user = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!validUser(user)) {
    throw diagnostic("Cannot safely resolve the current Android user; this device must support am get-current-user (no owner-profile fallback)", text);
  }
  return user;
}

/** An installed application, and whether run-as lets the database explorer act as it. */
export interface AndroidDatabasePackage {
  packageName: string;
  /** run-as's refusal for this package and user, e.g. `run-as: package not debuggable: …`; absent when it can be opened. */
  refusal?: string;
  /** The refusal is the one a non-debuggable (release) build meets. */
  notDebuggable?: boolean;
}

/** Package names per probe command, keeping each adb command line far below old adbd limits. */
const PROBE_COMMAND_BYTES = 2_048;

/**
 * Asks run-as itself, on the device and in one adb round trip per batch, whether it would run as each package: it
 * is the authority on debuggability, so the picker never offers an application that only fails once opened.
 */
async function probeRunAs(adb: string, device: string, user: number, packages: readonly string[], signal?: AbortSignal): Promise<Map<string, string | undefined>> {
  const script = `for p in "$@"; do if e=$(run-as "$p" --user ${user} true 2>&1 </dev/null); then printf 'ok %s\\n' "$p"; else printf 'no %s %s\\n' "$p" "$(printf '%s' "$e" | tr '\\r\\n' '  ' | cut -c1-300)"; fi; done`;
  const batches: string[][] = [[]];
  let bytes = 0;
  for (const packageName of packages) {
    if (bytes + packageName.length > PROBE_COMMAND_BYTES && batches.at(-1)!.length) {
      batches.push([]);
      bytes = 0;
    }
    batches.at(-1)!.push(packageName);
    bytes += packageName.length + 3;
  }
  const results = new Map<string, string | undefined>();
  for (const batch of batches) {
    if (!batch.length) continue;
    const output = await runAdb({ adb, args: remoteArgs(device, ["sh", "-c", script, "sh", ...batch]), signal, context: "Checking which applications run-as can open", maxOutput: 1024 * 1024 });
    for (const line of output.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const match = /^(ok|no) (\S+)(?: (.*))?$/.exec(line.trim());
      if (!match || !batch.includes(match[2]!) || results.has(match[2]!)) throw diagnostic("The run-as check returned an unsupported response", line);
      results.set(match[2]!, match[1] === "ok" ? undefined : match[3]?.trim() || "run-as refused this application");
    }
    if (batch.some((packageName) => !results.has(packageName))) throw new Error("The run-as check did not answer for every application. Reconnect the device and try again.");
  }
  return results;
}

/**
 * Third-party packages for one explicitly resolved foreground user, never a cross-profile package list, each with
 * whether run-as can open it for that user.
 */
export async function listAndroidDatabasePackages(adb: string, device: string, signal?: AbortSignal): Promise<AndroidDatabasePackage[]> {
  validateConnection(adb, device);
  checkAbort(signal);
  const user = await currentUser(adb, device, signal);
  const output = await runAdb({ adb, args: remoteArgs(device, ["cmd", "package", "list", "packages", "-3", "--user", String(user)]), signal, context: "Listing installed Android applications" });
  const packages = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^package:([^\s]+)$/.exec(line.trim());
    if (!match || !PACKAGE_NAME.test(match[1]!)) throw diagnostic("Android package discovery returned an unsupported response", line);
    packages.add(match[1]!);
  }
  const sorted = [...packages].sort();
  const refusals = await probeRunAs(adb, device, user, sorted, signal);
  if (await currentUser(adb, device, signal) !== user) throw new Error("The current Android user changed during package discovery. Select an application again.");
  checkAbort(signal);
  return sorted.map((packageName) => {
    const refusal = refusals.get(packageName);
    return refusal === undefined ? { packageName } : { packageName, refusal, ...(/not debuggable/i.test(refusal) ? { notDebuggable: true } : {}) };
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textCell(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= MAX_CELL;
}

function validCell(value: unknown): value is AndroidDatabaseCell {
  if (value === null || textCell(value)) return true;
  // A large SQLite REAL may be integer-valued in JS; only the device cursor can distinguish it from INT64.
  if (typeof value === "number") return Number.isFinite(value);
  if (!record(value)) return false;
  if (value.type === "integer" && typeof value.value === "string" && /^-?(?:0|[1-9]\d{0,18})$/.test(value.value)) {
    const integer = BigInt(value.value);
    return integer >= -9223372036854775808n && integer <= 9223372036854775807n;
  }
  if (value.type === "blob" && typeof value.base64 === "string" && value.base64.length <= 4 * Math.ceil(MAX_CELL / 3)
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64)) {
    const bytes = Buffer.from(value.base64, "base64");
    return bytes.length <= MAX_CELL && bytes.toString("base64") === value.base64;
  }
  return false;
}

/** The protocol the bundled helper speaks; a mismatch means the DEX and the extension disagree. */
export const ANDROID_DATABASE_PROTOCOL = 2;

/**
 * Splits the helper's stdout into newline-terminated protocol lines. A line longer than `maxBytes` is never
 * buffered whole: the helper either answers within its bound or the session is broken.
 */
export class AndroidDatabaseLineReader {
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): Buffer[] {
    const lines: Buffer[] = [];
    let start = 0;
    for (let newline = chunk.indexOf(10, start); newline >= 0; newline = chunk.indexOf(10, start)) {
      this.append(chunk.subarray(start, newline));
      lines.push(Buffer.concat(this.pending, this.pendingBytes));
      this.pending = [];
      this.pendingBytes = 0;
      start = newline + 1;
    }
    if (start < chunk.length) this.append(chunk.subarray(start));
    return lines;
  }

  private append(part: Buffer): void {
    this.pendingBytes += part.length;
    if (this.pendingBytes > this.maxBytes) throw new Error(`exceeded the bounded response size (${this.maxBytes} bytes)`);
    if (part.length) this.pending.push(part);
  }
}

/** One request line. Requests never contain a raw newline: JSON escapes it inside strings. */
export function encodeAndroidDatabaseRequest(id: number, request: AndroidDatabaseRequest): string {
  const line = `${JSON.stringify({ id, ...request })}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_INPUT) throw new Error("The encoded inspector request exceeds 512 KiB.");
  return line;
}

/** A response line as JSON. Undecodable output or another request's id means the stream is out of step. */
function decodeLine(line: Buffer): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(line);
  } catch {
    throw new ProtocolError("The Android database inspector returned invalid UTF-8 instead of its protocol.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProtocolError(diagnostic("The Android database inspector returned invalid JSON", text.slice(0, 4096)).message);
  }
  if (!record(value)) throw new ProtocolError("The Android database inspector returned an invalid response envelope.");
  return value;
}

/** The helper's first line: its protocol version and PID, which a cancelled request's cleanup signals. */
export function parseAndroidDatabaseHello(line: Buffer): number {
  const hello = decodeLine(line);
  if (hello.ready !== true || hello.protocol !== ANDROID_DATABASE_PROTOCOL) {
    throw new ProtocolError(`The Android database inspector speaks protocol ${String(hello.protocol)}, not ${ANDROID_DATABASE_PROTOCOL}. Reinstall the extension.`);
  }
  const pid = hello.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1) throw new ProtocolError("The Android database inspector announced an invalid process ID.");
  return pid;
}

/** Raised when the helper's stream cannot be trusted any more; the session restarts the helper. */
class ProtocolError extends Error {}

export function parseAndroidDatabaseResponse(line: Buffer, id: number, request: AndroidDatabaseRequest): Record<string, unknown> {
  const response = decodeLine(line);
  if (typeof response.ok !== "boolean") throw new ProtocolError("The Android database inspector returned an invalid response envelope.");
  if (response.id !== id) throw new ProtocolError(`The Android database inspector answered request ${String(response.id)} instead of ${id}.`);
  if (!response.ok) {
    if (!textCell(response.error) || !response.error) throw new Error("The Android database inspector returned an invalid error response.");
    throw new Error(response.error);
  }
  let valid = false;
  switch (request.action) {
    case "databases":
      valid = Array.isArray(response.databases) && response.databases.every((database) => {
        try { validateDatabase(database); return true; } catch { return false; }
      });
      break;
    case "schema":
      valid = Array.isArray(response.objects) && response.objects.every((object: unknown) => record(object)
        && textCell(object.name) && typeof object.type === "string" && ["table", "view", "index", "trigger"].includes(object.type)
        && (object.sql === null || textCell(object.sql)));
      break;
    case "query": {
      const columns = response.columns;
      valid = Array.isArray(columns) && columns.length <= MAX_COLUMNS && columns.every(textCell)
        && typeof response.hasMore === "boolean" && Array.isArray(response.rows) && response.rows.length <= request.limit
        && response.rows.every((row: unknown) => Array.isArray(row) && row.length === columns.length && row.every(validCell));
      break;
    }
    case "execute":
      valid = typeof response.changes === "number" && Number.isSafeInteger(response.changes) && response.changes >= 0;
      break;
  }
  if (!valid) throw new Error(`The Android database inspector returned a malformed or oversized ${request.action} response; no partial data was accepted.`);
  return response;
}

/**
 * One running helper: `adb shell` → `run-as` → `app_process`, speaking newline-framed JSON over its pipes. Lines
 * are consumed strictly in order; any failure ends the process, and the session starts another for the next request.
 */
class InspectorProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly reader = new AndroidDatabaseLineReader(MAX_OUTPUT);
  private readonly lines: Buffer[] = [];
  private waiter: { resolve: (line: Buffer) => void; reject: (error: Error) => void } | undefined;
  private stderr = Buffer.alloc(0);
  private failure: Error | undefined;
  private exited = false;
  /** The helper's PID on the device, once it said hello. */
  pid: number | undefined;

  constructor(adb: string, args: string[], private readonly context: string) {
    this.child = spawn(adb, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    this.child.stdout.on("data", (chunk: Buffer) => {
      if (this.failure) return;
      let lines: Buffer[];
      try {
        lines = this.reader.push(chunk);
      } catch (error) {
        this.fail(new Error(`${this.context} ${error instanceof Error ? error.message : String(error)}. Select fewer rows/columns or smaller values; data was not silently truncated.`));
        return;
      }
      for (const line of lines) {
        const waiter = this.waiter;
        this.waiter = undefined;
        if (waiter) waiter.resolve(line);
        else this.lines.push(line);
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = Buffer.concat([this.stderr, chunk]).subarray(-16 * 1024);
    });
    // EPIPE often means run-as rejected the app. Wait for its useful diagnostic instead of masking it.
    this.child.stdin.on("error", () => {});
    this.child.once("error", (error) => {
      this.exited = true;
      this.fail(diagnostic(this.context, error.message));
    });
    this.child.once("close", (code, signal) => {
      this.exited = true;
      this.fail(diagnostic(this.context, this.stderr.toString("utf8") || `the database inspector exited with ${signal ?? code}`));
    });
  }

  get alive(): boolean {
    return this.failure === undefined;
  }

  send(line: string): void {
    if (this.failure) throw this.failure;
    this.child.stdin.write(line);
  }

  /** The next protocol line, or the reason the process can produce none. */
  next(signal: AbortSignal, timeout: number, timedOut: string): Promise<Buffer> {
    const queued = this.lines.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    if (signal.aborted) return Promise.reject(abortError());
    const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
    const settle = (error?: Error, line?: Buffer) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancelled);
      this.waiter = undefined;
      if (error) reject(error);
      else resolve(line!);
    };
    const cancelled = () => settle(abortError());
    const timer = setTimeout(() => settle(new Error(timedOut)), timeout);
    timer.unref();
    signal.addEventListener("abort", cancelled, { once: true });
    this.waiter = { resolve: (line) => settle(undefined, line), reject: (error) => settle(error) };
    return promise;
  }

  /**
   * End of input ends an idle helper by itself; the adb client is signalled after a grace period. Resolves once
   * the client is gone, or after a bounded wait for one that never reports closing.
   */
  async close(grace = 1_000): Promise<void> {
    this.fail(abortError());
    if (this.exited) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.child.once("close", () => resolve());
    this.child.stdin.end();
    const terminate = setTimeout(() => this.child.kill(), grace);
    const force = setTimeout(() => { this.child.kill("SIGKILL"); resolve(); }, grace + 1_000);
    terminate.unref();
    force.unref();
    await promise;
    clearTimeout(terminate);
    clearTimeout(force);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.reject(error);
  }
}

/**
 * Serialized, live SQLite access as one debuggable app and one pinned Android user. No database is copied.
 * One helper process serves every request of the session, so a request costs a pipe round trip rather than a VM
 * start; a helper that fails, times out or is cancelled is ended and the next request starts a fresh one.
 * dispose aborts running/queued requests, ends the helper and makes a bounded best-effort attempt to remove only this
 * session's DEX. Explicit writes do not notify in-process Room observers; cancellation cannot undo a committed write.
 */
export class AndroidDatabaseSession {
  private readonly options: AndroidDatabaseOptions;
  private readonly controller = new AbortController();
  private requests = new AbortController();
  private readonly token = randomBytes(16).toString("hex");
  private readonly directory = `cache/elide-database-${this.token}`;
  private readonly helper = `${this.directory}/inspector.dex`;
  private queue: Promise<void> = Promise.resolve();
  private readonly pending = new Set<(error: Error) => void>();
  private user: number | undefined;
  private installed = false;
  private installationAttempted = false;
  private process: InspectorProcess | undefined;
  private nextId = 0;

  constructor(options: AndroidDatabaseOptions) {
    validateConnection(options.adb, options.device);
    if (typeof options.packageName !== "string" || !PACKAGE_NAME.test(options.packageName)) throw new Error("Enter an Android application ID, such as com.example.app.");
    nonempty(options.helperDex, "bundled inspector.dex path");
    if (options.user !== undefined && !validUser(options.user)) throw new Error("Invalid Android user ID.");
    this.options = { ...options };
  }

  async databases(): Promise<string[]> {
    const response = await this.request({ action: "databases" });
    return response.databases as string[];
  }

  async schema(database: string): Promise<AndroidDatabaseObject[]> {
    validateDatabase(database);
    const response = await this.request({ action: "schema", database });
    return response.objects as AndroidDatabaseObject[];
  }

  async query(database: string, sql: string, limit = 100, offset = 0): Promise<AndroidDatabaseResult> {
    validateDatabase(database);
    validateSql(sql);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Query page size must be an integer between 1 and 500.");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_OFFSET) throw new Error("Query offset must be an integer between 0 and 1,000,000.");
    const response = await this.request({ action: "query", database, sql, limit, offset });
    return { columns: response.columns as string[], rows: response.rows as AndroidDatabaseCell[][], hasMore: response.hasMore as boolean };
  }

  async execute(database: string, sql: string): Promise<{ changes: number }> {
    validateDatabase(database);
    validateSql(sql);
    const response = await this.request({ action: "execute", database, sql });
    return { changes: response.changes as number };
  }

  private runAs(script: string): string[] {
    if (this.user === undefined) throw new Error("Resolve the Android user before using run-as.");
    return remoteArgs(this.options.device, ["run-as", this.options.packageName, "--user", String(this.user), "sh", "-c", script]);
  }

  private async prepare(signal: AbortSignal): Promise<void> {
    const { adb, device, helperDex } = this.options;
    const current = await currentUser(adb, device, signal);
    checkAbort(signal);
    if (this.user === undefined) {
      if (this.options.user !== undefined && this.options.user !== current) throw new Error(`Selected Android user ${this.options.user} is not the current user ${current}; select the current profile explicitly.`);
      this.user = current;
    } else if (current !== this.user) {
      throw new Error(`The current Android user changed from ${this.user} to ${current}. Close this database session and select the application again.`);
    }
    if (this.installed) return;
    const file = await stat(helperDex);
    checkAbort(signal);
    if (!file.isFile() || file.size === 0 || file.size > MAX_DEX) throw new Error("The bundled inspector.dex must be a nonempty regular file no larger than 16 MiB. Reinstall the extension.");
    // mkdir and noclobber prevent replacing existing code. chmod occurs before writing via the already-open fd,
    // as required by Android 14's dynamic-code-loading policy; the path is never made writable again.
    // A directory left behind by an install whose file the system later trimmed is emptied, never followed.
    const script = `set -eu; umask 077; d=${quote(this.directory)}; f=${quote(this.helper)}; if [ -L cache ] || [ -L "$d" ]; then printf '%s\\n' 'Refusing a symlinked app cache' >&2; exit 1; fi; mkdir -p cache; if [ -d "$d" ]; then rm -f "$f"; rmdir "$d"; fi; mkdir "$d"; trap 'rm -f "$f"; rmdir "$d"' EXIT; set -C; exec 3>"$f"; chmod 400 "$f"; cat >&3; exec 3>&-; trap - EXIT; printf '%s\\n' ${quote(`ELIDE_DATABASE_READY_${this.token}`)}`;
    this.installationAttempted = true;
    const output = await runAdb({ adb, args: this.runAs(script), signal, input: createReadStream(helperDex), context: `Installing the database inspector for ${this.options.packageName}`, maxOutput: 64 * 1024 });
    checkAbort(signal);
    if (output.trim() !== `ELIDE_DATABASE_READY_${this.token}`) throw diagnostic(`Could not install the database inspector for ${this.options.packageName}`, output);
    this.installed = true;
    // Installation is a separate process: do not launch the first query after a profile switch during streaming.
    if (await currentUser(adb, device, signal) !== this.user) throw new Error("The current Android user changed while installing the inspector. Close this database session and select the application again.");
    checkAbort(signal);
  }

  /** The running helper, or a new one once it said hello. */
  private async inspector(signal: AbortSignal, reinstall = true): Promise<InspectorProcess> {
    if (this.process?.alive) return this.process;
    const context = `Inspecting ${this.options.packageName} databases`;
    // Clearing the app's cache or storage deletes the helper; say so instead of letting app_process fail obscurely.
    const started = new InspectorProcess(this.options.adb,
      this.runAs(`[ -f ${quote(this.helper)} ] || { printf '%s\\n' ${HELPER_MISSING} >&2; exit 3; }; CLASSPATH=${quote(this.helper)} exec app_process / dev.elide.inspector.DatabaseInspector`), context);
    this.process = started;
    try {
      started.pid = parseAndroidDatabaseHello(await started.next(signal, REQUEST_TIMEOUT, `${context} timed out while starting the helper. Check the device connection.`));
    } catch (error) {
      this.stop(started, false);
      if (!reinstall || !(error instanceof Error) || !error.message.includes(HELPER_MISSING)) throw error;
      this.installed = false;
      await this.prepare(signal);
      checkAbort(signal);
      return this.inspector(signal, false);
    }
    return started;
  }

  /**
   * Ends a helper that cannot be trusted with another request. One still executing SQL does not read its input,
   * so it is signalled on the device; an idle one exits at end of input.
   */
  private stop(helper: InspectorProcess, busy: boolean): Promise<void> {
    if (this.process === helper) this.process = undefined;
    const closed = helper.close();
    const pid = helper.pid;
    if (!busy || pid === undefined || this.user === undefined) return closed;
    // Signal only the helper: a recycled PID that runs something else of the app is never touched.
    const kill = runAdb({
      adb: this.options.adb,
      args: this.runAs(`grep -q dev.elide.inspector.DatabaseInspector /proc/${pid}/cmdline 2>/dev/null && kill ${pid}; true`),
      context: "Stopping the database inspector", timeout: 3_000, maxOutput: 16 * 1024,
    }).then(() => undefined, () => undefined);
    return Promise.all([closed, kill]).then(() => undefined);
  }

  private request(request: AndroidDatabaseRequest): Promise<Record<string, unknown>> {
    const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
    if (this.controller.signal.aborted) {
      reject(abortError());
      return promise;
    }
    const signal = AbortSignal.any([this.controller.signal, this.requests.signal]);
    this.pending.add(reject);
    const operation = this.queue.then(async () => {
      checkAbort(signal);
      await this.prepare(signal);
      checkAbort(signal);
      const id = ++this.nextId;
      const line = encodeAndroidDatabaseRequest(id, request);
      const helper = await this.inspector(signal);
      checkAbort(signal);
      let response: Buffer;
      try {
        helper.send(line);
        response = await helper.next(signal, REQUEST_TIMEOUT,
          `Inspecting ${this.options.packageName} databases timed out. Check the device connection or simplify the SQL; a timed-out write may already have committed.`);
      } catch (error) {
        await this.stop(helper, true);
        throw error;
      }
      try {
        return parseAndroidDatabaseResponse(response, id, request);
      } catch (error) {
        if (error instanceof ProtocolError) await this.stop(helper, false);
        throw error;
      }
    });
    this.queue = operation.then((response) => {
      this.pending.delete(reject);
      resolve(response);
    }, (error: unknown) => {
      this.pending.delete(reject);
      reject(error);
    });
    return promise;
  }

  /**
   * Abandons the running and queued requests and stops the helper; the session stays open and the next request
   * starts a new helper. A write already sent may still commit.
   */
  cancel(): void {
    if (this.controller.signal.aborted) return;
    this.requests.abort();
    this.requests = new AbortController();
    for (const reject of this.pending) reject(abortError());
    this.pending.clear();
  }

  dispose(): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    for (const reject of this.pending) reject(abortError());
    this.pending.clear();
    if (!this.installationAttempted || this.user === undefined) return;
    // Cleanup deliberately targets the original user, even after a profile switch, and never executes the helper.
    void this.queue.then(async () => {
      const helper = this.process;
      if (helper) await this.stop(helper, false);
      try {
        await runAdb({ adb: this.options.adb, args: this.runAs(`rm -f ${quote(this.helper)}; rmdir ${quote(this.directory)}`), context: "Removing the private database inspector", timeout: 3_000, maxOutput: 16 * 1024 });
      } catch { /* Device disconnects and app removal make remote cleanup best-effort. */ }
    });
  }
}
