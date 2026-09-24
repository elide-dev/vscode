import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { MANIFEST_NAME, OUTPUT_DIR } from "./elide.js";
import type { JarArtifact, Manifest } from "./manifest.js";
import { pklBlock, pklStrings } from "./pkl.js";
import { isPathUnder, normalizePath } from "./sourceRoots.js";

/** Directory under {@link OUTPUT_DIR} that `elide build` writes a project's artifacts to. */
export const ARTIFACTS_DIR = "artifacts";

/** Source set Elide packages into a JAR that names none. */
export const DEFAULT_SOURCE_SET = "main";

/** The name Elide knows the project rooted at `root` by: the one its manifest declares, else the directory's own. */
export function projectName(manifest: Manifest, root: string): string {
  return manifest.name ?? path.basename(root);
}

/**
 * The project root whose build wrote `entry`, when that path is an Elide build output (`<root>/.dev/artifacts/…`),
 * and `undefined` for anything else. The innermost output directory wins: a workspace root holding a member's
 * checkout has its own `.dev` above the member's.
 */
export function artifactProjectRoot(entry: string): string | undefined {
  const normalized = normalizePath(path.resolve(entry));
  const marker = `/${OUTPUT_DIR}/${ARTIFACTS_DIR}/`;
  const at = normalized.lastIndexOf(marker);
  return at < 0 ? undefined : normalized.slice(0, at);
}

/**
 * The members a manifest declares, read from its text: `workspace { members { "model" "cli" } }`.
 *
 * Reading the text answers for a directory no project has been loaded from — the workspace above the folder an
 * editor was pointed at — which `elide manifest` cannot be asked about without loading that project first.
 */
export function parseWorkspaceMembers(text: string): string[] {
  const workspace = pklBlock(text, "workspace");
  if (!workspace) return [];
  const members = pklBlock(text, "members", workspace.start, workspace.end);
  return members ? pklStrings(text, members.start, members.end) : [];
}

/** An Elide workspace declaring a directory as one of its members. */
export interface EnclosingWorkspace {
  /** Root of the workspace: the directory whose manifest declares the member. */
  root: string;
  /** The member entry naming the directory, as the root's manifest spells it. */
  member: string;
}

/**
 * The workspace `dir` is a member of, found by walking up from it until a manifest declares it — `undefined` when
 * none does. Nothing below `dir` is read, and the walk stops at the filesystem root.
 */
