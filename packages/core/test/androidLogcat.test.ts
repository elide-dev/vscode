import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AndroidLogcatSession, androidLogcatArgs, parseAndroidPackageUid, type AndroidLogcatOptions } from "../src/androidLogcat.js";

const defaults: AndroidLogcatOptions = { adb: "/sdk with spaces/platform-tools/adb", device: "emulator-5554", priority: "I", text: "" };

describe("logcat arguments and package identity", () => {
  test("serials remain individual argv entries and filters do not become shell commands", () => {
    expect(androidLogcatArgs({ ...defaults, device: "serial; echo bad", text: "$(touch /tmp/bad)" })).toEqual([
      "-s", "serial; echo bad", "logcat", "-v", "threadtime", "*:I",
    ]);
    expect(androidLogcatArgs({ ...defaults, packageName: "com.example.app", priority: "W" }, 10123)).toContain("--uid=10123");
  });

  test("remote-shell package arguments are restricted before execution", () => {
    expect(() => androidLogcatArgs({ ...defaults, packageName: "com.example;id" }, 123)).toThrow("application ID");
    expect(() => androidLogcatArgs({ ...defaults, packageName: "com.example.app" })).toThrow("UID");
    expect(() => androidLogcatArgs(defaults, Number.NaN)).toThrow("UID");
    expect(() => androidLogcatArgs({ ...defaults, device: "" })).toThrow("device");
  });

  test("UID discovery matches exact packages and accepts secondary-user UIDs", () => {
    const output = "package:com.example.app.other uid:10001\r\npackage:com.example.app uid:1010012\r\n";
    expect(parseAndroidPackageUid(output, "com.example.app")).toBe(1010012);
    expect(parseAndroidPackageUid(output, "com.example")).toBeUndefined();
    expect(parseAndroidPackageUid("package:com.example.app uid:garbage", "com.example.app")).toBeUndefined();
    expect(parseAndroidPackageUid("package:com.example.app uid:9007199254740992", "com.example.app")).toBeUndefined();
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
  fs.writeFileSync(path.join(root, "stopped-" + process.pid), "yes");
  process.exit(0);
});
if (args.includes("shell")) {
  if (args.at(-1) === "com.example.slow") {
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
  process.stdout.write("unrelated\\nNEEDLE ");
  process.stdout.write(euro.subarray(0, 1));
  setImmediate(() => {
    process.stdout.write(euro.subarray(1));
    process.stdout.write("\\r\\nNeed");
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
  const watcher = watch(path.dirname(file), check);
  watcher.on("error", reject);
  const deadline = AbortSignal.timeout(3_000);
  const expired = () => reject(new Error(`Timed out waiting for ${file}`));
  deadline.addEventListener("abort", expired, { once: true });
  try {
    check();
    return await promise;
  } finally {
    watcher.close();
    deadline.removeEventListener("abort", expired);
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
    await session.start({ ...defaults, adb: fake.adb, packageName: "com.example.app", text: "needle" });
    expect(await completion).toBeUndefined();
    expect(lines).toEqual(["NEEDLE €", "Needle final"]);
    expect(fake.calls()).toEqual([
      ["-s", defaults.device, "shell", "cmd", "package", "list", "packages", "--user", "current", "-U", "com.example.app"],
      ["-s", defaults.device, "logcat", "-v", "threadtime", "--uid=10123", "*:I"],
    ]);
  });

  test("an absent app fails instead of leaking all-device logs", async () => {
    const fake = fixture();
    const session = new AndroidLogcatSession(() => { throw new Error("Unexpected log"); }, () => {});
    sessions.push(session);
    await expect(session.start({ ...defaults, adb: fake.adb, packageName: "com.example.missing" })).rejects.toThrow("not installed");
    expect(fake.calls()).toHaveLength(1);
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
    await waitForFile(path.join(fake.root, `stopped-${firstPid}`));
    rmSync(path.join(fake.root, "live"));
    await session.start(options);
    const secondPid = await waitForFile(path.join(fake.root, "live"));
    expect(secondPid).not.toBe(firstPid);
    session.dispose();
    await waitForFile(path.join(fake.root, `stopped-${secondPid}`));
    expect(endCount).toBe(0);
    await expect(session.start(options)).rejects.toThrow("disposed");
  });

  test("stop cancels pending UID discovery and never launches a stale stream", async () => {
    const fake = fixture();
    const session = new AndroidLogcatSession(() => {}, () => { throw new Error("Unexpected end notification"); });
    sessions.push(session);
    const pending = session.start({ ...defaults, adb: fake.adb, packageName: "com.example.slow" });
    const pid = await waitForFile(path.join(fake.root, "pending"));
    session.stop();
    await pending;
    await waitForFile(path.join(fake.root, `stopped-${pid}`));
    expect(fake.calls()).toHaveLength(1);
  });
});
