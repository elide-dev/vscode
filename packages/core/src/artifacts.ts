import path from "node:path";

/** One entry of the `artifacts` block of `elide.pkl`. */
export interface ManifestArtifact {
  /** Mapping key of the entry, which is the build target name `elide build` takes. */
  name: string;
  /** Unqualified Pkl class the entry instantiates (`NativeImage`, `Jar`, `StaticSite`); empty when it is not a `new`. */
  type: string;
  /** Zero-based line of the entry in the manifest. */
  line: number;
  /** `name` declared in the entry's body: the output name, which overrides the one Elide derives. */
  outputName?: string;
  /** `type` declared in the body of a Native Image entry: `binary` (the schema default) or `library`. */
  imageType?: string;
}

/** Directory `elide build` writes Native Image output to, relative to the project root. */
export const NATIVE_IMAGE_DIR = path.join(".dev", "artifacts", "native-image");

/** Pkl class of a Native Image artifact, as `new NativeImage.NativeImage { … }` instantiates it. */
const NATIVE_IMAGE_TYPE = "NativeImage";
/** `artifacts {`; the schema declares exactly one such block, at the top level. */
const ARTIFACTS_OPEN = /^\s*artifacts\s*\{/;
/** A mapping entry of the block: `["bin"] = new NativeImage.NativeImage {`, with the class optional. */
const ENTRY = /^\s*\["([^"]+)"\]\s*=\s*(?:new\s+(?:\w+\s*\.\s*)*(\w+))?/;
/** `name = "app"` in an entry's body. */
const OUTPUT_NAME = /^\s*name\s*=\s*"([^"]*)"/;
/** `type = "library"` in an entry's body. */
const IMAGE_TYPE = /^\s*type\s*=\s*"([^"]*)"/;

/**
 * Artifacts declared in the text of an `elide.pkl`, in source order.
 *
 * The manifest is read as text rather than through `elide manifest`, whose JSON carries no artifacts and no source
 * positions; the caller needs both the line of each entry and the settings that decide the output path.
 */
export function parseManifestArtifacts(text: string): ManifestArtifact[] {
  const artifacts: ManifestArtifact[] = [];
  const lines = text.split("\n");
  let depth = 0;
  /** Brace depth the `artifacts` block sits at, `-1` while outside it. */
  let blockDepth = -1;
  let current: ManifestArtifact | undefined;
  let currentDepth = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i] ?? "");
    if (blockDepth < 0) {
      if (depth === 0 && ARTIFACTS_OPEN.test(line)) blockDepth = depth;
    } else if (depth === blockDepth + 1) {
      const entry = ENTRY.exec(line);
      if (entry?.[1]) {
        current = { name: entry[1], type: entry[2] ?? "", line: i };
        currentDepth = depth;
        artifacts.push(current);
      }
    } else if (current && depth === currentDepth + 1) {
      // Only the entry's own settings: nested blocks (`options`, `classInit`, …) carry keys of the same names.
      const outputName = OUTPUT_NAME.exec(line);
      if (outputName) current.outputName = outputName[1];
      const imageType = IMAGE_TYPE.exec(line);
      if (imageType) current.imageType = imageType[1];
    }

    depth += braceDelta(line);
    if (current && depth <= currentDepth) current = undefined;
    if (blockDepth >= 0 && depth <= blockDepth) blockDepth = -1;
  }
  return artifacts;
}

/** Whether `elide build` produces a runnable binary for this artifact. A `library` image is a shared object. */
export function isNativeImageBinary(artifact: ManifestArtifact): boolean {
  return artifact.type === NATIVE_IMAGE_TYPE && (artifact.imageType ?? "binary") === "binary";
}

/** Where `elide build` writes a Native Image artifact to, and what its parts are named. */
export interface NativeImageOutput {
  /** The artifact's own `name`, when it declares one. */
  outputName?: string;
  /** `name` of the manifest, which names the image when the artifact does not. */
  projectName?: string;
  platform?: NodeJS.Platform;
}

/**
 * Path `elide build` writes a Native Image artifact to. The image name is the artifact's own `name`, else the project
 * name, else the project directory name — the order `NativeImageTask` resolves it in.
 */
export function nativeImageBinary(root: string, output: NativeImageOutput = {}): string {
  const image = output.outputName || output.projectName || path.basename(root);
  return path.join(root, NATIVE_IMAGE_DIR, (output.platform ?? process.platform) === "win32" ? `${image}.exe` : image);
}

/** Subdirectory `native-image -g` caches the compiled sources in, beside the image it wrote. */
export const NATIVE_IMAGE_SOURCES_DIR = "sources";
/** GDB pretty-printer for Java objects, arrays, strings and enums, copied beside an image built with `-g`. */
export const NATIVE_IMAGE_GDB_HELPERS = "gdb-debughelpers.py";

/** What a Native Image built with `-g` leaves beside the image for a debugger to use. */
export interface NativeImageDebugInfo {
  /**
   * Cache of the Java and Kotlin sources the image was compiled from. GDB looks for it in `./sources` relative to
   * its own working directory, so it has to be pointed at this path explicitly.
   */
  sources: string;
  /**
   * Pretty-printer script for the image. Its `.debug_gdb_scripts` section makes GDB auto-load the file from the
   * working directory, which is not where it lands, so it has to be sourced explicitly too.
   */
  gdbHelpers: string;
}

/** Where the debug-info products of a Native Image are, given the image `elide build` wrote. */
export function nativeImageDebugInfo(binary: string): NativeImageDebugInfo {
  const dir = path.dirname(binary);
  return { sources: path.join(dir, NATIVE_IMAGE_SOURCES_DIR), gdbHelpers: path.join(dir, NATIVE_IMAGE_GDB_HELPERS) };
}

/** The line without its `//` comment; a `//` inside a string literal is content, not a comment. */
function stripComment(line: string): string {
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
function braceDelta(line: string): number {
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
