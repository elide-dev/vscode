import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ProjectModel, SourceRootKind } from "./model.js";
import { isPathUnder, normalizePath } from "./sourceRoots.js";

/**
 * Wire format of the Kotlin LSP JSON workspace importer
 * (`com.jetbrains.ls.imports.json.WorkspaceData` in kotlin-lsp's `workspace-import/src/.../json/model.kt`).
 *
 * kotlinx.serialization decodes it strictly: unknown keys are rejected and fields without defaults are required, so
 * every type here spells the exact key set. The key set is pinned to the installed server generation (263.x, extracted
 * from `language-server.workspace-import.jar`'s `$$serializer` classes): newer upstream fields such as
 * `WorkspaceData.externalSystem` are deliberately not emitted. Paths may be absolute or prefixed with `<WORKSPACE>/`
 * (resolved against the workspace folder) or `<HOME>/` (against the user home).
 */
export interface KotlinLspWorkspace {
  modules: KotlinLspModule[];
  libraries: KotlinLspLibrary[];
  sdks: KotlinLspSdk[];
  kotlinSettings: KotlinLspKotlinSettings[];
  javaSettings: never[];
}

export interface KotlinLspModule {
  name: string;
  type: "JAVA_MODULE";
  dependencies: KotlinLspDependency[];
  contentRoots: KotlinLspContentRoot[];
  facets: never[];
}

export type KotlinLspScope = "compile" | "test" | "runtime" | "provided";

export type KotlinLspDependency =
  | { type: "moduleSource" }
  | { type: "inheritedSdk" }
  | { type: "sdk"; name: string; kind: string }
  | { type: "library"; name: string; scope: KotlinLspScope; isExported: boolean }
  | { type: "module"; name: string; scope: KotlinLspScope; isExported: boolean; isTestJar: boolean };

export type KotlinLspSourceRootType = "java-source" | "java-test" | "java-resource" | "java-test-resource";

export interface KotlinLspContentRoot {
  path: string;
  excludedPatterns: string[];
  excludedUrls: string[];
  sourceRoots: { path: string; type: KotlinLspSourceRootType }[];
}

export interface KotlinLspLibrary {
  name: string;
  level: "project";
  type: null;
  roots: { path: string; type: "CLASSES" | "SOURCES" | "JAVADOC"; inclusionOptions: "root_itself" }[];
}

export interface KotlinLspSdk {
  name: string;
  type: "JavaSDK";
  version: string;
  homePath: string;
  additionalData: "";
}

export interface KotlinLspKotlinSettings {
  name: "Kotlin";
  sourceRoots: string[];
  configFileItems: never[];
  module: string;
  useProjectSettings: boolean;
  implementedModuleNames: string[];
  dependsOnModuleNames: string[];
  additionalVisibleModuleNames: string[];
  productionOutputPath: null;
  testOutputPath: null;
  sourceSetNames: string[];
  isTestModule: boolean;
  externalProjectId: string;
  isHmppEnabled: boolean;
  pureKotlinSourceFolders: string[];
  kind: "default";
  compilerArguments: null;
  additionalArguments: string | null;
  scriptTemplates: null;
  scriptTemplatesClasspath: null;
  copyJsLibraryFiles: boolean;
  outputDirectoryForJsLibraryFiles: null;
  targetPlatform: null;
  externalSystemRunTasks: never[];
  version: 5;
  flushNeeded: boolean;
}

export const WORKSPACE_JSON = "workspace.json";
const WORKSPACE_PREFIX = "<WORKSPACE>/";
const HOME_PREFIX = "<HOME>/";

const SOURCE_ROOT_TYPES: Record<SourceRootKind, KotlinLspSourceRootType> = {
  source: "java-source",
  test: "java-test",
  resource: "java-resource",
  "test-resource": "java-test-resource",
};

export interface EmitOptions {
  /** Workspace folder the LSP is rooted at; paths beneath it are written as `<WORKSPACE>/…`. */
  workspaceRoot: string;
  /** User home; paths beneath it are written as `<HOME>/…`. Defaults to `os.homedir()`. */
  userHome?: string;
}

/** Portable spelling of an absolute path, mirroring kotlin-lsp's `toRelativePath`. */
export function portablePath(absolute: string, opts: EmitOptions): string {
  const p = normalizePath(path.resolve(absolute));
  const ws = normalizePath(path.resolve(opts.workspaceRoot));
  if (isPathUnder(p, ws)) return p === ws ? WORKSPACE_PREFIX.slice(0, -1) : WORKSPACE_PREFIX + p.slice(ws.length + 1);
  const home = normalizePath(path.resolve(opts.userHome ?? homedir()));
  if (isPathUnder(p, home) && p !== home) return HOME_PREFIX + p.slice(home.length + 1);
  return p;
}

/** kotlinc flags for a module: language/API level, JVM target, then the manifest's free compiler args. */
export function kotlinAdditionalArguments(kotlin: ProjectModel["kotlin"]): string | null {
  const args: string[] = [];
  if (kotlin.languageVersion) args.push("-language-version", kotlin.languageVersion);
  if (kotlin.apiVersion) args.push("-api-version", kotlin.apiVersion);
  if (kotlin.jvmTarget) args.push("-jvm-target", kotlin.jvmTarget);
  args.push(...kotlin.freeCompilerArgs);
  return args.length > 0 ? args.join(" ") : null;
}

/**
 * Build the Kotlin LSP workspace for one or more Elide projects living under `opts.workspaceRoot`.
 *
 * Module names are unique across projects: when two projects share a name, the module names of the later ones are
 * suffixed with the project's workspace-relative path.
 */
