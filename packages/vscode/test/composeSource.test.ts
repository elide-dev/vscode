import { describe, expect, test } from "bun:test";
import { inspectableNodes, layoutTree, resolvePreviewSource, type PreviewSourceTarget } from "../src/composeSource.js";

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
    const unicode = new Map([["/app/Card.kt", "package app.ärger\nCard()"]]);
    expect(resolvePreviewSource({ ...location, packageHash: 544004729 }, [unicode])?.file).toBe("/app/Card.kt");
  });

  test("falls back to one-based lines only for unavailable offsets, never arbitrary paths or invalid ranges", () => {
    const content = "package app\r\nCard()";
    const files = [new Map([["/project/Card.kt", content]])];
    expect(resolvePreviewSource(location, files)?.offset).toBe(13);
    expect(resolvePreviewSource({ ...location, lineNumber: 3 }, files)).toBeUndefined();
    expect(resolvePreviewSource({ ...location, offset: 100, length: 2 }, files)).toBeUndefined();
    expect(resolvePreviewSource({ ...location, fileName: "../Card.kt" }, files)).toBeUndefined();
  });

  test("offers located project calls over library internals at the same bounds, never a call another call's range names", () => {
    const content = "package app\nCard()\nlib.Row { Badge() }";
    const files = [new Map([["/app/Card.kt", content]])];
    const bounds = { x: 0, y: 0, width: 10, height: 10 };
    const at = (call: string, length: number) => ({ ...location, packageHash: 96801, offset: content.indexOf(call), length });
    const card = { id: "n2", name: "Card", ...bounds, source: at("Card(", 6) };
    const row = { id: "n4", name: "Row", x: 0, y: 10, width: 10, height: 5, source: at("lib.Row", 19) };
    const nodes = [
      { id: "n0", name: "Layout", ...bounds },
      { id: "n1", name: "BasicText", ...bounds, source: { ...location, fileName: "BasicText.kt", offset: 40, length: 3 } },
      card,
      // Its group took the location of the call before it, whose callee has no source information.
      { id: "n3", name: "Text", x: 0, y: 10, width: 4, height: 5, source: at("Badge(", 7) },
      row,
    ];
    const image = { id: "card", name: "Card", detail: "", live: true, width: 10, height: 15, nodes };
    const targets = new Map<string, PreviewSourceTarget>();
    expect(inspectableNodes({ ...image, live: false }, files, targets)).toEqual([card, row]);
    expect([...targets.keys()]).toEqual(["card\0n2", "card\0n4"]);
    expect(targets.get("card\0n2")).toEqual({ file: "/app/Card.kt", content, offset: 12, length: 6 });
    // A live image keeps the measured bounds of the unlocated call, without the location it does not have.
    expect(inspectableNodes(image, files, new Map())).toEqual([card, { id: "n3", name: "Text", x: 0, y: 10, width: 4, height: 5 }, row]);
  });

  test("offers one measured call per rectangle, the outermost, when a live image has no source locations", () => {
    const bounds = { x: 0, y: 0, width: 10, height: 10 };
    const nodes = [{ id: "n0", name: "Layout", ...bounds }, { id: "n1", name: "BasicText", ...bounds }, { id: "n2", name: "Box", x: 0, y: 0, width: 20, height: 20 }];
    const image = { id: "card", name: "Card", detail: "", live: true, width: 20, height: 20, nodes };
    expect(inspectableNodes(image, [], new Map())).toEqual([nodes[1], nodes[2]]);
    expect(inspectableNodes({ ...image, live: false }, [], new Map())).toEqual([]);
  });
});

describe("Compose layout tree", () => {
  const box = (id: string, x: number, y: number, width: number, height: number) => ({ id, name: id, x, y, width, height });

  test("nests children-first nodes under their smallest enclosing node, siblings top to bottom then left to right", () => {
    // Post-order, as the renderers list them: a row's two items (right one first), the row, a caption, the root column.
    const nodes = [box("right", 50, 0, 40, 10), box("left", 0, 0, 40, 10), box("row", 0, 0, 100, 10), box("caption", 0, 20, 30, 10), box("column", 0, 0, 100, 40)];
    expect(layoutTree(nodes).map(({ node, depth }) => `${depth}:${node.id}`)).toEqual(["0:column", "1:row", "2:left", "2:right", "1:caption"]);
  });

  test("among equal bounds the later (outer) call is the parent, and disjoint nodes are roots", () => {
    const nodes = [box("text", 0, 0, 10, 10), box("padding", 0, 0, 10, 10), box("card", 0, 0, 10, 10), box("elsewhere", 20, 20, 5, 5)];
    expect(layoutTree(nodes).map(({ node, depth }) => `${depth}:${node.id}`)).toEqual(["0:card", "1:padding", "2:text", "0:elsewhere"]);
  });
});
