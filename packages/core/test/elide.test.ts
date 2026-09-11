import { describe, expect, test } from "bun:test";
import { ElideNotFoundError, InvalidElideHomeError, outermostManifests, parseClasspath, resolveElideDistribution } from "../src/index.js";

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
