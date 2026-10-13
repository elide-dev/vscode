import { existsSync, realpathSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { OUTPUT_DIR } from "./elide.js";

/** One branch of a line: how often it was taken (`0` when never). */
export interface BranchHits {
  hits: number;
}

/** A line with executable code; `line` is 1-based, as both report formats number lines. */
export interface LineHits {
  line: number;
  hits: number;
  branches: BranchHits[];
}

/** Coverage of one source file, keyed by absolute path. */
export interface FileCoverageData {
  path: string;
  /** Sorted by line. */
  lines: LineHits[];
}

/** The coverage files a `--coverage` run left in a project's output directory. */
export interface CoverageReports {
  /** Guest (JavaScript/TypeScript) coverage, LCOV. */
  lcov: string[];
  /** JVM coverage as a JaCoCo XML report, written when the manifest asks for one (`Coverage.xmlReport()`). */
  jacocoXml: string[];
  /** JVM coverage as JaCoCo execution data, which is only readable together with the compiled classes. */
  jacocoExec: string[];
}

/**
 * Directories under a project's `.dev` holding coverage: Elide 1.6 writes every engine's reports under
 * `reports/coverage/<engine>/`, while 1.5 wrote JVM coverage under `artifacts/coverage/jvm/`.
 */
const COVERAGE_DIRS = [path.join("reports", "coverage"), path.join("artifacts", "coverage")];
const LCOV_NAME = "lcov.info";
const JACOCO_DOCTYPE = "-//JACOCO//DTD Report";

/**
 * Coverage files under `projectRoot`, ignoring any last modified before `modifiedSince` (epoch ms): they stay in the
 * output directory until the next `--coverage` run overwrites them, so an older one belongs to an earlier run.
 */
export async function findCoverageReports(projectRoot: string, modifiedSince = 0): Promise<CoverageReports> {
  const found: CoverageReports = { lcov: [], jacocoXml: [], jacocoExec: [] };
  for (const dir of COVERAGE_DIRS) {
    for (const file of await filesUnder(path.join(projectRoot, OUTPUT_DIR, dir))) {
      try {
        if ((await stat(file)).mtimeMs < modifiedSince) continue;
      } catch {
        continue;
      }
      const name = path.basename(file);
      if (name === LCOV_NAME) found.lcov.push(file);
      else if (name.endsWith(".xml")) found.jacocoXml.push(file);
      else if (name.endsWith(".exec")) found.jacocoExec.push(file);
    }
  }
  return found;
}

async function filesUnder(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
    .sort();
}

/**
 * Decode an LCOV report: `SF` opens a record (Elide 1.5 wrote paths such as `/p/src/./a.ts`, normalized here), `DA:<line>,<hits>` counts a line, `BRDA:<line>,<block>,<branch>,<taken>`
 * a branch (`-` when its block never ran), `end_of_record` closes it. Everything else is a summary or a function record
 * and is skipped.
 */
export function parseLcov(text: string): FileCoverageData[] {
  const files: FileCoverageData[] = [];
  let current: Map<number, LineHits> | undefined;
  let source = "";
  const lineOf = (n: number): LineHits => {
    let entry = current!.get(n);
    if (!entry) current!.set(n, (entry = { line: n, hits: 0, branches: [] }));
    return entry;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      source = path.normalize(line.slice(3));
      current = new Map();
    } else if (!current) {
      continue;
    } else if (line.startsWith("DA:")) {
      const [n, hits] = line.slice(3).split(",");
      const lineNo = Number(n);
      if (lineNo >= 1) lineOf(lineNo).hits += Number(hits) || 0;
    } else if (line.startsWith("BRDA:")) {
      const [n, , , taken] = line.slice(5).split(",");
      const lineNo = Number(n);
      if (lineNo >= 1) lineOf(lineNo).branches.push({ hits: taken === "-" ? 0 : Number(taken) || 0 });
    } else if (line === "end_of_record") {
      files.push({ path: source, lines: sortedLines(current) });
      current = undefined;
    }
  }
  return files;
}

/**
 * Decode a JaCoCo XML report. Its `<sourcefile>` elements carry per-line instruction and branch counters (`ci`/`mi`,
 * `cb`/`mb`), but know a source only by package and file name, so `resolve` maps `<package>/<File.kt>` to an
 * absolute path; a source it cannot place is dropped, since a record no editor file matches shows nothing.
 *
 * JaCoCo records whether an instruction ran, not how often: a line with any covered instruction counts as one hit.
 */
