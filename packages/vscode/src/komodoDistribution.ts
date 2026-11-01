import { constants, accessSync, statSync } from "node:fs";
import path from "node:path";
import { ElideCli, ElideCommandFailedError, resolveElideDistribution, type RunOptions } from "@elide/ide-core";

/** The launch identity returned by Elide, shared by analysis, debugging and previews. */
export interface KomodoResolution {
  executable: string;
  bundle: string;
  pluginDirectory?: string;
  javaHome?: string;
}

export class KomodoResolutionError extends Error {
  constructor(readonly status: string, message: string) {
    super(message);
    this.name = "KomodoResolutionError";
  }
}

function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** An explicit developer build is authoritative: never replace it with a managed install. */
export async function resolveKomodo(explicit: string | undefined, elideHome: string | undefined,
  options: RunOptions = {}): Promise<KomodoResolution> {
  if (explicit) {
    if (!path.isAbsolute(explicit) || !executable(explicit)) {
      throw new KomodoResolutionError("override", `elide.kotlinLsp.komodo.path (${explicit}) must name an absolute, executable file. Fix or clear the setting; it will not be replaced automatically.`);
    }
    return { executable: explicit, bundle: path.dirname(explicit) };
  }
  return managedKomodo(elideHome, false, options);
}

/** Only an explicit user action may call this. Elide owns download, verification and storage. */
export function installKomodo(elideHome: string | undefined, options: RunOptions = {}): Promise<KomodoResolution> {
  return managedKomodo(elideHome, true, options);
}

async function managedKomodo(elideHome: string | undefined, install: boolean, options: RunOptions): Promise<KomodoResolution> {
  options.signal?.throwIfAborted();
  const dist = resolveElideDistribution(elideHome ? { explicitHome: elideHome } : {});
  const cli = new ElideCli(dist, dist.home);
  let stdout = "";
  let failed: unknown;
  try {
    await cli.run(["komodo", install ? "install" : "resolve", ...(install ? ["--yes"] : []), "--json"], {
      ...options,
      onLine: (line, stderr) => {
        if (stderr) options.onLine?.(line, true);
        else stdout += `${line}\n`;
      },
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    if (!(error instanceof ElideCommandFailedError)) throw error;
    failed = error;
  }
  let value: unknown;
  try { value = JSON.parse(stdout); } catch {
    if (failed instanceof ElideCommandFailedError && /(?:unknown|unrecognized|unexpected|invalid)[^\n]*(?:komodo|subcommand)|(?:komodo)[^\n]*(?:unknown|unrecognized)|No file or script named 'komodo'/i.test(failed.stderr)) {
      throw new KomodoResolutionError("upgrade", "This Elide CLI does not support managed Komodo. Upgrade Elide to a release providing 'elide komodo resolve --json', or configure an explicit developer build.");
    }
    throw failed ?? new KomodoResolutionError("incompatible", "Elide returned invalid Komodo resolution JSON. Upgrade Elide to a compatible release.");
  }
  if (!value || typeof value !== "object") throw new KomodoResolutionError("incompatible", "Elide returned an invalid Komodo resolution identity.");
  const data = value as Record<string, unknown>;
  if (data.schemaVersion !== 1 || data.component !== "komodo") {
    throw new KomodoResolutionError("incompatible", "Unsupported Elide Komodo resolution schema. Upgrade Elide and the extension together.");
  }
  if (data.status !== "resolved") {
    if (!["missing", "unsupported", "incompatible", "error"].includes(String(data.status)) || typeof data.message !== "string") {
      throw new KomodoResolutionError("incompatible", "Elide returned an invalid Komodo resolution failure.");
    }
    throw new KomodoResolutionError(String(data.status), data.message);
  }
  if (failed) throw failed;
  const protocol = data.protocol as Record<string, unknown> | undefined;
  const capabilities = data.capabilities;
  const absolute = (key: string): string => {
    const field = data[key];
    if (typeof field !== "string" || !path.isAbsolute(field)) throw new KomodoResolutionError("incompatible", `Elide's Komodo identity has no absolute ${key} path.`);
    return field;
  };
  if (typeof data.version !== "string" || !data.version || !protocol || protocol.lsp !== 1 || protocol.dap !== 1 ||
    !Array.isArray(capabilities) || !["lsp", "dap"].every((capability) => capabilities.includes(capability))) {
    throw new KomodoResolutionError("incompatible", "The installed Komodo does not provide compatible native Kotlin analysis and debugging. Install a compatible version through Elide.");
  }
  const launcher = absolute("executable");
  if (!executable(launcher)) throw new KomodoResolutionError("incompatible", `Elide resolved a missing or non-executable Komodo: ${launcher}. Reinstall Komodo through Elide.`);
  return { executable: launcher, bundle: absolute("bundle"), pluginDirectory: absolute("pluginDirectory"), javaHome: absolute("javaHome") };
}
