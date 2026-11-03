import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const sources = ["ComposableFunctionNameSuppressor.java"];
const PLUGIN_PATH = "-Dplugin.path=";

interface ProductInfo {
  buildNumber?: string;
  launch?: { os?: string; arch?: string; javaExecutablePath?: string }[];
}

const launchOs: Partial<Record<NodeJS.Platform, string>> = { darwin: "macOS", linux: "Linux", win32: "Windows" };
const launchArch: Partial<Record<string, string>> = { arm64: "aarch64", x64: "amd64" };

/**
 * Build Elide's plugin for the Kotlin language server shipped in `serverDirectory` (the JetBrains extension's
 * `server`), returning the plugin directory to list in `-Dplugin.path`. The plugin is compiled with the server's
 * own JDK against the server's own jars, so it always matches that server's ABI; it is cached per server build and
 * plugin source, and reused across sessions.
 */
export async function kotlinLspPlugin(serverDirectory: string, helperDirectory: string, cacheRoot: string, signal?: AbortSignal): Promise<string> {
  const product = JSON.parse(await readFile(path.join(serverDirectory, "product-info.json"), "utf8")) as ProductInfo;
  const launch = product.launch?.find((l) => l.os === launchOs[process.platform] && l.arch === launchArch[process.arch]) ?? product.launch?.[0];
  if (!launch?.javaExecutablePath) throw new Error(`${path.join(serverDirectory, "product-info.json")} names no Java runtime`);
  const hash = createHash("sha256").update(product.buildNumber ?? "").update("\0");
  for (const file of ["BuildPlugin.java", "plugin.xml", ...sources]) hash.update(file).update("\0").update(await readFile(path.join(helperDirectory, file)));
  const root = path.join(cacheRoot, "kotlin-lsp-plugin");
  const destination = path.join(root, hash.digest("hex").slice(0, 24));
  const plugin = path.join(destination, "elide");
  const ready = async (): Promise<boolean> => {
    try { return (await stat(path.join(destination, "ready"))).isFile(); }
    catch { return false; }
  };
  if (await ready()) return plugin;
  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(path.join(root, "staging-"));
  try {
    const lib = path.join(staging, "elide", "lib");
    await mkdir(lib, { recursive: true });
    const classPath = [path.join(serverDirectory, "lib", "*"), path.join(serverDirectory, "plugins", "kotlin", "lib", "*")].join(path.delimiter);
    await run(path.join(serverDirectory, launch.javaExecutablePath), ["-cp", classPath, path.join(helperDirectory, "BuildPlugin.java"),
      path.join(lib, "elide.jar"), path.join(helperDirectory, "plugin.xml"), ...sources.map((file) => path.join(helperDirectory, file))],
    { signal, timeout: 120_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    await writeFile(path.join(staging, "ready"), "");
    try { await rename(staging, destination); }
    catch (error) {
      // Another extension host published the same content key first.
      if (!await ready()) throw error;
    }
    return plugin;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * `args` (`intellij.additionalJvmArgs`) without the builds of Elide's plugin that earlier releases listed there in
 * `-Dplugin.path`, from any VS Code profile (each has its own `<globalStorage>/<extension id>`, whose last segment
 * `cacheRoot` shares); `undefined` when there are none. The user's own entries are kept, and a `-Dplugin.path` left
 * with none is dropped.
 */
export function withoutKotlinLspPlugin(args: readonly string[], cacheRoot: string): string[] | undefined {
  const owned = `${path.sep}${path.basename(cacheRoot)}${path.sep}kotlin-lsp-plugin${path.sep}`;
  let changed = false;
  const next = args.flatMap((arg) => {
    if (!arg.startsWith(PLUGIN_PATH)) return [arg];
    const entries = arg.slice(PLUGIN_PATH.length).split(path.delimiter).filter((entry) => entry.length > 0);
    const kept = entries.filter((entry) => !entry.includes(owned));
    if (kept.length === entries.length) return [arg];
    changed = true;
    return kept.length > 0 ? [PLUGIN_PATH + kept.join(path.delimiter)] : [];
  });
  return changed ? next : undefined;
}
