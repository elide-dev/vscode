import { describe, expect, test } from "bun:test";
import { ElideNotFoundError, InvalidElideHomeError, parseClasspath, resolveElideDistribution } from "../src/index.js";

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
