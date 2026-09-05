import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ElideDistribution } from "./elide.js";
import type { Manifest } from "./manifest.js";

export interface Jdk {
  home: string;
  /** Version string such as `25.0.4.1` or `21`; `"unknown"` when nothing reports one. */
  version: string;
}

export interface ResolveJdkOptions {
  /** Explicit JDK home; wins over every other source. */
  override?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
  listDir?: (p: string) => string[];
  readText?: (p: string) => string | undefined;
  /** Runs `<home>/bin/java -version`; returns combined output. Default spawns the process. */
  javaVersionOutput?: (home: string) => Promise<string | undefined>;
}

/**
 * A directory is usable as a JDK for symbol resolution when it is a modular image *with* a `release` file, or a legacy
 * JRE with `rt.jar`. IntelliJ's `JavaSdkImpl.findClasses` reads the module list from `release`, so a jlinked image
 * without it (the Elide distribution) yields no class roots; emitting explicit `jrt://<home>!/<module>` roots for such
 * an image was tried against kotlin-lsp 263.4421 and still left `java.*` unresolved, so it is not treated as a JDK.
 */
export function looksLikeJdk(home: string, exists: (p: string) => boolean = existsSync): boolean {
  return (exists(path.join(home, "lib", "modules")) && exists(path.join(home, "release"))) || exists(path.join(home, "jre", "lib", "rt.jar"));
}

/** Feature (major) version of a JDK version string: `1.8.0_292` → 8, `21.0.1` → 21, `openjdk 25` → 25. */
export function majorOf(version: string): number | undefined {
  const legacy = /(?<![\d.])1\.(\d+)/.exec(version);
  if (legacy?.[1]) return Number(legacy[1]);
  const modern = /(\d+)(?:\.\d+)*/.exec(version);
  return modern?.[1] ? Number(modern[1]) : undefined;
}

function defaultListDir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

function defaultReadText(p: string): string | undefined {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

/** Runs `<home>/bin/java <args>` and returns its combined output, or `undefined` when the launcher is missing/fails. */
function javaOutput(home: string, args: string[]): Promise<string | undefined> {
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  const bin = path.join(home, "bin", process.platform === "win32" ? "java.exe" : "java");
  if (!existsSync(bin)) {
    resolve(undefined);
    return promise;
  }
  let out = "";
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  child.stdout.on("data", (c) => (out += String(c)));
  child.stderr.on("data", (c) => (out += String(c)));
  child.once("error", () => resolve(undefined));
  child.once("close", (code) => {
    clearTimeout(timer);
    resolve(code === 0 && out.length > 0 ? out : undefined);
  });
  return promise;
}

/** Locations scanned when no explicit or environment JDK applies. */
export function jdkScanRoots(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const roots: string[] = [path.join(home, ".sdkman", "candidates", "java")];
  if (platform === "darwin") roots.push("/Library/Java/JavaVirtualMachines");
  else if (platform === "linux") roots.push("/usr/lib/jvm");
  else if (platform === "win32") {
    if (env.ProgramFiles) roots.push(path.join(env.ProgramFiles, "Java"), path.join(env.ProgramFiles, "Eclipse Adoptium"));
  }
  return roots;
}

/** Target feature version the manifest asks for, if any (`jvm.target`, then `jvm.java.release`). */
export function requestedJavaMajor(manifest: Manifest): number | undefined {
  const target = manifest.jvm?.target;
  if (target?.kind === "version") return target.major;
  const release = manifest.jvm?.java?.release;
  if (typeof release === "number") return release;
  if (typeof release === "string") return majorOf(release);
  return undefined;
}

async function versionOf(home: string, manifest: Manifest, opts: Required<Pick<ResolveJdkOptions, "readText" | "javaVersionOutput">>): Promise<string> {
  const release = opts.readText(path.join(home, "release"));
  const fromRelease = release ? /JAVA_VERSION="([^"]+)"/.exec(release)?.[1] : undefined;
  if (fromRelease) return fromRelease;
  const output = await opts.javaVersionOutput(home);
  const fromJava = output ? /(\d+)(?:\.\d+)*/.exec(output)?.[0] : undefined;
  if (fromJava) return fromJava;
  const engine = manifest.toolchain.engines.java;
  if (engine) return engine;
  const requested = requestedJavaMajor(manifest);
  return requested !== undefined ? String(requested) : "unknown";
}

/**
 * Pick the JDK the Kotlin LSP should resolve symbols against.
 *
 * Order: explicit override → `jvm.javaHome` → the Elide distribution (only if it carries a `release` file, see
 * {@link looksLikeJdk}) → `$JAVA_HOME` → installed JDKs (exact match on the requested major, else the highest).
 */
export async function resolveJdk(manifest: Manifest, dist: ElideDistribution, opts: ResolveJdkOptions = {}): Promise<Jdk | undefined> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? existsSync;
  const listDir = opts.listDir ?? defaultListDir;
  const readText = opts.readText ?? defaultReadText;
  const javaVersionOutput = opts.javaVersionOutput ?? ((home: string) => javaOutput(home, ["-version"]));
  const versionOpts = { readText, javaVersionOutput };

  const direct = [opts.override, manifest.jvm?.javaHome, dist.home, env.JAVA_HOME].filter(
    (h): h is string => typeof h === "string" && h.length > 0,
  );
  for (const home of direct) {
    if (looksLikeJdk(home, exists)) return { home, version: await versionOf(home, manifest, versionOpts) };
  }

  const found: Jdk[] = [];
  for (const root of jdkScanRoots(env, platform)) {
    for (const entry of listDir(root)) {
      const candidate = platform === "darwin" && root.includes("JavaVirtualMachines")
        ? path.join(root, entry, "Contents", "Home")
        : path.join(root, entry);
      if (!looksLikeJdk(candidate, exists)) continue;
      const release = readText(path.join(candidate, "release"));
      const version = (release ? /JAVA_VERSION="([^"]+)"/.exec(release)?.[1] : undefined) ?? entry;
      found.push({ home: candidate, version });
    }
  }
  if (found.length === 0) return undefined;

  const requested = requestedJavaMajor(manifest);
  const withMajor = found.map((j) => ({ jdk: j, major: majorOf(j.version) ?? -1 }));
  if (requested !== undefined) {
    const exact = withMajor.find((j) => j.major === requested);
    if (exact) return exact.jdk;
    const compatible = withMajor.filter((j) => j.major >= requested).sort((a, b) => a.major - b.major)[0];
    if (compatible) return compatible.jdk;
  }
  return withMajor.sort((a, b) => b.major - a.major)[0]?.jdk;
}
