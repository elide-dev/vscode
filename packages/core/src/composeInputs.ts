import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { androidPlatformApiLevel, androidRClasses, androidRTask, explodedAndroidLibrary } from "./android.js";
import { DEFAULT_LIBRARIES_ROOT } from "./libraries.js";
import { compareMavenVersions } from "./mavenVersion.js";
import { normalizePath, sourceSelection } from "./sourceRoots.js";
import { OUTPUT_DIR } from "./elide.js";
import type { AndroidTargetModel, ModuleModel, ProjectModel } from "./model.js";
import { ANDROID_STAGE_DIR } from "./workspace.js";

export interface ComposePreviewInputs {
  /** Complete execution classpath; Android framework implementations come from layoutlib, never SDK stubs. */
  classPath: string[];
  /** Original workspace class directories for bytecode-based preview discovery. */
  projectClassPath: string[];
  /** Original output directory → owning source set's manifest selectors, relative to its project. */
  sourceSelections: Record<string, string[]>;
  namespace: string;
  resourceApkPath: string;
  buildTargets: string[];
}

type PreviewModule = { project: ProjectModel; module: ModuleModel };

/** Runtime closure in consumer-first order, keeping provided-only and test dependencies out. */
function previewModules(model: ProjectModel, target: AndroidTargetModel, models: readonly ProjectModel[]): PreviewModule[] {
  if (!target.sourceSets) throw new Error("Sync the Elide project before opening Compose preview: artifact source sets are unavailable.");
  const projects = new Map(models.map((project) => [project.root, project]));
  projects.set(model.root, model);
  const queue: PreviewModule[] = model.modules
    .filter((module) => target.sourceSets!.includes(module.sourceSet) && module.kind !== "test")
    .map((module) => ({ project: model, module }));
  const result: PreviewModule[] = [];
  const seen = new Set<ModuleModel>();
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!;
    if (seen.has(current.module)) continue;
    seen.add(current.module);
    if (!current.module.compilationTargets || !current.module.runtimeClassPath || !current.module.runtimeModuleDeps) {
      throw new Error(`Sync the Elide project before opening Compose preview: runtime inputs for ${current.module.name} are unavailable.`);
    }
    result.push(current);
    for (const dependency of current.module.runtimeModuleDeps) {
      if (dependency.scope === "test") continue;
      const project = projects.get(dependency.project);
      const module = project?.modules.find((candidate) => candidate.name === dependency.module);
      if (!project || !module) throw new Error(`Compose preview cannot resolve workspace module ${dependency.module}; sync the whole workspace.`);
      if (module.kind !== "test") queue.push({ project, module });
    }
  }
  return result;
}

/** Build only resource identifiers/linking and JVM compiles; no APK, dex, signing, device or install targets. */
export function composePreviewBuildTargets(model: ProjectModel, target: AndroidTargetModel, models: readonly ProjectModel[]): string[] {
  const modules = previewModules(model, target, models);
  const scope = model.workspaceRoot || model.members.length > 0 ? `${model.name}:` : "";
  return [...new Set([`${scope}${androidRTask(target.name)}`, ...modules.flatMap(({ module }) => module.compilationTargets!)])];
}

/**
 * Android applications that can supply the resource context for previews of `file`: those whose preview closure
 * (packaged source sets and their workspace runtime dependencies) compiles it. The nearest consumer comes first, by
 * dependency distance, then by workspace and artifact declaration order.
 */
