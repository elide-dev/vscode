import { ManifestParseError } from "./errors.js";

/**
 * Decoded `elide manifest` output.
 *
 * The CLI serializes its Pkl-derived project model with kotlinx.serialization (`encodeDefaults=false`,
 * `explicitNulls=false`, discriminator `"@type"`), so absent keys mean schema defaults and unions arrive as objects
 * carrying an `@type`. Only the fields the IDE integration consumes are modelled; unknown keys are ignored.
 */
export interface Manifest {
  name?: string;
  version?: string;
  entrypoint: string[];
  scripts: Record<string, string>;
  jvm?: JvmSettings;
  kotlin?: KotlinSettings;
  sources: Record<string, SourceSet>;
  dependencies: { maven?: { localRepository?: string } };
  toolchain: { engines: Record<string, string> };
}

export interface JvmSettings {
  main?: string;
  target: JvmTarget;
  javaHome?: string;
  java?: { release?: number | string; source?: number | string };
}

export interface KotlinSettings {
  apiLevel: KotlinLevel;
  languageLevel: KotlinLevel;
  compilerOptions?: { apiVersion: KotlinLevel; languageVersion: KotlinLevel; freeCompilerArgs: string[] };
}

export type SourceSetType = "source" | "test" | "example" | "other";

export interface SourceSet {
  type: SourceSetType;
  paths: string[];
  dependsOn: string[];
  /** Resource paths keyed by source path; only JVM source sets declare them. */
  resources: Record<string, string>;
}

export type JvmTarget = { kind: "auto" | "latest" | "stable" } | { kind: "version"; major: number };
export type KotlinLevel = { kind: "auto" | "latest" | "stable" } | { kind: "version"; value: string };

export const TEST_SOURCE_SET = "test";

/** Default source sets the schema applies when the manifest declares none. */
export const DEFAULT_SOURCES: Record<string, SourceSet> = {
  main: { type: "source", paths: ["src/**.*"], dependsOn: [], resources: {} },
  test: { type: "test", paths: ["test/**.*"], dependsOn: [], resources: {} },
};

/** A set literally named `test` is a test source set regardless of its declared type. */
export function effectiveType(name: string, set: SourceSet): SourceSetType {
  return name === TEST_SOURCE_SET ? "test" : set.type;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function typeTag(v: Json): string {
  const t = v["@type"];
  return typeof t === "string" ? t : "";
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((e): e is string => typeof e === "string") : [];
}

function stringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObject(v)) return out;
  for (const [k, val] of Object.entries(v)) if (typeof val === "string") out[k] = val;
  return out;
}

function decodeSourceSet(v: unknown): SourceSet | undefined {
  if (typeof v === "string") return { type: "source", paths: [v], dependsOn: [], resources: {} };
  if (!isObject(v)) return undefined;
  if (typeTag(v) === "elide.sources.SourceSet.OfString") {
    return typeof v.value === "string" ? { type: "source", paths: [v.value], dependsOn: [], resources: {} } : undefined;
  }
  const rawType = typeof v.type === "string" ? v.type.toLowerCase() : "source";
  const type: SourceSetType =
    rawType === "test" || rawType === "example" || rawType === "other" ? rawType : "source";
  return { type, paths: strings(v.paths), dependsOn: strings(v.dependsOn), resources: stringMap(v.resources) };
}

function decodeJvmTarget(v: unknown): JvmTarget {
  if (!isObject(v)) return { kind: "auto" };
  const tag = typeTag(v);
  if (tag.endsWith(".Latest")) return { kind: "latest" };
  if (tag.endsWith(".Stable")) return { kind: "stable" };
  if (tag.endsWith(".OfInt") && typeof v.value === "number") return { kind: "version", major: v.value };
  if (tag.endsWith(".OfFloat") && typeof v.value === "number") {
    // The schema spells Java 8 and 9 as 1.8 / 1.9: the fractional part is the feature version.
    if (v.value < 2) return { kind: "version", major: Math.round((v.value - 1) * 10) };
    return { kind: "version", major: Math.trunc(v.value) };
  }
  return { kind: "auto" };
}

