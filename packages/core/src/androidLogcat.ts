import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

export const ANDROID_LOGCAT_PRIORITIES = ["V", "D", "I", "W", "E", "F"] as const;
export type AndroidLogcatPriority = (typeof ANDROID_LOGCAT_PRIORITIES)[number];

export interface AndroidLogcatOptions {
  /** Absolute path of the selected SDK's adb executable. */
  adb: string;
  device: string;
  /** Absent means all applications. UID filtering also includes the app's secondary processes. */
  packageName?: string;
  priority: AndroidLogcatPriority;
  /** Case-insensitive literal substring, not a shell expression or regular expression. */
  text: string;
}

const run = promisify(execFile);
const PACKAGE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;

/** Match the exact package, not another package returned by Android's substring search. */
export function parseAndroidPackageUid(output: string, packageName: string): number | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = /^package:(\S+)\s+uid:(\d+)\s*$/.exec(line.trim());
    if (match?.[1] !== packageName) continue;
    const uid = Number(match[2]);
    if (Number.isSafeInteger(uid) && uid >= 0) return uid;
  }
  return undefined;
}

/** Arguments are passed directly to adb, never through the host shell. */
export function androidLogcatArgs(options: AndroidLogcatOptions, uid?: number): string[] {
  if (!options.device) throw new Error("Select an Android device for logcat.");
  if (!ANDROID_LOGCAT_PRIORITIES.includes(options.priority)) throw new Error("Invalid logcat priority.");
  if (options.packageName && !PACKAGE_NAME.test(options.packageName)) throw new Error("Enter an Android application ID, such as com.example.app.");
  if (options.packageName && uid === undefined) throw new Error("Resolve the application's installed UID before starting logcat.");
  if (uid !== undefined && (!Number.isSafeInteger(uid) || uid < 0)) throw new Error("Invalid Android application UID.");
  return ["-s", options.device, "logcat", "-v", "threadtime", ...(uid === undefined ? [] : [`--uid=${uid}`]), `*:${options.priority}`];
}

/** One `threadtime` record. Multi-line messages arrive as one record per line, each with the same header. */
export interface AndroidLogcatEntry {
  /** `MM-DD HH:MM:SS.mmm`, device-local. */
  time: string;
  pid: string;
  tid: string;
  priority: AndroidLogcatPriority;
  tag: string;
  message: string;
}

const THREADTIME = /^(\d\d-\d\d\s+\d\d:\d\d:\d\d\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+(.*?)\s*:(?: (.*))?$/;

export function parseAndroidLogcatLine(line: string): AndroidLogcatEntry | undefined {
  const match = THREADTIME.exec(line);
  if (!match) return undefined;
  return {
    time: match[1]!.replace(/\s+/, " "),
    pid: match[2]!,
    tid: match[3]!,
    priority: match[4] as AndroidLogcatPriority,
    tag: match[5]!,
    message: match[6] ?? "",
  };
}

/** Android's historical tag limit; longer tags are shortened so every message starts in the same column. */
export const ANDROID_LOGCAT_TAG_WIDTH = 23;

/**
 * Aligns `threadtime` lines into `time  pid-tid  tag  priority  message` columns. A line continuing the previous
 * record (same time, thread, priority and tag) shows only its message, indented, so stack traces read as one block.
 * PID/TID columns only ever widen, keeping later lines aligned when a device reports longer IDs.
 * Lines that are not log records (buffer separators, adb notices) pass through unchanged.
 */
export class AndroidLogcatFormatter {
  private previous: string | undefined;
  private pidWidth = 5;
  private tidWidth = 5;

  format(line: string): string {
    const entry = parseAndroidLogcatLine(line);
    if (!entry) {
      this.previous = undefined;
      return line;
    }
    this.pidWidth = Math.max(this.pidWidth, entry.pid.length);
    this.tidWidth = Math.max(this.tidWidth, entry.tid.length);
    const tag = entry.tag.length > ANDROID_LOGCAT_TAG_WIDTH
      ? `${entry.tag.slice(0, ANDROID_LOGCAT_TAG_WIDTH - 1)}…`
      : entry.tag.padEnd(ANDROID_LOGCAT_TAG_WIDTH);
    const header = `${entry.time}  ${entry.pid.padStart(this.pidWidth)}-${entry.tid.padEnd(this.tidWidth)}  ${tag}  ${entry.priority}  `;
    const key = `${entry.time}\0${entry.pid}\0${entry.tid}\0${entry.priority}\0${entry.tag}`;
    const continuation = key === this.previous;
    this.previous = key;
    return `${continuation ? " ".repeat(header.length) : header}${entry.message}`;
  }

  /** The next record starts a new block, e.g. after a notice line or when the stream restarts. */
  reset(): void {
    this.previous = undefined;
  }
}

/** One owned adb stream; stopping also cancels in-flight package discovery. */
export class AndroidLogcatSession {
  private process: ChildProcess | undefined;
  private pending: AbortController | undefined;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onEnd: (error?: Error) => void,
  ) {}

  /** Resolving the application or streaming; false once stopped or after the stream ends. */
  get active(): boolean {
    return this.process !== undefined || this.pending !== undefined;
  }

  async start(options: AndroidLogcatOptions): Promise<void> {
    if (this.disposed) throw new Error("The logcat session has been disposed.");
    this.stop();
    const generation = this.generation;
    // Validate before invoking adb shell: adb itself joins remote shell arguments.
    if (options.packageName && !PACKAGE_NAME.test(options.packageName)) throw new Error("Enter an Android application ID, such as com.example.app.");
    const controller = new AbortController();
    this.pending = controller;
    let uid: number | undefined;
    try {
      if (options.packageName) {
        const { stdout } = await run(
          options.adb,
          ["-s", options.device, "shell", "cmd", "package", "list", "packages", "--user", "current", "-U", options.packageName],
          { encoding: "utf8", signal: controller.signal, timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true },
        );
        uid = parseAndroidPackageUid(stdout, options.packageName);
        if (uid === undefined) throw new Error(`Application ${options.packageName} is not installed for the current Android user, or package UID discovery is unsupported.`);
      }
    } catch (error) {
      if (generation !== this.generation) return;
      throw error;
    } finally {
      if (this.pending === controller) this.pending = undefined;
    }
    if (generation !== this.generation) return;

    const child = spawn(options.adb, androidLogcatArgs(options, uid), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.process = child;
    const text = options.text.toLocaleLowerCase();
    let remainder = "";
    let stderr = "";
    let ended = false;
    const emit = (line: string) => {
      if (generation === this.generation && (!text || line.toLocaleLowerCase().includes(text))) this.onLine(line);
    };
    const finish = (error?: Error) => {
      if (ended) return;
      ended = true;
      if (generation !== this.generation) return;
      if (remainder) emit(remainder);
      this.process = undefined;
      this.onEnd(error);
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (generation !== this.generation) return;
      remainder += chunk;
      let newline = remainder.indexOf("\n");
      while (newline >= 0) {
        emit(remainder.slice(0, newline).replace(/\r$/, ""));
        remainder = remainder.slice(newline + 1);
        newline = remainder.indexOf("\n");
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      finish(code === 0 ? undefined : new Error(stderr.trim() || `adb logcat exited with ${signal ? `signal ${signal}` : `code ${code}`}.`));
    });
  }

  stop(): void {
    this.generation++;
    this.pending?.abort();
    this.pending = undefined;
    const child = this.process;
    this.process = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    // adb normally exits on SIGTERM; still reap an unresponsive client on extension shutdown.
    const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
    force.unref();
    child.once("close", () => clearTimeout(force));
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }
}
