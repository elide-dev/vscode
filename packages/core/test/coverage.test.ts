import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findCoverageReports, loadCoverage, mergeCoverage, parseJacocoXml, parseLcov, sourceResolver } from "../src/index.js";

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
