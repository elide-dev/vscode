import { createHash } from "node:crypto";
import path from "node:path";

/** A function parameter as declared: `type` and `defaultValue` are source text without comments. */
export interface KotlinParameter { name: string; type: string; defaultValue?: string; vararg: boolean; annotations: string[] }

export interface ComposableDeclaration {
  name: string;
  packageName: string;
  file: string;
  /** Offset of the `fun` keyword in the text. */
  offset: number;
  /** 1-based line of `fun`. */
  line: number;
  visibility: "public" | "internal" | "private" | "protected";
  /** Extension receiver type as declared (`ColumnScope`). */
  receiver?: string;
  /** Context parameters (`context(a: A)`, `name` absent for `_`) and context receivers (`context(A)`) as declared; absent when none. */
  contexts?: KotlinContext[];
  /** Type parameters as declared (`T`, `reified T : Any`). */
  typeParameters: string[];
  parameters: KotlinParameter[];
  /** Annotated `@Preview` or a multipreview (an annotation whose simple name contains `Preview`). */
  previews: boolean;
  /** The function's annotations as written (`@Composable`, `@Preview(name = "Dark")`). */
  annotations: string[];
}

/** A context parameter or receiver: `name` is absent for a context receiver and for `_`. */
export interface KotlinContext { name?: string; type: string }

/** A composable named by an agent: `name` is empty when `line` alone locates it in `file`. */
export interface ComposableReference { file?: string; packageName?: string; name: string; line?: number }

export interface PreviewConfiguration {
  widthDp?: number;
  heightDp?: number;
  showBackground?: boolean;
  /** ARGB. */
  backgroundColor?: number;
  darkTheme?: boolean;
  fontScale?: number;
  locale?: string;
  device?: string;
  showSystemUi?: boolean;
  apiLevel?: number;
}

export interface WrapperRequest {
  target: ComposableDeclaration;
  /** JVM facade class of the target's file ({@link jvmFacade}). */
  facade: string;
  /** Kotlin expressions by parameter name. */
  arguments: Readonly<Record<string, string>>;
  /** A composable whose last parameter is a composable lambda, wrapped around the target. */
  theme?: ComposableDeclaration;
  configuration: PreviewConfiguration;
  /** Emit a `@Preview` annotation carrying the configuration (layoutlib discovers previews by it). */
  annotate: boolean;
}

export interface PreviewWrapper {
  name: string;
  /** `<facade>.<name>`. */
  methodFQN: string;
  /** Appended to the target file's text. */
  text: string;
  /** The configuration's `@Preview` attributes as preview discovery reports them. */
  previewParams: Record<string, string>;
  /** What the wrapper passes to the target, in parameter order. */
  arguments: { name: string; value: string; source: "argument" | "placeholder" }[];
}

/** The target cannot be wrapped as requested; the message tells the agent what to pass. */
export class WrapperError extends Error {
  override readonly name = "WrapperError";
}

const IDENTIFIER_PART = /[\p{L}\p{Nd}_]/u;
const identifierPart = (char: string | undefined): boolean => char !== undefined && IDENTIFIER_PART.test(char);
const MODIFIERS = [
  "public", "private", "internal", "protected", "inline", "suspend", "tailrec", "operator", "infix", "external", "override", "open",
  "final", "abstract", "expect", "actual",
];
const HARD_KEYWORDS = [
  "as", "break", "class", "continue", "do", "else", "false", "for", "fun", "if", "in", "interface", "is", "null", "object", "package",
  "return", "super", "this", "throw", "true", "try", "typealias", "typeof", "val", "var", "when", "while",
];

/**
 * Two views of Kotlin source with the offsets of `text`: `code` blanks comments, `masked` also blanks the contents of string
 * (raw strings and `${}` templates included) and character literals, keeping their quotes. Newlines are kept.
 */
