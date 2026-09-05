import path from "node:path";
import { ElideCli, isLockfileCurrent } from "./elide.js";
import { resolveJdk, type Jdk, type ResolveJdkOptions } from "./jdk.js";
import { DEFAULT_LIBRARIES_ROOT, libraryFor, type LibraryModel } from "./libraries.js";
import { effectiveType, type Manifest, type SourceSetType } from "./manifest.js";
import { collectContentRoots, isPathUnder, normalizePath } from "./sourceRoots.js";

export type { LibraryModel } from "./libraries.js";

export type SourceRootKind = "source" | "test" | "resource" | "test-resource";
export type DependencyScope = "compile" | "test";

export interface ContentRootModel {
  path: string;
  sourceRoots: { path: string; kind: SourceRootKind }[];
  /** Directory names excluded beneath this root (only set when the root is the project root itself). */
  excludedPatterns: string[];
}

export interface ModuleModel {
  /** `${projectName}.${sourceSet}`. */
  name: string;
  sourceSet: string;
  kind: Exclude<SourceSetType, "other">;
  contentRoots: ContentRootModel[];
  libraries: { name: string; scope: DependencyScope }[];
  /** Names of modules this module depends on. */
  moduleDeps: string[];
}

export type Entrypoint =
  | { kind: "jvmMain"; value: string }
  | { kind: "script"; value: string }
  | { kind: "generic"; value: string };

export interface ProjectModel {
  root: string;
  name: string;
  elideVersion: string;
  jdk?: Jdk;
  kotlin: { languageVersion?: string; apiVersion?: string; freeCompilerArgs: string[]; jvmTarget?: string };
  modules: ModuleModel[];
  libraries: LibraryModel[];
  entrypoints: Entrypoint[];
  warnings: string[];
}

export interface BuildModelOptions {
  onProgress?: (step: string) => void;
  onLine?: (line: string, stderr: boolean) => void;
  signal?: AbortSignal;
  /** Skip `elide install` even when the lockfile is stale. */
  skipInstall?: boolean;
  jdk?: ResolveJdkOptions;
  exists?: (p: string) => boolean;
}

const EXCLUDED_AT_ROOT = [".dev", "node_modules", ".git"];

