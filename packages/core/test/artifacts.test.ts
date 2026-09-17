import path from "node:path";
import { describe, expect, test } from "bun:test";
import { isNativeImageBinary, nativeImageBinary, parseManifestArtifacts } from "../src/index.js";

/** Shape of a real manifest: a jar the image is built from, a binary image, and a shared library. */
const MANIFEST = `amends "elide:project.pkl"
import "elide:Jvm.pkl" as Jvm
import "elide:NativeImage.pkl" as NativeImage

name = "display-repro"

jvm {
  main = "Hello"
}

artifacts {
  ["jar"] = new Jvm.Jar {
    sources {
      "main"
    }
  }
  ["bin"] = new NativeImage.NativeImage {
    from {
      "jar"
    }
    entrypoint = "Hello"
    options {
      // A nested block declares keys of the same names; they are not the artifact's own.
      classInit {
        default = "runtime"
      }
    }
  }
  ["shared"] = new NativeImage.NativeImage {
    type = "library"
    name = "libhello"
  }
}
`;

describe("parseManifestArtifacts", () => {
  test("reads every entry with its class and line", () => {
    expect(parseManifestArtifacts(MANIFEST)).toEqual([
      { name: "jar", type: "Jar", line: 11 },
      { name: "bin", type: "NativeImage", line: 16 },
      { name: "shared", type: "NativeImage", line: 28, imageType: "library", outputName: "libhello" },
    ]);
  });

  test("a key of a nested block is not the artifact's own setting", () => {
    const bin = parseManifestArtifacts(MANIFEST).find((a) => a.name === "bin");
    expect(bin?.outputName).toBeUndefined();
    expect(bin?.imageType).toBeUndefined();
  });

  test("entries of other mappings are not artifacts", () => {
    const manifest = `scripts {\n  ["dev"] = "elide run"\n}\n\nartifacts {\n  ["bin"] = new NativeImage.NativeImage {}\n}\n`;
    expect(parseManifestArtifacts(manifest)).toEqual([{ name: "bin", type: "NativeImage", line: 5 }]);
  });

  test("braces in comments and string literals do not shift the block", () => {
    const manifest = `artifacts { // opens { the block\n  ["bin"] = new NativeImage.NativeImage {\n    name = "a{b"\n  }\n}\n["late"] = "not an artifact"\n`;
    expect(parseManifestArtifacts(manifest)).toEqual([{ name: "bin", type: "NativeImage", line: 1, outputName: "a{b" }]);
  });

  test("a manifest without artifacts yields none", () => {
    expect(parseManifestArtifacts(`name = "x"\njvm {\n  main = "Hello"\n}\n`)).toEqual([]);
  });
});

describe("isNativeImageBinary", () => {
  test("a Native Image is runnable unless it is a library", () => {
    const [jar, bin, shared] = parseManifestArtifacts(MANIFEST);
    expect(isNativeImageBinary(bin!)).toBe(true);
    expect(isNativeImageBinary(shared!)).toBe(false);
    expect(isNativeImageBinary(jar!)).toBe(false);
  });
});

describe("nativeImageBinary", () => {
  test("the artifact's own name wins over the project name", () => {
    expect(nativeImageBinary("/p/app", { outputName: "custom-bin", projectName: "app-name", platform: "darwin" })).toBe(
      path.join("/p/app", ".dev", "artifacts", "native-image", "custom-bin"),
    );
  });

  test("without one, the project name names the image, then the project directory", () => {
    expect(nativeImageBinary("/p/app", { projectName: "app-name", platform: "darwin" })).toBe(
      path.join("/p/app", ".dev", "artifacts", "native-image", "app-name"),
    );
    expect(nativeImageBinary("/p/app", { platform: "darwin" })).toBe(
      path.join("/p/app", ".dev", "artifacts", "native-image", "app"),
    );
  });

  test("Windows images carry the executable suffix", () => {
    expect(nativeImageBinary("/p/app", { projectName: "app-name", platform: "win32" })).toBe(
      path.join("/p/app", ".dev", "artifacts", "native-image", "app-name.exe"),
    );
  });
});
