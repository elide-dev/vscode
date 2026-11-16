import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findCoverageReports, loadCoverage, loadCoverageArtifact, mergeCoverage, parseJacocoXml, parseLcov, sourceResolver } from "../src/index.js";

const fixture = (name: string) => path.join(import.meta.dir, "fixtures", "coverage", name);
/** `elide test --coverage` (Elide 1.6.0-rc.2) on a TypeScript project, with the project root replaced by `/project`. */
const lcov = readFileSync(fixture("lcov.info"), "utf8");
/**
 * The JaCoCo XML report of `elide test --coverage` (Elide 1.6.0-rc.2) on `samples/ktjvm` with `classify` added and
 * `coverage.jvm.reports { Coverage.xmlReport() }` in the manifest.
 */
const jacoco = readFileSync(fixture("jacoco.xml"), "utf8");

describe("parseLcov", () => {
  test("reads the guest report Elide writes", () => {
    expect(parseLcov(lcov)).toEqual([
      { path: "/project/src/math.ts", lines: [{ line: 1, hits: 1, branches: [] }] },
      { path: "/project/src/math.test.ts", lines: [{ line: 1, hits: 1, branches: [] }] },
    ]);
  });

  test("reads branches, and a branch whose block never ran as not taken", () => {
    const report = ["SF:/p/src/./a.ts", "DA:1,3", "DA:2,0", "BRDA:1,0,0,2", "BRDA:1,0,1,-", "BRDA:2,1,0,0", "LF:2", "LH:1", "end_of_record"].join("\n");
    expect(parseLcov(report)).toEqual([
      {
        path: path.normalize("/p/src/a.ts"),
        lines: [
          { line: 1, hits: 3, branches: [{ hits: 2 }, { hits: 0 }] },
          { line: 2, hits: 0, branches: [{ hits: 0 }] },
        ],
      },
    ]);
  });

  test("ignores an unterminated record and lines outside a record", () => {
    expect(parseLcov("DA:1,1\nSF:/a.ts\nDA:1,1\n")).toEqual([]);
  });
});

describe("parseJacocoXml", () => {
  const roots = ["/project/src/main", "/project/src/test"];
  const files = new Set(["/project/src/main/sample/Main.kt", "/project/src/test/sample/MainTest.kt"]);
  const resolve = sourceResolver(roots, (p) => files.has(p));

  test("maps instruction and branch counters to line hits and branches", () => {
    const [main, tests] = parseJacocoXml(jacoco, resolve);
    expect(main!.path).toBe("/project/src/main/sample/Main.kt");
    expect(main!.lines.map((l) => [l.line, l.hits, l.branches.map((b) => b.hits)])).toEqual([
      [4, 0, []],
      [5, 0, []],
      [6, 0, []],
      [8, 1, []],
      [11, 1, [1, 0]],
      [12, 0, [0, 0]],
      [13, 1, []],
    ]);
    expect(tests!.path).toBe("/project/src/test/sample/MainTest.kt");
    expect(tests!.lines.every((l) => l.hits === 1)).toBe(true);
  });

  test("drops sources no source root holds", () => {
    expect(parseJacocoXml(jacoco, () => undefined)).toEqual([]);
  });

  test("anything but a JaCoCo report decodes to nothing", () => {
    expect(parseJacocoXml("<testsuite name='x'/>", resolve)).toEqual([]);
  });
});

describe("mergeCoverage", () => {
  test("adds up the hits of a line and of the branch at the same position", () => {
    const merged = mergeCoverage([
      { path: "/a.kt", lines: [{ line: 2, hits: 1, branches: [{ hits: 1 }, { hits: 0 }] }] },
      { path: "/b.kt", lines: [{ line: 1, hits: 0, branches: [] }] },
      { path: "/a.kt", lines: [{ line: 1, hits: 0, branches: [] }, { line: 2, hits: 1, branches: [{ hits: 0 }, { hits: 1 }, { hits: 0 }] }] },
    ]);
    expect(merged).toEqual([
      {
        path: "/a.kt",
        lines: [
          { line: 1, hits: 0, branches: [] },
          { line: 2, hits: 2, branches: [{ hits: 1 }, { hits: 1 }, { hits: 0 }] },
        ],
      },
      { path: "/b.kt", lines: [{ line: 1, hits: 0, branches: [] }] },
    ]);
  });
});

