import path from "node:path";
import type { PreviewLayoutNode } from "./composeRender.js";

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
        const packageName = /^\s*package\s+([\w.`]+)/m.exec(content)?.[1]?.replaceAll("`", "") ?? "";
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