/** Resolve the project model of the Elide project the CLI points at. */
export async function buildProjectModel(cli: ElideCli, manifest: Manifest, opts: BuildModelOptions = {}): Promise<ProjectModel> {
  const root = normalizePath(path.resolve(cli.projectRoot));
  const name = manifest.name ?? path.basename(root);
  const warnings: string[] = [];
  const run = { onLine: opts.onLine, signal: opts.signal };

  opts.onProgress?.("Querying Elide version");
  const elideVersion = await cli.version(run);

  if (!opts.skipInstall && !(await isLockfileCurrent(cli.projectRoot))) {
    opts.onProgress?.("Installing dependencies");
    await cli.install(run);
  }

  const librariesRoot = manifest.dependencies.maven?.localRepository ?? DEFAULT_LIBRARIES_ROOT;
  const libraries = new Map<string, LibraryModel>();
  const usedNames = new Set<string>();
  const libraryNameFor = (entry: string): string => {
    const abs = normalizePath(path.resolve(cli.projectRoot, entry));
    const existing = libraries.get(abs);
    if (existing) return existing.name;
    const lib = libraryFor(abs, librariesRoot, opts.exists);
    let candidate = lib.name;
    for (let i = 2; usedNames.has(candidate); i++) candidate = `${lib.name} (${i})`;
    lib.name = candidate;
    usedNames.add(candidate);
    libraries.set(abs, lib);
    return candidate;
  };

  const sets = Object.entries(manifest.sources)
    .map(([setName, set]) => ({ setName, set, kind: effectiveType(setName, set) }))
    .filter((s): s is typeof s & { kind: Exclude<SourceSetType, "other"> } => s.kind !== "other");

  const modules: ModuleModel[] = [];
  const compileLibs = new Map<string, string[]>();
  for (const { setName, set, kind } of sets) {
    opts.onProgress?.(`Resolving classpath: ${setName}`);
    const entries = await cli.classpath(setName, "compile", run);
    const names = [...new Set(entries.map(libraryNameFor))];
    compileLibs.set(setName, names);

    const sourceKind: SourceRootKind = kind === "test" ? "test" : "source";
    const resourceKind: SourceRootKind = kind === "test" ? "test-resource" : "resource";
    const contentRoots: ContentRootModel[] = [];
    for (const [crPath, folders] of collectContentRoots(cli.projectRoot, set.paths)) {
      contentRoots.push({
        path: crPath,
        sourceRoots: folders.map((f) => ({ path: f, kind: sourceKind })),
        excludedPatterns: crPath === root ? [...EXCLUDED_AT_ROOT] : [],
      });
    }
    for (const [resRoot, folders] of collectContentRoots(cli.projectRoot, Object.values(set.resources))) {
      // resources may live outside every source content root, in which case they get one of their own
      let owner: ContentRootModel | undefined;
      for (const cr of contentRoots) {
        if (isPathUnder(resRoot, cr.path) && (owner === undefined || cr.path.length > owner.path.length)) owner = cr;
      }
      if (!owner) {
        owner = { path: resRoot, sourceRoots: [], excludedPatterns: resRoot === root ? [...EXCLUDED_AT_ROOT] : [] };
        contentRoots.push(owner);
      }
      for (const f of folders) owner.sourceRoots.push({ path: f, kind: resourceKind });
    }

    modules.push({
      name: `${name}.${setName}`,
      sourceSet: setName,
      kind,
      contentRoots,
      libraries: names.map((n) => ({ name: n, scope: kind === "test" ? "test" : "compile" })),
      moduleDeps: [],
    });
  }

  splitSharedContentRoots(modules);

  const byName = new Map(modules.map((m) => [m.sourceSet, m]));
  const sourceModules = modules.filter((m) => m.kind === "source");
  for (const m of modules) {
    const deps = new Set<string>();
    if (m.kind === "test") {
      // `elide classpath test:compile` yields only test-scoped jars: test modules see main modules and their libraries
      for (const main of sourceModules) {
        deps.add(main.name);
        for (const libName of compileLibs.get(main.sourceSet) ?? []) {
          if (!m.libraries.some((l) => l.name === libName)) m.libraries.push({ name: libName, scope: "compile" });
        }
      }
    }
    for (const depSet of manifest.sources[m.sourceSet]?.dependsOn ?? []) {
      const target = byName.get(depSet);
      if (target && target !== m) deps.add(target.name);
    }
    m.moduleDeps = [...deps];
  }

  if (![...libraries.keys()].some((p) => /kotlin-stdlib/.test(p))) {
    warnings.push("Compile classpath contains no kotlin-stdlib jar; Kotlin symbol resolution may be incomplete.");
  }

  const ko = manifest.kotlin?.compilerOptions;
  const lang = ko?.languageVersion ?? manifest.kotlin?.languageLevel;
  const api = ko?.apiVersion ?? manifest.kotlin?.apiLevel;
  const target = manifest.jvm?.target;
  const kotlin: ProjectModel["kotlin"] = {
    languageVersion: lang?.kind === "version" ? lang.value : undefined,
    apiVersion: api?.kind === "version" ? api.value : undefined,
    freeCompilerArgs: ko?.freeCompilerArgs ?? [],
    jvmTarget: target?.kind === "version" ? (target.major === 8 ? "1.8" : String(target.major)) : undefined,
  };

  const entrypoints: Entrypoint[] = manifest.entrypoint.map((value) => ({ kind: "generic", value }));
  if (entrypoints.length === 0 && manifest.jvm?.main) entrypoints.push({ kind: "jvmMain", value: manifest.jvm.main });
  for (const script of Object.keys(manifest.scripts)) entrypoints.push({ kind: "script", value: script });

  opts.onProgress?.("Resolving JDK");
  const jdk = await resolveJdk(manifest, cli.dist, opts.jdk);
  if (!jdk) warnings.push("No JDK found for symbol resolution; set `elide.jdk.home` or `JAVA_HOME`.");

  return { root, name, elideVersion, jdk, kotlin, modules, libraries: [...libraries.values()], entrypoints, warnings };
}

/**
 * A directory can be the content root of only one module. When the parent-directory grouping gives two modules the
 * same content root (e.g. `src/main/**` and `src/test/**` both grouping under `src`), each such module instead gets
 * one content root per source folder, with folders nested under another of the module's folders kept inside it.
 */
export function splitSharedContentRoots(modules: ModuleModel[]): void {
  const owners = new Map<string, number>();
  for (const m of modules) for (const cr of m.contentRoots) owners.set(cr.path, (owners.get(cr.path) ?? 0) + 1);
  for (const m of modules) {
    const shared = m.contentRoots.filter((cr) => (owners.get(cr.path) ?? 0) > 1);
    if (shared.length === 0) continue;
    const kept = m.contentRoots.filter((cr) => (owners.get(cr.path) ?? 0) <= 1);
    for (const cr of shared) {
      const folders = [...new Set(cr.sourceRoots.map((sr) => sr.path))];
      const outer = folders.filter((f) => !folders.some((o) => o !== f && isPathUnder(f, o)));
      for (const root of outer) {
        kept.push({
          path: root,
          sourceRoots: cr.sourceRoots.filter((sr) => isPathUnder(sr.path, root)),
          excludedPatterns: [],
        });
      }
    }
    m.contentRoots = kept;
  }
}