describe("loadCoverage", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  /** A project with a Kotlin source, laid out the way `elide test --coverage` leaves its reports. */
  const project = (layout: "1.6" | "1.5") => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "elide-cov-")));
    dirs.push(root);
    mkdirSync(path.join(root, "src", "main", "sample"), { recursive: true });
    mkdirSync(path.join(root, "src", "test", "sample"), { recursive: true });
    writeFileSync(path.join(root, "src", "main", "sample", "Main.kt"), "");
    writeFileSync(path.join(root, "src", "math.ts"), "");
    const jvm = path.join(root, ".dev", layout === "1.6" ? "reports" : "artifacts", "coverage", "jvm", "jvm-test");
    mkdirSync(jvm, { recursive: true });
    copyFileSync(fixture("jacoco.xml"), path.join(jvm, "jvm-test.xml"));
    writeFileSync(path.join(jvm, "jvm-test.exec"), "");
    const js = path.join(root, ".dev", "reports", "coverage", "js");
    mkdirSync(js, { recursive: true });
    writeFileSync(path.join(js, "lcov.info"), lcov.replaceAll("/project", root));
    return root;
  };
  const sourceRoots = (root: string) => [path.join(root, "src", "main"), path.join(root, "src", "test")];

  for (const layout of ["1.6", "1.5"] as const) {
    test(`finds guest LCOV and JVM reports in the Elide ${layout} layout`, async () => {
      const root = project(layout);
      const { files, reports } = await loadCoverage(root, sourceRoots(root));
      expect(reports.jacocoExec.map((f) => path.basename(f))).toEqual(["jvm-test.exec"]);
      // MainTest.kt does not exist in this project, so only Main.kt resolves.
      expect(files.map((f) => path.relative(root, f.path)).sort()).toEqual([path.join("src", "main", "sample", "Main.kt"), path.join("src", "math.test.ts"), path.join("src", "math.ts")]);
    });
  }

  test("reports older than the run are not its coverage", async () => {
    const root = project("1.6");
    const past = new Date(Date.now() - 60_000);
    const js = path.join(root, ".dev", "reports", "coverage", "js", "lcov.info");
    utimesSync(js, past, past);
    const found = await findCoverageReports(root, Date.now() - 30_000);
    expect(found.lcov).toEqual([]);
    expect(found.jacocoXml).toHaveLength(1);
  });

  test("restates guest paths under the symlinked root the editor opened", async () => {
    const real = project("1.6");
    const link = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), "elide-cov-link-"))), "project");
    dirs.push(path.dirname(link));
    symlinkSync(real, link, "dir");
    const { files } = await loadCoverage(link, sourceRoots(link));
    expect(files.map((f) => f.path).filter((p) => p.endsWith(".ts")).sort()).toEqual([path.join(link, "src", "math.test.ts"), path.join(link, "src", "math.ts")]);
  });
});

