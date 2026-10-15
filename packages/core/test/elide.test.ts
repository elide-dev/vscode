import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ElideCli,
  ElideCommandFailedError,
  ElideNotFoundError,
  InvalidElideHomeError,
  distributionAt,
  importedModules,
  isLockfileCurrent,
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

describe("isLockfileCurrent", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  const at = (file: string, secondsFromNow: number) => {
    const when = new Date(Date.now() + secondsFromNow * 1000);
    utimesSync(file, when, when);
  };
  /** A workspace installed a minute ago whose member imports a shared `versions.pkl`, itself importing more. */
  const installed = () => {
    const root = mkdtempSync(path.join(tmpdir(), "elide-current-"));
    roots.push(root);
    const files: Record<string, string> = {
      "elide.pkl": `amends "elide:project.pkl"\n// import "notes.pkl"\nimport "gone.pkl"\n`,
      "packages/ui/elide.pkl": `amends "elide:project.pkl"\n\nimport "elide:Android.pkl" as Android\nimport "../../versions.pkl"\n`,
      "versions.pkl": `import "elide:Android.pkl" as Android\nlocal compose = import("deps/compose.pkl")\n`,
      "deps/compose.pkl": `bom = "androidx.compose:compose-bom:2026.01.00"\n`,
      "notes.pkl": `text = "not imported"\n`,
      ".dev/elide.lock.v2.bin": "lock",
    };
    mkdirSync(path.join(root, ".dev", "dependencies"), { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      writeFileSync(path.join(root, name), text);
      at(path.join(root, name), name.endsWith(".bin") ? -60 : -120);
    }
    return { root, manifests: [path.join(root, "elide.pkl"), path.join(root, "packages/ui/elide.pkl")] };
  };

  test("a module a manifest imports, directly or through another, counts like the manifest", async () => {
    const { root, manifests } = installed();
    expect(await isLockfileCurrent(root, manifests)).toBe(true);
    at(path.join(root, "deps/compose.pkl"), 0);
    expect(await isLockfileCurrent(root, manifests)).toBe(false);
    at(path.join(root, "deps/compose.pkl"), -120);
    at(path.join(root, "versions.pkl"), 0);
    expect(await isLockfileCurrent(root, manifests)).toBe(false);
  });

  test("a commented-out import does not count, and a missing one is the CLI's to report", async () => {
    const { root, manifests } = installed();
    at(path.join(root, "notes.pkl"), 0);
    expect(await isLockfileCurrent(root, manifests)).toBe(true);
    at(manifests[1]!, 0);
    expect(await isLockfileCurrent(root, manifests)).toBe(false);
  });

  test("importedModules lists every local module read, transitively, and no non-file scheme", async () => {
    const { root, manifests } = installed();
    const found = await importedModules(manifests);
    expect(found.sort()).toEqual(["deps/compose.pkl", "gone.pkl", "versions.pkl"].map((name) => path.join(root, name)));
  });
});

describe("ElideCli.manifest", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A CLI reporting `version` that records every argv it is given and answers `answers`, refusing the other
   * manifest command the way a release that no longer carries it does.
   */
  const cliReporting = (version: string, answers: "manifest" | "project" | "both" | "none" = "both") => {
    const home = mkdtempSync(path.join(tmpdir(), "elide-home-"));
    const root = mkdtempSync(path.join(tmpdir(), "elide-proj-"));
    dirs.push(home, root);
    const log = path.join(root, "argv.log");
    const answered = answers === "both" ? "manifest|project" : answers === "none" ? "--nothing" : answers;
    mkdirSync(path.join(home, "bin"));
    writeFileSync(
      path.join(home, "bin", "elide"),
      `#!/bin/sh
echo "$*" >> "${log}"
case "$1" in
  --version) echo "${version}" ;;
  ${answered}) echo '{"name":"app"}' ;;
  *) echo "elide $1: removed" >&2; exit 2 ;;
esac
`,
    );
    chmodSync(path.join(home, "bin", "elide"), 0o755);
    return {
      cli: new ElideCli(distributionAt(home), root),
      argv: (): string[] => readFileSync(log, "utf8").trim().split("\n"),
    };
  };

  test("1.6 and newer export the project; an older release keeps the command it retired", async () => {
    const recent = cliReporting("1.6.1+abc1234");
    expect((await recent.cli.manifest()).name).toBe("app");
    expect(recent.argv()).toEqual(["--version", "project export"]);

    const older = cliReporting("1.5.4+abc1234");
    expect((await older.cli.manifest()).name).toBe("app");
    expect(older.argv()).toEqual(["--version", "manifest"]);
  });

  test("the version is asked once, however often the CLI is driven", async () => {
    const { cli, argv } = cliReporting("1.6.1+abc1234");
    await cli.manifest();
    await cli.manifest();
    expect(argv()).toEqual(["--version", "project export", "project export"]);
  });

  test("a version that does not match the binary is answered by the other command, once", async () => {
    // A wrapper reporting an old version in front of a release that retired `manifest`, which is what a stub does.
    const { cli, argv } = cliReporting("1.4.0+stub", "project");
    expect((await cli.manifest()).name).toBe("app");
    await cli.manifest();
    expect(argv()).toEqual(["--version", "manifest", "project export", "project export"]);
  });

  test("a project neither command can describe fails with the error of the one its version named", async () => {
    const { cli, argv } = cliReporting("1.6.1+abc1234", "none");
    await expect(cli.manifest()).rejects.toThrow(/project export/);
    expect(argv()).toEqual(["--version", "project export", "manifest"]);
  });
});

