import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ElideCli,
  ElideCommandFailedError,
  ElideNotFoundError,
  InvalidElideHomeError,
  distributionAt,
  lockfileDigest,
  lockfilesIn,
  outermostManifests,
  parseClasspath,
  resolveElideDistribution,
} from "../src/index.js";

describe("resolveElideDistribution", () => {
  const files = new Set(["/custom/elide/bin/elide", "/home/u/.local/share/elide/bin/elide", "/usr/local/bin/elide"]);
  const base = { platform: "linux" as const, isFile: (p: string) => files.has(p) };

  test("an explicit home must be valid", () => {
    expect(() => resolveElideDistribution({ ...base, env: {}, explicitHome: "/nonexistent" })).toThrow(InvalidElideHomeError);
    expect(resolveElideDistribution({ ...base, env: {}, explicitHome: "/custom/elide" }).bin).toBe("/custom/elide/bin/elide");
  });

  test("ELIDE_HOME beats platform candidates, which beat PATH", () => {
    expect(resolveElideDistribution({ ...base, env: { HOME: "/home/u", ELIDE_HOME: "/custom/elide" } }).home).toBe("/custom/elide");
    expect(resolveElideDistribution({ ...base, env: { HOME: "/home/u" } }).home).toBe("/home/u/.local/share/elide");
    expect(resolveElideDistribution({ ...base, env: { HOME: "/nobody" }, which: () => "/usr/local/bin/elide" }).home).toBe("/usr/local");
  });

  test("reports every probed location when nothing is found", () => {
    expect(() => resolveElideDistribution({ ...base, env: { HOME: "/nobody" }, which: () => undefined })).toThrow(ElideNotFoundError);
  });
});

describe("parseClasspath", () => {
  test("splits on the delimiter, drops empties, resolves relative entries", () => {
    expect(parseClasspath(" /a/x.jar:rel/y.jar::/b/z.jar \n", "/proj", ":")).toEqual(["/a/x.jar", "/proj/rel/y.jar", "/b/z.jar"]);
    expect(parseClasspath("", "/proj", ":")).toEqual([]);
  });
});

describe("outermostManifests", () => {
  test("drops manifests nested inside another project, keeping discovery order", () => {
    expect(
      outermostManifests([
        "/proj/tools/elide.pkl",
        "/proj/elide.pkl",
        "/proj/samples/ktjvm/elide.pkl",
        "/proj/third_party/vendored/deep/elide.pkl",
      ]),
    ).toEqual(["/proj/elide.pkl"]);
  });

  test("keeps siblings and prefix-sharing roots", () => {
    expect(outermostManifests(["/w/app/elide.pkl", "/w/app-tests/elide.pkl", "/w/lib/elide.pkl"])).toEqual([
      "/w/app/elide.pkl",
      "/w/app-tests/elide.pkl",
      "/w/lib/elide.pkl",
    ]);
  });

  test("an outer manifest discovered last still shadows the inner ones", () => {
    expect(outermostManifests(["/w/a/b/elide.pkl", "/w/a/elide.pkl"])).toEqual(["/w/a/elide.pkl"]);
  });

  test("relative and non-normalized paths resolve before comparison", () => {
    const cwd = process.cwd();
    expect(outermostManifests(["elide.pkl", `${cwd}/sub/./elide.pkl`])).toEqual(["elide.pkl"]);
  });
});

