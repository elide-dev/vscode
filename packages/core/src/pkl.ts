/**
 * Reading and editing `elide.pkl` as text.
 *
 * `elide manifest` answers for a project the CLI can already load, which is not every question an editor asks: the
 * artifacts a manifest declares carry no source positions in that JSON, and the workspace above a folder has to be
 * found before any project is loaded. Both are read from the manifest text instead, with the little of Pkl's syntax
 * those questions need — braces, string literals and `//` comments.
 */

/** The line without its `//` comment; a `//` inside a string literal is content, not a comment. */
export function stripComment(line: string): string {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted && c === "\\") i++;
    else if (c === '"') quoted = !quoted;
    else if (!quoted && c === "/" && line[i + 1] === "/") return line.slice(0, i);
  }
  return line;
}

/** Net brace nesting the line adds, ignoring braces inside string literals. */
export function braceDelta(line: string): number {
  let delta = 0;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted && c === "\\") i++;
    else if (c === '"') quoted = !quoted;
    else if (!quoted && c === "{") delta++;
    else if (!quoted && c === "}") delta--;
  }
  return delta;
}

/** Offsets of the body of a `name { … }` block: what sits between its braces. */
export interface PklBlock {
  /** Offset of the first character after the opening brace. */
  start: number;
  /** Offset of the closing brace. */
  end: number;
}

const IDENTIFIER = /[A-Za-z0-9_$]/;

/**
 * The body of the `name { … }` block declared directly inside `from`…`to`, or `undefined` when the region declares
 * none. Blocks nested deeper are skipped whole, so an inner `members` of some other block is never mistaken for the
 * one being looked for. The name is the token right before the brace (`new Jvm.Jar {` declares `Jar`) or, when the
 * block is the value of an assignment, the property it is assigned to (`members = new Listing { … }`).
 */
export function pklBlock(text: string, name: string, from = 0, to = text.length): PklBlock | undefined {
  let word = "";
  let ended = false;
  /** Property the block being read belongs to, until the line it was assigned on ends. */
  let assigned = "";
  for (let i = from; i < to; i++) {
    const c = text[i] as string;
    if (c === '"') {
      i = endOfString(text, i, to);
      word = "";
      ended = false;
    } else if (c === "/" && text[i + 1] === "/") {
      const newline = text.indexOf("\n", i);
      if (newline < 0 || newline >= to) return undefined;
      i = newline;
      word = "";
      ended = false;
      assigned = "";
    } else if (IDENTIFIER.test(c)) {
      word = ended ? c : word + c;
      ended = false;
    } else if (c === "{") {
      const close = matchingBrace(text, i, to);
      if (close === undefined) return undefined;
      if (word === name || assigned === name) return { start: i + 1, end: close };
      i = close;
      word = "";
      ended = false;
      assigned = "";
    } else if (c === "}") {
      return undefined;
    } else if (c === "=") {
      assigned = word;
      word = "";
      ended = false;
    } else if (c === "\n") {
      // A simple value ends with its line; only a block opened on it can still belong to the property.
      word = "";
      ended = false;
      assigned = "";
    } else if (/\s/.test(c)) {
      ended = word.length > 0;
    } else {
      word = "";
      ended = false;
    }
  }
  return undefined;
}

/** Every string literal of `from`…`to`, in source order, with comments ignored. */
export function pklStrings(text: string, from = 0, to = text.length): string[] {
  const found: string[] = [];
  for (let i = from; i < to; i++) {
    const c = text[i];
    if (c === '"') {
      const end = endOfString(text, i, to);
      found.push(text.slice(i + 1, end));
      i = end;
    } else if (c === "/" && text[i + 1] === "/") {
      const newline = text.indexOf("\n", i);
      if (newline < 0 || newline >= to) return found;
      i = newline;
    }
  }
  return found;
}

/** Offset of the brace closing the one at `open`, or `undefined` when the region holds no match. */
function matchingBrace(text: string, open: number, to: number): number | undefined {
  let depth = 0;
  for (let i = open; i < to; i++) {
    const c = text[i];
    if (c === '"') i = endOfString(text, i, to);
    else if (c === "/" && text[i + 1] === "/") {
      const newline = text.indexOf("\n", i);
      if (newline < 0) return undefined;
      i = newline;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return undefined;
}

/** Offset of the quote closing the string opened at `open`; the end of the region when it is never closed. */
function endOfString(text: string, open: number, to: number): number {
  for (let i = open + 1; i < to; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === '"') return i;
  }
  return to;
}
