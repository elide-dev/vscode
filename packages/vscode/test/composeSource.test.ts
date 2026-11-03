import { describe, expect, test } from "bun:test";
import { resolvePreviewSource } from "../src/composeSource.js";

const location = { fileName: "Card.kt", packageHash: -1, lineNumber: 2, offset: -1, length: -1 };

describe("Compose source navigation", () => {
  test("uses UTF-16 call ranges and deduplicates shared compiler inputs", () => {
    const content = 'package app\n// 🌊\nCard("Hello")';
    const files = new Map([["/project/Card.kt", content]]);
    const offset = content.indexOf("Card(");
    expect(resolvePreviewSource({ ...location, offset, length: 4 }, [files, files])).toEqual({ file: "/project/Card.kt", content, offset, length: 4 });
  });

  test("matches the compiler package hash and rejects ambiguous modules", () => {
    const app = new Map([["/app/Card.kt", "package app\nCard()"]]);
    const library = new Map([["/lib/Card.kt", "package lib\nCard()"]]);
    expect(resolvePreviewSource(location, [app, library])).toBeUndefined();
    expect(resolvePreviewSource({ ...location, packageHash: 96801 }, [app, library])?.file).toBe("/app/Card.kt");
    expect(resolvePreviewSource({ ...location, packageHash: 96801 }, [app, new Map([["/other/Card.kt", "package app\nCard()"]])])).toBeUndefined();
  });

  test("falls back to one-based lines only for unavailable offsets, never arbitrary paths or invalid ranges", () => {
    const content = "package app\r\nCard()";
    const files = [new Map([["/project/Card.kt", content]])];
    expect(resolvePreviewSource(location, files)?.offset).toBe(13);
    expect(resolvePreviewSource({ ...location, lineNumber: 3 }, files)).toBeUndefined();
    expect(resolvePreviewSource({ ...location, offset: 100, length: 2 }, files)).toBeUndefined();
    expect(resolvePreviewSource({ ...location, fileName: "../Card.kt" }, files)).toBeUndefined();
  });
});
