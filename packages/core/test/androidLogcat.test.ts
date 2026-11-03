import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AndroidLogcatFormatter, AndroidLogcatSession, androidLogcatArgs, androidLogcatClockScript, androidLogcatProcessFallback, androidLogcatStart,
  formatAndroidLogcatFilter, parseAndroidLogcatFilter, parseAndroidLogcatLine, parseAndroidPackageUid, type AndroidLogcatOptions,
} from "../src/androidLogcat.js";

const defaults: AndroidLogcatOptions = { adb: "/sdk with spaces/platform-tools/adb", device: "emulator-5554", priority: "I", text: "" };

describe("logcat arguments and package identity", () => {
  test("serials remain individual argv entries and filters do not become shell commands", () => {
    expect(androidLogcatArgs({ ...defaults, device: "serial; echo bad", text: "$(touch /tmp/bad)" })).toEqual([
      "-s", "serial; echo bad", "logcat", "-v", "threadtime", "*:I",
    ]);
    expect(androidLogcatArgs({ ...defaults, packageName: "com.example.app", priority: "W" }, { uid: 10123 })).toContain("--uid=10123");
    expect(androidLogcatArgs({ ...defaults, packageName: "com.example.app" }, { pid: 4242 })).toEqual([
      "-s", "emulator-5554", "logcat", "-v", "threadtime", "--pid=4242", "*:I",
    ]);
    expect(androidLogcatArgs(defaults, undefined, "1792192635.684")).toEqual([
      "-s", "emulator-5554", "logcat", "-v", "threadtime", "-T", "1792192635.684", "*:I",
    ]);
    expect(() => androidLogcatArgs(defaults, undefined, "1; id")).toThrow("start time");
  });

  test("remote-shell package arguments are restricted before execution", () => {
    expect(() => androidLogcatArgs({ ...defaults, packageName: "com.example;id" }, { uid: 123 })).toThrow("application ID");
    expect(() => androidLogcatArgs({ ...defaults, packageName: "com.example.app" })).toThrow("UID");
    expect(() => androidLogcatArgs(defaults, { uid: Number.NaN })).toThrow("UID");
    expect(() => androidLogcatArgs(defaults, { pid: 0 })).toThrow("process ID");
    expect(() => androidLogcatArgs({ ...defaults, device: "" })).toThrow("device");
  });

  test("UID discovery matches exact packages and accepts secondary-user UIDs", () => {
    const output = "package:com.example.app.other uid:10001\r\npackage:com.example.app uid:1010012\r\n";
    expect(parseAndroidPackageUid(output, "com.example.app")).toBe(1010012);
    expect(parseAndroidPackageUid(output, "com.example")).toBeUndefined();
    expect(parseAndroidPackageUid("package:com.example.app uid:garbage", "com.example.app")).toBeUndefined();
    expect(parseAndroidPackageUid("package:com.example.app uid:9007199254740992", "com.example.app")).toBeUndefined();
  });

  test("devices whose logcat lacks --uid (before API 31) follow the app's running process, or explain why not", () => {
    const stat = "stat 4242 (com.example.app) S 1 2 3";
    expect(androidLogcatClockScript()).toContain("getprop ro.build.version.sdk");
    expect(androidLogcatProcessFallback(`now 2000\nsdk 31\n${stat}\n`, "com.example.app")).toBeUndefined();
    // An unreadable level keeps UID discovery, which reports its own failure.
    expect(androidLogcatProcessFallback(`now 2000\nsdk \n${stat}\n`, "com.example.app")).toBeUndefined();
    expect(androidLogcatProcessFallback(`now 2000\nsdk 30\n${stat}\n`, "com.example.app")).toEqual({ pid: 4242, sdk: 30 });
    expect(androidLogcatProcessFallback(`sdk 24\n${stat}`, "com.example.app")).toEqual({ pid: 4242, sdk: 24 });
    expect(() => androidLogcatProcessFallback("now 2000\nsdk 28\n", "com.example.app")).toThrow("com.example.app is not running");
    expect(() => androidLogcatProcessFallback("now 2000\nsdk 28\nstat garbage\n", "com.example.app")).toThrow("not running");
    expect(() => androidLogcatProcessFallback(`sdk 23\n${stat}`, "com.example.app")).toThrow("needs API 24");
  });

  test("a new stream starts at the running app's process start, else now, never at the buffer's start", () => {
    expect(() => androidLogcatClockScript("com.example;id")).toThrow("application ID");
    expect(androidLogcatClockScript()).not.toContain("pidof");
    expect(androidLogcatClockScript("com.example.app")).toContain("pidof -s com.example.app");
    // Booted 1000 s ago; the process started 900 s after boot (90000 ticks at 100 Hz). Its name contains spaces.
    const stat = "4242 (com.exa mple) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 90000 19";
    expect(androidLogcatStart(`now 2000.5\nuptime 1000.25 3000.00\ntck 100\nstat ${stat}\n`)).toEqual({ since: "1900.250", from: "process" });
    expect(androidLogcatStart("now 2000.123456789\nuptime 1000.25 3000.00\ntck 100\n")).toEqual({ since: "2000.123", from: "now" });
    // Missing CLK_TCK means Android's 100 Hz; a malformed stat falls back to now.
    expect(androidLogcatStart(`now 2000\nuptime 1000 1\ntck \nstat ${stat}`)?.since).toBe("1900.000");
    expect(androidLogcatStart("now 2000\nuptime 1000 1\ntck 100\nstat garbage")).toEqual({ since: "2000.000", from: "now" });
    expect(androidLogcatStart("now %s.%N\n")).toBeUndefined();
  });

  test("one filter line carries the application, minimum priority and literal text", () => {
    expect(parseAndroidLogcatFilter("package:com.example.app level:warn Fatal Exception")).toEqual({ packageName: "com.example.app", priority: "W", text: "Fatal Exception" });
    expect(parseAndroidLogcatFilter("")).toEqual({ priority: "I", text: "" });
    expect(parseAndroidLogcatFilter("APP:com.example.app priority:E")).toEqual({ packageName: "com.example.app", priority: "E", text: "" });
    expect(parseAndroidLogcatFilter(`level:v "package:not.a.filter  x" http://host "say \\"hi\\""`)).toEqual({ priority: "V", text: `package:not.a.filter  x http://host say "hi"` });
    for (const [input, error] of [["package:com.example;id", "application ID"], ["level:loud", "not a priority"],
      ["level:constructor", "not a priority"], ["priority:__proto__", "not a priority"], ["package:a.b package:c.d", "twice"],
      ["level:e level:w", "twice"], ["\"unclosed text", "Close"]]) {
      expect(parseAndroidLogcatFilter(input!)).toEqual({ error: expect.stringContaining(error!) });
    }
  });

  test("the formatted filter reads back as the same filter", () => {
    const filters = [
      { priority: "I" as const, text: "" },
      { packageName: "com.example.app", priority: "D" as const, text: "two words" },
      { priority: "F" as const, text: "level:error" },
      { priority: "W" as const, text: "  padded  " },
      { priority: "E" as const, text: "quote \" and back\\slash" },
    ];
    for (const filter of filters) expect(parseAndroidLogcatFilter(formatAndroidLogcatFilter(filter))).toEqual(filter);
    expect(formatAndroidLogcatFilter({ packageName: "com.example.app", priority: "W", text: "Exception" })).toBe("package:com.example.app level:warn Exception");
  });
});

