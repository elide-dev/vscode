import { realpath } from "node:fs/promises";
import path from "node:path";

/** `file` is `directory` or lies beneath it, lexically. */
export function inside(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/**
 * `file` with every symlink resolved, as Elide records it. A path that does not exist resolves its longest existing
 * prefix and keeps the rest lexical, so a missing file still compares as being under the root it belongs to.
 */
export async function canonicalPath(file: string): Promise<string> {
  const absolute = path.resolve(file);
  const missing: string[] = [];
  for (let existing = absolute; ;) {
    try {
      return path.join(await realpath(existing), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) return absolute;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

function escape(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/**
 * Elide canonicalizes project roots and records the paths under them that way (`/private/tmp/app/…` for a
 * workspace opened as `/tmp/app`). Editors, the synced model and the Problems view spell paths the way the workspace
 * was opened. This maps recorded paths under a root's canonical path back onto that root's workspace spelling, so
 * one physical file has one path on both sides of every comparison.
 */
export class WorkspacePaths {
  private constructor(
    /** Canonical root → workspace root, deepest first; only roots whose spellings differ. */
    private readonly aliases: readonly { canonical: string; lexical: string; pattern: RegExp }[],
  ) {}

  static async of(roots: Iterable<string>): Promise<WorkspacePaths> {
    const aliases = new Map<string, string>();
    for (const root of new Set([...roots].map((root) => path.resolve(root)))) {
      const canonical = await canonicalPath(root);
      if (canonical !== root && !aliases.has(canonical)) aliases.set(canonical, root);
    }
    const delimiters = escape(`=,${path.delimiter}`);
    const separators = escape(`${path.sep}/,${path.delimiter}`);
    return new WorkspacePaths([...aliases].sort(([left], [right]) => right.length - left.length).map(([canonical, lexical]) => ({
      canonical, lexical,
      pattern: new RegExp(`(^|[${delimiters}])${escape(canonical)}(?=$|[${separators}])`, "g"),
    })));
  }

  /** `file` spelled under its workspace root when it lies under that root's canonical path. */
  lexical(file: string): string {
    for (const { canonical, lexical } of this.aliases) {
      if (inside(canonical, file)) return path.join(lexical, path.relative(canonical, file));
    }
    return file;
  }

  /**
   * A recorded compiler argument with every canonical root it names respelled: a whole path, an `-option=path`
   * value, and each entry of a classpath or comma-separated path list.
   */
  argument(arg: string): string {
    for (const { lexical, pattern } of this.aliases) arg = arg.replace(pattern, (_, prefix: string) => `${prefix}${lexical}`);
    return arg;
  }
}
