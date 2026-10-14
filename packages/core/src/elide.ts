import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseElideRecord, renderElideRecord, type ElideRecord } from "./buildOutput.js";
import { parseBuildInspect, type BuildTaskInfo } from "./buildTasks.js";
import { ElideCommandFailedError, ElideNotFoundError, InvalidElideHomeError, ManifestParseError } from "./errors.js";
import { decodeInitTemplates, initArgs, type InitTemplate } from "./init.js";
import { elideFlagArgs } from "./invocation.js";
import { decodeManifest, type Manifest } from "./manifest.js";
import { pklModuleReferences } from "./pkl.js";
import { isPathUnder, normalizePath } from "./sourceRoots.js";
import { compareElideVersions, parseElideVersion, supportsProgressRecords, type ElideVersion } from "./version.js";

/** First release where `elide manifest` became `elide project export`; both print the same document. */
const PROJECT_EXPORT_VERSION: ElideVersion = { major: 1, minor: 6, patch: 0 };
const PROJECT_EXPORT_COMMAND = ["project", "export"] as const;
const MANIFEST_COMMAND = ["manifest"] as const;

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

/** First executable named `name` on `PATH`, or `undefined` when there is none. */
export function whichExecutable(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
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
  const which = opts.which ?? ((name: string) => whichExecutable(name, env, platform));

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

/** One `elide classpath` query: `<sourceSet>:<usage>`. */
export type ClasspathQuery = `${string}:${ClasspathUsage}`;

export interface RunOptions {
  /**
   * Receives every output line (without trailing newline) as it arrives. Progress records on stderr arrive as the
   * text the CLI prints without a terminal, and not at all when they have none: see {@link renderElideRecord}.
   */
  onLine?: (line: string, stderr: boolean) => void;
  signal?: AbortSignal;
  env?: Record<string, string>;
  /**
   * Told about every CLI process this invocation starts, as it starts: a caller that wants to show what the CLI is
   * doing and how long each step takes observes the processes rather than the method calls.
   */
  onCommand?: (argv: readonly string[], cwd: string) => CommandObserver | undefined;
}

/** Follows one CLI process from start to exit. */
export interface CommandObserver {
  /**
   * An output line meant for a person. The stdout of a command whose stdout is its result — the exported project,
   * a classpath, a task listing — is data, and is not passed here. A progress record arrives as its text, after
   * {@link record} saw it.
   */
  line?(line: string, stderr: boolean): void;
  /** A progress record on stderr, which the CLI writes when it supports `ELIDE_PROGRESS=json`. */
  record?(record: ElideRecord): void;
  /** The process is gone: `exitCode` is `null` when it was killed by a signal or never started. */
  end(outcome: { exitCode: number | null; durationMs: number; aborted: boolean }): void;
}

export interface RunResult {
  stdout: string;
  exitCode: number;
}

const STDERR_CAPTURE_LIMIT = 64 * 1024;
const TERMINATION_GRACE_MS = 5_000;

/** Splits a stream into lines, forwarding complete lines and keeping the remainder. */
export class LineSplitter {
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

/**
 * Invokes the Elide CLI of a distribution with a project root as working directory.
 *
 * `flags` are the `-f NAME[=VALUE]` build flags every subcommand this class drives is given: the manifest sees them
 * as `build.flags`, so a project model resolved without the flags a build uses would describe a different build.
 *
 * Every process is started with `ELIDE_PROGRESS=json`, unless `env` says otherwise: a CLI that knows the variable
 * reports build events as records, which observers receive as such and everyone else as the text it stands for; an
 * older CLI ignores it.
 */
export class ElideCli {
  constructor(
    readonly dist: ElideDistribution,
    readonly projectRoot: string,
    readonly flags: readonly string[] = [],
  ) {}

  run(args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
    return this.spawn(args, opts, false);
  }

  /** `payload`: stdout is the command's result, so it is not shown to a {@link RunOptions.onCommand} observer. */
  private spawn(args: readonly string[], opts: RunOptions, payload: boolean): Promise<RunResult> {
    if (!defaultIsFile(this.dist.bin)) throw new InvalidElideHomeError(this.dist.home);
    const argv = [...args];
    const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
    const child = spawn(this.dist.bin, argv, {
      cwd: this.projectRoot,
      env: { ...process.env, ELIDE_PROGRESS: "json", ...opts.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const startedAt = performance.now();
    const observer = opts.onCommand?.(argv, this.projectRoot);
    let observed = false;
    const finish = (exitCode: number | null, aborted: boolean) => {
      if (observed) return;
      observed = true;
      observer?.end({ exitCode, durationMs: performance.now() - startedAt, aborted });
    };

    let stdout = "";
    let stderr = "";
    const out = new LineSplitter((line) => {
      stdout += `${line}\n`;
      opts.onLine?.(line, false);
      if (!payload) observer?.line?.(line, false);
    });
    const errText = (line: string) => {
      if (stderr.length < STDERR_CAPTURE_LIMIT) stderr += `${line}\n`;
      opts.onLine?.(line, true);
      observer?.line?.(line, true);
    };
    const err = new LineSplitter((line) => {
      const record = parseElideRecord(line);
      if (!record) return errText(line);
      observer?.record?.(record);
      for (const text of renderElideRecord(record)) errText(text);
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
      finish(null, aborted);
      reject(e);
    });
    child.once("close", (code, sig) => {
      opts.signal?.removeEventListener("abort", onAbort);
      clearTimeout(killTimer);
      out.flush();
      err.flush();
      finish(sig ? null : code, aborted);
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

  /** `elide --version` → first line, e.g. `1.5.1+db2bc827b`; asked once per instance, since it cannot change. */
  async version(opts: RunOptions = {}): Promise<string> {
    this.reportedVersion ??= this.spawn(["--version"], opts, true).then(({ stdout }) => stdout.trim().split("\n")[0]?.trim() ?? "");
    return this.reportedVersion;
  }

  private reportedVersion?: Promise<string>;

  /**
   * The project manifest, decoded: `elide project export`, or `elide manifest` on a release that still carries it.
   *
   * Elide 1.6.0 retired `manifest` in favour of `project export`, which prints the same document; the retired name
   * exits with a usage error there, and the new one does not exist on 1.5.x. The reported version picks which to
   * run, and a refusal is answered by running the other — a distribution whose `--version` does not match its
   * binary (a wrapper, a stub) is a real thing, and both commands answer the same question. Whichever worked is
   * kept for the rest of this instance's life.
   */
  async manifest(opts: RunOptions = {}): Promise<Manifest> {
    const version = parseElideVersion(await this.version(opts));
    const retired = version !== undefined && compareElideVersions(version, PROJECT_EXPORT_VERSION) < 0;
    const candidates = this.manifestCommand
      ? [this.manifestCommand]
      : retired
        ? [MANIFEST_COMMAND, PROJECT_EXPORT_COMMAND]
        : [PROJECT_EXPORT_COMMAND, MANIFEST_COMMAND];

    let refusal: unknown;
    for (const command of candidates) {
      let json = "";
      try {
        await this.spawn([...command, ...elideFlagArgs(this.flags)], {
          ...opts,
          onLine: (line, stderr) => {
            if (!stderr) json += `${line}\n`;
            opts.onLine?.(line, stderr);
          },
        }, true);
      } catch (e) {
        // The command the version pointed at is the one whose failure describes the project, so it is the error
        // reported when neither answers.
        refusal ??= e;
        continue;
      }
      const trimmed = json.trim();
      if (!trimmed) throw new ManifestParseError("empty output");
      this.manifestCommand = command;
      return decodeManifest(trimmed);
    }
    throw refusal;
  }

  /** The command that answered for this project, once one has. */
  private manifestCommand?: readonly string[];

  /** `elide classpath <sourceSet>:<usage>` → absolute jar/dir entries (stdout split on the platform path delimiter). */
  async classpath(sourceSet: string, usage: ClasspathUsage, opts: RunOptions = {}): Promise<string[]> {
    let text = "";
    await this.spawn(["classpath", `${sourceSet}:${usage}`, ...elideFlagArgs(this.flags)], {
      ...opts,
      onLine: (line, stderr) => {
        if (!stderr) text += line;
        opts.onLine?.(line, stderr);
      },
    }, true);
    return parseClasspath(text, this.projectRoot);
  }

  /**
   * Several classpaths of this project → entries keyed by query. One query that cannot be resolved fails the call.
   *
   * Elide 1.6.1 answers them all from one `elide classpath --json <query…>`, which resolves the project once; an
   * older release rejects `--json` and is asked one query per process. A version that cannot be read is tried with
   * `--json` first, and whichever form answered is kept for the rest of this instance's life.
   */
  async classpaths(queries: readonly ClasspathQuery[], opts: RunOptions = {}): Promise<Map<ClasspathQuery, string[]>> {
    const answers = new Map<ClasspathQuery, string[]>();
    if (queries.length === 0) return answers;
    this.batchedClasspath ??= supportsProgressRecords(await this.version(opts));
    if (this.batchedClasspath !== false) {
      try {
        const batched = await this.classpathJson(queries, opts);
        this.batchedClasspath = true;
        return batched;
      } catch (e) {
        if (this.batchedClasspath) throw e;
      }
    }
    for (const query of queries) {
      const at = query.lastIndexOf(":");
      answers.set(query, await this.classpath(query.slice(0, at), query.slice(at + 1) as ClasspathUsage, opts));
    }
    this.batchedClasspath = false;
    return answers;
  }

  /** Whether `elide classpath --json` works here; `undefined` until the version or an attempt has said. */
  private batchedClasspath?: boolean;

  private async classpathJson(queries: readonly ClasspathQuery[], opts: RunOptions): Promise<Map<ClasspathQuery, string[]>> {
    let json = "";
    await this.spawn(["classpath", "--json", ...queries, ...elideFlagArgs(this.flags)], {
      ...opts,
      onLine: (line, stderr) => {
        if (!stderr) json += `${line}\n`;
        opts.onLine?.(line, stderr);
      },
    }, true);
    let answer: unknown;
    try {
      answer = JSON.parse(json);
    } catch (e) {
      throw new Error(`elide classpath --json printed no JSON object: ${e instanceof Error ? e.message : String(e)}`);
    }
    const answers = new Map<ClasspathQuery, string[]>();
    for (const query of queries) {
      const entries = (answer as Record<string, unknown> | null)?.[query];
      if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
        throw new Error(`elide classpath --json did not answer ${query}`);
      }
      answers.set(query, (entries as string[]).map((entry) => path.resolve(this.projectRoot, entry)));
    }
    return answers;
  }

  /**
   * `elide install`. Omitting `with` keeps the CLI default, which downloads sources *and* javadoc for every declared
   * Maven package. A `with` array pins the set exactly — `--slim` turns the default classifiers off and each entry is
   * requested back with `--with` — so `[]` installs classes only and `["sources"]` skips the javadoc download.
   * Elide's own toolchain jars (kotlin-stdlib, kotlin-test, JUnit) are published without classifiers either way.
   */
  async install(opts: RunOptions & { with?: readonly string[] } = {}): Promise<void> {
    const flags = opts.with ? ["--slim", ...opts.with.flatMap((classifier) => ["--with", classifier])] : [];
    await this.run(["install", ...elideFlagArgs(this.flags), ...flags], opts);
  }

  /**
   * `elide build <target…>`: run build targets by name, with the build flags this instance carries.
   *
   * Used for what the project model needs on disk and nothing else produces — a published `.aar` has to be unpacked
   * before its classes are on a classpath the editor can read. A build the user asked for runs as a task instead,
   * so its output reaches the terminal.
   */
  async build(targets: readonly string[], opts: RunOptions = {}): Promise<void> {
    await this.run(["build", ...targets, ...elideFlagArgs(this.flags)], opts);
  }

  /** `elide build --inspect` → the build targets of the project and the options they accept. */
  async buildInspect(opts: RunOptions = {}): Promise<BuildTaskInfo[]> {
    let text = "";
    await this.spawn(["build", "--inspect", ...elideFlagArgs(this.flags)], {
      ...opts,
      onLine: (line, stderr) => {
        if (!stderr) text += `${line}\n`;
        opts.onLine?.(line, stderr);
      },
    }, true);
    return parseBuildInspect(text);
  }

  /** `elide init --templates --json` → the project templates the CLI can generate. */
  async initTemplates(opts: RunOptions = {}): Promise<InitTemplate[]> {
    let json = "";
    await this.spawn(["init", "--templates", "--json"], {
      ...opts,
      onLine: (line, stderr) => {
        if (!stderr) json += `${line}\n`;
        opts.onLine?.(line, stderr);
      },
    }, true);
    return decodeInitTemplates(json);
  }

  /**
   * Generate a project from a template, non-interactively. The CLI has no target-path flag, so the project lands
   * in this instance's `projectRoot`, which must be the (existing) target directory.
   */
  async init(templateId: string, answers: Readonly<Record<string, string>>, opts: RunOptions = {}): Promise<void> {
    await this.run(initArgs(templateId, answers), opts);
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

/** Whether `p` is a strict descendant of directory `dir`; both are resolved and compared as normalized paths. */
export function isNestedUnder(p: string, dir: string): boolean {
  const child = normalizePath(path.resolve(p));
  const parent = normalizePath(path.resolve(dir));
  return child !== parent && isPathUnder(child, parent);
}

/**
 * Keep only the outermost manifest of each directory tree.
 *
 * A manifest inside another project's directory is either a member of the workspace the enclosing manifest declares,
 * which is resolved as part of that workspace, or a separate build the enclosing project never invokes (a vendored
 * checkout, a sample, a test fixture). Neither is a project of its own: importing it on its own resolves its sources
 * twice and produces overlapping content roots in the generated workspace model, so the nested ones are dropped here,
 * and the members are attached once the enclosing manifest has been read. Input order is preserved.
 */
export function outermostManifests(manifestPaths: Iterable<string>): string[] {
  const all = [...manifestPaths].map((manifest) => ({ manifest, root: path.dirname(path.resolve(manifest)) }));
  const roots: string[] = [];
  const kept = new Set<string>();
  // Shallower roots first: an ancestor is always shorter than its descendants, so it is decided before them.
  for (const entry of [...all].sort((a, b) => a.root.length - b.root.length)) {
    if (roots.some((r) => r === entry.root || isNestedUnder(entry.root, r))) continue;
    roots.push(entry.root);
    kept.add(entry.manifest);
  }
  return all.map((e) => e.manifest).filter((m) => kept.has(m));
}

/** Absolute paths of the `.dev/elide.lock*.bin` files of `projectRoot`, sorted by file name. */
export async function lockfilesIn(projectRoot: string): Promise<string[]> {
  const outputDir = path.join(projectRoot, OUTPUT_DIR);
  let entries: string[];
  try {
    entries = await readdir(outputDir);
  } catch {
    return [];
  }
  return entries
    .filter(isLockfileName)
    .sort()
    .map((name) => path.join(outputDir, name));
}

/**
 * Digest of the dependency set `projectRoot` currently resolves to: the content of every `.dev/elide.lock*.bin`.
 *
 * Every `elide` invocation rewrites its lockfile, so `run`, `test` and `build` bump the file's mtime without
 * changing a byte. Only a different digest means a project model resolved earlier describes other dependencies.
 * A project with no lockfile hashes to the digest of an empty input.
 */
export async function lockfileDigest(projectRoot: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await lockfilesIn(projectRoot)) {
    hash.update(path.basename(file));
    try {
      hash.update(await readFile(file));
    } catch {
      hash.update("\u0000unreadable");
    }
  }
  return hash.digest("hex");
}

/**
 * Whether installed dependencies can be trusted without `elide install`: `.dev/dependencies` exists and the
 * newest `.dev/elide.lock*.bin` is at least as recent as every manifest in `manifestPaths` and every local Pkl module
 * they amend, extend or import, such as a shared `versions.pkl`.
 *
 * A workspace resolves into its root's repository and records one lockfile there, so the manifests of its members
 * count as well, although each member has a `.dev` of its own.
 */
export async function isLockfileCurrent(
  projectRoot: string,
  manifestPaths: readonly string[] = [path.join(projectRoot, MANIFEST_NAME)],
): Promise<boolean> {
  if (!existsSync(path.join(projectRoot, OUTPUT_DIR, DEPENDENCIES_DIR))) return false;
  let newest = -Infinity;
  for (const file of await lockfilesIn(projectRoot)) {
    try {
      const s = await stat(file);
      if (s.isFile()) newest = Math.max(newest, s.mtimeMs);
    } catch {
      // ignore
    }
  }
  if (newest === -Infinity) return false;
  try {
    for (const manifestPath of manifestPaths) if ((await stat(manifestPath)).mtimeMs > newest) return false;
  } catch {
    return false;
  }
  for (const module of await importedModules(manifestPaths)) {
    // A module that is gone fails the manifest importing it, which the CLI reports; it is no reason to install.
    const modified = await stat(module).then((s) => s.mtimeMs, () => -Infinity);
    if (modified > newest) return false;
  }
  return true;
}

/**
 * The local Pkl modules the files in `modules` read, directly or through each other, without `modules` themselves.
 * A URI with a scheme other than `file:` (`elide:`, `pkl:`, `package:`, `https:`) names no local file; a module that
 * cannot be read contributes none of its own.
 */
export async function importedModules(modules: readonly string[]): Promise<string[]> {
  const seen = new Set(modules.map((module) => path.resolve(module)));
  const found: string[] = [];
  const pending = [...seen];
  for (let module = pending.pop(); module !== undefined; module = pending.pop()) {
    let text: string;
    try {
      text = await readFile(module, "utf8");
    } catch {
      continue;
    }
    for (const uri of pklModuleReferences(text)) {
      const file = uri.startsWith("file:")
        ? fileURLToPath(uri)
        : /^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri) ? undefined : path.resolve(path.dirname(module), decodeURI(uri));
      if (file === undefined || seen.has(file)) continue;
      seen.add(file);
      found.push(file);
      pending.push(file);
    }
  }
  return found;
}
