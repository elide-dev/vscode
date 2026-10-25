import { existsSync } from "node:fs";
import path from "node:path";

/** One native source-analysis and Compose preview daemon. */
export const KOMODO_LSP = "komodo";

/**
 * A Komodo launcher: the configured path, then its payload in an Elide distribution (`<elide.home>/lib/<payload>/bin`,
 * shipped through the distribution's `lib/` like its other tools), or the distribution's `bin/`, then `PATH`.
 */
export function resolveKomodoLauncher(name: typeof KOMODO_LSP, explicit: string | undefined, elideHome: string | undefined,
  env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = existsSync): string | undefined {
  if (explicit) return exists(explicit) ? explicit : undefined;
  const candidates = [
    ...(elideHome ? [path.join(elideHome, "lib", "komodo", "bin", name), path.join(elideHome, "bin", name)] : []),
    ...(env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, name)),
  ];
  return candidates.find(exists);
}

/** JDK class/module resolution inputs for a native daemon installed in this distribution; never a JVM launcher. */
export function elideJdkHome(launcher: string, elideHome: string | undefined, exists: (file: string) => boolean = existsSync): string | undefined {
  if (!elideHome) return undefined;
  const relative = path.relative(elideHome, launcher);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return exists(path.join(elideHome, "lib", "modules")) ? elideHome : undefined;
}

