import { existsSync } from "node:fs";
import path from "node:path";
import { androidPlatformApiLevel, androidRClassesArtifact, explodedAndroidLibrary } from "./android.js";
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
  /**
   * Maven coordinate the entry resolved from, when its path names one.
   *
   * Two entries carrying the same coordinate are the same library however they reach a classpath: a published
   * `.aar` is exploded once per project, so a workspace with two Android projects holds two copies of one archive.
   */
  coordinate?: string;
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

/**
 * Build a library from a classpath entry, attaching sibling `-sources.jar` / `-javadoc.jar` when present.
 *
 * A published `.aar` reaches a classpath as the `classes.jar` of the directory the build exploded it into, which
 * carries neither the archive's name nor anything beside it. It is therefore named from the coordinate its path
 * spells out, and its sources and javadoc are looked up in the Maven repository the archive itself came from.
 *
 * The two entries an Android build provides — the platform jar and the compiled `R` classes — are named from what
 * they are: neither carries a coordinate, and `android.jar` and `r-classes` say nothing on their own.
 */
export function libraryFor(entry: string, librariesRoot?: string, exists: (p: string) => boolean = existsSync): LibraryModel {
  const classes = path.resolve(entry);
  const apiLevel = androidPlatformApiLevel(classes);
  if (apiLevel) return { name: `${LIBRARY_NAME_PREFIX}Android API ${apiLevel} platform`, classes };
  const rClasses = androidRClassesArtifact(classes);
  if (rClasses) return { name: `${LIBRARY_NAME_PREFIX}Android resources of ${rClasses}`, classes };
  const exploded = explodedAndroidLibrary(classes);
  if (exploded) {
    const { group, artifact, version, coordinate } = exploded;
    const repository = path.resolve(exploded.root, librariesRoot ?? DEFAULT_LIBRARIES_ROOT);
    const stem = path.join(repository, ...group.split("."), artifact, version, `${artifact}-${version}`);
    const lib: LibraryModel = { name: `${LIBRARY_NAME_PREFIX}${coordinate}`, classes, coordinate };
    if (exists(`${stem}-sources.jar`)) lib.sources = `${stem}-sources.jar`;
    if (exists(`${stem}-javadoc.jar`)) lib.javadoc = `${stem}-javadoc.jar`;
    return lib;
  }
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