function scan(text: string): { code: string; masked: string } {
  const code = text.split("");
  const masked = text.split("");
  const blank = (chars: string[], from: number, to: number) => {
    for (let index = from; index < to; index++) if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
  };
  // Open literals, innermost last: a string, a raw string, or a template's code with its unclosed braces.
  const stack: ({ kind: "string" | "raw" } | { kind: "template"; braces: number })[] = [];
  let literal = 0;
  let index = 0;
  const close = (end: number, next: number) => {
    stack.pop();
    if (stack.length === 0) blank(masked, literal, end);
    index = next;
  };
  while (index < text.length) {
    const top = stack.at(-1);
    const char = text[index]!;
    if (!top || top.kind === "template") {
      if (text.startsWith("//", index)) {
        const end = text.indexOf("\n", index);
        const stop = end < 0 ? text.length : end;
        if (!top) blank(code, index, stop);
        blank(masked, index, stop);
        index = stop;
      } else if (text.startsWith("/*", index)) {
        let depth = 1;
        let end = index + 2;
        while (end < text.length && depth > 0) {
          if (text.startsWith("/*", end)) depth++;
          else if (text.startsWith("*/", end)) depth--;
          else {
            end++;
            continue;
          }
          end += 2;
        }
        if (!top) blank(code, index, end);
        blank(masked, index, end);
        index = end;
      } else if (char === '"') {
        const raw = text.startsWith('"""', index);
        index += raw ? 3 : 1;
        if (!top) literal = index;
        stack.push({ kind: raw ? "raw" : "string" });
      } else if (char === "'") {
        let end = index + 1;
        while (end < text.length && text[end] !== "'" && text[end] !== "\n") end += text[end] === "\\" ? 2 : 1;
        if (!top) blank(masked, index + 1, Math.min(end, text.length));
        index = end + 1;
      } else if (char === "`") {
        const end = text.indexOf("`", index + 1);
        const newline = text.indexOf("\n", index + 1);
        index = end < 0 || (newline >= 0 && newline < end) ? index + 1 : end + 1;
      } else {
        if (top && char === "{") top.braces++;
        else if (top && char === "}") {
          if (top.braces === 0) stack.pop();
          else top.braces--;
        }
        index++;
      }
      continue;
    }
    if (char === "$" && text[index + 1] === "{") {
      stack.push({ kind: "template", braces: 0 });
      index += 2;
    } else if (top.kind === "string") {
      if (char === "\\") index += 2;
      else if (char === '"') close(index, index + 1);
      else if (char === "\n") close(index, index); // unterminated
      else index++;
    } else if (text.startsWith('"""', index)) {
      // Quotes before the closing three belong to the string.
      let end = index + 3;
      while (text[end] === '"') end++;
      close(end - 3, end);
    } else index++;
  }
  if (stack.length > 0) blank(masked, literal, text.length);
  return { code: code.join(""), masked: masked.join("") };
}

function skipSpace(text: string, index: number): number {
  while (index < text.length && /\s/.test(text[index]!)) index++;
  return index;
}

/** The identifier at `index` (backticks removed) and the offset after it. */
function identifierAt(text: string, index: number): { name: string; end: number } | undefined {
  if (text[index] === "`") {
    const end = text.indexOf("`", index + 1);
    return end > index + 1 ? { name: text.slice(index + 1, end), end: end + 1 } : undefined;
  }
  let end = index;
  while (identifierPart(text[end])) end++;
  return end > index && !/\d/.test(text[index]!) ? { name: text.slice(index, end), end } : undefined;
}

/** The offset of the bracket closing the one at `open` in masked text, or -1. */
function closing(masked: string, open: number): number {
  const opener = masked[open]!;
  const closer = { "(": ")", "[": "]", "{": "}" }[opener];
  if (!closer) return -1;
  let depth = 0;
  for (let index = open; index < masked.length; index++) {
    if (masked[index] === opener) depth++;
    else if (masked[index] === closer && --depth === 0) return index;
  }
  return -1;
}

/** The offset of the bracket opening the one at `close` in masked text, scanning backwards, or -1. */
function opening(masked: string, close: number): number {
  const closer = masked[close]!;
  const opener = { ")": "(", "]": "[" }[closer];
  if (!opener) return -1;
  let depth = 0;
  for (let index = close; index >= 0; index--) {
    if (masked[index] === closer) depth++;
    else if (masked[index] === opener && --depth === 0) return index;
  }
  return -1;
}

/**
 * The `>` closing the type argument list opened at `open`, or -1 when the text there cannot be one (a less-than comparison):
 * only type syntax may occur in between, `->` does not close it, and parentheses must balance.
 */
