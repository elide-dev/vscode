import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { androidPlatformApiLevel, androidRClasses, androidRTask, explodedAndroidLibrary } from "./android.js";
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
  const archives = new Map<string, string>();
  const selected = new Map<string, { directory: string; root: string }>();
  const runtimeEntries = modules.flatMap(({ module }) => module.runtimeClassPath!);
  for (const entry of runtimeEntries) {
    if (path.basename(entry) !== "classes.jar") continue;
    const aar = explodedAndroidLibrary(entry);
    if (!aar) continue;
    const identity = `${aar.group}:${aar.artifact}`;
    const directory = path.dirname(entry);
    archives.set(directory, identity);
    // The consumer's resolved copy wins even when the CLI lists a sibling's entry first.
    if (!selected.has(identity) || aar.root === model.root) selected.set(identity, { directory, root: aar.root });
  }
  for (const entry of runtimeEntries) {
    if (androidPlatformApiLevel(entry)) continue;
    let canonical = entry;
    let embedded = false;
    if (explodedAndroidLibrary(entry)) {
      for (let directory = path.dirname(entry); directory !== path.dirname(directory); directory = path.dirname(directory)) {
        const identity = archives.get(directory);
        if (!identity) continue;
        const member = path.relative(directory, entry);
        canonical = path.join(selected.get(identity)!.directory, member);
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

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