describe("lockfileDigest", () => {
  const roots: string[] = [];
  /** A throwaway project root with an empty `.dev`; returns the `.dev` path, which is where lockfiles live. */
  const projectDev = (): string => {
    const root = mkdtempSync(path.join(tmpdir(), "elide-lock-"));
    roots.push(root);
    mkdirSync(path.join(root, ".dev"));
    return path.join(root, ".dev");
  };
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  test("a rewrite with the same content is not a change", async () => {
    const dev = projectDev();
    const root = path.dirname(dev);
    const lock = path.join(dev, "elide.lock.v2.bin");
    writeFileSync(lock, Buffer.from([1, 2, 3]));
    const before = await lockfileDigest(root);
    // What `elide run`/`elide test` do: write the same bytes back, moving only the mtime.
    writeFileSync(lock, Buffer.from([1, 2, 3]));
    const later = new Date(Date.now() + 60_000);
    utimesSync(lock, later, later);
    expect(await lockfileDigest(root)).toBe(before);

    writeFileSync(lock, Buffer.from([1, 2, 4]));
    expect(await lockfileDigest(root)).not.toBe(before);
  });

  test("covers every lockfile and ignores the rest of .dev", async () => {
    const dev = projectDev();
    const root = path.dirname(dev);
    writeFileSync(path.join(dev, "elide.lock.v2.bin"), "a");
    const single = await lockfileDigest(root);
    writeFileSync(path.join(dev, "elide.build.bin"), "irrelevant");
    expect(await lockfileDigest(root)).toBe(single);
    writeFileSync(path.join(dev, "elide.lock.v3.bin"), "b");
    expect(await lockfileDigest(root)).not.toBe(single);
    expect((await lockfilesIn(root)).map((f) => path.basename(f))).toEqual(["elide.lock.v2.bin", "elide.lock.v3.bin"]);
  });

  test("a project without lockfiles digests to a constant", async () => {
    expect(await lockfileDigest(path.dirname(projectDev()))).toBe(await lockfileDigest(path.dirname(projectDev())));
    expect(await lockfilesIn(path.dirname(projectDev()))).toEqual([]);
  });
});

/**
 * Stand-ins for the CLI, with the exit codes and usage errors of the real ones: 1.6 removed `manifest` in favour of
 * `project export`, which 1.5 does not have. Each prints its argv to stderr after the manifest.
 */
const MANIFEST_JSON = '{"name":"demo"}';
const ELIDE_1_6 = `#!/bin/sh
case "$1 $2" in
  "project export") echo '${MANIFEST_JSON}'; echo "argv: $*" >&2 ;;
  manifest*) echo 'elide manifest: removed; use \`elide project export\` instead' >&2; exit 2 ;;
esac
`;
const ELIDE_1_5 = `#!/bin/sh
case "$1 $2" in
  "project export") printf "error: unrecognized subcommand 'export'\\n\\nUsage: elide project [-p --project <PATH>] [SUBCOMMAND]\\n" >&2; exit 2 ;;
  manifest*) echo '${MANIFEST_JSON}'; echo "argv: $*" >&2 ;;
esac
`;
const ELIDE_BROKEN_PROJECT = `#!/bin/sh
echo "Pkl Error: Cannot find module 'elide:nope.pkl'" >&2
exit 1
`;

describe("ElideCli.manifest", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const cliFor = (script: string, flags: string[] = []): ElideCli => {
    const home = mkdtempSync(path.join(tmpdir(), "elide-home-"));
    dirs.push(home);
    mkdirSync(path.join(home, "bin"));
    writeFileSync(path.join(home, "bin", "elide"), script);
    chmodSync(path.join(home, "bin", "elide"), 0o755);
    return new ElideCli(distributionAt(home), home, flags);
  };
  const manifestOf = async (cli: ElideCli) => {
    const stderr: string[] = [];
    const manifest = await cli.manifest({ onLine: (line, isStderr) => isStderr && stderr.push(line) });
    return { manifest, stderr };
  };

  test("reads `elide project export` on Elide 1.6", async () => {
    const { manifest, stderr } = await manifestOf(cliFor(ELIDE_1_6, ["release"]));
    expect(manifest.name).toBe("demo");
    expect(stderr).toEqual(["argv: project export -f release"]);
  });

  test("falls back to `elide manifest` on a CLI without `project export`, hiding the usage error", async () => {
    const { manifest, stderr } = await manifestOf(cliFor(ELIDE_1_5, ["release"]));
    expect(manifest.name).toBe("demo");
    expect(stderr).toEqual(["argv: manifest -f release"]);
  });

  test("any other failure of `project export` is reported as is", async () => {
    const stderr: string[] = [];
    const failure = await cliFor(ELIDE_BROKEN_PROJECT)
      .manifest({ onLine: (line, isStderr) => isStderr && stderr.push(line) })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ElideCommandFailedError);
    expect((failure as ElideCommandFailedError).args).toEqual(["project", "export"]);
    expect(stderr).toEqual(["Pkl Error: Cannot find module 'elide:nope.pkl'"]);
  });
});
