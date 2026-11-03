import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Where a manifest error points: a 1-based line and column range on one line of a local Pkl file. */
export interface ManifestErrorLocation {
  file: string;
  line: number;
  column: number;
  /** Exclusive end column, after the marked span. */
  endColumn: number;
}

/** What Elide said about a manifest it could not evaluate. */
export interface ManifestError {
  /** Elide's message: Pkl's, such as "Cannot find property `kapt` in object of type …", possibly over several lines. */
  message: string;
  /** Places in local files the message points at, innermost first, as Pkl prints its frames. */
  locations: ManifestErrorLocation[];
}

/**
 * Elide's `elide_project_manifest_error_header` in every locale it ships (`Elide_<locale>.properties`): it picks one
 * from `LANG`, with no override of its own, and `LANG` cannot be pinned for the manifest's sake, since manifests read
 * it as `env`. Pkl's messages and source frames that follow are not localized.
 */
const HEADERS = ["Manifest error:", "Manifestfehler:", "Error de manifiesto:", "Erreur de manifeste:", "Ошибка манифеста:", "Помилка маніфесту:"];
const HEADER = new RegExp(`^(?:${HEADERS.join("|")})\\s?(.*)$`);
/** `elide_project_invalid_manifest` in the same locales, which Elide prints last as `Error: <text>; see --help`. */
const GENERIC = new RegExp(`^[^:]+: (${[
  "Project manifest is invalid or contains errors",
  "Projektmanifest ist ungültig oder enthält Fehler",
  "El manifiesto del proyecto es inválido o contiene errores",
  "Le manifeste du projet est invalide ou contient des erreurs",
  "Манифест проекта повреждён или содержит ошибки",
  "Маніфест проєкту недійсний або містить помилки",
].join("|")})`);
const SNIPPET = /^(\s*(\d+) \| )(.*)$/;
const CARETS = /^(\s*)(\^+)\s*$/;
/** `at <member> (<module uri>)`; a URI may carry `:line:column`. */
const FRAME = /^at .*\(([^()]+?)(?::\d+(?::\d+)?)?\)\s*$/;

/**
 * The manifest error in an Elide command's stderr, as Elide prints a Pkl evaluation failure:
 *
 * ```
 * Manifest error: Expected value of type `Boolean`, but got type `String`.
 * Value: "yes"
 *
 * 12 | compose = "yes"
 *                ^^^^^
 * at elide#kotlin.features (file:///work/app/elide.pkl)
 * ```
 *
 * Each frame is a source line (Pkl strips its indentation), carets under the span, and, usually, the module it is
 * in. A frame names a local file through a `file:` URI; a frame without a module line is taken to be in
 * `manifestPath`, the manifest the command evaluated, when that manifest has the quoted line at that number. Frames
 * in Elide's own modules (`elide:Kotlin.pkl`) carry no location. `undefined` when the output holds no manifest error.
 */
export function parseManifestError(
  stderr: string,
  manifestPath: string,
  readText: (file: string) => string | undefined = readLocal,
): ManifestError | undefined {
  const lines = stderr.split(/\r?\n/);
  const start = lines.findIndex((line) => HEADER.test(line));
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && lines[end]!.trim().length > 0) end++;
  const message = [HEADER.exec(lines[start]!)![1]!, ...lines.slice(start + 1, end)].join("\n").trim()
    || lines.map((line) => GENERIC.exec(line)?.[1]).find((text) => text !== undefined)
    || "Project manifest is invalid";

  const locations: ManifestErrorLocation[] = [];
  const sources = new Map<string, string[] | undefined>();
  const sourceLines = (file: string) => {
    if (!sources.has(file)) sources.set(file, readText(file)?.split(/\r?\n/));
    return sources.get(file);
  };
  for (let i = end; i < lines.length; i++) {
    const snippet = SNIPPET.exec(lines[i]!);
    const carets = snippet && CARETS.exec(lines[i + 1] ?? "");
    if (!snippet || !carets) continue;
    const uri = FRAME.exec(lines[i + 2] ?? "")?.[1];
    i += uri !== undefined ? 2 : 1;
    const file = uri === undefined ? manifestPath : uri.startsWith("file:") ? fileURLToPath(uri) : undefined;
    if (!file) continue;
    const line = Number(snippet[2]);
    const quoted = snippet[3]!;
    const actual = sourceLines(file)?.[line - 1];
    // A frame that names no module is placed only where the manifest really holds what it quotes.
    if (uri === undefined && actual?.trim() !== quoted.trim()) continue;
    const indent = actual !== undefined && actual.trim() === quoted.trim() ? actual.length - actual.trimStart().length : 0;
    const column = indent + carets[1]!.length - snippet[1]!.length + 1;
    locations.push({ file: path.resolve(file), line, column: Math.max(1, column), endColumn: Math.max(1, column) + carets[2]!.length });
  }
  return { message, locations };
}

function readLocal(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}
