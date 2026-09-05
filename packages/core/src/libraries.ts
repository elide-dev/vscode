import { existsSync } from "node:fs";
import path from "node:path";
import { normalizePath } from "./sourceRoots.js";

export const DEFAULT_LIBRARIES_ROOT = ".dev/dependencies/m2/";
export const LIBRARY_NAME_PREFIX = "Elide: ";

export interface LibraryModel {
  /** Unique display name, `Elide: group:artifact:version` when the jar sits in a Maven repository layout. */
  name: string;
  /** Absolute path to the classes jar (or directory). */
  classes: string;
  sources?: string;
  javadoc?: string;
}

/**
 * Maven-style name for a classpath entry laid out as `{root}/group/artifact/version/artifact-version.jar`.
 * The repository marker is located anywhere in the entry (the CLI prints absolute paths).
 */
export function parseLibraryName(entry: string, librariesRoot: string = DEFAULT_LIBRARIES_ROOT): string {
  const normalized = normalizePath(entry);
  const markers = [...new Set([librariesRoot.replace(/\\/g, "/").replace(/\/?$/, "/"), DEFAULT_LIBRARIES_ROOT])];
  let local: string | undefined;
  for (const marker of markers) {
    const idx = normalized.indexOf(marker);
    if (idx >= 0) {
      local = normalized.slice(idx + marker.length);
      break;
    }
  }
  if (local === undefined) return fallbackLibraryName(normalized);
  const fileSlash = local.lastIndexOf("/");
  if (fileSlash < 0) return fallbackLibraryName(normalized);
  local = local.slice(0, fileSlash);

  const versionIndex = local.lastIndexOf("/");
  if (versionIndex <= 0) return fallbackLibraryName(normalized);
  const artifactIndex = local.lastIndexOf("/", versionIndex - 1);
  if (artifactIndex < 0 || artifactIndex >= versionIndex - 1) return fallbackLibraryName(normalized);

  const group = local.slice(0, artifactIndex);
  const artifact = local.slice(artifactIndex + 1, versionIndex);
  const version = local.slice(versionIndex + 1);
  if (!group || !artifact || !version) return fallbackLibraryName(normalized);
  return `${LIBRARY_NAME_PREFIX}${group.replace(/\//g, ".")}:${artifact}:${version}`;
}

export function fallbackLibraryName(entry: string): string {
  const file = normalizePath(entry).split("/").pop() ?? "";
  const stem = file.replace(/\.jar$/i, "");
  return `${LIBRARY_NAME_PREFIX}${stem.length > 0 ? stem : "library"}`;
}

/** Build a library from a classpath entry, attaching sibling `-sources.jar` / `-javadoc.jar` when present. */
export function libraryFor(entry: string, librariesRoot?: string, exists: (p: string) => boolean = existsSync): LibraryModel {
  const classes = path.resolve(entry);
  const lib: LibraryModel = { name: parseLibraryName(classes, librariesRoot), classes };
  if (/\.jar$/i.test(classes)) {
    const stem = classes.slice(0, -4);
    const sources = `${stem}-sources.jar`;
    const javadoc = `${stem}-javadoc.jar`;
    if (exists(sources)) lib.sources = sources;
    if (exists(javadoc)) lib.javadoc = javadoc;
  }
  return lib;
}
