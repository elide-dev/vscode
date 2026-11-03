import { describe, expect, test } from "bun:test";
import { libraryFor, parseLibraryName } from "../src/index.js";

describe("parseLibraryName", () => {
  test("maven layout under the default repository root", () => {
    expect(parseLibraryName("/p/.dev/dependencies/m2/org/jetbrains/kotlin/kotlin-stdlib/2.4.10/kotlin-stdlib-2.4.10.jar")).toBe(
      "Elide: org.jetbrains.kotlin:kotlin-stdlib:2.4.10",
    );
  });

  test("custom localRepository marker", () => {
    expect(parseLibraryName("/cache/repo/com/foo/bar/1.0/bar-1.0.jar", "/cache/repo")).toBe("Elide: com.foo:bar:1.0");
  });

  test("entries outside a repository layout fall back to the file name", () => {
    expect(parseLibraryName("/opt/libs/thing.jar")).toBe("Elide: thing");
    expect(parseLibraryName("/p/.dev/dependencies/m2/flat.jar")).toBe("Elide: flat");
    expect(parseLibraryName("/p/.dev/artifacts/classes")).toBe("Elide: classes");
  });
});

describe("libraryFor", () => {
  test("attaches sibling sources and javadoc jars only when present", () => {
    const present = new Set(["/r/a/b/1/b-1-sources.jar"]);
    const lib = libraryFor("/r/a/b/1/b-1.jar", "/r", (p) => present.has(p));
    expect(lib.sources).toBe("/r/a/b/1/b-1-sources.jar");
    expect(lib.javadoc).toBeUndefined();
    expect(lib.coordinate).toBeUndefined();
  });

  test("an exploded published .aar is named by its coordinate and keeps the sources of the archive it came from", () => {
    const present = new Set(["/ws/.dev/dependencies/m2/androidx/core/core/1.13.0/core-1.13.0-sources.jar"]);
    const lib = libraryFor("/app/.dev/android/libraries/androidx/core/core/1.13.0/classes.jar", "/ws/.dev/dependencies/m2", (p) => present.has(p));
    expect(lib.name).toBe("Elide: androidx.core:core:1.13.0");
    expect(lib.coordinate).toBe("androidx.core:core:1.13.0");
    expect(lib.sources).toBe("/ws/.dev/dependencies/m2/androidx/core/core/1.13.0/core-1.13.0-sources.jar");
    expect(lib.javadoc).toBeUndefined();
  });
});
