import { pklBlock } from "./pkl.js";

/** A local literal in the top-level `extensions` listing; offsets exclude its quotes. */
export interface ManifestBuildExtension {
  path: string;
  start: number;
  end: number;
}

interface Token {
  text: string;
  start: number;
  end: number;
  value?: string;
}

/**
 * Navigation, not Pkl evaluation: only ordinary single-line literals and `new { from = "…" }` entries.
 * Raw and multiline strings are deliberately unsupported: decline the document rather than guess its nesting.
 */
export function parseManifestBuildExtensions(text: string): ManifestBuildExtension[] {
  if (/#"|"""/.test(text)) return [];
  const block = pklBlock(text, "extensions");
  if (!block) return [];
  const tokens = tokenize(text, block.start, block.end);
  if (!tokens) return [];
  const found: ManifestBuildExtension[] = [];
  for (const entry of statements(tokens)) {
    if (entry.length === 1) addLiteral(entry[0], found);
    else if (entry[0]?.text === "new" && entry[1]?.text === "{" && entry.at(-1)?.text === "}") {
      // Split only at the object's own depth: config strings and nested `from` properties are never destinations.
      const members = entry.slice(2, -1);
      for (let i = 0; i < members.length; i++) {
        const token = members[i]!;
        if (token.text === "{") {
          i = closingBrace(members, i);
        } else if (token.text === "from" && (i === 0 || separator(members[i - 1]!))) {
          const literal = members[i + 2];
          const next = members[i + 3];
          if (members[i + 1]?.text === "=" && (!next || (separator(next) && !continuesExpression(members, i + 3)) || (next.text === "config" && members[i + 4]?.text === "{"))) {
            addLiteral(literal, found);
          }
        }
      }
    }
  }
  return found;
}

function addLiteral(token: Token | undefined, found: ManifestBuildExtension[]): void {
  const value = token?.value;
  if (!token || !value || /^(?:url:|npm:|maven:|https?:\/\/)/.test(value) || /[\0\r\n]/.test(value)) return;
  found.push({ path: value, start: token.start + 1, end: token.end - 1 });
}

function separator(token: Token): boolean {
  return token.text === "\n" || token.text === ";" || token.text === ",";
}

/** A newline is not enough to prove a literal complete when the following token continues an expression. */
function continuesExpression(tokens: Token[], at: number): boolean {
  while (tokens[at] && separator(tokens[at]!)) at++;
  return !!tokens[at] && /^[+?.*/%<>=!&|^-]$/.test(tokens[at]!.text);
}

function closingBrace(tokens: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i]!.text === "{") depth++;
    else if (tokens[i]!.text === "}" && --depth === 0) return i;
  }
  return tokens.length;
}

function statements(tokens: Token[]): Token[][] {
  const entries: Token[][] = [];
  let start = 0;
  for (let i = 0; i <= tokens.length; i++) {
    const open = tokens[i]?.text;
    if (open === "{" || open === "(" || open === "[") {
      const stack = [open === "{" ? "}" : open === "(" ? ")" : "]"];
      for (i++; i < tokens.length && stack.length; i++) {
        const text = tokens[i]!.text;
        if (text === "{" || text === "(" || text === "[") stack.push(text === "{" ? "}" : text === "(" ? ")" : "]");
        else if (text === stack.at(-1)) stack.pop();
      }
      if (stack.length) return entries;
      i--;
    }
    if (i === tokens.length || (tokens[i] && separator(tokens[i]!) && !continuesExpression(tokens, i))) {
      if (i > start) entries.push(tokens.slice(start, i));
      start = i + 1;
    }
  }
  return entries;
}

function tokenize(text: string, from: number, to: number): Token[] | undefined {
  const tokens: Token[] = [];
  for (let i = from; i < to;) {
    const start = i;
    const c = text[i]!;
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i + 2);
      i = end < 0 ? to : end;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0 || end >= to) return undefined;
      // A newline in a comment still separates listing entries.
      if (text.slice(i, end).includes("\n")) tokens.push({ text: "\n", start, end: end + 2 });
      i = end + 2;
    } else if (c === '"') {
      let value = "";
      let valid = true;
      for (i++; i < to && text[i] !== '"'; i++) {
        const char = text[i]!;
        if (char === "\n" || char === "\r") return undefined;
        if (char !== "\\") value += char;
        else {
          const escaped = text[++i];
          if (escaped === '"' || escaped === "\\") value += escaped;
          else if (escaped === "n") value += "\n";
          else if (escaped === "r") value += "\r";
          else if (escaped === "t") value += "\t";
          else if (escaped === "u" && text[i + 1] === "{") {
            const end = text.indexOf("}", i + 2);
            const hex = text.slice(i + 2, end);
            const point = /^[0-9a-fA-F]{1,6}$/.test(hex) ? Number.parseInt(hex, 16) : -1;
            if (end < 0 || point < 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) valid = false;
            else { value += String.fromCodePoint(point); i = end; }
          } else valid = false; // Includes Pkl interpolation: its result is not a literal path.
        }
      }
      if (i >= to) return undefined;
      i++;
      tokens.push({ text: "string", start, end: i, value: valid ? value : undefined });
    } else if (c === "\n" || !/\s/.test(c)) {
      if (/[A-Za-z_$]/.test(c)) {
        for (i++; i < to && /[A-Za-z0-9_$]/.test(text[i]!); i++);
      } else i++;
      tokens.push({ text: text.slice(start, i), start, end: i });
    } else i++;
  }
  return tokens;
}