describe("loadCoverageArtifact", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const project = () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "elide-cov-artifact-")));
    dirs.push(root);
    return root;
  };
  const row = (source = "src/Main.kt") => ({
    engine: "jvm",
    path: source,
    lines: [{ line: 1, covered: true }],
  });
  const document = (files: unknown[] = [row()], complete = true) => ({ version: 1, complete, files });
  const write = (root: string, value: unknown) => {
    const file = path.join(root, "coverage.json");
    writeFileSync(file, JSON.stringify(value));
    return file;
  };

  test("maps boolean hits and exact branch totals, sorts lines, and merges engines", async () => {
    const root = project();
    const artifact = document([
      {
        ...row(),
        lines: [
          { line: 5, covered: false, branches: { covered: 0, total: 2 } },
          { line: 3, covered: true, branches: { covered: 2, total: 3 } },
          { line: 1, covered: false },
          { line: 6, covered: true, branches: { covered: 0, total: 0 } },
        ],
      },
      { ...row(), engine: "js", lines: [{ line: 3, covered: true, branches: { covered: 1, total: 3 } }] },
      { ...row("other.ts"), engine: "future-engine", language: "typescript", unknown: true },
    ]);
    expect(await loadCoverageArtifact(write(root, artifact), root)).toEqual({
      complete: true,
      files: [
        {
          path: path.join(root, "src", "Main.kt"),
          lines: [
            { line: 1, hits: 0, branches: [] },
            { line: 3, hits: 2, branches: [{ hits: 2 }, { hits: 1 }, { hits: 0 }] },
            { line: 5, hits: 0, branches: [{ hits: 0 }, { hits: 0 }] },
            { line: 6, hits: 1, branches: [] },
          ],
        },
        { path: path.join(root, "other.ts"), lines: [{ line: 1, hits: 1, branches: [] }] },
      ],
    });
  });

  test("retains incomplete subsets and recognizes empty complete or incomplete artifacts", async () => {
    const root = project();
    const partial = await loadCoverageArtifact(write(root, document([row()], false)), root);
    expect(partial?.complete).toBe(false);
    expect(partial?.files).toHaveLength(1);
    for (const complete of [true, false]) {
      expect(await loadCoverageArtifact(write(root, document([], complete)), root)).toEqual({ files: [], complete });
    }
  });

  test("ignores absent, unreadable, invalid JSON and invalid UTF-8 artifacts", async () => {
    const root = project();
    const file = path.join(root, "coverage.json");
    expect(await loadCoverageArtifact(file, root)).toBeUndefined();
    expect(await loadCoverageArtifact(root, root)).toBeUndefined();
    writeFileSync(file, "{");
    expect(await loadCoverageArtifact(file, root)).toBeUndefined();
    writeFileSync(file, Buffer.concat([Buffer.from('{"version":1,"complete":true,"files":[],"extra":"'), Buffer.from([0xff]), Buffer.from('"}')]));
    expect(await loadCoverageArtifact(file, root)).toBeUndefined();
  });

  test("rejects unsupported versions and malformed envelopes, files, lines and counters", async () => {
    const root = project();
    const badLines: unknown[] = [
      null, {}, { line: 0, covered: true }, { line: -1, covered: true },
      { line: 1.5, covered: true }, { line: Number.MAX_SAFE_INTEGER + 1, covered: true },
      { line: "1", covered: true }, { line: 1, covered: 1 },
      { line: 1, covered: true, branches: null },
      ...[
        {}, { covered: -1, total: 1 }, { covered: 2, total: 1 },
        { covered: 0, total: -1 }, { covered: 0.5, total: 1 },
        { covered: 0, total: 1.5 }, { covered: 0, total: "2" },
        { covered: 0, total: Number.MAX_SAFE_INTEGER + 1 },
        { covered: 0, total: 1_000_000_000 },
      ].map((branches) => ({ line: 1, covered: true, branches })),
    ];
    const invalid: unknown[] = [
      null, [], {}, { ...document(), version: 2 }, { ...document(), complete: "true" },
      { ...document(), files: {} }, document([null]), document([{}]),
      document([{ ...row(), engine: 1 }]), document([{ ...row(), engine: "" }]),
      document([{ ...row(), lines: {} }]), document([row(), row()]),
      document([{ ...row(), lines: [{ line: 1, covered: true }, { line: 1, covered: false }] }]),
      ...badLines.map((line) => document([{ ...row(), lines: [line] }])),
      ...[
        null, {}, { algorithm: "sha256", value: "0".repeat(64) },
        { algorithm: "sha256-utf16be", value: "0".repeat(63) },
        { algorithm: "sha256-utf16be", value: "g".repeat(64) },
      ].map((sourceDigest) => document([{ ...row(), sourceDigest }])),
    ];
    for (const value of invalid) {
      expect(await loadCoverageArtifact(write(root, value), root)).toBeUndefined();
    }
  });

  test("rejects traversal and absolute paths on every platform", async () => {
    const root = project();
    for (const source of ["", ".", "..", "../outside.kt", "src/../../outside.kt", "/outside.kt", "C:/outside.kt", "C:outside.kt", "\\\\host\\outside.kt", "src\\Main.kt", "src/./Main.kt", "src//Main.kt", "src/\0Main.kt"]) {
      expect(await loadCoverageArtifact(write(root, document([row(source)])), root)).toBeUndefined();
    }
  });

  test("rejects symlinked source files or directories escaping the project", async () => {
    const root = project();
    const outside = project();
    writeFileSync(path.join(outside, "Outside.kt"), "");
    symlinkSync(path.join(outside, "Outside.kt"), path.join(root, "Outside.kt"), "file");
    symlinkSync(outside, path.join(root, "linked"), "dir");
    for (const source of ["Outside.kt", "linked/Outside.kt", "linked/missing/nested.kt"]) {
      expect(await loadCoverageArtifact(write(root, document([row(source)])), root)).toBeUndefined();
    }
  });

  test("bounds bytes, file count, total lines and expanded branches", async () => {
    const root = project();
    const file = path.join(root, "coverage.json");
    writeFileSync(file, " ".repeat(8 * 1024 * 1024 + 1));
    expect(await loadCoverageArtifact(file, root)).toBeUndefined();
    expect(await loadCoverageArtifact(write(root, document(Array.from({ length: 2_001 }, (_, i) => row(`${i}.kt`)))), root)).toBeUndefined();
    const lines = Array.from({ length: 100_001 }, (_, i) => ({ line: i + 1, covered: true }));
    expect(await loadCoverageArtifact(write(root, document([{ ...row("a.kt"), lines }, { ...row("b.kt"), lines }])), root)).toBeUndefined();
    expect(await loadCoverageArtifact(write(root, document([{
      ...row(),
      lines: [
        { line: 1, covered: true, branches: { covered: 0, total: 600_000 } },
        { line: 2, covered: true, branches: { covered: 0, total: 600_000 } },
      ],
    }])), root)).toBeUndefined();
  });

  test("checks UTF-16BE source digests without normalizing Unicode or line endings", async () => {
    const root = project();
    const source = "A😀\r\né";
    // Explicit UTF-16BE code units include the astral character's surrogate pair, and no BOM.
    const digest = createHash("sha256").update(Buffer.from([0x00, 0x41, 0xd8, 0x3d, 0xde, 0x00, 0x00, 0x0d, 0x00, 0x0a, 0x00, 0xe9])).digest("hex");
    const sourcePath = path.join(root, "Main.kt");
    writeFileSync(sourcePath, source);
    const file = write(root, document([
      { ...row("Main.kt"), sourceDigest: { algorithm: "sha256-utf16be", value: digest.toUpperCase() } },
      row("unversioned.ts"),
    ]));
    expect((await loadCoverageArtifact(file, root))?.complete).toBe(true);
    writeFileSync(sourcePath, source.replace("\r\n", "\n"));
    expect(await loadCoverageArtifact(file, root)).toEqual({
      complete: false,
      files: [{ path: path.join(root, "unversioned.ts"), lines: [{ line: 1, hits: 1, branches: [] }] }],
    });
    rmSync(sourcePath);
    expect((await loadCoverageArtifact(file, root))?.files.map((entry) => path.basename(entry.path))).toEqual(["unversioned.ts"]);
    expect((await loadCoverageArtifact(file, root))?.complete).toBe(false);
  });

  test("drops all stale rows without treating the recognized artifact as absent", async () => {
    const root = project();
    const file = write(root, document([{ ...row(), sourceDigest: { algorithm: "sha256-utf16be", value: "0".repeat(64) } }]));
    expect(await loadCoverageArtifact(file, root)).toEqual({ files: [], complete: false });
  });

  test("keeps editor paths for a symlinked project root while validating current source", async () => {
    const real = project();
    const parent = project();
    const link = path.join(parent, "project");
    symlinkSync(real, link, "dir");
    writeFileSync(path.join(real, "Main.kt"), "a");
    const digest = createHash("sha256").update(Buffer.from([0x00, 0x61])).digest("hex");
    const file = write(real, document([{ ...row("Main.kt"), sourceDigest: { algorithm: "sha256-utf16be", value: digest } }]));
    expect(await loadCoverageArtifact(file, link)).toEqual({
      complete: true,
      files: [{ path: path.join(link, "Main.kt"), lines: [{ line: 1, hits: 1, branches: [] }] }],
    });
  });
});