describe("logcat formatting", () => {
  const record = (pid: string, tid: string, priority: string, tag: string, message: string) =>
    `10-13 12:00:00.123 ${pid.padStart(5)} ${tid.padStart(5)} ${priority} ${tag.padEnd(8)}: ${message}`;

  test("threadtime fields survive tags with colons and empty messages", () => {
    expect(parseAndroidLogcatLine(record("1", "2", "W", "a:b", "x: y"))).toEqual({ time: "10-13 12:00:00.123", pid: "1", tid: "2", priority: "W", tag: "a:b", message: "x: y" });
    expect(parseAndroidLogcatLine("10-13 12:00:00.123   1   2 I Tag     :")?.message).toBe("");
    expect(parseAndroidLogcatLine("--------- beginning of main")).toBeUndefined();
  });

  test("messages share one column across tag and ID lengths", () => {
    const formatter = new AndroidLogcatFormatter();
    const lines = [
      formatter.format(record("1", "2", "I", "A", "short")),
      formatter.format(record("12345", "12367", "E", "AVeryLongTagThatExceedsTheLimit", "long")),
    ];
    expect(lines[1]).toContain("AVeryLongTagThatExceed…  E  long");
    expect(lines[0]!.indexOf("short")).toBe(lines[1]!.indexOf("long"));
    // Wider IDs widen later rows only; rows after them stay aligned with each other.
    const wide = formatter.format(record("1234567", "2", "I", "A", "wide"));
    expect(formatter.format(record("1", "2", "D", "A", "after")).indexOf("after")).toBe(wide.indexOf("wide"));
  });

  test("continuations indent under their record until the header or stream changes", () => {
    const formatter = new AndroidLogcatFormatter();
    const first = formatter.format(record("10", "11", "E", "AndroidRuntime", "FATAL EXCEPTION: main"));
    const frame = formatter.format(record("10", "11", "E", "AndroidRuntime", "\tat app.Main.run(Main.kt:12)"));
    expect(frame).toBe(`${" ".repeat(first.indexOf("FATAL"))}\tat app.Main.run(Main.kt:12)`);
    expect(formatter.format(record("10", "11", "W", "AndroidRuntime", "next"))).toStartWith("10-13 ");
    expect(formatter.format("--------- beginning of crash")).toBe("--------- beginning of crash");
    expect(formatter.format(record("10", "11", "W", "AndroidRuntime", "again"))).toStartWith("10-13 ");
    formatter.reset();
    expect(formatter.format(record("10", "11", "W", "AndroidRuntime", "again"))).toStartWith("10-13 ");
  });
});