export function composePreviewApplications(file: string, models: readonly ProjectModel[]): { model: ProjectModel; target: AndroidTargetModel }[] {
  const owners = new Set(models.flatMap((project) => project.modules.filter((module) => module.kind !== "test"
    && module.sourcePaths?.some((pattern) => sourceSelection(project.root, pattern).matches(file)))));
  if (!owners.size) return [];
  const projects = new Map(models.map((project) => [project.root, project]));
  const ranked: { model: ProjectModel; target: AndroidTargetModel; distance: number }[] = [];
  for (const model of models) {
    for (const target of model.android?.targets ?? []) {
      if (target.kind !== "apk" || !target.sourceSets) continue;
      let level = model.modules.filter((module) => module.kind !== "test" && target.sourceSets!.includes(module.sourceSet));
      const seen = new Set(level);
      for (let distance = 0; level.length; distance++) {
        if (level.some((module) => owners.has(module))) {
          ranked.push({ model, target, distance });
          break;
        }
        level = level.flatMap((module) => (module.runtimeModuleDeps ?? []).flatMap((dependency) => {
          const next = dependency.scope === "test" ? undefined : projects.get(dependency.project)?.modules.find((candidate) => candidate.name === dependency.module);
          if (!next || next.kind === "test" || seen.has(next)) return [];
          seen.add(next);
          return [next];
        }));
      }
    }
  }
  return ranked.sort((a, b) => a.distance - b.distance).map(({ model, target }) => ({ model, target }));
}