describe("ElideCli command observers", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  const cli = (script: string) => {
    const home = mkdtempSync(path.join(tmpdir(), "elide-home-"));
    const root = mkdtempSync(path.join(tmpdir(), "elide-proj-"));
    dirs.push(home, root);
    mkdirSync(path.join(home, "bin"));
    writeFileSync(path.join(home, "bin", "elide"), `#!/bin/sh\n${script}\n`);
    chmodSync(path.join(home, "bin", "elide"), 0o755);
    return new ElideCli(distributionAt(home), root);
  };

  const observe = () => {
    const seen: { argv: readonly string[]; lines: string[]; exitCode?: number | null }[] = [];
    return {
      seen,
      onCommand: (argv: readonly string[]) => {
        const entry: (typeof seen)[number] = { argv, lines: [] };
        seen.push(entry);
        return {
          line: (line: string, stderr: boolean) => entry.lines.push(`${stderr ? "err" : "out"} ${line}`),
          record: (record: { type: string }) => entry.lines.push(`record ${record.type}`),
          end: ({ exitCode }: { exitCode: number | null }) => { entry.exitCode = exitCode; },
        };
      },
    };
  };

  test("a command whose stdout is its result shows the observer only what it printed for a person", async () => {
    const observer = observe();
    const entries = await cli(`echo "/a.jar:/b.jar"; echo "resolving" >&2`).classpath("main", "compile", { onCommand: observer.onCommand });
    expect(entries).toEqual(["/a.jar", "/b.jar"]);
    expect(observer.seen).toEqual([{ argv: ["classpath", "main:compile"], lines: ["err resolving"], exitCode: 0 }]);
  });

  test("a build shows every line, and a failure still ends its observation with the exit code", async () => {
    const observer = observe();
    await expect(cli(`echo "compiled"; echo "✗ Build failed in (1.0s)" >&2; exit 3`).build(["app"], { onCommand: observer.onCommand })).rejects.toThrow();
    expect(observer.seen).toEqual([{ argv: ["build", "app"], lines: ["out compiled", "err ✗ Build failed in (1.0s)"], exitCode: 3 }]);
  });

  test("progress records reach the observer as records, and everyone else as the text they stand for", async () => {
    const observer = observe();
    const lines: string[] = [];
    const records = [
      `{"type":"task-started","task":"app:compile-kotlin-main","project":"app","message":"Compiling Kotlin sources","time":1}`,
      `{"type":"message","level":"error","text":"error: kotlinc: Unresolved reference 'x'.\\nIn file: src/Main.kt:3:5","file":"/p/src/Main.kt","line":3,"column":5,"time":2}`,
      `{"type":"build-finished","outcome":"failure","exitCode":1,"durationMs":3000,"message":"Build failed","time":3}`,
    ];
    const failure = cli(`cat >&2 <<'EOF'\n${records.join("\n")}\n{"not":"a record"}\nEOF\nexit 1`)
      .build(["app"], { onCommand: observer.onCommand, onLine: (line) => lines.push(line) });
    const error = await failure.then(() => undefined, (e: unknown) => e as Error);
    const text = ["error: kotlinc: Unresolved reference 'x'.", "In file: /p/src/Main.kt:3:5", "✗ Build failed in 3.0s", `{"not":"a record"}`];
    expect(lines).toEqual(text);
    expect(observer.seen[0]!.lines).toEqual([
      "record task-started",
      "record message", ...text.slice(0, 2).map((line) => `err ${line}`),
      "record build-finished", `err ${text[2]}`,
      `err ${text[3]}`,
    ]);
    expect(error?.message).toEndWith(text.join("\n"));
  });

  test("every process asks for progress records unless the caller picks another mode", async () => {
    const elide = cli(`echo "$ELIDE_PROGRESS"`);
    expect((await elide.run(["build"])).stdout).toBe("json\n");
    expect((await elide.run(["build"], { env: { ELIDE_PROGRESS: "plain" } })).stdout).toBe("plain\n");
  });
});

