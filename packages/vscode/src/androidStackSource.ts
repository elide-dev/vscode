import path from "node:path";

export interface AndroidStackFrame {
  packageName: string;
  className: string;
  fileName: string;
  /** JVM stack traces use one-based lines. */
  line: number;
  /** UTF-16 offsets of the clickable File.kt:123 span within the log line. */
  start: number;
  end: number;
}

/** SourceFile attributes, not binary class names, locate nested classes and Kotlin FileKt facades. */
export function parseAndroidStackFrame(text: string): AndroidStackFrame | undefined {
  const match = /(?:^|\s)at\s+(?:[\w.$@-]+\/)?([\p{ID_Start}_$][\p{ID_Continue}.$]*)\.[^\s.()]+\(([^\s():/\\]+\.(?:kt|java)):([0-9]+)\)/u.exec(text);
  if (!match) return undefined;
  const className = match[1]!;
  const fileName = match[2]!;
  const line = Number(match[3]);
  if (!Number.isSafeInteger(line) || line < 1) return undefined;
  const start = match.index + match[0].lastIndexOf(`(${fileName}:`) + 1;
  return {
    packageName: className.slice(0, Math.max(0, className.lastIndexOf("."))),
    className,
    fileName,
    line,
    start,
    end: start + fileName.length + 1 + match[3]!.length,
  };
}

/** Ignore comments and literals so example package declarations cannot redirect a frame. */
function sourceCode(content: string): string {
  const tokens = /\/\*|\/\/[^\r\n]*|"""[\s\S]*?"""|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[^\r\n]|[^'\\\r\n])*'/g;
  const parts: string[] = [];
  let end = 0;
  for (let match = tokens.exec(content); match; match = tokens.exec(content)) {
    parts.push(content.slice(end, match.index), "\n");
    if (match[0] === "/*") {
      // Kotlin permits nested block comments.
      let depth = 1;
      let cursor = tokens.lastIndex;
      while (cursor < content.length && depth > 0) {
        if (content.startsWith("/*", cursor)) { depth++; cursor += 2; }
        else if (content.startsWith("*/", cursor)) { depth--; cursor += 2; }
        else cursor++;
      }
      tokens.lastIndex = cursor;
    }
    end = tokens.lastIndex;
  }
  parts.push(content.slice(end));
  return parts.join("");
}

interface SourceInfo {
  packageName: string;
  lines: number;
}

function sourceInfo(content: string): SourceInfo {
  const code = sourceCode(content);
  const declaration = /^\s*package\s+((?:`[^`\r\n]+`|[\p{ID_Start}_$][\p{ID_Continue}$]*)(?:\s*\.\s*(?:`[^`\r\n]+`|[\p{ID_Start}_$][\p{ID_Continue}$]*))*)/mu.exec(code);
  return {
    packageName: declaration?.[1]?.replace(/\s*\.\s*/g, ".").replace(/`/g, "") ?? "",
    lines: content.split(/\r\n|\r|\n/).length,
  };
}

export interface AndroidStackLocation {
  file: string;
  /** Zero-based editor position; URI selection fragments convert this back to one-based. */
  line: number;
}

/** One lazy filename inventory per revision; source text is loaded only for matching filenames. */
export class AndroidStackSourceIndex {
  private inventory: Promise<Map<string, string[]>> | undefined;
  private readonly sources = new Map<string, Promise<SourceInfo>>();
  private revision = 0;
  private disposed = false;

  constructor(
    private readonly listFiles: () => Promise<readonly string[]>,
    private readonly readSource: (file: string) => Promise<string>,
  ) {}

  invalidate(): void {
    this.revision++;
    this.inventory = undefined;
    this.sources.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }

  async resolve(frame: AndroidStackFrame): Promise<AndroidStackLocation | undefined> {
    if (this.disposed) return undefined;
    const revision = this.revision;
    const inventory = this.inventory ??= this.listFiles().then((files) => {
      const result = new Map<string, string[]>();
      for (const file of new Set(files)) {
        const name = path.basename(file);
        const candidates = result.get(name);
        if (candidates) candidates.push(file);
        else result.set(name, [file]);
      }
      return result;
    });
    const files = (await inventory).get(frame.fileName) ?? [];
    if (this.disposed || this.revision !== revision) return undefined;
    let found: { file: string; source: SourceInfo } | undefined;
    for (const file of files) {
      let source = this.sources.get(file);
      if (!source) {
        source = this.readSource(file).then(sourceInfo);
        this.sources.set(file, source);
      }
      const info = await source;
      if (this.disposed || this.revision !== revision) return undefined;
      if (info.packageName !== frame.packageName) continue;
      // A line number cannot disambiguate two modules containing the same package and SourceFile.
      if (found) return undefined;
      found = { file, source: info };
    }
    if (!found || frame.line > found.source.lines) return undefined;
    return { file: found.file, line: frame.line - 1 };
  }
}
