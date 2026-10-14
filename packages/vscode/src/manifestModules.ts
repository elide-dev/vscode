import path from "node:path";
import { MANIFEST_NAME, OUTPUT_DIR, importedModules } from "@elide/ide-core";

/** What {@link projectModules} needs to know of a tracked project. */
export interface ModuleReader {
  root: string;
  manifestPath: string;
  workspaceRoot?: string;
}

/**
 * The local Pkl modules the manifests of each project read, keyed by project root. A workspace root reads its
 * members' manifests as well, as its sync does. Manifests are left out, the manifest watcher covers those, and so is
 * anything under `.dev`.
 */
export async function projectModules(projects: readonly ModuleReader[]): Promise<Map<string, string[]>> {
  const modules = new Map<string, string[]>();
  for (const project of projects) {
    const members = project.workspaceRoot ? [] : projects.filter((p) => p.workspaceRoot === project.root);
    const read = await importedModules([project.manifestPath, ...members.map((m) => m.manifestPath)]);
    modules.set(project.root, read.filter((m) => path.basename(m) !== MANIFEST_NAME && !m.split(path.sep).includes(OUTPUT_DIR)));
  }
  return modules;
}

/** Every module in `projects`' {@link projectModules} result, with the distinct folders of the projects reading it. */
export function moduleReaders<F>(projects: Iterable<{ folder: F; modules?: readonly string[] }>): Map<string, F[]> {
  const readers = new Map<string, F[]>();
  for (const project of projects) {
    for (const module of project.modules ?? []) {
      const folders = readers.get(module);
      if (!folders) readers.set(module, [project.folder]);
      else if (!folders.includes(project.folder)) folders.push(project.folder);
    }
  }
  return readers;
}