const roots: string[] = [];
const sessions: AndroidLogcatSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A real child process exercising argv, pipe framing and signals, without an attached device. */
function fixture(): { adb: string; root: string; calls: () => string[][] } {
  const root = mkdtempSync(path.join(tmpdir(), "elide logcat-"));
  roots.push(root);
  const adb = path.join(root, "fake adb.cjs");
  writeFileSync(adb, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const root = __dirname;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, "calls"), JSON.stringify(args) + "\\n");
process.on("SIGTERM", () => {
  if (args.at(-1) === "com.example.stubborn") return;
  process.exit(0);
});
if (args.includes("shell") && args.at(-1).includes("date +%s")) {
  console.log("now 2000.5");
  console.log("uptime 1000.25 3000.00");
  console.log("tck 100");
  console.log("sdk " + ((/^api(\\d+)$/.exec(args[1]) || [])[1] || 34));
  if (args.at(-1).includes("pidof -s com.example.app")) console.log("stat 4242 (com.example.app) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 90000 19");
} else if (args.includes("shell")) {
  if (args.at(-1) === "com.example.slow" || args.at(-1) === "com.example.stubborn") {
    fs.writeFileSync(path.join(root, "pending"), String(process.pid));
    fs.watch(root, () => {});
  } else {
    console.log("package:com.example.app.extra uid:9000");
    if (args.at(-1) === "com.example.app") console.log("package:com.example.app uid:10123");
  }
} else if (args[1] === "offline") {
  console.error("error: device offline");
  process.exitCode = 1;
} else if (args[1] === "live") {
  fs.writeFileSync(path.join(root, "live"), String(process.pid));
  console.log("live line");
  fs.watch(root, () => {});
} else {
  const euro = Buffer.from("€");
  // Each write also carries whole characters: under Bun, a stdout read holding only part of one can stall the pipe.
  process.stdout.write(Buffer.concat([Buffer.from("unrelated\\nNEEDLE "), euro.subarray(0, 1)]));
  setImmediate(() => {
    process.stdout.write(Buffer.concat([euro.subarray(1), Buffer.from("\\r\\nNeed")]));
    setImmediate(() => process.stdout.write("le final"));
  });
}
`);
  chmodSync(adb, 0o755);
  return {
    adb,
    root,
    calls: () => existsSync(path.join(root, "calls")) ? readFileSync(path.join(root, "calls"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]) : [],
  };
}

async function waitForFile(file: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const check = () => {
    if (!existsSync(file)) return;
    const contents = readFileSync(file, "utf8");
    if (contents) resolve(contents);
  };
  // Marker contents persist; directory events can be coalesced before the write completes.
  watchFile(file, { interval: 10 }, check);
  const deadline = AbortSignal.timeout(3_000);
  const expired = () => reject(new Error(`Timed out waiting for ${file}`));
  deadline.addEventListener("abort", expired, { once: true });
  try {
    check();
    return await promise;
  } finally {
    unwatchFile(file, check);
    deadline.removeEventListener("abort", expired);
  }
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error(`adb process ${pid} survived cancellation`);
    // Let the OS reap the real child; fake timers cannot advance a subprocess exit.
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

// The fixture uses a POSIX executable; argument and identity tests above also run on Windows.
describe.skipIf(process.platform === "win32")("owned adb streams", () => {
  test("resolves a UID, frames UTF-8 chunks and filters literal text case-insensitively", async () => {
    const fake = fixture();
    const lines: string[] = [];
    const { promise: completion, resolve: ended } = Promise.withResolvers<Error | undefined>();
    const session = new AndroidLogcatSession((line) => lines.push(line), ended);
    sessions.push(session);
    expect(await session.start({ ...defaults, adb: fake.adb, packageName: "com.example.app", text: "needle" })).toEqual({ start: { since: "1900.250", from: "process" } });
    expect(await completion).toBeUndefined();
    expect(lines).toEqual(["NEEDLE €", "Needle final"]);
    expect(fake.calls()).toEqual([
      ["-s", defaults.device, "shell", androidLogcatClockScript("com.example.app")],
      ["-s", defaults.device, "shell", "cmd", "package", "list", "packages", "--user", "current", "-U", "com.example.app"],
      ["-s", defaults.device, "logcat", "-v", "threadtime", "-T", "1900.250", "--uid=10123", "*:I"],
    ]);
  });

  test("before API 31 a running app is followed by its process ID, never by an unsupported --uid", async () => {
    const fake = fixture();
    const { promise: completion, resolve: ended } = Promise.withResolvers<Error | undefined>();
    const session = new AndroidLogcatSession(() => {}, ended);
    sessions.push(session);
    const options = { ...defaults, adb: fake.adb, device: "api30", packageName: "com.example.app" };
    expect(await session.start(options)).toEqual({ start: { since: "1900.250", from: "process" }, process: { pid: 4242, sdk: 30 } });
    expect(await completion).toBeUndefined();
    expect(fake.calls()).toEqual([
      ["-s", "api30", "shell", androidLogcatClockScript("com.example.app")],
      ["-s", "api30", "logcat", "-v", "threadtime", "-T", "1900.250", "--pid=4242", "*:I"],
    ]);
  });

  test("before API 31 a stopped app, and before API 24 any app, fails with the reason instead of streaming", async () => {
    const fake = fixture();
    const session = new AndroidLogcatSession(() => { throw new Error("Unexpected log"); }, () => {});
    sessions.push(session);
    await expect(session.start({ ...defaults, adb: fake.adb, device: "api30", packageName: "com.example.missing" })).rejects.toThrow("com.example.missing is not running");
    await expect(session.start({ ...defaults, adb: fake.adb, device: "api23", packageName: "com.example.app" })).rejects.toThrow("needs API 24");
    expect(fake.calls().every((call) => call.includes("shell"))).toBe(true);
    expect(session.active).toBe(false);
  });

  test("an absent app fails instead of leaking all-device logs", async () => {
    const fake = fixture();
    const session = new AndroidLogcatSession(() => { throw new Error("Unexpected log"); }, () => {});
    sessions.push(session);
    await expect(session.start({ ...defaults, adb: fake.adb, packageName: "com.example.missing" })).rejects.toThrow("not installed");
    expect(fake.calls()).toHaveLength(2);
  });

  test("reports device failures and executable launch errors", async () => {
    const fake = fixture();
    for (const options of [{ ...defaults, adb: fake.adb, device: "offline" }, { ...defaults, adb: path.join(fake.root, "missing-adb") }]) {
      const { promise: completion, resolve: ended } = Promise.withResolvers<Error | undefined>();
      const session = new AndroidLogcatSession(() => {}, ended);
      sessions.push(session);
      await session.start(options);
      const error = await completion;
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toMatch(options.device === "offline" ? /device offline/ : /ENOENT/);
    }
  });

  test("stop kills the stream without reporting an intentional exit; restart owns a new process", async () => {
    const fake = fixture();
    let endCount = 0;
    const session = new AndroidLogcatSession(() => {}, () => { endCount++; });
    sessions.push(session);
    const options = { ...defaults, adb: fake.adb, device: "live" };
    await session.start(options);
    const firstPid = await waitForFile(path.join(fake.root, "live"));
    session.stop();
    await waitForExit(Number(firstPid));
    rmSync(path.join(fake.root, "live"));
    await session.start(options);
    const secondPid = await waitForFile(path.join(fake.root, "live"));
    expect(secondPid).not.toBe(firstPid);
    session.dispose();
    await waitForExit(Number(secondPid));
    expect(endCount).toBe(0);
    await expect(session.start(options)).rejects.toThrow("disposed");
  });

  test("stop and disposal cancel UID discovery even when adb ignores SIGTERM", async () => {
    for (const packageName of ["com.example.slow", "com.example.stubborn"]) {
      const fake = fixture();
      const session = new AndroidLogcatSession(() => {}, () => { throw new Error("Unexpected end notification"); });
      sessions.push(session);
      const pending = session.start({ ...defaults, adb: fake.adb, packageName });
      const pid = Number(await waitForFile(path.join(fake.root, "pending")));
      try {
        if (packageName.endsWith("stubborn")) session.dispose();
        else session.stop();
        expect(await pending).toBeUndefined();
        await waitForExit(pid);
        expect(session.active).toBe(false);
        expect(fake.calls()).toHaveLength(2);
      } finally {
        try { process.kill(pid, "SIGKILL"); } catch { /* Already reaped. */ }
      }
    }
  });
});
