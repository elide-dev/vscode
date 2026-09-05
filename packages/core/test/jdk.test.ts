import { describe, expect, test } from "bun:test";
import { decodeManifest, looksLikeJdk, majorOf, resolveJdk } from "../src/index.js";

describe("looksLikeJdk", () => {
  test("a jlinked image without a release file (the Elide distribution) does not qualify", () => {
    const files = new Set(["/elide/lib/modules", "/elide/bin/java"]);
    expect(looksLikeJdk("/elide", (p) => files.has(p))).toBe(false);
  });

  test("modular JDK with release, or legacy JRE with rt.jar, qualifies", () => {
    const files = new Set(["/jdk/lib/modules", "/jdk/release", "/jre8/jre/lib/rt.jar"]);
    expect(looksLikeJdk("/jdk", (p) => files.has(p))).toBe(true);
    expect(looksLikeJdk("/jre8", (p) => files.has(p))).toBe(true);
  });
});

describe("resolveJdk", () => {
  const dist = { home: "/elide", bin: "/elide/bin/elide" };
  const sdkRoot = "/home/u/.sdkman/candidates/java";
  const files = new Set(["/elide/lib/modules", ...["17", "21", "25"].flatMap((v) => [`${sdkRoot}/${v}/lib/modules`, `${sdkRoot}/${v}/release`]), "/opt/jdk17/lib/modules", "/opt/jdk17/release"]);
  const fs = {
    exists: (p: string) => files.has(p),
    listDir: (p: string) => (p === sdkRoot ? ["17", "21", "25"] : []),
    readText: (p: string) => {
      if (!files.has(p)) return undefined;
      const m = /\/(\d+)\/release$/.exec(p);
      return m ? `JAVA_VERSION="${m[1]}.0.1"\n` : 'JAVA_VERSION="17.0.9"\n';
    },
    javaVersionOutput: async () => undefined,
    env: { HOME: "/home/u" },
    platform: "linux" as const,
  };

  test("skips the Elide home and picks the installed JDK matching jvm.target", async () => {
    const manifest = decodeManifest(JSON.stringify({ jvm: { target: { "@type": "elide.jvm.JvmTargetLevel.OfInt", value: 21 } } }));
    expect(await resolveJdk(manifest, dist, fs)).toEqual({ home: `${sdkRoot}/21`, version: "21.0.1" });
  });

  test("without a target picks the highest; JAVA_HOME wins when valid", async () => {
    const manifest = decodeManifest("{}");
    expect((await resolveJdk(manifest, dist, fs))?.home).toBe(`${sdkRoot}/25`);
    expect((await resolveJdk(manifest, dist, { ...fs, env: { HOME: "/home/u", JAVA_HOME: "/opt/jdk17" } }))?.home).toBe("/opt/jdk17");
  });

  test("majorOf handles legacy and vendor-prefixed strings", () => {
    expect(majorOf("1.8.0_292")).toBe(8);
    expect(majorOf("21.0.1")).toBe(21);
    expect(majorOf("openjdk 25.0.2")).toBe(25);
  });
});
