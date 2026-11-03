import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect as connectTcp, isIP } from "node:net";

export interface AndroidWirelessService {
  name: string;
  type: "pairing" | "connect";
  endpoint: string;
}

/** Requires the distinct pairing/connection port shown by Wireless debugging, never adb's default port. */
export function validateAndroidWirelessEndpoint(value: string): string | undefined {
  const invalid = "Enter a hostname, IPv4 address, or bracketed IPv6 address with an explicit port (1–65535).";
  if (typeof value !== "string" || /[\s\u0000-\u001f\u007f]/.test(value)) return invalid;
  const match = /^(\[[^\]]+\]|[^:]+):([0-9]{1,5})$/.exec(value);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return invalid;
  const host = match[1]!;
  if (host.startsWith("[")) return isIP(host.slice(1, -1)) === 6 ? undefined : invalid;
  if (/^[0-9.]+$/.test(host)) return isIP(host) === 4 ? undefined : invalid;
  const hostname = host.endsWith(".") ? host.slice(0, -1) : host;
  if (hostname.length > 253 || !hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return invalid;
  return undefined;
}

/** Hex is alphanumeric, cryptographically random, and needs no escaping in the Android WIFI payload. */
export function createAndroidWirelessQr(): { name: string; secret: string; payload: string } {
  const name = `studio-${randomBytes(16).toString("hex")}`;
  const secret = randomBytes(16).toString("hex");
  return { name, secret, payload: `WIFI:T:ADB;S:${name};P:${secret};;` };
}

function abortError(): Error {
  const error = new Error("Android wireless operation cancelled.");
  error.name = "AbortError";
  return error;
}

const MAX_OUTPUT = 256 * 1024;
const DISCOVERY_TIMEOUT = 10_000;
const PAIR_TIMEOUT = 30_000;
const CONNECT_TIMEOUT = 15_000;
const REACH_TIMEOUT = 5_000;

/**
 * What adb printed, for an error message: its pairing prompt dropped and the pairing code masked wherever adb (or a
 * wrapper) echoed it, so the code never reaches the UI.
 */
export function androidWirelessDiagnostic(output: string, secret?: string): string {
  let text = output.replace(/Enter pairing code:\s*/gi, "");
  if (secret) text = text.replaceAll(secret, "******");
  return text.replace(/\s+/g, " ").trim().slice(0, 2048);
}

interface AdbOptions {
  /** Written to stdin, never to argv, the environment or an error. */
  secret?: string;
  timeout: number;
  timedOut: string;
}

function runAdb(adb: string, args: string[], signal: AbortSignal, options: AdbOptions): Promise<string> {
  if (signal.aborted) return Promise.reject(abortError());
  if (!adb || /[\u0000-\u001f\u007f]/.test(adb)) return Promise.reject(new Error("Invalid adb executable path."));
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(adb, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    return Promise.reject(new Error("Could not run adb for wireless debugging. Check the Android SDK Platform-Tools installation."));
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let settled = false;
  let inputFailed = false;
  const finish = (error?: Error, value = "") => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", cancelled);
    if (error) {
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        const force = setTimeout(() => child.kill("SIGKILL"), 500);
        force.unref();
        child.once("close", () => clearTimeout(force));
      }
      reject(error);
    } else resolve(value);
  };
  const cancelled = () => finish(abortError());
  const timer = setTimeout(() => finish(new Error(options.timedOut)), options.timeout);
  timer.unref();
  signal.addEventListener("abort", cancelled, { once: true });
  const collect = (chunks: Buffer[], chunk: Buffer) => {
    if (settled) return;
    bytes += chunk.length;
    if (bytes > MAX_OUTPUT) finish(new Error("adb wireless response exceeded the size limit."));
    else chunks.push(chunk);
  };
  child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
  child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
  child.stdin.on("error", () => { inputFailed = true; });
  child.once("error", () => finish(new Error("Could not run adb for wireless debugging. Check the Android SDK Platform-Tools installation.")));
  child.once("close", (code) => {
    if (settled) return;
    const output = Buffer.concat(stdout).toString("utf8");
    const diagnostic = Buffer.concat(stderr).toString("utf8");
    // adb connect can exit successfully while reporting a connection failure.
    const failure = /(?:^|\n|:\s)\s*(?:adb:\s*)?(?:error\b|failed\b|failure\b|cannot\b|can't\b|could not\b|unable\b|unknown command\b|usage:)/i;
    if (code !== 0 || inputFailed || failure.test(output) || failure.test(diagnostic)) {
      const detail = androidWirelessDiagnostic(`${diagnostic}\n${output}`, options.secret);
      finish(new Error(`adb ${args.join(" ")} failed${detail ? `: ${detail}` : ` with exit code ${code}`}`));
    } else finish(undefined, output);
  });
  child.stdin.end(options.secret === undefined ? undefined : `${options.secret}\n`);
  if (signal.aborted) cancelled();
  return promise;
}

/**
 * Whether anything accepts a TCP connection at `endpoint`, within a few seconds: adb itself waits far longer for
 * an unreachable address, and only says "failed" when it gives up.
 */
