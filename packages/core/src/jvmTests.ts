/** A test method found in a source file. */
export interface ScannedTestMethod {
  name: string;
  /** 0-based line of the declaration. */
  line: number;
}

/** A class holding test methods, or enclosing one that does. */
export interface ScannedTestClass {
  /** JVM binary name, e.g. `sample.Outer$Inner`. */
  binaryName: string;
  simpleName: string;
  /** 0-based line of the declaration. */
  line: number;
  methods: ScannedTestMethod[];
}

export interface ScannedTestFile {
  packageName: string;
  classes: ScannedTestClass[];
}

const PACKAGE = /^\s*package\s+([\w.]+)/;
const KOTLIN_CLASS =
  /^\s*(?:(?:public|internal|private|protected|open|abstract|final|data|inner|annotation|sealed|enum)\s+)*(?:class|object)\s+([A-Za-z_]\w*)/;
const JAVA_CLASS = /^\s*(?:(?:public|protected|private|static|abstract|final)\s+)*(?:class|record|enum)\s+([A-Za-z_]\w*)/;
const KOTLIN_METHOD =
  /^\s*(?:(?:public|internal|private|protected|open|override|suspend|final)\s+)*fun\s+(?:`([^`]+)`|([A-Za-z_]\w*))\s*\(/;
const JAVA_METHOD =
  /^\s*(?:(?:public|protected|private|static|final|synchronized)\s+)*(?:<[^>]+>\s+)?[\w<>\[\],.?\s]+?\s+([A-Za-z_]\w*)\s*\(/;
const TEST_ANNOTATION = /@(?:[\w.]+\.)?(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/;
/**
 * Annotations opening a line, with their arguments: `@Test fun works()` declares on the annotation's own line, and
 * the declaration patterns match what follows them. Literals are already stripped, so arguments hold no parentheses
 * of their own but those of a nested annotation or a class literal.
 */
const LEADING_ANNOTATIONS = /^\s*(?:@[\w.]+(?:\((?:[^()]|\([^()]*\))*\))?\s*)+/;

/** Characters a Java regex reads as syntax, escaped so a class or method name matches itself. */
const JAVA_REGEX_META = /[.*+?^${}()|[\]\\]/g;

/** Engine-level containers the JUnit platform prefixes a display name with; they are not part of the class chain. */
const ENGINE_CONTAINERS: Record<string, true> = {
  "JUnit Jupiter": true,
  "JUnit Vintage": true,
  "JUnit Platform Suite": true,
};

interface ScanState {
  inBlockComment: boolean;
  inRawString: boolean;
}

/**
 * Strip comments and string literals from a line, keeping every other character in place.
 *
 * Brace counting and declaration matching both run on the result, so a brace, a `//`, or a `fun` inside a string
 * cannot move the parser.
 */
function sanitize(line: string, state: ScanState): string {
  let code = "";
  let i = 0;
  while (i < line.length) {
    if (state.inRawString) {
      const end = line.indexOf('"""', i);
      if (end < 0) return code;
      state.inRawString = false;
      i = end + 3;
      continue;
    }
    if (state.inBlockComment) {
      const end = line.indexOf("*/", i);
      if (end < 0) return code;
      state.inBlockComment = false;
      i = end + 2;
      continue;
    }
    const char = line[i];
    if (char === "/" && line[i + 1] === "/") return code;
    if (char === "/" && line[i + 1] === "*") {
      state.inBlockComment = true;
      i += 2;
      continue;
    }
    if (line.startsWith('"""', i)) {
      state.inRawString = true;
      i += 3;
      continue;
    }
    if (char === '"' || char === "'") {
      for (i++; i < line.length; i++) {
        if (line[i] === "\\") i++;
        else if (line[i] === char) break;
      }
      i++;
      continue;
    }
    code += char;
    i++;
  }
  return code;
}

interface ClassNode {
  simpleName: string;
  line: number;
  methods: ScannedTestMethod[];
  parent: ClassNode | undefined;
  children: ClassNode[];
}

interface StackEntry {
  node: ClassNode;
  /** Brace depth before the declaration line; the class body is closed when depth returns to it. */
  depthAtOpen: number;
  opened: boolean;
}

function hasTests(node: ClassNode): boolean {
  return node.methods.length > 0 || node.children.some(hasTests);
}

