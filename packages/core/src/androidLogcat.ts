import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

export const ANDROID_LOGCAT_PRIORITIES = ["V", "D", "I", "W", "E", "F"] as const;
export type AndroidLogcatPriority = (typeof ANDROID_LOGCAT_PRIORITIES)[number];

export interface AndroidLogcatOptions {
  /** Absolute path of the selected SDK's adb executable. */
  adb: string;
  device: string;
  /** Absent means all applications. UID filtering also includes the app's secondary processes; before Android 12 only its main process is followed. */
  packageName?: string;
  priority: AndroidLogcatPriority;
  /** Case-insensitive literal substring, not a shell expression or regular expression. */
  text: string;
}

const run = promisify(execFile);
const PACKAGE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
/** AOSP logcat gained `--uid` in Android 12 and `--pid` in Android 7.0. */
const LOGCAT_UID_API = 31;
const LOGCAT_PID_API = 24;

/** What narrows logcat to one application: its UID, or on devices whose logcat lacks `--uid`, its main process. */
export type AndroidLogcatScope = { uid: number } | { pid: number };

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

/**
 * Arguments are passed directly to adb, never through the host shell. `since` is a `logcat -T` epoch time
 * (`seconds.millis`): the stream starts there instead of replaying the device's whole buffer.
 */
export function androidLogcatArgs(options: AndroidLogcatOptions, scope?: AndroidLogcatScope, since?: string): string[] {
  if (!options.device) throw new Error("Select an Android device for logcat.");
  if (!ANDROID_LOGCAT_PRIORITIES.includes(options.priority)) throw new Error("Invalid logcat priority.");
  if (options.packageName && !PACKAGE_NAME.test(options.packageName)) throw new Error("Enter an Android application ID, such as com.example.app.");
  if (options.packageName && scope === undefined) throw new Error("Resolve the application's installed UID or running process before starting logcat.");
  if (scope && "uid" in scope && (!Number.isSafeInteger(scope.uid) || scope.uid < 0)) throw new Error("Invalid Android application UID.");
  if (scope && "pid" in scope && (!Number.isSafeInteger(scope.pid) || scope.pid <= 0)) throw new Error("Invalid Android process ID.");
  if (since !== undefined && !/^\d+\.\d{3}$/.test(since)) throw new Error("Invalid logcat start time.");
  return ["-s", options.device, "logcat", "-v", "threadtime", ...(since === undefined ? [] : ["-T", since]),
    ...(scope === undefined ? [] : "uid" in scope ? [`--uid=${scope.uid}`] : [`--pid=${scope.pid}`]), `*:${options.priority}`];
}

/**
 * Device-side script printing the device clock and API level and, when `packageName` runs, its main process's `stat`
 * line, so the stream can start at that process's start: everything the running app logged, nothing from earlier
 * processes.
 */
export function androidLogcatClockScript(packageName?: string): string {
  if (packageName !== undefined && !PACKAGE_NAME.test(packageName)) throw new Error("Enter an Android application ID, such as com.example.app.");
  const clock = "echo \"now $(date +%s.%N)\"; echo \"uptime $(cat /proc/uptime)\"; echo \"tck $(getconf CLK_TCK 2>/dev/null)\"; echo \"sdk $(getprop ro.build.version.sdk)\"";
  return packageName === undefined ? clock
    : `${clock}; p=$(pidof -s ${packageName} 2>/dev/null); if [ -n "$p" ]; then echo "stat $(cat /proc/$p/stat 2>/dev/null)"; fi`;
}

function scriptField(output: string, name: string): string | undefined {
  return new RegExp(`^${name} (.*)$`, "m").exec(output)?.[1]?.trim();
}

/**
 * How a device whose logcat lacks `--uid` (before Android 12, API 31) follows `packageName`: by its running main
 * process, read from `androidLogcatClockScript(packageName)`'s output. Undefined on newer devices, or when the API
 * level is unreadable: resolve the UID instead. Throws when the device cannot filter the application now.
 */
