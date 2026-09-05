import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { ElideCommandFailedError, ElideNotFoundError, InvalidElideHomeError, ManifestParseError } from "./errors.js";
import { decodeManifest, type Manifest } from "./manifest.js";

export interface ElideDistribution {
  /** Distribution root, e.g. `~/.local/share/elide`. */
  readonly home: string;
  /** Path to the CLI binary: `<home>/bin/elide` (`elide.exe` on Windows). */
  readonly bin: string;
}

export interface ResolveElideOptions {
  /** Explicit distribution root; wins over every other source and must be valid. */
  explicitHome?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isFile?: (p: string) => boolean;
  /** Resolve a binary on `PATH`; return its path or `undefined`. */
  which?: (name: string) => string | undefined;
}

export const ELIDE_BINARY_NAME = "elide";
export const MANIFEST_NAME = "elide.pkl";
export const OUTPUT_DIR = ".dev";
export const DEPENDENCIES_DIR = "dependencies";
const LOCKFILE_PREFIX = "elide.lock";
const LOCKFILE_EXTENSION = ".bin";

export function distributionAt(home: string, platform: NodeJS.Platform = process.platform): ElideDistribution {
  return { home, bin: path.join(home, "bin", platform === "win32" ? `${ELIDE_BINARY_NAME}.exe` : ELIDE_BINARY_NAME) };
}

function defaultIsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function defaultWhich(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const names = platform === "win32" ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name];
  for (const dir of dirs) {
    for (const n of names) {
      const candidate = path.join(dir, n);
      if (defaultIsFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Platform install locations, in the order the IntelliJ plugin probes them. */
export function defaultHomeCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  if (platform === "win32") {
    const out: string[] = [];
    if (env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, "elide"));
    if (env.ProgramFiles) out.push(path.join(env.ProgramFiles, "Elide"));
    out.push(path.join(home, ".local", "share", "elide"), path.join(home, ".elide"));
    return out;
  }
  const out: string[] = [];
  if (env.XDG_DATA_HOME) out.push(path.join(env.XDG_DATA_HOME, "elide"));
  out.push(path.join(home, ".local", "share", "elide"), "/opt/elide/current", path.join(home, ".elide"));
  return out;
}

/**
 * Locate an Elide distribution: explicit home → `$ELIDE_HOME` → platform candidates → `elide` on `PATH`
 * (resolved through symlinks to its distribution root).
 */
export function resolveElideDistribution(opts: ResolveElideOptions = {}): ElideDistribution {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const isFile = opts.isFile ?? defaultIsFile;
  const which = opts.which ?? ((name: string) => defaultWhich(name, env, platform));

  const valid = (home: string): ElideDistribution | undefined => {
    const dist = distributionAt(home, platform);
    return isFile(dist.bin) ? dist : undefined;
  };

  if (opts.explicitHome) {
    const dist = valid(opts.explicitHome);
    if (!dist) throw new InvalidElideHomeError(opts.explicitHome);
    return dist;
  }

  const tried: string[] = [];
  if (env.ELIDE_HOME) {
    tried.push(env.ELIDE_HOME);
    const dist = valid(env.ELIDE_HOME);
    if (dist) return dist;
  }
  for (const candidate of defaultHomeCandidates(env, platform)) {
    tried.push(candidate);
    const dist = valid(candidate);
    if (dist) return dist;
  }
  const onPath = which(ELIDE_BINARY_NAME);
  if (onPath) {
    tried.push(`PATH (${onPath})`);
    let real = onPath;
    try {
      real = realpathSync(onPath);
    } catch {
      // keep the unresolved path
    }
    const dist = valid(path.dirname(path.dirname(real)));
    if (dist) return dist;
  }
  throw new ElideNotFoundError(tried);
}

export type ClasspathUsage = "compile" | "runtime" | "processor" | "provided" | "modules" | "toolchain";

export interface RunOptions {
  /** Receives every output line (without trailing newline) as it arrives. */
  onLine?: (line: string, stderr: boolean) => void;
  signal?: AbortSignal;
  env?: Record<string, string>;
}

export interface RunResult {
  stdout: string;
  exitCode: number;
}

const STDERR_CAPTURE_LIMIT = 64 * 1024;
const TERMINATION_GRACE_MS = 5_000;

/** Splits a stream into lines, forwarding complete lines and keeping the remainder. */
class LineSplitter {
  private rest = "";
  constructor(private readonly emit: (line: string) => void) {}
  push(chunk: string): void {
    this.rest += chunk;
    let idx: number;
    while ((idx = this.rest.indexOf("\n")) >= 0) {
      let line = this.rest.slice(0, idx);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.emit(line);
      this.rest = this.rest.slice(idx + 1);
    }
  }
  flush(): void {
    if (this.rest.length > 0) {
      this.emit(this.rest);
      this.rest = "";
    }
  }
}

/** Kill `pid` and, on POSIX, its whole process group (the CLI re-execs and forks a grandchild JVM). */
export function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32") process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

/** Invokes the Elide CLI of a distribution with a project root as working directory. */
export class ElideCli {
  constructor(
    readonly dist: ElideDistribution,
    readonly projectRoot: string,
  ) {}

  run(args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
    if (!defaultIsFile(this.dist.bin)) throw new InvalidElideHomeError(this.dist.home);
    const argv = [...args];
    const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
    const child = spawn(this.dist.bin, argv, {
      cwd: this.projectRoot,
      env: { ...process.env, ...opts.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    const out = new LineSplitter((line) => {
      stdout += `${line}\n`;
      opts.onLine?.(line, false);
    });
    const err = new LineSplitter((line) => {
      if (stderr.length < STDERR_CAPTURE_LIMIT) stderr += `${line}\n`;
      opts.onLine?.(line, true);
    });
    child.stdout.setEncoding("utf8").on("data", (c: string) => out.push(c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => err.push(c));

    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      aborted = true;
      if (child.pid === undefined) return;
      killProcessTree(child.pid, "SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.pid !== undefined) killProcessTree(child.pid, "SIGKILL");
      }, TERMINATION_GRACE_MS);
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.once("error", (e) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.once("close", (code, sig) => {
      opts.signal?.removeEventListener("abort", onAbort);
      clearTimeout(killTimer);
      out.flush();
      err.flush();
      if (aborted) {
        reject(opts.signal?.reason instanceof Error ? opts.signal.reason : new Error("Elide command aborted"));
        return;
      }
      if (code !== 0) {
        reject(new ElideCommandFailedError(argv, sig ? null : code, stderr.trim()));
        return;
      }
      resolve({ stdout, exitCode: 0 });
    });
    return promise;
  }

  /** `elide --version` → first line, e.g. `1.5.1+db2bc827b`. */
  async version(opts: RunOptions = {}): Promise<string> {
    const { stdout } = await this.run(["--version"], opts);
    return stdout.trim().split("\n")[0]?.trim() ?? "";
  }

  /** `elide manifest` → decoded manifest JSON. */
  async manifest(opts: RunOptions = {}): Promise<Manifest> {
    let json = "";
    await this.run(["manifest"], {
      ...opts,
      onLine: (line, stderr) => {
        if (!stderr) json += `${line}\n`;
        opts.onLine?.(line, stderr);
      },
    });
    const trimmed = json.trim();
    if (!trimmed) throw new ManifestParseError("empty output");
    return decodeManifest(trimmed);
  }

  /** `elide classpath <sourceSet>:<usage>` → absolute jar/dir entries (stdout split on the platform path delimiter). */
  async classpath(sourceSet: string, usage: ClasspathUsage, opts: RunOptions = {}): Promise<string[]> {
    let text = "";
    await this.run(["classpath", `${sourceSet}:${usage}`], {
      ...opts,
      onLine: (line, stderr) => {
        if (!stderr) text += line;
        opts.onLine?.(line, stderr);
      },
    });
    return parseClasspath(text, this.projectRoot);
  }

  /** `elide install`. */
  async install(opts: RunOptions = {}): Promise<void> {
    await this.run(["install"], opts);
  }
}

/** Split a platform-native classpath string; relative entries are resolved against `root`. */
export function parseClasspath(text: string, root: string, delimiter: string = path.delimiter): string[] {
  return text
    .trim()
    .split(delimiter)
    .map((e) => e.trim())
    .filter((e) => e.length > 0)
    .map((e) => (path.isAbsolute(e) ? e : path.resolve(root, e)));
}

export function isLockfileName(fileName: string): boolean {
  return fileName.startsWith(LOCKFILE_PREFIX) && fileName.endsWith(LOCKFILE_EXTENSION);
}

/**
 * Whether installed dependencies can be trusted without `elide install`: `.dev/dependencies` exists and the
 * newest `.dev/elide.lock*.bin` is at least as recent as the manifest.
 */
export async function isLockfileCurrent(projectRoot: string, manifestPath: string = path.join(projectRoot, MANIFEST_NAME)): Promise<boolean> {
  const outputDir = path.join(projectRoot, OUTPUT_DIR);
  if (!existsSync(path.join(outputDir, DEPENDENCIES_DIR))) return false;
  let entries: string[];
  try {
    entries = await readdir(outputDir);
  } catch {
    return false;
  }
  let newest = -Infinity;
  for (const name of entries) {
    if (!isLockfileName(name)) continue;
    try {
      const s = await stat(path.join(outputDir, name));
      if (s.isFile()) newest = Math.max(newest, s.mtimeMs);
    } catch {
      // ignore
    }
  }
  if (newest === -Infinity) return false;
  try {
    return newest >= (await stat(manifestPath)).mtimeMs;
  } catch {
    return false;
  }
}