function angleClosing(text: string, open: number): number {
  let angles = 0;
  let parens = 0;
  for (let index = open; index < text.length; index++) {
    const char = text[index]!;
    if (char === "<") angles++;
    else if (char === ">") {
      if (--angles === 0) return parens === 0 ? index : -1;
    } else if (char === "-" && text[index + 1] === ">") index++;
    else if (char === "(") parens++;
    else if (char === ")") {
      if (--parens < 0) return -1;
    } else if (!identifierPart(char) && !/[\s.,?*:@&\[\]`]/.test(char)) return -1;
  }
  return -1;
}

/** `[from, to)` split at commas outside (), [], {} and type argument lists, as trimmed non-empty ranges. */
function splitTopLevel(text: string, from: number, to: number): [number, number][] {
  const ranges: [number, number][] = [];
  let depth = 0;
  let start = from;
  const push = (end: number) => {
    let first = start;
    let last = end;
    while (first < last && /\s/.test(text[first]!)) first++;
    while (last > first && /\s/.test(text[last - 1]!)) last--;
    if (last > first) ranges.push([first, last]);
  };
  for (let index = from; index < to; index++) {
    const char = text[index]!;
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth--;
    else if (char === "<" && identifierPart(text[index - 1])) {
      const close = angleClosing(text, index);
      if (close >= 0 && close < to) index = close;
    } else if (char === "," && depth === 0) {
      push(index);
      start = index + 1;
    }
  }
  push(to);
  return ranges;
}

/** The offset after an annotation starting with `@` at `index`: `@a.b.Name`, `@site:Name`, `@Name<T>(…)` or `@[A B(…)]`. */
function annotationEnd(masked: string, index: number): number {
  let end = index + 1;
  if (masked[end] === "[") {
    const close = closing(masked, end);
    return close < 0 ? -1 : close + 1;
  }
  let name = identifierAt(masked, end);
  if (!name) return -1;
  end = name.end;
  if (masked[end] === ":" && (name = identifierAt(masked, end + 1))) end = name.end;
  while (masked[end] === "." && (name = identifierAt(masked, end + 1))) end = name.end;
  if (masked[end] === "<") {
    const close = angleClosing(masked, end);
    if (close >= 0) end = close + 1;
  }
  if (masked[end] === "(") {
    const close = closing(masked, end);
    if (close < 0) return -1;
    end = close + 1;
  }
  return end;
}

/** The simple names of an annotation as written: `@a.Name(…)` is `Name`, `@[A B]` is `A`, `B`. */
function annotationNames(annotation: string): string[] {
  const body = annotation.startsWith("@[") ? annotation.slice(2, -1) : annotation.slice(1);
  // Argument lists and type arguments contribute no names.
  let flat = "";
  let depth = 0;
  for (const char of body) {
    if (char === "(" || char === "<") depth++;
    else if (char === ")" || char === ">") depth--;
    else if (depth === 0) flat += char;
  }
  return flat.split(/\s+/).filter(Boolean).map((name) => name.replace(/^[\p{L}_]+:/u, "").split(".").at(-1)!.replaceAll("`", ""));
}

const collapse = (text: string) => text.trim().replace(/\s+/g, " ");

function parameter(code: string, masked: string, from: number, to: number): KotlinParameter | undefined {
  const annotations: string[] = [];
  let index = from;
  while (masked[index] === "@") {
    const end = annotationEnd(masked, index);
    if (end < 0 || end > to) return undefined;
    annotations.push(collapse(code.slice(index, end)));
    index = skipSpace(masked, end);
  }
  let vararg = false;
  for (;;) {
    const word = identifierAt(masked, index);
    if (!word || masked[word.end] === ":" || !["vararg", "noinline", "crossinline"].includes(word.name) || !/\s/.test(masked[word.end] ?? "")) break;
    vararg ||= word.name === "vararg";
    index = skipSpace(masked, word.end);
  }
  const name = identifierAt(masked, index);
  if (!name) return undefined;
  const colon = skipSpace(masked, name.end);
  if (masked[colon] !== ":") return undefined;
  let depth = 0;
  let equals = -1;
  for (let position = colon + 1; position < to && equals < 0; position++) {
    const char = masked[position];
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth--;
    else if (char === "=" && depth === 0) equals = position;
  }
  const type = collapse(code.slice(colon + 1, equals < 0 ? to : equals));
  if (!type) return undefined;
  const defaultValue = equals < 0 ? undefined : code.slice(equals + 1, to).trim();
  return { name: name.name, type, ...defaultValue !== undefined ? { defaultValue } : {}, vararg, annotations };
}

/** The start of the (qualified, possibly backticked) name ending at `end` in masked text; `end` when there is none. */
function nameStart(masked: string, end: number): number {
  let start = end;
  for (;;) {
    let segment = start;
    if (masked[segment - 1] === "`") segment = Math.max(0, masked.lastIndexOf("`", segment - 2));
    else while (identifierPart(masked[segment - 1])) segment--;
    if (segment === start) return start;
    start = segment;
    const before = masked[start - 2];
    if (masked[start - 1] !== "." || !(before === "`" || identifierPart(before))) return start;
    start--;
  }
}

/**
 * Annotations (as written, and their simple names) and modifiers before the `fun` at `offset`, in source order. Strings are
 * masked for the names: `@Preview(name = "a)b")` is `Preview`.
 */
function prefix(code: string, masked: string, offset: number): { annotations: string[]; names: string[]; modifiers: string[]; contexts: KotlinContext[] } {
  const annotations: string[] = [];
  const names: string[] = [];
  const modifiers: string[] = [];
  const contexts: KotlinContext[][] = [];
  let start = offset;
  for (;;) {
    let end = start - 1;
    while (end >= 0 && /\s/.test(masked[end]!)) end--;
    if (end < 0) break;
    const group = masked[end] === "]";
    let wordEnd = end + 1;
    if (group || masked[end] === ")") {
      wordEnd = opening(masked, end);
      if (wordEnd < 0) break;
    }
    const wordStart = group ? wordEnd : nameStart(masked, wordEnd);
    if (masked[wordStart - 1] === "@" && (group || wordStart < wordEnd)) {
      annotations.push(collapse(code.slice(wordStart - 1, end + 1)));
      names.push(...annotationNames(masked.slice(wordStart - 1, end + 1)));
      start = wordStart - 1;
      continue;
    }
    const word = masked.slice(wordStart, wordEnd);
    if (word === "context" && !group && masked[end] === ")") {
      contexts.push(splitTopLevel(masked, wordEnd + 1, end).map(([from, to]) => {
        const name = identifierAt(masked, skipSpace(masked, from));
        const colon = name ? skipSpace(masked, name.end) : -1;
        if (!name || masked[colon] !== ":") return { type: collapse(code.slice(from, to)) };
        const type = collapse(code.slice(colon + 1, to));
        return name.name === "_" ? { type } : { name: name.name, type };
      }));
      start = wordStart;
      continue;
    }
    if (wordEnd !== end + 1 || !MODIFIERS.includes(word)) break;
    modifiers.push(word);
    start = wordStart;
  }
  return { annotations: annotations.reverse(), names, modifiers, contexts: contexts.reverse().flat() };
}

type Declaration = Omit<ComposableDeclaration, "packageName" | "file" | "line"> & { composable: boolean };

/** The declaration of the top-level `fun` at `offset`; undefined for anonymous functions, `fun interface` and malformed ones. */
function declaration(code: string, masked: string, offset: number): Declaration | undefined {
  let index = skipSpace(masked, offset + 3);
  let typeParameters: string[] = [];
  if (masked[index] === "<") {
    const close = angleClosing(masked, index);
    if (close < 0) return undefined;
    typeParameters = splitTopLevel(masked, index + 1, close).map(([from, to]) => collapse(code.slice(from, to)));
    index = skipSpace(masked, close + 1);
  }
  const receiverStart = index;
  let receiverEnd = -1;
  let name: { name: string; end: number } | undefined;
  if (masked[index] === "(") {
    const close = closing(masked, index);
    if (close < 0) return undefined;
    let dot = skipSpace(masked, close + 1);
    if (masked[dot] === "?") dot++;
    if (masked[dot] !== ".") return undefined;
    receiverEnd = dot;
    name = identifierAt(masked, dot + 1);
  } else {
    for (;;) {
      const segment = identifierAt(masked, index);
      if (!segment) return undefined;
      let end = segment.end;
      if (masked[end] === "<") {
        const close = angleClosing(masked, end);
        if (close < 0) return undefined;
        end = close + 1;
      }
      if (masked[end] === "?") end++;
      if (masked[end] === ".") {
        receiverEnd = end;
        index = end + 1;
        continue;
      }
      if (end !== segment.end) return undefined;
      name = segment;
      break;
    }
  }
  if (!name) return undefined;
  const open = skipSpace(masked, name.end);
  if (masked[open] !== "(") return undefined;
  const close = closing(masked, open);
  if (close < 0) return undefined;
  const parameters: KotlinParameter[] = [];
  for (const [from, to] of splitTopLevel(masked, open + 1, close)) {
    const parsed = parameter(code, masked, from, to);
    if (!parsed) return undefined;
    parameters.push(parsed);
  }
  const { annotations, names, modifiers, contexts } = prefix(code, masked, offset);
  const visibility = (["private", "internal", "protected"] as const).find((modifier) => modifiers.includes(modifier)) ?? "public";
  return {
    name: name.name,
    offset,
    visibility,
    ...receiverEnd >= 0 ? { receiver: collapse(code.slice(receiverStart, receiverEnd)) } : {},
    typeParameters,
    ...contexts.length > 0 ? { contexts } : {},
    parameters,
    previews: names.some((annotation) => annotation.includes("Preview")),
    annotations,
    composable: names.includes("Composable"),
  };
}

function packageOf(masked: string): string {
  return /^[ \t]*package[ \t]+([\p{L}\p{Nd}_.`]+)/mu.exec(masked)?.[1]?.replaceAll("`", "") ?? "";
}

/** Top-level `@Composable` functions of a Kotlin file, in source order. */
export function composableDeclarations(text: string, file: string): ComposableDeclaration[] {
  const { code, masked } = scan(text);
  const packageName = packageOf(masked);
  const declarations: ComposableDeclaration[] = [];
  let depth = 0;
  let line = 1;
  let counted = 0;
  for (let index = 0; index < masked.length; index++) {
    const char = masked[index];
    if (char === "{") depth++;
    else if (char === "}") depth = Math.max(0, depth - 1);
    else if (char === "`") {
      const end = masked.indexOf("`", index + 1);
      if (end > 0) index = end;
    } else if (depth === 0 && masked.startsWith("fun", index) && !identifierPart(masked[index - 1]) && !identifierPart(masked[index + 3])) {
      const found = declaration(code, masked, index);
      if (!found?.composable) continue;
      const { composable: _, ...composable } = found;
      for (; counted < index; counted++) if (text[counted] === "\n") line++;
      declarations.push({ ...composable, packageName, file, line });
    }
  }
  return declarations;
}

const REFERENCE_FORMS = "pkg.Name, Name, path/to/File.kt#Name, path/to/File.kt:42 or path/to/File.kt#Name:42";

/** Splits a dotted name outside backticks, removing them. */
function dotted(value: string): string[] | undefined {
  const segments: string[] = [];
  let index = 0;
  for (;;) {
    const segment = identifierAt(value, index);
    if (!segment) return undefined;
    segments.push(segment.name);
    if (segment.end === value.length) return segments;
    if (value[segment.end] !== ".") return undefined;
    index = segment.end + 1;
  }
}

function lineNumber(value: string, reference: string): number {
  const line = Number(value);
  if (!Number.isSafeInteger(line) || line < 1) throw new Error(`Invalid line ${value} in composable reference "${reference}"`);
  return line;
}

/**
 * Parses an agent's composable reference: `pkg.sub.Name`, `Name`, `path/to/File.kt#Name`, `path/to/File.kt:42` (the composable
 * at that line) or `path/to/File.kt#Name:42`. Throws for anything else.
 */
export function parseReference(reference: string): ComposableReference {
  const value = reference.trim();
  const invalid = () => new Error(`Unrecognized composable reference "${reference}": use ${REFERENCE_FORMS}`);
  const hash = value.lastIndexOf("#");
  if (hash >= 0) {
    const file = value.slice(0, hash).trim();
    const match = /^(.*?)(?::(\d+))?$/s.exec(value.slice(hash + 1).trim())!;
    const name = dotted(match[1]!.trim());
    if (!file || name?.length !== 1) throw invalid();
    return { file, name: name[0]!, ...match[2] ? { line: lineNumber(match[2], reference) } : {} };
  }
  const located = /^(.+\.kts?):(\d+)$/s.exec(value);
  if (located) return { file: located[1]!.trim(), name: "", line: lineNumber(located[2]!, reference) };
  const segments = /\.kts?$/.test(value) ? undefined : dotted(value);
  if (!segments) throw invalid();
  const name = segments.pop()!;
  return segments.length > 0 ? { packageName: segments.join("."), name } : { name };
}

/** The JVM class holding a file's top-level functions: `@file:JvmName`, else `<FileName>Kt`, in the file's package. */
export function jvmFacade(text: string, file: string): string {
  const { masked } = scan(text);
  const annotation = /@file\s*:\s*(?:kotlin\s*\.\s*jvm\s*\.\s*)?JvmName\s*\(\s*(?:name\s*=\s*)?"/.exec(masked);
  let facade: string;
  if (annotation) {
    const start = annotation.index + annotation[0].length;
    facade = text.slice(start, masked.indexOf('"', start));
  } else {
    const base = path.basename(file).replace(/\.[^.]*$/, "").replace(/[^\p{L}\p{Nd}_]/gu, "_");
    // Kotlin capitalizes ASCII letters only.
    facade = `${base.replace(/^[a-z]/, (letter) => letter.toUpperCase()) || "_"}Kt`;
  }
  const packageName = packageOf(masked);
  return packageName ? `${packageName}.${facade}` : facade;
}

/** `type` without leading annotations and `suspend`. */
function bareType(type: string): string {
  let value = type.trim();
  for (;;) {
    if (value.startsWith("@")) {
      const end = annotationEnd(value, 0);
      if (end < 0) return value;
      value = value.slice(end).trim();
    } else if (/^suspend\b/.test(value)) value = value.slice(7).trim();
    else return value;
  }
}

/** The offset of `->` outside brackets in a type, or -1. */
function topLevelArrow(type: string): number {
  let depth = 0;
  for (let index = 0; index < type.length; index++) {
    const char = type[index];
    if (char === "-" && type[index + 1] === ">") {
      if (depth === 0) return index;
      index++;
    } else if (char === "(" || char === "<" || char === "[") depth++;
    else if (char === ")" || char === ">" || char === "]") depth--;
  }
  return -1;
}

const PLACEHOLDERS: Record<string, string> = {
  Int: "0",
  Long: "0L",
  Short: "0.toShort()",
  Byte: "0.toByte()",
  Float: "0f",
  Double: "0.0",
  Boolean: "false",
  Char: "'a'",
  Modifier: "androidx.compose.ui.Modifier",
  Color: "androidx.compose.ui.graphics.Color.Gray",
  Dp: "androidx.compose.ui.unit.Dp(16f)",
  List: "emptyList()",
  Collection: "emptyList()",
  Iterable: "emptyList()",
  Set: "emptySet()",
  Map: "emptyMap()",
  MutableList: "mutableListOf()",
  MutableSet: "mutableSetOf()",
  MutableMap: "mutableMapOf()",
};

function kotlinString(value: string): string {
  return `"${value.replace(/[\\"$]/g, "\\$&").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t")}"`;
}

/** A value for a required parameter an agent did not pass: an empty, neutral value of its type, or undefined when none is known. */
export function placeholder(parameter: KotlinParameter): string | undefined {
  let type = bareType(parameter.type);
  for (;;) {
    const arrow = topLevelArrow(type);
    if (arrow >= 0) {
      if (!/^(kotlin\.)?Unit$/.test(type.slice(arrow + 2).trim())) return undefined;
      // The parameter list of `(A, B) -> Unit`, `Receiver.() -> Unit`; a receiver is the lambda's `this`.
      const inputs = type.slice(0, arrow).trim();
      const open = opening(inputs, inputs.length - 1);
      if (open < 0) return undefined;
      const arity = splitTopLevel(inputs, open + 1, inputs.length - 1).length;
      return arity === 0 ? "{}" : `{ ${Array(arity).fill("_").join(", ")} -> }`;
    }
    if (type.endsWith("?")) return "null";
    // Parentheses only group: `(() -> Unit)` is a function type.
    if (!type.startsWith("(") || closing(type, 0) !== type.length - 1) break;
    type = bareType(type.slice(1, -1));
  }
  const simple = type.replace(/<[\s\S]*$/, "").trim().split(".").at(-1)!;
  if (simple === "String" || simple === "CharSequence") return kotlinString(parameter.name);
  return Object.hasOwn(PLACEHOLDERS, simple) ? PLACEHOLDERS[simple] : undefined;
}

/** A name as Kotlin source: backticked when it is not a plain identifier or is a hard keyword. */
function identifier(name: string): string {
  return /^[\p{L}_][\p{L}\p{Nd}_]*$/u.test(name) && !HARD_KEYWORDS.includes(name) ? name : `\`${name}\``;
}

function qualified(declaration: ComposableDeclaration): string {
  return [...declaration.packageName ? declaration.packageName.split(".") : [], declaration.name].map(identifier).join(".");
}

/** The name a type parameter declaration introduces: `reified T : Any` is `T`. */
function typeParameterName(declaration: string): string {
  return bareType(declaration).replace(/^((reified|in|out)\s+)+/, "").split(/[\s:]/)[0]!.replaceAll("`", "");
}

function mentions(type: string, name: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{Nd}_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{Nd}_])`, "u").test(type);
}

const signature = (parameters: readonly KotlinParameter[]) => parameters.map((parameter) => `${parameter.name}: ${parameter.type}`).join(", ");
const passArguments = (parameters: readonly KotlinParameter[]) =>
  `Pass arguments: {${parameters.map((parameter) => `${JSON.stringify(parameter.name)}: "<Kotlin expression>"`).join(", ")}}.`;

/** Java's `String.valueOf(float)` for the values an agent passes. */
function javaFloat(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

const PRIMITIVE_ARRAYS: Record<string, string> = {
  Int: "intArrayOf", Long: "longArrayOf", Short: "shortArrayOf", Byte: "byteArrayOf", Float: "floatArrayOf", Double: "doubleArrayOf",
  Boolean: "booleanArrayOf", Char: "charArrayOf",
};

/** A vararg argument in named form, which Kotlin only accepts spread: `"a", "b"` is `*arrayOf("a", "b")`. */
function spread(parameter: KotlinParameter, value: string): string {
  if (value.trim().startsWith("*")) return value;
  const type = bareType(parameter.type).replace(/^kotlin\./, "");
  // The value ends its line: a trailing `// comment` in it must not swallow the closing parenthesis.
  return `*${Object.hasOwn(PRIMITIVE_ARRAYS, type) ? PRIMITIVE_ARRAYS[type] : "arrayOf"}(${value}\n)`;
}

const SCOPES: Record<string, string> = { ColumnScope: "Column", RowScope: "Row", BoxScope: "Box" };
const LAYOUT_PACKAGE = "androidx.compose.foundation.layout";

/** The argument key an agent supplies a context by: its name, or its type when it has none. */
const contextKey = (context: KotlinContext) => context.name ?? context.type;
const contextSignature = (contexts: readonly KotlinContext[]) =>
  contexts.map((context) => (context.name ? `${context.name}: ${context.type}` : context.type)).join(", ");

/** A public no-argument composable calling `target` with the agent's arguments, for the preview compile of its file. */
export function previewWrapper(request: WrapperRequest): PreviewWrapper {
  const { target, theme, configuration } = request;
  const problems: string[] = [];
  const contexts = target.contexts ?? [];
  const known = new Set([...target.parameters.map((parameter) => parameter.name), ...contexts.map(contextKey)]);
  const unknown = Object.keys(request.arguments).filter((name) => !known.has(name));
  if (unknown.length > 0) {
    problems.push(`\`${target.name}\` has no parameter named ${unknown.join(", ")}; `
      + (target.parameters.length > 0 ? `its parameters are ${signature(target.parameters)}` : "it takes no parameters")
      + (contexts.length > 0 ? ` and its contexts are ${contextSignature(contexts)}.` : "."));
  }
  const absent = contexts.filter((context) => !Object.hasOwn(request.arguments, contextKey(context)));
  if (absent.length > 0) {
    problems.push(`\`${target.name}\` needs context ${contextSignature(absent)}, which the preview supplies with \`with(…)\` from arguments `
      + `keyed by context name (by type for a context receiver). Pass arguments: {${absent.map((context) => `${JSON.stringify(contextKey(context))}: "<Kotlin expression>"`).join(", ")}}.`);
  }
  const empty = Object.entries(request.arguments).filter(([, value]) => !value.trim()).map(([name]) => name);
  if (empty.length > 0) problems.push(`Arguments ${empty.join(", ")} are empty: pass a Kotlin expression for each.`);

  let scope: string | undefined;
  if (target.receiver !== undefined) {
    const receiver = target.receiver.replace(/\?$/, "");
    const simple = receiver.split(".").at(-1)!;
    scope = Object.hasOwn(SCOPES, simple) && (receiver === simple || receiver === `${LAYOUT_PACKAGE}.${simple}`) ? SCOPES[simple] : undefined;
    if (!scope) {
      problems.push(`\`${target.name}\` extends ${target.receiver}: only ColumnScope, RowScope and BoxScope receivers can be previewed.`);
    }
  }

  // A type parameter is inferred from the arguments the agent passes; placeholders cannot determine it.
  const passed = target.parameters.filter((parameter) => Object.hasOwn(request.arguments, parameter.name));
  const unresolved = target.typeParameters.map(typeParameterName)
    .filter((name) => !passed.some((parameter) => mentions(parameter.type, name)));
  for (const name of unresolved) {
    const users = target.parameters.filter((parameter) => mentions(parameter.type, name));
    problems.push(users.length > 0
      ? `\`${target.name}\` has type parameter ${name}, which only an argument for a parameter whose type uses it determines `
        + `(${signature(users)}). ${passArguments(users)}`
      : `\`${target.name}\` cannot be previewed: no parameter determines its type parameter ${name}.`);
  }

  const values: PreviewWrapper["arguments"] = [];
  const missing: KotlinParameter[] = [];
  for (const parameter of target.parameters) {
    if (Object.hasOwn(request.arguments, parameter.name)) {
      const value = request.arguments[parameter.name]!;
      values.push({ name: parameter.name, value: parameter.vararg ? spread(parameter, value) : value, source: "argument" });
      continue;
    }
    if (parameter.defaultValue !== undefined || parameter.vararg) continue;
    if (unresolved.some((name) => mentions(parameter.type, name))) continue; // reported above
    const value = placeholder(parameter);
    if (value === undefined) missing.push(parameter);
    else values.push({ name: parameter.name, value, source: "placeholder" });
  }
  if (missing.length > 0) {
    problems.push(`\`${target.name}\` needs a value for ${signature(missing)}: no placeholder fits `
      + `${missing.length === 1 ? "its type" : "their types"}. ${passArguments(missing)}`);
  }

  let themeCall: string | undefined;
  if (theme) {
    const content = theme.parameters.at(-1);
    const others = theme.parameters.slice(0, -1);
    const themeArguments: string[] = [];
    const unfilled: KotlinParameter[] = [];
    for (const parameter of others) {
      if (parameter.defaultValue !== undefined || parameter.vararg) continue;
      const value = theme.typeParameters.length > 0 ? undefined : placeholder(parameter);
      if (value === undefined) unfilled.push(parameter);
      else themeArguments.push(`${identifier(parameter.name)} = ${value}`);
    }
    if (!content || topLevelArrow(bareType(content.type)) < 0 || !/@(androidx\.compose\.runtime\.)?Composable\b/.test(content.type)) {
      problems.push(`Theme \`${theme.name}\` cannot wrap a preview: its last parameter must be a composable lambda (content: @Composable () -> Unit).`);
    } else if (theme.receiver !== undefined) {
      problems.push(`Theme \`${theme.name}\` cannot wrap a preview: it extends ${theme.receiver}.`);
    } else if (theme.contexts !== undefined) {
      problems.push(`Theme \`${theme.name}\` cannot wrap a preview: it needs context ${contextSignature(theme.contexts)}.`);
    } else if (theme.visibility === "private" && theme.file !== target.file) {
      problems.push(`Theme \`${theme.name}\` cannot wrap a preview: it is private to ${theme.file}.`);
    } else if (unfilled.length > 0) {
      problems.push(`Theme \`${theme.name}\` cannot wrap a preview: no placeholder fits its required parameters ${signature(unfilled)}.`);
    } else themeCall = `${qualified(theme)}${themeArguments.length > 0 ? `(${themeArguments.join(", ")})` : ""}`;
  }

  for (const [key, value] of [["widthDp", configuration.widthDp], ["heightDp", configuration.heightDp], ["apiLevel", configuration.apiLevel]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) problems.push(`${key} must be a positive integer, not ${value}.`);
  }
  if (configuration.fontScale !== undefined && !(configuration.fontScale > 0)) problems.push(`fontScale must be positive, not ${configuration.fontScale}.`);
  if (problems.length > 0) throw new WrapperError(problems.join(" "));

  // Preview attributes as Kotlin source and as preview discovery reports them (String.valueOf of the annotation's values).
  const attributes: [string, string, string][] = [["name", kotlinString(target.name), target.name]];
  const add = (name: string, source: string, reported: string) => attributes.push([name, source, reported]);
  if (configuration.widthDp !== undefined) add("widthDp", String(configuration.widthDp), String(configuration.widthDp));
  if (configuration.heightDp !== undefined) add("heightDp", String(configuration.heightDp), String(configuration.heightDp));
  if (configuration.showBackground !== undefined) add("showBackground", String(configuration.showBackground), String(configuration.showBackground));
  if (configuration.backgroundColor !== undefined) {
    const argb = configuration.backgroundColor >>> 0;
    add("backgroundColor", `0x${argb.toString(16).toUpperCase().padStart(8, "0")}L`, String(argb));
  }
  if (configuration.darkTheme) add("uiMode", "0x21", "33");
  if (configuration.fontScale !== undefined) add("fontScale", `${javaFloat(configuration.fontScale)}f`, javaFloat(configuration.fontScale));
  if (configuration.locale !== undefined) add("locale", kotlinString(configuration.locale), configuration.locale);
  if (configuration.device !== undefined) add("device", kotlinString(configuration.device), configuration.device);
  if (configuration.showSystemUi !== undefined) add("showSystemUi", String(configuration.showSystemUi), String(configuration.showSystemUi));
  if (configuration.apiLevel !== undefined) add("apiLevel", String(configuration.apiLevel), String(configuration.apiLevel));

  const key = JSON.stringify([
    request.facade,
    `${target.name}:${target.line}`,
    Object.entries(request.arguments).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    theme ? `${qualified(theme)}:${theme.line}` : null,
    Object.entries(configuration).filter(([, value]) => value !== undefined).sort(([left], [right]) => (left < right ? -1 : 1)),
    request.annotate,
  ]);
  const name = `ElideAgentPreview_${createHash("sha256").update(key).digest("hex").slice(0, 10)}`;

  // Qualified, because an explicit import of the same name takes precedence over the file's own declaration; an extension's
  // call cannot be qualified.
  const callee = target.receiver === undefined ? qualified(target) : identifier(target.name);
  // Each argument ends its line, so a trailing `// comment` in an agent's expression comments out nothing else.
  const call = (pad: string) => (values.length === 0 ? `${pad}${callee}()` : [
    `${pad}${callee}(`,
    ...values.map((value, index) => `${pad}  ${index > 0 ? ", " : ""}${identifier(value.name)} = ${value.value}`),
    `${pad})`,
  ].join("\n"));
  const blocks: ((pad: string) => string)[] = [
    ...themeCall !== undefined ? [(pad: string) => `${pad}${themeCall} {`] : [],
    ...scope !== undefined ? [(pad: string) => `${pad}${LAYOUT_PACKAGE}.${scope} {`] : [],
    // `with` makes the value an implicit receiver, which resolves both context parameters and context receivers.
    ...contexts.map((context) => (pad: string) => `${pad}with(\n${pad}  ${request.arguments[contextKey(context)]}\n${pad}) {`),
  ];
  const body = [
    ...blocks.map((block, depth) => block("  ".repeat(depth + 1))),
    call("  ".repeat(blocks.length + 1)),
    ...blocks.map((_, depth) => `${"  ".repeat(blocks.length - depth)}}`),
  ];
  const lines = [
    "",
    "",
    "// Generated by Elide for an agent's Compose preview; never saved.",
    ...request.annotate ? [`@androidx.compose.ui.tooling.preview.Preview(${attributes.map(([key, source]) => `${key} = ${source}`).join(", ")})`] : [],
    "@androidx.compose.runtime.Composable",
    `fun ${name}() {`,
    ...body,
    "}",
    "",
  ];
  return {
    name,
    methodFQN: `${request.facade}.${name}`,
    text: lines.join("\n"),
    previewParams: Object.fromEntries(attributes.map(([key, , reported]) => [key, reported])),
    arguments: values,
  };
}
