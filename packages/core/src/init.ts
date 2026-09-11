/** One answer `elide init` asks for, as `elide init --templates --json` describes it. */
export interface InitParameter {
  id: string;
  title: string;
  description: string;
  default: string;
  /** Validator names the CLI applies to the answer, e.g. `JavaPackage`, `JavaClass`, `Boolean`. */
  attributes: string[];
}

/**
 * A project template, or one optional block of one.
 *
 * A block is the same shape as the template that owns it: its `id` is answered `true`/`false` to enable it, and
 * only an enabled block's parameters are asked for.
 */
export interface InitTemplate {
  id: string;
  title: string;
  description: string;
  default: boolean;
  parameters: InitParameter[];
  actions: string[];
  blocks: InitTemplate[];
}

/** Every template asks for the project name under this id. */
export const PROJECT_NAME_PARAMETER = "project_name";

/** Answers the CLI validates; the same patterns the `init` command applies to interactive input. */
const JAVA_PACKAGE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*[a-z0-9_]*$/;
const JAVA_CLASS = /^[a-zA-Z_$][a-zA-Z\d_$]*$/;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((e): e is string => typeof e === "string") : [];
}

function decodeParameter(value: unknown): InitParameter {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return {
    id: asString(raw.id),
    title: asString(raw.title),
    description: asString(raw.description),
    default: asString(raw.default),
    attributes: asStrings(raw.attributes),
  };
}

function decodeTemplate(value: unknown): InitTemplate {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return {
    id: asString(raw.id),
    title: asString(raw.title),
    description: asString(raw.description),
    default: raw.default === true,
    parameters: Array.isArray(raw.parameters) ? raw.parameters.map(decodeParameter) : [],
    actions: asStrings(raw.actions),
    blocks: Array.isArray(raw.blocks) ? raw.blocks.map(decodeTemplate) : [],
  };
}

/** Decode the JSON array printed by `elide init --templates --json`. */
export function decodeInitTemplates(json: string): InitTemplate[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (cause) {
    throw new Error("elide init --templates --json: invalid JSON", { cause });
  }
  if (!Array.isArray(raw)) throw new Error("elide init --templates --json: expected an array");
  return raw.map(decodeTemplate);
}

/** Problem text for an answer the CLI would reject, or `undefined` when it accepts the value. */
export function validateInitParameter(parameter: InitParameter, value: string): string | undefined {
  if (parameter.attributes.includes("JavaPackage") && !JAVA_PACKAGE.test(value)) {
    return "must be a Java package name (lowercase segments separated by dots)";
  }
  if (parameter.attributes.includes("JavaClass") && !JAVA_CLASS.test(value)) return "must be a Java class name";
  if (parameter.attributes.includes("Boolean") && value !== "true" && value !== "false") return "must be true or false";
  return undefined;
}

/**
 * Argv generating a project non-interactively. The CLI has no target-path flag: the project is written to the
 * working directory the command runs in.
 */
export function initArgs(templateId: string, answers: Readonly<Record<string, string>>): string[] {
  return [
    "init",
    "--plain",
    "--skip-defaults",
    "--skip-run",
    "--template",
    templateId,
    "--",
    ...Object.entries(answers).map(([key, value]) => `${key}=${value}`),
  ];
}
