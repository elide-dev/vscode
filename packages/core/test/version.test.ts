import { describe, expect, test } from "bun:test";
import { compareElideVersions, isSupportedElideVersion, parseElideVersion } from "../src/index.js";

describe("parseElideVersion", () => {
  test("reads the release triple, ignoring a build suffix", () => {
    expect(parseElideVersion("1.5.1+db2bc827b")).toEqual({ major: 1, minor: 5, patch: 1 });
    expect(parseElideVersion("  1.5.3\n")).toEqual({ major: 1, minor: 5, patch: 3 });
  });

  test("a display string without a triple has no version", () => {
    expect(parseElideVersion("garbage")).toBeUndefined();
    expect(parseElideVersion("1.5")).toBeUndefined();
  });
});

describe("compareElideVersions", () => {
  test("orders by major, then minor, then patch", () => {
    const v = (major: number, minor: number, patch: number) => ({ major, minor, patch });
    expect(compareElideVersions(v(1, 5, 0), v(1, 5, 0))).toBe(0);
    expect(compareElideVersions(v(1, 4, 9), v(1, 5, 0))).toBeLessThan(0);
    expect(compareElideVersions(v(2, 0, 0), v(1, 9, 9))).toBeGreaterThan(0);
    expect(compareElideVersions(v(1, 5, 1), v(1, 5, 0))).toBeGreaterThan(0);
  });
});

describe("isSupportedElideVersion", () => {
  test("1.5.0 is the floor", () => {
    expect(isSupportedElideVersion("1.5.0")).toBe(true);
    expect(isSupportedElideVersion("1.5.1+db2bc827b")).toBe(true);
    expect(isSupportedElideVersion("1.4.9")).toBe(false);
    expect(isSupportedElideVersion("0.9.0")).toBe(false);
  });

  test("an unparsable version never blocks the integration", () => {
    expect(isSupportedElideVersion("garbage")).toBe(true);
    expect(isSupportedElideVersion("")).toBe(true);
  });
});