/** Resolve fresh outputs after composePreviewBuildTargets has completed, rather than caching prebuild directories. */
export async function composePreviewInputs(model: ProjectModel, target: AndroidTargetModel, models: readonly ProjectModel[]): Promise<ComposePreviewInputs> {
  const modules = previewModules(model, target, models);
  const stage = path.join(model.root, OUTPUT_DIR, ANDROID_STAGE_DIR, target.name);
  const manifestFile = path.join(stage, "AndroidManifest.xml");
  const manifest = await readFile(manifestFile, "utf8");
  const root = /<manifest\b((?:[^\"'<>]|\"[^\"]*\"|'[^']*')*)>/.exec(manifest.replace(/<!--[\s\S]*?-->/g, ""));
  const attributes = root?.[1]?.matchAll(/([^\s=]+)\s*=\s*(?:\"([^\"]*)\"|'([^']*)')/g);
  let namespace: string | undefined;
  for (const attribute of attributes ?? []) {
    if (attribute[1] === "package") namespace = attribute[2] ?? attribute[3];
  }
  if (!namespace) throw new Error(`Merged Android manifest has no package: ${manifestFile}`);
  const resourceApkPath = path.join(stage, "resources.apk");
  if (!(await stat(resourceApkPath)).isFile()) throw new Error(`Linked Android resources are not a file: ${resourceApkPath}`);
  const rClasses = androidRClasses(model.root, target.name);
  if (!(await stat(rClasses)).isDirectory()) throw new Error(`Compiled Android resource identifiers are not a directory: ${rClasses}`);

  const projectClassPath: string[] = [];
  const sourceSelections: Record<string, string[]> = {};
  for (const { project, module } of modules) {
    if (!module.sourcePaths) throw new Error(`Sync the Elide project before opening Compose preview: source selectors for ${module.name} are unavailable.`);
    for (const language of ["kotlin", "java"]) {
      const name = `compile-${language}-${module.sourceSet}`;
      if (!module.compilationTargets!.some((task) => task === name || task === `${project.name}:${name}`)) continue;
      const directory = path.join(project.root, OUTPUT_DIR, "jvm", "classes", module.sourceSet, language);
      if (await isDirectory(directory)) {
        projectClassPath.push(directory);
        sourceSelections[directory] = [...module.sourcePaths];
      }
    }
  }
  const classPath = new Set([rClasses, ...projectClassPath]);
  const runtimeEntries = modules.flatMap(({ module }) => module.runtimeClassPath!);
  // Each member resolves its own graph, so one library can arrive at several versions. Render what ships: Elide
  // dexes the newest, a tie going to the consumer's own copy, and never an empty stand-in without its provider.
  const libraries = runtimeEntries.flatMap((entry) => {
    const library = publishedLibrary(entry);
    return library ? [{ entry, ...library, own: library.root === model.root }] : [];
  });
  const shippedJars = new Set(libraries.filter((library) => !library.archive).map((library) => library.name));
  const candidates = Map.groupBy(libraries, (library) => library.identity);
  const selected = new Map<string, string>();
  for (const [identity, versions] of candidates) {
    const eligible = versions.filter((library) => {
      const provider = STAND_IN_VERSIONS[`${library.name}:${library.version}`];
      return !provider || shippedJars.has(provider);
    });
    const newest = (eligible.length ? eligible : versions).reduce((best, library) => {
      const relation = compareMavenVersions(library.version, best.version);
      return relation > 0 || (relation === 0 && library.own && !best.own) ? library : best;
    });
    selected.set(identity, newest.location);
  }
  const archives = new Map(libraries.filter((library) => library.archive).map((library) => [library.location, library.identity]));
  for (const entry of runtimeEntries) {
    if (androidPlatformApiLevel(entry)) continue;
    let canonical = entry;
    let embedded = false;
    const jar = publishedLibrary(entry);
    if (jar && !jar.archive) canonical = selected.get(jar.identity)!;
    else if (explodedAndroidLibrary(entry)) {
      for (let directory = path.dirname(entry); directory !== path.dirname(directory); directory = path.dirname(directory)) {
        const identity = archives.get(directory);
        if (!identity) continue;
        const member = path.relative(directory, entry);
        canonical = path.join(selected.get(identity)!, member);
        embedded = member !== "classes.jar";
        break;
      }
    }
    if (classPath.has(canonical)) continue;
    try {
      await stat(canonical);
    } catch (error) {
      // A jar removed from a selected newer AAR must not be resurrected from its older copy.
      if (embedded && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    classPath.add(canonical);
  }
  return { classPath: [...classPath], projectClassPath: [...new Set(projectClassPath)], sourceSelections, namespace, resourceApkPath, buildTargets: composePreviewBuildTargets(model, target, models) };
}

/**
 * Versions published to stand in for a library another artifact provides, mapped to that provider's
 * `group:artifact`. Guava's empty `listenablefuture` is only correct beside Guava itself.
 */
const STAND_IN_VERSIONS: Record<string, string> = {
  "com.google.guava:listenablefuture:9999.0-empty-to-avoid-conflict-with-guava": "com.google.guava:guava",
};

const REPOSITORY_MARKER = `/${DEFAULT_LIBRARIES_ROOT.replace(/\/$/, "")}/`;

/**
 * The published library a runtime entry is a version of: an exploded archive's `classes.jar` (located by its
 * directory) or a jar in the Maven repository layout, `<group…>/<artifact>/<version>/<artifact>-<version>[-<classifier>].jar`.
 */
function publishedLibrary(entry: string): { identity: string; name: string; version: string; location: string; root: string; archive: boolean } | undefined {
  const aar = path.basename(entry) === "classes.jar" ? explodedAndroidLibrary(entry) : undefined;
  if (aar) {
    const name = `${aar.group}:${aar.artifact}`;
    return { identity: `aar:${name}`, name, version: aar.version, location: path.dirname(entry), root: aar.root, archive: true };
  }
  const normalized = normalizePath(path.resolve(entry));
  const marker = normalized.lastIndexOf(REPOSITORY_MARKER);
  if (marker < 0) return undefined;
  const parts = normalized.slice(marker + REPOSITORY_MARKER.length).split("/");
  if (parts.length < 4) return undefined;
  const [artifact, version, file] = parts.slice(-3) as [string, string, string];
  const stem = `${artifact}-${version}`;
  const extension = path.extname(file);
  if (!file.startsWith(stem) || (file.length - extension.length > stem.length && file[stem.length] !== "-")) return undefined;
  const classifier = file.slice(stem.length + 1, file.length - extension.length);
  const name = `${parts.slice(0, -3).join(".")}:${artifact}`;
  return { identity: `jar:${name}:${classifier}${extension}`, name, version, location: entry, root: normalized.slice(0, marker), archive: false };
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
