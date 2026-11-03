import { describe, expect, test } from "bun:test";
import { compareMavenVersions } from "../src/mavenVersion.js";

describe("Maven version ordering", () => {
  // Each version orders strictly before the next, as maven-resolver's GenericVersionScheme orders them.
  const ascending = [
    "1.0-alpha1", "1.0-alpha2", "1.0-alpha10", "1.0-beta1", "1.0-m1", "1.0-rc1", "1.0-SNAPSHOT", "1.0", "1.0-sp", "1.0-xyz",
    "1.0.1", "1.3.1", "1.5.0-alpha22", "1.5.0", "1.10.0", "9999.0-empty-to-avoid-conflict-with-guava",
  ];

  test("orders numbers numerically and pre-releases before their release", () => {
    for (let i = 0; i + 1 < ascending.length; i++) {
      expect([ascending[i], Math.sign(compareMavenVersions(ascending[i]!, ascending[i + 1]!))]).toEqual([ascending[i], -1]);
      expect(Math.sign(compareMavenVersions(ascending[i + 1]!, ascending[i]!))).toBe(1);
    }
  });

  test("padding, release aliases, letter abbreviations and case are equivalent spellings", () => {
    for (const [a, b] of [["1", "1.0.0"], ["1.0", "1-ga"], ["1.0-final", "1.0-release"], ["1.0a1", "1.0-alpha-1"], ["1.0-RC1", "1.0-cr1"], ["1.01", "1.1"]]) {
      expect([a, b, compareMavenVersions(a!, b!)]).toEqual([a, b, 0]);
    }
  });
});
