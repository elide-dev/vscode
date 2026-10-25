import path from "node:path";
import type { PreviewImage, PreviewLayoutNode } from "./composeRender.js";

export interface PreviewSourceTarget {
  file: string;
  content: string;
  offset: number;
  length: number;
}

/** Resolve tooling locations only against actual compiler inputs, never paths supplied by a webview. */
export function resolvePreviewSource(
  source: NonNullable<PreviewLayoutNode["source"]>,
  units: readonly ReadonlyMap<string, string>[],
): PreviewSourceTarget | undefined {
  const matches = new Map<string, string>();
  for (const files of units) {
    for (const [file, content] of files) {
      if (path.basename(file) !== source.fileName) continue;
      if (source.packageHash !== -1) {
        const packageName = /^\s*package\s+([\p{L}\p{Nd}_.`]+)/mu.exec(content)?.[1]?.replaceAll("`", "") ?? "";
        let hash = 0;
        for (let index = 0; index < packageName.length; index++) hash = (Math.imul(hash, 31) + packageName.charCodeAt(index)) | 0;
        // Kotlin abs(Int.MIN_VALUE) remains negative.
        if ((hash === -2147483648 ? hash : Math.abs(hash)) !== source.packageHash) continue;
      }
      matches.set(file, content);
    }
  }
  if (matches.size !== 1) return undefined;
  const [file, content] = matches.entries().next().value!;
  // Compose compiler offsets and VS Code positions both count UTF-16 code units.
  if (source.offset >= 0 && source.length >= 0 && source.offset + source.length <= content.length) {
    return { file, content, offset: source.offset, length: source.length };
  }
  if (source.offset !== -1 || source.lineNumber < 1) return undefined;
  let offset = 0;
  for (let line = 1; line < source.lineNumber; line++) {
    const next = content.indexOf("\n", offset);
    if (next < 0) return undefined;
    offset = next + 1;
  }
  return { file, content, offset, length: 0 };
}

/** The called function's name at the start of a call's range: the last segment of a qualified call (`a.b.Box(…)` is `Box`). */
const CALLEE = /^\s*(?:(?:[\p{L}_$][\p{L}\p{N}_$]*|`[^`]+`)\s*\.\s*)*([\p{L}_$][\p{L}\p{N}_$]*|`[^`]+`)/u;

/**
 * The nodes the inspector offers for `image`: calls located in the compiler inputs `units` whose range calls them, each recorded
 * in `targets` by `imageId\0nodeId`, not Compose's implementation internals. A call whose range names another function is not
 * located: tooling assigns a group's call sites by position, which code compiled without source information shifts. A live image
 * also offers the measured bounds of its other calls (compiled without source information, or a renderer without any), the
 * outermost call of each rectangle no located call has, without a location.
 */
export function inspectableNodes(
  image: PreviewImage,
  units: readonly ReadonlyMap<string, string>[],
  targets: Map<string, PreviewSourceTarget>,
): PreviewLayoutNode[] | undefined {
  if (!image.nodes) return undefined;
  const located = new Set<PreviewLayoutNode>();
  for (const node of image.nodes) {
    const target = node.source && resolvePreviewSource(node.source, units);
    if (!target) continue;
    const callee = CALLEE.exec(target.content.slice(target.offset, target.offset + target.length))?.[1]?.replaceAll("`", "");
    if (target.length > 0 && callee !== node.name) continue;
    located.add(node);
    targets.set(`${image.id}\0${node.id}`, target);
  }
  if (!image.live) return image.nodes.filter((node) => located.has(node));
  const rectangle = (node: PreviewLayoutNode) => `${node.x},${node.y},${node.width},${node.height}`;
  const claimed = new Set([...located].map(rectangle));
  // Children come first: the last call of a rectangle is its outermost.
  const outermost = new Map<string, PreviewLayoutNode>();
  for (const node of image.nodes) if (!located.has(node) && !claimed.has(rectangle(node))) outermost.set(rectangle(node), node);
  const measured = new Set(outermost.values());
  return image.nodes.filter((node) => located.has(node) || measured.has(node))
    .map((node) => located.has(node) || !node.source ? node
      : { id: node.id, name: node.name, x: node.x, y: node.y, width: node.width, height: node.height });
}

/**
 * Nodes as a tree by geometric containment: the renderer lists children first, so a node's parent is the smallest later node
 * whose bounds contain it (the nearest one among equal bounds). Siblings go top to bottom, then left to right.
 */
export function layoutTree(nodes: readonly PreviewLayoutNode[]): { node: PreviewLayoutNode; depth: number }[] {
  const parent = nodes.map((node, index) => {
    let best = -1;
    let area = Infinity;
    for (let candidate = index + 1; candidate < nodes.length; candidate++) {
      const other = nodes[candidate]!;
      if (other.x > node.x || other.y > node.y || other.x + other.width < node.x + node.width || other.y + other.height < node.y + node.height) continue;
      const size = other.width * other.height;
      if (size < area) {
        area = size;
        best = candidate;
      }
    }
    return best;
  });
  const children = nodes.map(() => [] as number[]);
  const roots: number[] = [];
  for (const [index, owner] of parent.entries()) (owner < 0 ? roots : children[owner]!).push(index);
  const order = (list: number[]) => list.sort((left, right) => nodes[left]!.y - nodes[right]!.y || nodes[left]!.x - nodes[right]!.x || left - right);
  const result: { node: PreviewLayoutNode; depth: number }[] = [];
  const visit = (index: number, depth: number) => {
    result.push({ node: nodes[index]!, depth });
    for (const child of order(children[index]!)) visit(child, depth + 1);
  };
  for (const root of order(roots)) visit(root, 0);
  return result;
}

