import { describe, expect, test } from "bun:test";
import { binaryManifestPackage } from "../src/androidBinaryXml.js";

const NO_INDEX = 0xffffffff;

function chunk(type: number, headerSize: number, body: number[]): number[] {
  const size = 8 + body.length;
  return [...u16(type), ...u16(headerSize), ...u32(size), ...body];
}
const u16 = (value: number) => [value & 0xff, (value >> 8) & 0xff];
const u32 = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];

function pool(strings: string[], utf8: boolean): number[] {
  const encoded = strings.map((value) => {
    if (utf8) {
      const bytes = [...new TextEncoder().encode(value)];
      // Two-unit lengths exercise the long form.
      const length = (n: number) => n > 0x7f ? [0x80 | (n >> 8), n & 0xff] : [n];
      return [...length(value.length), ...length(bytes.length), ...bytes, 0];
    }
    const units = [...value].flatMap((character) => u16(character.charCodeAt(0)));
    return [...u16(value.length), ...units, 0, 0];
  });
  const offsets: number[] = [];
  let at = 0;
  for (const bytes of encoded) {
    offsets.push(at);
    at += bytes.length;
  }
  const headerSize = 28;
  const stringsStart = headerSize + offsets.length * 4;
  const data = encoded.flat();
  while (data.length % 4) data.push(0);
  return chunk(0x0001, headerSize, [...u32(strings.length), ...u32(0), ...u32(utf8 ? 1 << 8 : 0), ...u32(stringsStart), ...u32(0), ...offsets.flatMap(u32), ...data]);
}

function attribute(ns: number, name: number, raw: number, type: number, data: number): number[] {
  return [...u32(ns), ...u32(name), ...u32(raw), ...u16(8), 0, type, ...u32(data)];
}

/** A compiled manifest: string pool, then the `root` element with the given attributes. */
function manifest(strings: string[], attributes: number[][], utf8 = false, root = "manifest"): Uint8Array {
  const element = chunk(0x0102, 16, [
    ...u32(1), ...u32(NO_INDEX),
    ...u32(NO_INDEX), ...u32(strings.indexOf(root)), ...u16(20), ...u16(20), ...u16(attributes.length), ...u16(0), ...u16(0), ...u16(0),
    ...attributes.flat(),
  ]);
  return new Uint8Array(chunk(0x0003, 8, [...pool(strings, utf8), ...element]));
}

describe("compiled manifest application ID", () => {
  const strings = ["versionCode", "package", "manifest", "http://schemas.android.com/apk/res/android", "app.renamed.dev"];

  test("reads the root package attribute from UTF-16 and UTF-8 string pools", () => {
    const attributes = [attribute(3, 0, NO_INDEX, 0x10, 1), attribute(NO_INDEX, 1, 4, 0x03, 4)];
    expect(binaryManifestPackage(manifest(strings, attributes))).toBe("app.renamed.dev");
    expect(binaryManifestPackage(manifest(strings, attributes, true))).toBe("app.renamed.dev");
    const long = `app.${"a".repeat(200)}`;
    expect(binaryManifestPackage(manifest([...strings.slice(0, 4), long], attributes, true))).toBe(long);
  });

  test("accepts a typed string value without a raw value", () => {
    expect(binaryManifestPackage(manifest(strings, [attribute(NO_INDEX, 1, NO_INDEX, 0x03, 4)]))).toBe("app.renamed.dev");
  });

  test("ignores namespaced lookalikes, other roots and truncated data", () => {
    expect(binaryManifestPackage(manifest(strings, [attribute(3, 1, 4, 0x03, 4)]))).toBeUndefined();
    const application = ["versionCode", "package", "application", "ns", "app.renamed.dev"];
    expect(binaryManifestPackage(manifest(application, [attribute(NO_INDEX, 1, 4, 0x03, 4)], false, "application"))).toBeUndefined();
    const complete = manifest(strings, [attribute(NO_INDEX, 1, 4, 0x03, 4)]);
    expect(binaryManifestPackage(complete.subarray(0, complete.length - 6))).toBeUndefined();
    expect(binaryManifestPackage(new TextEncoder().encode("<manifest package=\"a.b\"/>"))).toBeUndefined();
  });
});
