import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  androidWirelessDiagnostic, connectAndroidWireless, createAndroidWirelessQr, discoverAndroidWireless, pairAndroidWireless,
  validateAndroidWirelessEndpoint,
} from "../src/androidWireless.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** `adb connect` first checks that the address accepts TCP; a local listener stands in for the device. */
let device: Server;
let reachable = "";
beforeAll(async () => {
  device = createServer((socket) => socket.destroy());
  const { promise, resolve } = Promise.withResolvers<void>();
  device.listen(0, "127.0.0.1", () => resolve());
  await promise;
  reachable = `127.0.0.1:${(device.address() as AddressInfo).port}`;
});
afterAll(() => { device.close(); });

interface Behavior {
  stdout?: string;
  stderr?: string;
  exit?: number;
  echoSecret?: boolean;
  hang?: boolean;
  flood?: boolean;
}

function fixture(behavior: Behavior = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "elide wireless 'quoted' "));
  roots.push(root);
  const adb = path.join(root, "fake adb.cjs");
  writeFileSync(path.join(root, "behavior"), JSON.stringify(behavior));
  writeFileSync(adb, String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "behavior"), "utf8"));
fs.writeFileSync(path.join(__dirname, "args"), JSON.stringify(args));
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(path.join(__dirname, "input"), input);
  if (config.hang) { fs.writeFileSync(path.join(__dirname, "ready"), String(process.pid)); fs.watch(__dirname, () => {}); return; }
  if (config.flood) { process.stdout.write("x".repeat(300000)); return; }
  if (config.echoSecret) { console.error("error: rejected " + input.trim()); console.log(input.trim()); }
  const defaults = args[0] === "pair" ? "Enter pairing code: Successfully paired to " + args[1] + " [guid=adb-example]\n"
    : args[0] === "connect" ? "connected to " + args[1] + "\n" : "List of discovered mdns services\n";
  process.stdout.write(config.stdout ?? defaults);
  process.stderr.write(config.stderr ?? "");
  process.exitCode = config.exit ?? 0;
});
`);
  chmodSync(adb, 0o755);
  return { root, adb };
}

async function waitForFile(file: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const check = () => { if (existsSync(file) && readFileSync(file, "utf8")) resolve(); };
  const watcher = watch(path.dirname(file), check);
  watcher.on("error", reject);
  // Await the real subprocess event; this deadline only bounds a broken fixture, not its success path.
  const deadline = AbortSignal.timeout(3000);
  const expired = () => reject(new Error(`Timed out waiting for ${file}`));
  deadline.addEventListener("abort", expired, { once: true });
  try {
    check();
    await promise;
  } finally {
    deadline.removeEventListener("abort", expired);
    watcher.close();
  }
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (true) {
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error(`adb process ${pid} survived cancellation`);
    // Await real OS reaping rather than requiring an incidental SIGTERM handler to run.
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

const endpoint = "192.168.1.2:37123";

describe("wireless endpoints and QR payloads", () => {
  test("accepts explicit IPv4, DNS and bracketed IPv6 ports", () => {
    for (const value of [endpoint, "phone.local:1", "phone.local.:65535", "localhost:5555", "[::1]:5555", "[2001:db8::42]:12345", "[fe80::1%en0]:12345"]) {
      expect(validateAndroidWirelessEndpoint(value)).toBeUndefined();
    }
  });
  test("rejects missing ports, flags, malformed addresses and shell/control characters", () => {
    for (const value of ["", "phone", "phone:", "phone:0", "phone:65536", "phone:-1", "phone:1e3", "phone:123456", "phone:55 extra", " phone:55", "phone:55\n", "--help:55", "-s:55", "a..b:55", "a-.b:55", "999.1.1.1:55", "1.2.3:55", "::1:55", "[hello]:55", "[::1]", "phone;id:55", "$(id):55", "phone\u0000:55", "phone\u007f:55", "http://phone:55", "user@phone:55"]) {
      expect(validateAndroidWirelessEndpoint(value)).toBeString();
    }
  });
  test("creates fresh Android-compatible credentials with no payload delimiters", () => {
    const first = createAndroidWirelessQr();
    const second = createAndroidWirelessQr();
    expect(first.name).toMatch(/^studio-[a-z0-9]+$/i);
    expect(first.secret).toMatch(/^[a-z0-9]{16,}$/i);
    expect(first.payload).toBe(`WIFI:T:ADB;S:${first.name};P:${first.secret};;`);
    expect(first.name).not.toBe(second.name);
    expect(first.secret).not.toBe(second.secret);
  });
});

describe.skipIf(process.platform === "win32")("wireless adb subprocess behavior", () => {
  test("parses both TLS services, suffix periods and IPv6 while ignoring malformed and legacy rows", async () => {
    const fake = fixture({ stdout: [
      "List of discovered mdns services",
      `adb-device _adb-tls-pairing._tcp ${endpoint}`,
      "studio-exact.\t_adb-tls-pairing._tcp.\tphone.local:1234",
      "studio-exact-other _adb-tls-pairing._tcp phone.local:1235",
      "adb-device _adb-tls-connect._tcp [::1]:4567",
      `adb-device _adb-tls-pairing._tcp ${endpoint}`,
      "legacy _adb._tcp 192.168.1.2:5555",
      "wrong _adb-tls-pairing._tcp.local 192.168.1.2:5555",
      "invalid _adb-tls-connect._tcp --help:5555",
      "invalid _adb-tls-connect._tcp 192.168.1.2:0",
      "missing _adb-tls-connect._tcp",
      "extra _adb-tls-connect._tcp phone:5555 trailing",
      "bad\u0000name _adb-tls-connect._tcp phone:5555",
      ". _adb-tls-connect._tcp phone:5555",
    ].join("\r\n") });
    expect(await discoverAndroidWireless(fake.adb, new AbortController().signal)).toEqual([
      { name: "adb-device", type: "pairing", endpoint },
      { name: "studio-exact", type: "pairing", endpoint: "phone.local:1234" },
      { name: "studio-exact-other", type: "pairing", endpoint: "phone.local:1235" },
      { name: "adb-device", type: "connect", endpoint: "[::1]:4567" },
    ]);
    expect(JSON.parse(readFileSync(path.join(fake.root, "args"), "utf8"))).toEqual(["mdns", "services"]);
  });
  test("distinguishes empty discovery from an unsupported or failing mDNS command", async () => {
    const empty = fixture();
    expect(await discoverAndroidWireless(empty.adb, new AbortController().signal)).toEqual([]);
    for (const stdout of ["", "unknown command mdns", "error: mDNS unavailable", "List of discovered mdns services\nerror: backend failed"]) {
      const fake = fixture({ stdout });
      await expect(discoverAndroidWireless(fake.adb, new AbortController().signal)).rejects.toThrow();
    }
  });
  test("sends manual and QR secrets only through stdin and confirms successful pairing", async () => {
    for (const secret of ["012345", createAndroidWirelessQr().secret]) {
      const fake = fixture();
      await pairAndroidWireless(fake.adb, endpoint, secret, new AbortController().signal);
      expect(JSON.parse(readFileSync(path.join(fake.root, "args"), "utf8"))).toEqual(["pair", endpoint]);
      expect(readFileSync(path.join(fake.root, "input"), "utf8")).toBe(`${secret}\n`);
    }
  });
  test("never leaks an echoed secret on exit-zero or nonzero pairing failures, but reports what adb said", async () => {
    for (const exit of [0, 1]) {
      const secret = createAndroidWirelessQr().secret;
      const fake = fixture({ echoSecret: true, exit });
      const error = await pairAndroidWireless(fake.adb, endpoint, secret, new AbortController().signal).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(secret);
      expect(String(error)).toContain("error: rejected ******");
    }
    expect(androidWirelessDiagnostic("Enter pairing code: 123456\nFailed: Wrong password or connection was dropped.\n", "123456"))
      .toBe("****** Failed: Wrong password or connection was dropped.");
  });
  test("rejects exit-zero pairing refusal and unrecognized success output, quoting adb", async () => {
    for (const stdout of ["Failed to pair: wrong password", "Enter pairing code: error: protocol fault", "", "done"]) {
      const fake = fixture({ stdout });
      const error = await pairAndroidWireless(fake.adb, endpoint, "123456", new AbortController().signal).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      if (stdout) expect(String(error)).toContain(stdout.replace("Enter pairing code: ", ""));
      expect(String(error)).toContain("pairing port");
    }
  });
  test("accepts connected and already-connected responses but rejects exit-zero failures", async () => {
    for (const stdout of [`connected to ${reachable}`, `already connected to ${reachable}`]) {
      const fake = fixture({ stdout });
      await connectAndroidWireless(fake.adb, reachable, new AbortController().signal);
      expect(readFileSync(path.join(fake.root, "input"), "utf8")).toBe("");
    }
    for (const stdout of ["failed to connect: Connection refused", "cannot connect to device", "", "done"]) {
      const fake = fixture({ stdout });
      await expect(connectAndroidWireless(fake.adb, reachable, new AbortController().signal)).rejects.toThrow();
    }
    const fake = fixture({ stderr: "error: connection lost" });
    await expect(connectAndroidWireless(fake.adb, reachable, new AbortController().signal)).rejects.toThrow("error: connection lost");
  });
  test("an address that refuses connections fails at once, without running adb connect", async () => {
    const closed = createServer();
    const { promise, resolve } = Promise.withResolvers<void>();
    closed.listen(0, "127.0.0.1", () => resolve());
    await promise;
    const refused = `127.0.0.1:${(closed.address() as AddressInfo).port}`;
    closed.close();
    const fake = fixture();
    await expect(connectAndroidWireless(fake.adb, refused, new AbortController().signal)).rejects.toThrow("refused the connection");
    expect(existsSync(path.join(fake.root, "args"))).toBe(false);
  });
  test("rejects invalid inputs before starting adb", async () => {
    const fake = fixture();
    await expect(pairAndroidWireless(fake.adb, "--help", "123456", new AbortController().signal)).rejects.toThrow();
    await expect(connectAndroidWireless(fake.adb, "phone:0", new AbortController().signal)).rejects.toThrow();
    await expect(pairAndroidWireless(fake.adb, endpoint, "123456\nmore", new AbortController().signal)).rejects.toThrow();
    expect(existsSync(path.join(fake.root, "args"))).toBe(false);
  });
  test("pre-cancelled operations never spawn and active cancellation kills each subprocess", async () => {
    for (const operation of [
      (adb: string, signal: AbortSignal) => discoverAndroidWireless(adb, signal),
      (adb: string, signal: AbortSignal) => pairAndroidWireless(adb, endpoint, "123456", signal),
      (adb: string, signal: AbortSignal) => connectAndroidWireless(adb, reachable, signal),
    ]) {
      const fake = fixture({ hang: true });
      const stopped = new AbortController();
      stopped.abort();
      await expect(operation(fake.adb, stopped.signal)).rejects.toMatchObject({ name: "AbortError" });
      expect(existsSync(path.join(fake.root, "args"))).toBe(false);
      const active = new AbortController();
      const pending = operation(fake.adb, active.signal).catch((error: unknown) => error);
      await waitForFile(path.join(fake.root, "ready"));
      const pid = Number(readFileSync(path.join(fake.root, "ready"), "utf8"));
      active.abort();
      expect(await pending).toMatchObject({ name: "AbortError" });
      await waitForExit(pid);
    }
  });
  test("bounds subprocess output and reports unavailable executables without secrets", async () => {
    const fake = fixture({ flood: true });
    await expect(discoverAndroidWireless(fake.adb, new AbortController().signal)).rejects.toThrow("size limit");
    await expect(pairAndroidWireless(path.join(fake.root, "missing-adb"), endpoint, "123456", new AbortController().signal)).rejects.toThrow("Could not run adb");
  });
});