export function parseJacocoXml(text: string, resolve: (relative: string) => string | undefined): FileCoverageData[] {
  if (!text.includes(JACOCO_DOCTYPE) && !/<report[\s>]/.test(text)) return [];
  const files: FileCoverageData[] = [];
  const packages = /<package\s+name="([^"]*)"\s*>([\s\S]*?)<\/package>/g;
  for (const [, packageName = "", body = ""] of text.matchAll(packages)) {
    const sources = /<sourcefile\s+name="([^"]*)"\s*>([\s\S]*?)<\/sourcefile>/g;
    for (const [, fileName = "", lines = ""] of body.matchAll(sources)) {
      const pkg = xmlText(packageName);
      const name = xmlText(fileName);
      const absolute = resolve(pkg ? `${pkg}/${name}` : name);
      if (!absolute) continue;
      const entries: LineHits[] = [];
      for (const [attrs = ""] of lines.matchAll(/<line\s[^>]*\/>/g)) {
        const nr = attr(attrs, "nr");
        if (nr < 1) continue;
        const covered = attr(attrs, "cb");
        const missed = attr(attrs, "mb");
        const branches: BranchHits[] = [];
        for (let i = 0; i < covered; i++) branches.push({ hits: 1 });
        for (let i = 0; i < missed; i++) branches.push({ hits: 0 });
        entries.push({ line: nr, hits: attr(attrs, "ci") > 0 ? 1 : 0, branches });
      }
      files.push({ path: absolute, lines: entries.sort((a, b) => a.line - b.line) });
    }
  }
  return files;
}

function attr(element: string, name: string): number {
  const m = new RegExp(`\\s${name}="(\\d+)"`).exec(element);
  return m ? Number(m[1]) : 0;
}

function xmlText(s: string): string {
  return s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e: string) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[e] ?? "");
}

function sortedLines(lines: Map<number, LineHits>): LineHits[] {
  return [...lines.values()].sort((a, b) => a.line - b.line);
}

/**
 * Union reports by path: hits of the same line add up, and so do the hits of the branch at the same position, which
 * is how several runs over one source combine. Files keep the order they first appear in.
 */
export function mergeCoverage(reports: Iterable<FileCoverageData>): FileCoverageData[] {
  const byPath = new Map<string, Map<number, LineHits>>();
  for (const file of reports) {
    let lines = byPath.get(file.path);
    if (!lines) byPath.set(file.path, (lines = new Map()));
    for (const { line, hits, branches } of file.lines) {
      const entry = lines.get(line);
      if (!entry) {
        lines.set(line, { line, hits, branches: branches.map((b) => ({ ...b })) });
        continue;
      }
      entry.hits += hits;
      branches.forEach((b, i) => {
        const existing = entry.branches[i];
        if (existing) existing.hits += b.hits;
        else entry.branches.push({ ...b });
      });
    }
  }
  return [...byPath].map(([p, lines]) => ({ path: p, lines: sortedLines(lines) }));
}

/** Absolute path of `<package>/<File>` under the first source root holding it. */
export function sourceResolver(sourceRoots: readonly string[], exists: (p: string) => boolean = existsSync): (relative: string) => string | undefined {
  return (relative) => sourceRoots.map((root) => path.join(root, relative)).find(exists);
}

export interface LoadedCoverage {
  files: FileCoverageData[];
  reports: CoverageReports;
}

/**
 * Read the coverage a run left under `projectRoot` since `modifiedSince`: guest LCOV as it is, JaCoCo XML resolved
 * against `sourceRoots`. JaCoCo execution data is reported in `reports` but not decoded.
 *
 * The CLI records the real path of the project directory, so for a project opened through a symlink LCOV paths under
 * the real root are restated under `projectRoot`, the path the editor knows its files by.
 */
export async function loadCoverage(projectRoot: string, sourceRoots: readonly string[], modifiedSince = 0): Promise<LoadedCoverage> {
  const reports = await findCoverageReports(projectRoot, modifiedSince);
  const files: FileCoverageData[] = [];
  let realRoot = projectRoot;
  try {
    realRoot = realpathSync(projectRoot);
  } catch {
    // keep the path as given
  }
  for (const file of reports.lcov) {
    const text = await readText(file);
    if (text === undefined) continue;
    for (const entry of parseLcov(text)) files.push({ ...entry, path: rebase(entry.path, realRoot, projectRoot) });
  }
  const resolve = sourceResolver(sourceRoots);
  for (const file of reports.jacocoXml) {
    const text = await readText(file);
    if (text !== undefined) files.push(...parseJacocoXml(text, resolve));
  }
  return { files: mergeCoverage(files), reports };
}

function rebase(p: string, from: string, to: string): string {
  if (from === to) return p;
  if (p === from) return to;
  return p.startsWith(from + path.sep) || p.startsWith(`${from}/`) ? to + p.slice(from.length) : p;
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}