export function emitKotlinLspWorkspace(models: readonly ProjectModel[], opts: EmitOptions): KotlinLspWorkspace {
  const modules: KotlinLspModule[] = [];
  const libraries = new Map<string, KotlinLspLibrary>();
  const sdks = new Map<string, KotlinLspSdk>();
  const kotlinSettings: KotlinLspKotlinSettings[] = [];
  const takenModuleNames = new Set<string>();

  for (const model of models) {
    const sdk = model.jdk ? sdkFor(model, opts) : undefined;
    if (sdk) sdks.set(sdk.name, sdk);

    for (const lib of model.libraries) {
      if (libraries.has(lib.name)) continue;
      const roots: KotlinLspLibrary["roots"] = [{ path: portablePath(lib.classes, opts), type: "CLASSES", inclusionOptions: "root_itself" }];
      if (lib.sources) roots.push({ path: portablePath(lib.sources, opts), type: "SOURCES", inclusionOptions: "root_itself" });
      if (lib.javadoc) roots.push({ path: portablePath(lib.javadoc, opts), type: "JAVADOC", inclusionOptions: "root_itself" });
      libraries.set(lib.name, { name: lib.name, level: "project", type: null, roots });
    }

    const rename = moduleRenamer(model, opts, takenModuleNames);
    for (const m of model.modules) {
      const name = rename(m.name);
      const dependencies: KotlinLspDependency[] = [
        sdk ? { type: "sdk", name: sdk.name, kind: sdk.type } : { type: "inheritedSdk" },
        { type: "moduleSource" },
        ...m.moduleDeps.map((dep): KotlinLspDependency => ({ type: "module", name: rename(dep), scope: "compile", isExported: false, isTestJar: false })),
        ...m.libraries.map((l): KotlinLspDependency => ({ type: "library", name: l.name, scope: l.scope, isExported: false })),
      ];
      modules.push({
        name,
        type: "JAVA_MODULE",
        dependencies,
        contentRoots: m.contentRoots.map((cr) => ({
          path: portablePath(cr.path, opts),
          excludedPatterns: [...cr.excludedPatterns],
          excludedUrls: [],
          sourceRoots: cr.sourceRoots.map((sr) => ({ path: portablePath(sr.path, opts), type: SOURCE_ROOT_TYPES[sr.kind] })),
        })),
        facets: [],
      });
      kotlinSettings.push({
        name: "Kotlin",
        sourceRoots: m.contentRoots.flatMap((cr) => cr.sourceRoots.filter((sr) => sr.kind === "source" || sr.kind === "test").map((sr) => portablePath(sr.path, opts))),
        configFileItems: [],
        module: name,
        useProjectSettings: false,
        implementedModuleNames: [],
        dependsOnModuleNames: [],
        additionalVisibleModuleNames: [],
        productionOutputPath: null,
        testOutputPath: null,
        sourceSetNames: [],
        isTestModule: m.kind === "test",
        externalProjectId: "",
        isHmppEnabled: false,
        pureKotlinSourceFolders: [],
        kind: "default",
        compilerArguments: null,
        additionalArguments: kotlinAdditionalArguments(model.kotlin),
        scriptTemplates: null,
        scriptTemplatesClasspath: null,
        copyJsLibraryFiles: false,
        outputDirectoryForJsLibraryFiles: null,
        targetPlatform: null,
        externalSystemRunTasks: [],
        version: 5,
        flushNeeded: false,
      });
    }
  }

  return {
    modules,
    libraries: [...libraries.values()],
    sdks: [...sdks.values()],
    kotlinSettings,
    javaSettings: [],
  };
}

function sdkFor(model: ProjectModel, opts: EmitOptions): KotlinLspSdk | undefined {
  if (!model.jdk) return undefined;
  return {
    name: `Elide JDK ${model.jdk.version}`,
    type: "JavaSDK",
    version: model.jdk.version,
    homePath: portablePath(model.jdk.home, opts),
    additionalData: "",
  };
}

/** Maps a project's module names to workspace-unique names (suffixing the project's relative path on collision). */
function moduleRenamer(model: ProjectModel, opts: EmitOptions, taken: Set<string>): (name: string) => string {
  const rel = normalizePath(path.relative(opts.workspaceRoot, model.root)).replace(/^\.\.?$/, "");
  const needsSuffix = model.modules.some((m) => taken.has(m.name));
  const mapping: Record<string, string> = {};
  for (const m of model.modules) {
    const unique = needsSuffix && rel ? `${m.name} (${rel})` : m.name;
    mapping[m.name] = unique;
    taken.add(unique);
  }
  return (name) => mapping[name] ?? name;
}

/** Serialize with stable formatting. */
export function serializeKotlinLspWorkspace(workspace: KotlinLspWorkspace): string {
  return `${JSON.stringify(workspace, null, 2)}\n`;
}

/** Atomically write `workspace.json` (temp file + rename) so a failed write never leaves a truncated file. */
export async function writeKotlinLspWorkspace(models: readonly ProjectModel[], workspaceRoot: string, outFile: string = path.join(workspaceRoot, WORKSPACE_JSON)): Promise<KotlinLspWorkspace> {
  const workspace = emitKotlinLspWorkspace(models, { workspaceRoot });
  await mkdir(path.dirname(outFile), { recursive: true });
  const tmp = `${outFile}.${process.pid}.tmp`;
  await writeFile(tmp, serializeKotlinLspWorkspace(workspace), "utf8");
  await rename(tmp, outFile);
  return workspace;
}
