import path from "node:path";

const DRIVE_LETTER = /^[A-Za-z]:\//;

/** Normalized paths only: forward slashes, no trailing separator. */
export function isPathUnder(candidate: string, other: string): boolean {
  if (candidate === other) return true;
  if (other === "/") return candidate.startsWith("/");
  return candidate.length > other.length && candidate[other.length] === "/" && candidate.startsWith(other);
}

export function normalizePath(p: string): string {
  const forward = p.trim().replace(/\\/g, "/");
  return forward.length > 1 ? forward.replace(/\/+$/, "") : forward;
}

/** Longest directory prefix of a glob pattern that contains no wildcard. */
export function staticPrefix(pattern: string): string {
  const normalized = normalizePath(pattern);
  const wildcard = normalized.search(/[*?[{]/);
  if (wildcard === -1) return normalized;
  const prefix = normalized.slice(0, wildcard);
  const lastSlash = prefix.lastIndexOf("/");
  return lastSlash > 0 ? prefix.slice(0, lastSlash) : "/";
}

/** Resolve a pattern against the project root unless it is already absolute (POSIX, drive letter, or UNC). */
export function absolutePattern(pattern: string, projectRoot: string): string {
  const normalized = normalizePath(pattern);
  if (normalized.startsWith("/") || DRIVE_LETTER.test(normalized)) return normalized;
  const root = normalizePath(path.resolve(projectRoot));
  return `${root}/${normalized.replace(/^\.\//, "")}`;
}

function contentRootFor(sourceFolder: string, projectRoot: string): string {
  if (sourceFolder === projectRoot || !isPathUnder(sourceFolder, projectRoot)) return sourceFolder;
  const slash = sourceFolder.lastIndexOf("/");
  const parent = slash >= 0 ? sourceFolder.slice(0, slash) : "";
  // A top-level source folder owns itself: taking the project root as a module content root would enclose every
  // other module's roots (and `.dev`), which the IDE does not allow.
  if (parent.length === 0 || parent === projectRoot || !isPathUnder(parent, projectRoot)) return sourceFolder;
  return parent;
}

/**
 * Group source-set glob patterns into non-nesting content roots.
 *
 * Returns content root → source folders (static prefixes of the patterns) it contains. Content roots never nest: a
 * folder covered by another candidate root is merged into it; the project root bounds the search.
 */
export function collectContentRoots(projectRoot: string, patterns: readonly string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (patterns.length === 0) return result;

  const root = normalizePath(path.resolve(projectRoot));
  const sourceFolders = [...new Set(patterns.map((p) => staticPrefix(absolutePattern(p, projectRoot))))];
  const candidates = [...new Set(sourceFolders.map((f) => contentRootFor(f, root)))];
  const contentRoots = candidates.filter((c) => candidates.every((o) => o === c || !isPathUnder(c, o)));

  for (const folder of sourceFolders) {
    let owner: string | undefined;
    for (const cr of contentRoots) {
      if (isPathUnder(folder, cr) && (owner === undefined || cr.length > owner.length)) owner = cr;
    }
    owner ??= contentRootFor(folder, root);
    const list = result.get(owner);
    if (list) {
      if (!list.includes(folder)) list.push(folder);
    } else {
      result.set(owner, [folder]);
    }
  }
  return result;
}

export interface SourceSelection {
  /** Deepest literal directory to scan (a literal file selector may itself be a file). */
  root: string;
  matches(file: string): boolean;
}

/**
 * Elide FileCollection selectors use Java NIO globs, not Node globs: `**` crosses
 * separators even inside a component; Elide also makes a globstar plus slash optional.
 * Literal paths select their complete tree. Keep this separate from IDE content roots,
 * whose directory approximation must never decide compiler source membership.
 */
export function sourceSelection(project: string, pattern: string): SourceSelection {
  const wildcard = pattern.search(/[*?[{]/);
  if (wildcard < 0) {
    const root = path.resolve(project, pattern);
    return { root, matches: (file) => isPathUnder(normalizePath(file), normalizePath(root)) };
  }
  const slash = pattern.lastIndexOf("/", wildcard);
  const root = path.resolve(project, slash < 0 ? "." : pattern.slice(0, slash));
  const literal = (value: string): string => value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  let expression = "^";
  let group = false;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character === "\\") {
      if (++index === pattern.length) throw new Error(`Invalid source selector: ${pattern}`);
      expression += literal(pattern[index]!);
    } else if (character === "*") {
      if (pattern[index + 1] === "*") {
        index++;
        if (pattern[index + 1] === "/") {
          index++;
          expression += "(?:.*/)?";
        } else expression += ".*";
      } else expression += "[^/]*";
    } else if (character === "?") expression += "[^/]";
    else if (character === "{") {
      if (group) throw new Error(`Nested group in source selector: ${pattern}`);
      group = true;
      expression += "(?:";
    } else if (character === "}" && group) {
      group = false;
      expression += ")";
    } else if (character === "," && group) expression += "|";
    else if (character === "[") {
      let members = "";
      let negative = false;
      if (pattern[index + 1] === "!") { negative = true; index++; }
      while (++index < pattern.length && pattern[index] !== "]") {
        const member = pattern[index]!;
        if (member === "/") throw new Error(`Separator in source selector character class: ${pattern}`);
        members += member === "\\" || member === "[" || member === "^" || member === "&" ? `\\${member}` : member;
      }
      if (index === pattern.length || !members) throw new Error(`Invalid character class in source selector: ${pattern}`);
      expression += `(?!/)[${negative ? "^" : ""}${members}]`;
    } else expression += literal(character);
  }
  if (group) throw new Error(`Unclosed group in source selector: ${pattern}`);
  const matcher = new RegExp(`${expression}$`);
  return { root, matches: (file) => matcher.test(path.relative(project, file).split(path.sep).join("/")) };
}