function decodeKotlinLevel(v: unknown): KotlinLevel {
  if (typeof v === "string") return decodeKotlinLevelString(v);
  if (!isObject(v)) return { kind: "auto" };
  const tag = typeTag(v);
  if (tag.endsWith(".VLatest")) return { kind: "latest" };
  if (tag.endsWith(".VStable")) return { kind: "stable" };
  if (tag.endsWith(".VAuto")) return { kind: "auto" };
  const m = /\.V(\d+)_(\d+)$/.exec(tag);
  if (m) return { kind: "version", value: `${m[1]}.${m[2]}` };
  if (tag.endsWith(".OfString") && typeof v.value === "string") return decodeKotlinLevelString(v.value);
  return { kind: "auto" };
}

function decodeKotlinLevelString(s: string): KotlinLevel {
  const lower = s.trim().toLowerCase();
  if (lower === "auto" || lower === "") return { kind: "auto" };
  if (lower === "latest") return { kind: "latest" };
  if (lower === "stable") return { kind: "stable" };
  return { kind: "version", value: s.trim() };
}

function decodeEngine(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (isObject(v) && typeof v.value === "string") return v.value;
  return undefined;
}

/** Decode the JSON printed by `elide manifest`. Throws {@link ManifestParseError} on malformed input. */
export function decodeManifest(text: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ManifestParseError(e instanceof Error ? e.message : String(e), e);
  }
  if (!isObject(raw)) throw new ManifestParseError("top-level value is not an object");

  const sources: Record<string, SourceSet> = {};
  if (isObject(raw.sources)) {
    for (const [name, v] of Object.entries(raw.sources)) {
      const set = decodeSourceSet(v);
      if (set) sources[name] = set;
    }
  } else {
    Object.assign(sources, structuredClone(DEFAULT_SOURCES));
  }

  let jvm: JvmSettings | undefined;
  if (isObject(raw.jvm)) {
    const java = isObject(raw.jvm.java) ? raw.jvm.java : undefined;
    jvm = {
      main: typeof raw.jvm.main === "string" ? raw.jvm.main : undefined,
      target: decodeJvmTarget(raw.jvm.target),
      javaHome: typeof raw.jvm.javaHome === "string" ? raw.jvm.javaHome : undefined,
      java: java
        ? {
            release: typeof java.release === "number" || typeof java.release === "string" ? java.release : undefined,
            source: typeof java.source === "number" || typeof java.source === "string" ? java.source : undefined,
          }
        : undefined,
    };
  }

  let kotlin: KotlinSettings | undefined;
  if (isObject(raw.kotlin)) {
    const co = isObject(raw.kotlin.compilerOptions) ? raw.kotlin.compilerOptions : undefined;
    kotlin = {
      apiLevel: decodeKotlinLevel(raw.kotlin.apiLevel),
      languageLevel: decodeKotlinLevel(raw.kotlin.languageLevel),
      compilerOptions: co
        ? {
            apiVersion: decodeKotlinLevel(co.apiVersion),
            languageVersion: decodeKotlinLevel(co.languageVersion),
            freeCompilerArgs: strings(co.freeCompilerArgs),
          }
        : undefined,
    };
  }

  const engines: Record<string, string> = {};
  if (isObject(raw.toolchain) && isObject(raw.toolchain.engines)) {
    for (const [k, v] of Object.entries(raw.toolchain.engines)) {
      const e = decodeEngine(v);
      if (e !== undefined) engines[k] = e;
    }
  }

  const maven = isObject(raw.dependencies) && isObject(raw.dependencies.maven) ? raw.dependencies.maven : undefined;

  return {
    name: typeof raw.name === "string" ? raw.name : undefined,
    version: typeof raw.version === "string" ? raw.version : undefined,
    entrypoint: strings(raw.entrypoint),
    scripts: stringMap(raw.scripts),
    jvm,
    kotlin,
    sources,
    dependencies: {
      maven: maven ? { localRepository: typeof maven.localRepository === "string" ? maven.localRepository : undefined } : undefined,
    },
    toolchain: { engines },
  };
}