function reachable(endpoint: string, signal: AbortSignal): Promise<void> {
  const match = /^\[?(.*?)\]?:(\d+)$/.exec(endpoint)!;
  const host = match[1]!;
  const port = Number(match[2]);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal.aborted) return Promise.reject(abortError());
  const socket = connectTcp({ host, port });
  const finish = (error?: Error) => {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancelled);
    socket.destroy();
    if (error) reject(error);
    else resolve();
  };
  const cancelled = () => finish(abortError());
  const timer = setTimeout(() => finish(new Error(`Nothing answered at ${endpoint} within ${REACH_TIMEOUT / 1000} s. Check that the device is on the same network as this computer (not a guest network with client isolation, or behind a VPN or firewall) and that the address matches the main Wireless debugging screen.`)), REACH_TIMEOUT);
  signal.addEventListener("abort", cancelled, { once: true });
  socket.once("connect", () => finish());
  socket.once("error", (error: NodeJS.ErrnoException) => {
    const reason = error.code === "ECONNREFUSED" ? `${endpoint} refused the connection: Wireless debugging is off, or its port changed (it changes whenever Wireless debugging restarts). Use the IP address & port on the main Wireless debugging screen.`
      : error.code === "ENOTFOUND" || error.code === "EAI_AGAIN" ? `Cannot resolve ${host}. Enter the device's IP address instead.`
      : error.code === "EHOSTUNREACH" || error.code === "ENETUNREACH" ? `${host} is unreachable from this computer (${error.code}). Check that the device is on the same network.`
      : `Cannot connect to ${endpoint}: ${error.message}.`;
    finish(new Error(reason));
  });
  return promise;
}

export async function discoverAndroidWireless(adb: string, signal: AbortSignal): Promise<AndroidWirelessService[]> {
  const output = await runAdb(adb, ["mdns", "services"], signal, {
    timeout: DISCOVERY_TIMEOUT,
    timedOut: `adb mdns services did not answer within ${DISCOVERY_TIMEOUT / 1000} s. Restart the adb server (adb kill-server), or enter the address manually.`,
  });
  if (!/^List of discovered mdns services\s*$/im.test(output)) {
    throw new Error("adb did not return an mDNS service list. Update Android SDK Platform-Tools or enter the endpoint manually.");
  }
  const services: AndroidWirelessService[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^([^\s\u0000-\u001f\u007f]+)\s+_adb-tls-(pairing|connect)\._tcp\.?\s+(\S+)\s*$/.exec(line.trim());
    if (!match) continue;
    // DNS may print a terminating dot. Never prefix-match names when selecting a QR service.
    const name = match[1]!.replace(/\.$/, "");
    const type = match[2] as AndroidWirelessService["type"];
    const endpoint = match[3]!;
    if (!name || validateAndroidWirelessEndpoint(endpoint)) continue;
    const key = JSON.stringify([name, type, endpoint]);
    if (seen.has(key)) continue;
    seen.add(key);
    services.push({ name, type, endpoint });
  }
  return services;
}

export async function pairAndroidWireless(adb: string, endpoint: string, secret: string, signal: AbortSignal): Promise<void> {
  const invalid = validateAndroidWirelessEndpoint(endpoint);
  if (invalid) throw new Error(invalid);
  if (!/^[a-z0-9]{6,128}$/i.test(secret)) throw new Error("Enter the six-digit pairing code or use a newly generated QR code.");
  // The pairing service is not probed first: a bare connection could count as a failed pairing attempt.
  const advice = "Check the pairing code and the pairing port in ‘Pair device with pairing code’ (both change each time that dialog opens), and that the device is on the same network.";
  let output: string;
  try {
    output = await runAdb(adb, ["pair", endpoint], signal, { secret, timeout: PAIR_TIMEOUT, timedOut: `adb pair ${endpoint} did not finish within ${PAIR_TIMEOUT / 1000} s. ${advice}` });
  } catch (error) {
    if (error instanceof Error && error.name !== "AbortError" && !error.message.includes("did not finish")) error.message = `${error.message}. ${advice}`;
    throw error;
  }
  if (!/\bSuccessfully paired to\s+\S+/i.test(output)) {
    const detail = androidWirelessDiagnostic(output, secret);
    throw new Error(`adb did not confirm pairing${detail ? ` (it said: ${detail})` : ""}. ${advice}`);
  }
}

export async function connectAndroidWireless(adb: string, endpoint: string, signal: AbortSignal): Promise<void> {
  const invalid = validateAndroidWirelessEndpoint(endpoint);
  if (invalid) throw new Error(invalid);
  await reachable(endpoint, signal);
  const output = await runAdb(adb, ["connect", endpoint], signal, {
    timeout: CONNECT_TIMEOUT,
    timedOut: `adb connect ${endpoint} did not finish within ${CONNECT_TIMEOUT / 1000} s although the address answers. Check that the device is paired with this computer, then retry.`,
  });
  if (!/^(?:already )?connected to\s+\S+/im.test(output)) {
    const detail = androidWirelessDiagnostic(output);
    throw new Error(`adb did not confirm the connection${detail ? ` (it said: ${detail})` : ""}. Use the connection port from the main Wireless debugging screen, not the pairing port.`);
  }
}