export function findEnclosingWorkspace(dir: string, readManifest: (file: string) => string | undefined = readManifestOrNothing): EnclosingWorkspace | undefined {
  const target = normalizePath(path.resolve(dir));
  for (let current = path.dirname(path.resolve(dir)); ; ) {
    const text = readManifest(path.join(current, MANIFEST_NAME));
    const member = text === undefined ? undefined : parseWorkspaceMembers(text).find((m) => normalizePath(path.resolve(current, m)) === target);
    if (member !== undefined) return { root: current, member };
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * The manifest text with `member` declared as a workspace member, in the block the manifest already has: added to
 * `workspace.members`, or written whole when the manifest declares no workspace, which turns a standalone project
 * into the root of one. A member already declared leaves the text untouched.
 */
export function withWorkspaceMember(text: string, member: string): string {
  if (parseWorkspaceMembers(text).includes(member)) return text;
  const entry = `"${member}"`;
  const workspace = pklBlock(text, "workspace");
  if (!workspace) {
    const separator = text.length === 0 || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    return `${text}${separator}workspace {\n  members {\n    ${entry}\n  }\n}\n`;
  }
  const members = pklBlock(text, "members", workspace.start, workspace.end);
  if (!members) {
    const indent = indentOfLineAt(text, workspace.start);
    const rest = text.slice(workspace.start);
    // Whatever the workspace block already held keeps a line of its own, wherever it stood before.
    const tail = rest.startsWith("\n") ? rest : `\n${indent}  ${rest.trimStart()}`;
    return `${text.slice(0, workspace.start)}\n${indent}  members {\n${indent}    ${entry}\n${indent}  }${tail}`;
  }
  const closeIndent = indentBefore(text, members.end);
  // A block written on one line (`members { "a" "b" }`) keeps its shape; one spread over lines gets another row.
  if (closeIndent === undefined) return `${text.slice(0, members.end).replace(/\s+$/, "")} ${entry} ${text.slice(members.end)}`;
  const body = text.slice(members.start, members.end);
  const entryIndent = /\n([ \t]*)"/.exec(body)?.[1] ?? `${closeIndent}  `;
  const closeLine = text.lastIndexOf("\n", members.end) + 1;
  return `${text.slice(0, closeLine)}${entryIndent}${entry}\n${text.slice(closeLine)}`;
}

/** Indentation of the line holding `offset`. */
function indentOfLineAt(text: string, offset: number): string {
  const start = text.lastIndexOf("\n", offset) + 1;
  return /^[ \t]*/.exec(text.slice(start, offset))?.[0] ?? "";
}

/** Whitespace between `offset` and the start of its line, or `undefined` when something else stands there. */
function indentBefore(text: string, offset: number): string | undefined {
  const start = text.lastIndexOf("\n", offset) + 1;
  const prefix = text.slice(start, offset);
  return /^[ \t]*$/.test(prefix) ? prefix : undefined;
}

function readManifestOrNothing(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** An artifact a project of a workspace builds, as a classpath entry names it. */
export interface ArtifactOutput {
  /** Name of the project writing the artifact. */
  project: string;
  /** Name the artifact is written under; absent when the entry names no artifact directory of its own. */
  name?: string;
}

/**
 * Relates classpath entries to the artifacts the projects of a workspace build.
 *
 * The CLI puts a sibling's JAR on a member's classpath as the path that sibling's build writes, spelled relative to
 * the consumer (`<ws>/cli/../parser/.dev/artifacts/jar/parser/parser.jar`). Such an entry is a build output rather
 * than a library — it may not even exist yet — and the IDE can only act on the sources behind it. Both the lexical
 * and the real form of every project root are indexed, because the CLI resolves symlinks on its way (`/tmp` is
 * `/private/tmp` on macOS) while the IDE holds the path the folder was opened with.
 */
export class ArtifactIndex {
  private readonly dirs: { dir: string; project: string }[];

  constructor(projects: readonly { name: string; root: string }[], realpath: (p: string) => string = realpathOrSelf) {
    this.dirs = projects.flatMap(({ name, root }) => {
      const lexical = normalizePath(path.resolve(root));
      return [...new Set([lexical, normalizePath(realpath(lexical))])].map((r) => ({ dir: `${r}/${OUTPUT_DIR}/${ARTIFACTS_DIR}`, project: name }));
    });
  }

  /**
   * The artifact `entry` names, or `undefined` when it names a library. Elide writes an artifact to
   * `<kind>/<name>/` below the project's artifact directory, which is all the entry carries about it.
   */
  resolve(entry: string): ArtifactOutput | undefined {
    const normalized = normalizePath(path.resolve(entry));
    const match = this.dirs.find(({ dir }) => isPathUnder(normalized, dir));
    if (!match) return undefined;
    const name = normalized.slice(match.dir.length + 1).split("/")[1];
    return { project: match.project, ...(name ? { name } : {}) };
  }
}

/**
 * The source sets of `manifest` backing the JAR a `project(…)` reference names, or `[]` when it resolves to no JAR
 * the manifest declares. A reference naming no artifact resolves against a project declaring exactly one JAR, the
 * way the CLI resolves it; one declaring several is a manifest error the CLI reports.
 */
export function referencedSourceSets(manifest: Manifest, artifact: string | undefined): string[] {
  const jars = Object.values(manifest.jars);
  const jar = artifact === undefined ? (jars.length === 1 ? jars[0] : undefined) : manifest.jars[artifact];
  return jar ? packagedSourceSets(manifest, jar) : [];
}

/**
 * The source sets of `manifest` backing the JAR the build writes under the output name `output`, or `[]` when the
 * manifest declares no such JAR. An artifact is written under its declared `name`, falling back to its key; an
 * entry that carries no name resolves the way an unnamed reference does.
 */
export function sourceSetsForArtifactOutput(manifest: Manifest, output: string | undefined): string[] {
  if (output === undefined) return referencedSourceSets(manifest, undefined);
  const jar = Object.entries(manifest.jars).find(([key, j]) => (j.name ?? key) === output)?.[1];
  return jar ? packagedSourceSets(manifest, jar) : [];
}

/** The source sets `jar` packages: those it names which the manifest declares, else the default one. */
function packagedSourceSets(manifest: Manifest, jar: JarArtifact): string[] {
  const declared = jar.sources.filter((s) => s in manifest.sources);
  return declared.length > 0 ? declared : [DEFAULT_SOURCE_SET];
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}