export function androidLogcatProcessFallback(output: string, packageName: string): { pid: number; sdk: number } | undefined {
  const sdk = Number(scriptField(output, "sdk"));
  if (!Number.isSafeInteger(sdk) || sdk <= 0 || sdk >= LOGCAT_UID_API) return undefined;
  if (sdk < LOGCAT_PID_API) {
    throw new Error(`Logcat on Android API ${sdk} cannot filter by application (needs API ${LOGCAT_PID_API}). Remove package: with Elide: Filter Android Logcat to stream all applications.`);
  }
  const pid = Number(/^(\d+) \(/.exec(scriptField(output, "stat") ?? "")?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`${packageName} is not running. Logcat on Android API ${sdk} can only follow a running app process (application filtering needs API ${LOGCAT_UID_API}): start the app, then restart logcat.`);
  }
  return { pid, sdk };
}

/** Where a new stream starts, as a `logcat -T` epoch time: the running app's process start, or the device's now. */
export interface AndroidLogcatStart {
  since: string;
  from: "process" | "now";
}

/** A running stream. */
export interface AndroidLogcatStarted {
  /** Absent when the device clock was unreadable: the stream replays the device's buffer. */
  start?: AndroidLogcatStart;
  /** Set when the device's logcat lacks `--uid`: the stream follows only this process of the application. */
  process?: { pid: number; sdk: number };
}

/**
 * The `logcat -T` time to start from, read from `androidLogcatClockScript`'s output: the app process's start when it
 * runs, else the device's current time. Undefined when the device clock is unreadable.
 */
export function androidLogcatStart(output: string): AndroidLogcatStart | undefined {
  const now = Number(/^\d+(?:\.\d+)?/.exec(scriptField(output, "now") ?? "")?.[0]);
  if (!Number.isFinite(now) || now <= 0) return undefined;
  const seconds = (value: number) => (Math.floor(value * 1000) / 1000).toFixed(3);
  const uptime = Number(scriptField(output, "uptime")?.split(/\s+/)[0]);
  const tck = Number(scriptField(output, "tck") || 100);
  // Field 22 (starttime, in clock ticks since boot) follows the parenthesized command name, which may contain spaces.
  const stat = scriptField(output, "stat");
  const fields = stat && stat.includes(")") ? stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/) : [];
  const started = Number(fields[19]);
  if (Number.isFinite(uptime) && uptime > 0 && Number.isInteger(tck) && tck > 0 && Number.isSafeInteger(started) && started >= 0) {
    const start = now - uptime + started / tck;
    if (start > 0 && start <= now) return { since: seconds(start), from: "process" };
  }
  return { since: seconds(now), from: "now" };
}

/** What **Filter Android Logcat** edits: one line of `package:` and `level:` terms plus literal text. */
export type AndroidLogcatFilter = Pick<AndroidLogcatOptions, "packageName" | "priority" | "text">;

const PRIORITY_NAMES: Record<string, AndroidLogcatPriority> = {
  v: "V", verbose: "V", d: "D", debug: "D", i: "I", info: "I", w: "W", warn: "W", warning: "W", e: "E", error: "E", f: "F", fatal: "F", a: "F", assert: "F",
};
const PRIORITY_KEYWORDS: Record<AndroidLogcatPriority, string> = { V: "verbose", D: "debug", I: "info", W: "warn", E: "error", F: "fatal" };
const FILTER_TERM = /^(package|app|level|priority):(.*)$/i;

/**
 * Parses `package:com.example.app level:warn some text`. `package:` (or `app:`) names the application, absent for
 * all of them; `level:` (or `priority:`) the minimum priority, Info when absent; everything else is case-insensitive
 * literal text, with `"…"` quoting text that has a colon term, quotes or significant spaces.
 */