/**
 * Find the JUnit test classes and methods a Kotlin or Java source file declares.
 *
 * The scan is line-based and regex-driven by design — the extension carries no Kotlin or Java parser — so it covers
 * the shapes test sources actually use: annotated methods (`@Test` and friends, qualified or not) inside classes and
 * objects, nested classes included. A class contributes only when it, or a class nested in it, holds a test method.
 */
export function scanJvmTestSource(text: string, language: "kotlin" | "java"): ScannedTestFile {
  const classPattern = language === "kotlin" ? KOTLIN_CLASS : JAVA_CLASS;
  const methodPattern = language === "kotlin" ? KOTLIN_METHOD : JAVA_METHOD;

  const state: ScanState = { inBlockComment: false, inRawString: false };
  const stack: StackEntry[] = [];
  const declared: ClassNode[] = [];
  let packageName = "";
  let depth = 0;
  let annotated = false;

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const code = sanitize((lines[index] ?? "").replace(/\r$/, ""), state);
    const depthBefore = depth;

    if (!packageName) {
      const pkg = PACKAGE.exec(code);
      if (pkg) packageName = pkg[1] ?? "";
    }

    const annotationHere = TEST_ANNOTATION.test(code);
    if (annotationHere) annotated = true;

    const declaration = code.replace(LEADING_ANNOTATIONS, "");
    const classMatch = classPattern.exec(declaration);
    if (classMatch) {
      // a declaration that never opened a body was bodyless; it cannot enclose what follows
      while (stack.length > 0 && !stack[stack.length - 1]?.opened) stack.pop();
      const parent = stack[stack.length - 1]?.node;
      const node: ClassNode = { simpleName: classMatch[1] ?? "", line: index, methods: [], parent, children: [] };
      parent?.children.push(node);
      declared.push(node);
      stack.push({ node, depthAtOpen: depthBefore, opened: false });
      annotated = false;
    } else {
      const owner = stack[stack.length - 1]?.node;
      const methodMatch = owner ? methodPattern.exec(declaration) : null;
      if (methodMatch && owner) {
        if (annotated) owner.methods.push({ name: methodMatch[1] ?? methodMatch[2] ?? "", line: index });
        annotated = false;
      } else if (!annotationHere && (code.includes("{") || code.includes("}"))) {
        annotated = false;
      }
    }

    for (const char of code) {
      if (char === "{") depth++;
      else if (char === "}") depth--;
    }
    for (const entry of stack) if (depth > entry.depthAtOpen) entry.opened = true;
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (!top || !top.opened || depth > top.depthAtOpen) break;
      stack.pop();
    }
  }

  const prefix = packageName ? `${packageName}.` : "";
  const classes = declared.filter(hasTests).map((node) => {
    const chain: string[] = [];
    for (let owner: ClassNode | undefined = node; owner; owner = owner.parent) chain.unshift(owner.simpleName);
    return { binaryName: prefix + chain.join("$"), simpleName: node.simpleName, line: node.line, methods: node.methods };
  });
  return { packageName, classes };
}

/**
 * A `elide test -t <pattern>` value selecting exactly the given classes and methods.
 *
 * The JVM engine full-matches the pattern against `pkg.Class#method` (`$` separating nested classes), wrapped in
 * `.*(?:…).*`, so each target is anchored: a method target matches only itself, a class target matches the class and
 * everything nested in it.
 */
export function jvmTestNamePattern(targets: readonly { binaryName: string; method?: string }[]): string | undefined {
  if (targets.length === 0) return undefined;
  return targets
    .map(({ binaryName, method }) => {
      const cls = binaryName.replace(JAVA_REGEX_META, "\\$&");
      return method === undefined ? `^${cls}[#$]` : `^${cls}#${method.replace(JAVA_REGEX_META, "\\$&")}$`;
    })
    .join("|");
}

/** Split a TAP label (`Outer > Inner > works()`) into its container chain and the test's own name. */
export function parseTapLabel(label: string): { containers: string[]; name: string } {
  const segments = label.split(" > ");
  const name = (segments.pop() ?? "").replace(/\(.*\)$/, "");
  if (segments.length > 0 && ENGINE_CONTAINERS[segments[0] ?? ""]) segments.shift();
  return { containers: segments, name };
}