describe("ElideCli.classpaths", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  /** A CLI reporting `version` that answers `--json` only when `json` is set, failing on a set named `broken`. */
  const cliReporting = (version: string, json: boolean) => {
    const home = mkdtempSync(path.join(tmpdir(), "elide-home-"));
    const root = mkdtempSync(path.join(tmpdir(), "elide-proj-"));
    dirs.push(home, root);
    const log = path.join(root, "argv.log");
    mkdirSync(path.join(home, "bin"));
    writeFileSync(
      path.join(home, "bin", "elide"),
      `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  --version) echo "${version}" ;;
  *broken*) echo "no such source set" >&2; exit 1 ;;
  "classpath --json"*) ${json ? `echo '{"main:compile":["/m2/a.jar","lib/b.jar"],"main:runtime":["/m2/a.jar","/m2/r.jar"]}'` : `echo "Unknown option: '--json'" >&2; exit 2`} ;;
  "classpath main:compile") echo "/m2/a.jar:lib/b.jar" ;;
  "classpath main:runtime") echo "/m2/a.jar:/m2/r.jar" ;;
esac
`,
    );
    chmodSync(path.join(home, "bin", "elide"), 0o755);
    return {
      cli: new ElideCli(distributionAt(home), root),
      root,
      argv: (): string[] => readFileSync(log, "utf8").trim().split("\n"),
    };
  };
  const answers = (root: string) => new Map([
    ["main:compile", ["/m2/a.jar", path.join(root, "lib/b.jar")]],
    ["main:runtime", ["/m2/a.jar", "/m2/r.jar"]],
  ]);

  test("1.6.1 answers every query from one process; an older release is asked one query at a time", async () => {
    const recent = cliReporting("1.6.1+abc1234", true);
    expect(await recent.cli.classpaths(["main:compile", "main:runtime"])).toEqual(answers(recent.root));
    expect(recent.argv()).toEqual(["--version", "classpath --json main:compile main:runtime"]);

    const older = cliReporting("1.6.0+abc1234", false);
    expect(await older.cli.classpaths(["main:compile", "main:runtime"])).toEqual(answers(older.root));
    expect(older.argv()).toEqual(["--version", "classpath main:compile", "classpath main:runtime"]);
  });

  test("a version that cannot be read is tried with --json once, and the form that answered is kept", async () => {
    const { cli, root, argv } = cliReporting("development build", false);
    expect(await cli.classpaths(["main:compile", "main:runtime"])).toEqual(answers(root));
    await cli.classpaths(["main:compile"]);
    expect(argv()).toEqual([
      "--version",
      "classpath --json main:compile main:runtime", "classpath main:compile", "classpath main:runtime",
      "classpath main:compile",
    ]);
  });

  test("a release that batches fails the call with the query that could not be resolved", async () => {
    const { cli, argv } = cliReporting("1.6.1+abc1234", true);
    await expect(cli.classpaths(["main:compile", "broken:provided"])).rejects.toThrow(/no such source set/);
    expect(argv()).toEqual(["--version", "classpath --json main:compile broken:provided"]);
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
# --version answers without loading the project, as the real CLI does.
[ "$1" = "--version" ] && { echo "1.6.1+test"; exit 0; }
echo "Pkl Error: Cannot find module 'elide:nope.pkl'" >&2
exit 1
`;

describe("ElideCli.manifest against Elide 1.5 and 1.6 stand-ins", () => {
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
