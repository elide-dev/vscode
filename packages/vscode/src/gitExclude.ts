import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Where a file would be excluded from Git: the clone's `info/exclude`, and the pattern naming the file there. */
export interface GitExcludeTarget {
  exclude: string;
  pattern: string;
}

/**
 * The exclusion that would hide `name` in `directory` from `git status`, when Git would list it as untracked: the
 * directory is in a work tree, the repository does not track the file, and no ignore rule covers it yet. `undefined`
 * otherwise, and when Git is not installed.
 */
export async function gitExcludeCandidate(directory: string, name: string): Promise<GitExcludeTarget | undefined> {
  const git = async (...args: string[]) => (await run("git", args, { cwd: directory, encoding: "utf8", timeout: 10_000 })).stdout.trim();
  try {
    const prefix = await git("rev-parse", "--show-prefix");
    if (await git("ls-files", "--", name)) return undefined;
    try {
      await git("check-ignore", "-q", "--", name);
      return undefined;
    } catch (e) {
      // Exit status 1: no rule ignores the file.
      if (!(e instanceof Error && "code" in e && e.code === 1)) throw e;
    }
    const exclude = path.resolve(directory, await git("rev-parse", "--git-path", "info/exclude"));
    // Anchored to the work tree root, with the characters Git's patterns treat specially escaped.
    return { exclude, pattern: `/${`${prefix}${name}`.replace(/[\\*?[!#]/g, "\\$&")}` };
  } catch {
    return undefined;
  }
}

/** Append `target.pattern` to its exclude file, unless a line already says it. */
export async function addGitExclude(target: GitExcludeTarget): Promise<void> {
  let current = "";
  try {
    current = await readFile(target.exclude, "utf8");
  } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
    await mkdir(path.dirname(target.exclude), { recursive: true });
  }
  if (current.split(/\r?\n/).includes(target.pattern)) return;
  await appendFile(target.exclude, `${current.length > 0 && !current.endsWith("\n") ? "\n" : ""}${target.pattern}\n`);
}