export function parseAndroidLogcatFilter(input: string): AndroidLogcatFilter | { error: string } {
  let packageName: string | undefined;
  let priority: AndroidLogcatPriority | undefined;
  const text: string[] = [];
  const token = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (let match = token.exec(input); match; match = token.exec(input)) {
    if (match[1] !== undefined) {
      if (match[1]) text.push(match[1].replace(/\\(.)/g, "$1"));
      continue;
    }
    const word = match[2]!;
    if (word.startsWith("\"")) return { error: "Close the quoted text with \"." };
    const term = FILTER_TERM.exec(word);
    if (!term) {
      text.push(word);
      continue;
    }
    const key = term[1]!.toLowerCase();
    const value = term[2]!;
    if (key === "package" || key === "app") {
      if (packageName !== undefined) return { error: "Name one application: `package:` appears twice." };
      if (!PACKAGE_NAME.test(value)) return { error: `\`${word}\` is not an application ID such as package:com.example.app; leave package: out for all applications.` };
      packageName = value;
    } else {
      if (priority !== undefined) return { error: "Give one minimum priority: `level:` appears twice." };
      priority = Object.hasOwn(PRIORITY_NAMES, value.toLowerCase()) ? PRIORITY_NAMES[value.toLowerCase()] : undefined;
      if (!priority) return { error: `\`${word}\` is not a priority; use level:verbose, debug, info, warn, error or fatal (or V/D/I/W/E/F).` };
    }
  }
  return { ...(packageName ? { packageName } : {}), priority: priority ?? "I", text: text.join(" ") };
}

/** The filter line `parseAndroidLogcatFilter` reads back as the same filter. */
export function formatAndroidLogcatFilter(filter: AndroidLogcatFilter): string {
  const terms = [...(filter.packageName ? [`package:${filter.packageName}`] : []), `level:${PRIORITY_KEYWORDS[filter.priority]}`];
  if (filter.text) {
    const plain = filter.text.split(" ").every((word) => word && !word.includes("\"") && !FILTER_TERM.test(word)) && !/\s/.test(filter.text.replaceAll(" ", ""));
    terms.push(plain ? filter.text : `"${filter.text.replace(/["\\]/g, "\\$&")}"`);
  }
  return terms.join(" ");
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

  /** Resolves after spawning adb, not after device-side reader attachment; undefined once superseded. */
  async start(options: AndroidLogcatOptions): Promise<AndroidLogcatStarted | undefined> {
    if (this.disposed) throw new Error("The logcat session has been disposed.");
    this.stop();
    const generation = this.generation;
    // Validate before invoking adb shell: adb itself joins remote shell arguments.
    if (options.packageName && !PACKAGE_NAME.test(options.packageName)) throw new Error("Enter an Android application ID, such as com.example.app.");
    const controller = new AbortController();
    this.pending = controller;
    let scope: AndroidLogcatScope | undefined;
    const started: AndroidLogcatStarted = {};
    try {
      // Read-only probes need no shutdown grace; execFile otherwise leaves a SIGTERM-resistant adb alive.
      const shell = (command: string[]) => run(options.adb, ["-s", options.device, "shell", ...command],
        { encoding: "utf8", signal: controller.signal, timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, windowsHide: true });
      // Without the device clock the stream still runs, as before, from the start of the buffer.
      const probe = await shell([androidLogcatClockScript(options.packageName)]).then(({ stdout }) => stdout,
        (error: unknown) => { if (controller.signal.aborted) throw error; return undefined; });
      started.start = probe === undefined ? undefined : androidLogcatStart(probe);
      if (options.packageName) {
        started.process = probe === undefined ? undefined : androidLogcatProcessFallback(probe, options.packageName);
        if (started.process) scope = { pid: started.process.pid };
        else {
          const { stdout } = await shell(["cmd", "package", "list", "packages", "--user", "current", "-U", options.packageName]);
          const uid = parseAndroidPackageUid(stdout, options.packageName);
          if (uid === undefined) throw new Error(`Application ${options.packageName} is not installed for the current Android user, or package UID discovery is unsupported.`);
          scope = { uid };
        }
      }
    } catch (error) {
      if (generation !== this.generation) return undefined;
      throw error;
    } finally {
      if (this.pending === controller) this.pending = undefined;
    }
    if (generation !== this.generation) return undefined;

    const child = spawn(options.adb, androidLogcatArgs(options, scope, started.start?.since), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
    return started;
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
