import path from "node:path";
import { ElideCli, MANIFEST_NAME, isLockfileCurrent, type RunOptions } from "./elide.js";
import { resolveJdk, type Jdk, type ResolveJdkOptions } from "./jdk.js";
import { DEFAULT_LIBRARIES_ROOT, libraryFor, type LibraryModel } from "./libraries.js";
import { effectiveType, type Manifest, type SourceSetType } from "./manifest.js";
import { collectContentRoots, isPathUnder, normalizePath } from "./sourceRoots.js";
import { ArtifactIndex, artifactProjectRoot, projectName, referencedSourceSets, sourceSetsForArtifactOutput, type ArtifactOutput } from "./workspace.js";

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
  moduleDeps: ModuleDependency[];
}

/** A dependency of one module on another, possibly one of a sibling project of the same workspace. */
export interface ModuleDependency {
  /** Root of the project declaring the module depended on. */
  project: string;
  /** Name of the module depended on. */
  module: string;
  scope: DependencyScope;
  /** Whether the modules depending on this module see the dependency as well. */
  exported: boolean;
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
  /** Roots of the members this project declares, in declaration order; empty unless it is a workspace root. */
  members: string[];
  /** Root of the workspace this project is a member of; absent for a workspace root or a standalone project. */
  workspaceRoot?: string;
}

export interface BuildModelOptions {
  onProgress?: (step: string) => void;
  onLine?: (line: string, stderr: boolean) => void;
  signal?: AbortSignal;
  /** Skip `elide install` even when the lockfile is stale. */
  skipInstall?: boolean;
  /**
   * Exact classifier set for `elide install` (`sources`, `docs`). Omitted: the CLI default (sources and javadoc);
   * `[]`: classes only.
   */
  installWith?: readonly string[];
  /** Run `elide install` even when the lockfile is current, e.g. after the requested classifiers changed. */
  forceInstall?: boolean;
  jdk?: ResolveJdkOptions;
  exists?: (p: string) => boolean;
}

const EXCLUDED_AT_ROOT = [".dev", "node_modules", ".git"];

/** One project a model is built for: where it is, the CLI focused on it, and its decoded manifest. */
interface ProjectSpec {
  name: string;
  root: string;
  cli: ElideCli;
  manifest: Manifest;
}

/** What the models of one workspace share while they are built. */
interface BuildContext {
  opts: BuildModelOptions;
  run: RunOptions;
  elideVersion: string;
  libraries: LibraryRegistry;
  artifacts: ArtifactIndex;
}

/**
 * Resolve the models of the Elide project the CLI points at and of the workspace members its manifest declares:
 * the project first, then the members in declaration order. A standalone project is a workspace of one.
 *
 * A workspace resolves and builds as one graph from its root: one `elide install` there covers every member, into
 * the root's repository. Each member's classpath is then resolved by the CLI focused on that member — invoked in its
 * directory — which is the member's own classpath within the workspace. A sibling's JAR on it becomes a dependency
 * on the modules packaged into that JAR, since those are what an editor can compile against and navigate into.
 */
export async function buildProjectModels(cli: ElideCli, manifest: Manifest, opts: BuildModelOptions = {}): Promise<ProjectModel[]> {
  const root = normalizePath(path.resolve(cli.projectRoot));
  const run: RunOptions = { onLine: opts.onLine, signal: opts.signal };

  opts.onProgress?.("Querying Elide version");
  const elideVersion = await cli.version(run);

  // `elide manifest` has already validated the member list at the root: every entry is a directory below it holding
  // a manifest, and no two members share a name.
  const projects: ProjectSpec[] = [{ name: projectName(manifest, root), root, cli, manifest }];
  for (const entry of manifest.workspaceMembers) {
    const memberRoot = normalizePath(path.resolve(root, entry));
    opts.onProgress?.(`Reading member manifest: ${entry}`);
    const memberCli = new ElideCli(cli.dist, memberRoot, cli.flags);
    const memberManifest = await memberCli.manifest(run);
    projects.push({ name: projectName(memberManifest, memberRoot), root: memberRoot, cli: memberCli, manifest: memberManifest });
  }

  const manifests = projects.map((p) => path.join(p.root, MANIFEST_NAME));
  if (!opts.skipInstall && (opts.forceInstall || !(await isLockfileCurrent(root, manifests)))) {
    opts.onProgress?.("Installing dependencies");
    await cli.install({ ...run, with: opts.installWith });
  }

  // Members resolve into the root's repository, so the layout library names are read against is the root's.
  const ctx: BuildContext = {
    opts,
    run,
    elideVersion,
    libraries: new LibraryRegistry(manifest.dependencies.maven?.localRepository ?? DEFAULT_LIBRARIES_ROOT, opts.exists),
    artifacts: new ArtifactIndex(projects),
  };
  const resolved: ResolvedProject[] = [];
  for (const project of projects) resolved.push(await resolveProject(project, ctx));

  const members = projects.slice(1).map((p) => p.root);
  if (members.length > 0) {
    resolved[0]!.model.members = members;
    for (const r of resolved.slice(1)) r.model.workspaceRoot = root;
    wireProjectDependencies(resolved);
  }
  return resolved.map((r) => r.model);
}

/** A project's model, with what the dependency wiring across a workspace needs to know about it. */
interface ResolvedProject {
  spec: ProjectSpec;
  model: ProjectModel;
  /** Sibling artifacts each source set's classpath resolved, keyed by source set. */
  artifacts: Map<string, ArtifactOutput[]>;
}

async function resolveProject(project: ProjectSpec, ctx: BuildContext): Promise<ResolvedProject> {
  const { root, cli, manifest, name } = project;
  const { opts, run } = ctx;
  const warnings: string[] = [];

  const sets = Object.entries(manifest.sources)
    .map(([setName, set]) => ({ setName, set, kind: effectiveType(setName, set) }))
    .filter((s): s is typeof s & { kind: Exclude<SourceSetType, "other"> } => s.kind !== "other");

  const modules: ModuleModel[] = [];
  const compileLibs = new Map<string, string[]>();
  const artifacts = new Map<string, ArtifactOutput[]>();
  const used = new Set<string>();
  for (const { setName, set, kind } of sets) {
    opts.onProgress?.(`Resolving classpath: ${name}.${setName}`);
    const entries = await cli.classpath(setName, "compile", run);
    const outputs: ArtifactOutput[] = [];
    const names: string[] = [];
    for (const entry of entries) {
      const output = ctx.artifacts.resolve(entry);
      if (output) {
        if (!outputs.some((o) => o.project === output.project && o.name === output.name)) outputs.push(output);
        continue;
      }
      // An entry below some project's `.dev/artifacts` is a build output, not a library: one of a project this
      // model does not cover, which happens when a member of a workspace is resolved without its root. The jar
      // may not even exist, and the sources behind it are what an editor would need.
      const foreign = artifactProjectRoot(path.resolve(cli.projectRoot, entry));
      if (foreign !== undefined) {
        const warning = `Classpath names an artifact built by ${foreign}, which is not part of this project's workspace; its sources cannot be resolved.`;
        if (!warnings.includes(warning)) warnings.push(warning);
        continue;
      }
      const libName = ctx.libraries.nameFor(path.resolve(cli.projectRoot, entry));
      if (!names.includes(libName)) names.push(libName);
      used.add(libName);
    }
    compileLibs.set(setName, names);
    artifacts.set(setName, outputs);

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
    m.moduleDeps = [...deps].map((module) => ({ project: root, module, scope: "compile", exported: false }));
  }

  const libraries = ctx.libraries.models(used);
  if (!libraries.some((l) => /kotlin-stdlib/.test(l.classes))) {
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

  opts.onProgress?.(`Resolving JDK: ${name}`);
  const jdk = await resolveJdk(manifest, cli.dist, opts.jdk);
  if (!jdk) warnings.push("No JDK found for symbol resolution; set `elide.jdk.home` or `JAVA_HOME`.");

  return {
    spec: project,
    model: { root, name, elideVersion: ctx.elideVersion, jdk, kotlin, modules, libraries, entrypoints, warnings, members: [] },
    artifacts,
  };
}

/**
 * Wire every artifact one project of a workspace consumes from another as dependencies on the modules packaged into
 * it, exported so that a module depending on the consumer sees them too, the way the consumer's JAR carries them.
 *
 * What each source set resolved is the complete account of it: an artifact reached *through* a sibling sits on the
 * consumer's classpath without the consumer declaring it anywhere, exactly as Elide compiles it. The declarations are
 * walked as well, because a reference in a bucket whose classpath is never asked for (a processor, a runtime-only
 * dependency) still relates the two projects.
 */
function wireProjectDependencies(projects: readonly ResolvedProject[]): void {
  const byName = new Map(projects.map((p) => [p.spec.name, p]));
  const wire = (consumer: ModuleModel, target: ResolvedProject, sourceSets: readonly string[], scope: DependencyScope) => {
    for (const module of target.model.modules) {
      if (module === consumer || !sourceSets.includes(module.sourceSet)) continue;
      if (consumer.moduleDeps.some((d) => d.project === target.model.root && d.module === module.name)) continue;
      consumer.moduleDeps.push({ project: target.model.root, module: module.name, scope, exported: true });
    }
  };

  for (const project of projects) {
    for (const consumer of project.model.modules) {
      const scope: DependencyScope = consumer.kind === "test" ? "test" : "compile";
      for (const output of project.artifacts.get(consumer.sourceSet) ?? []) {
        // a project's own artifacts stand for its own source sets, which are already related by type
        if (output.project === project.spec.name) continue;
        const target = byName.get(output.project);
        if (target) wire(consumer, target, sourceSetsForArtifactOutput(target.spec.manifest, output.name), scope);
      }
    }
  }

  for (const project of projects) {
    for (const reference of project.spec.manifest.projectReferences) {
      const target = byName.get(reference.project);
      if (!target) {
        // the CLI rejects an unresolvable reference when a build is configured; the model simply carries none
        project.model.warnings.push(`References unknown workspace project '${reference.project}'.`);
        continue;
      }
      const sourceSets = referencedSourceSets(target.spec.manifest, reference.artifact);
      for (const consumer of project.model.modules) {
        const applies = reference.test ? consumer.kind === "test" : consumer.kind === "source" || consumer.kind === "example";
        if (applies) wire(consumer, target, sourceSets, reference.test ? "test" : "compile");
      }
    }
  }
}

/**
 * The libraries of every project of a workspace, named once: two projects resolving the same JAR name the same
 * library, and two different JARs never share a name.
 */
class LibraryRegistry {
  private readonly byPath = new Map<string, LibraryModel>();
  private readonly byName = new Map<string, LibraryModel>();

  constructor(
    private readonly librariesRoot: string,
    private readonly exists?: (p: string) => boolean,
  ) {}

  /** Name of the library for the classpath entry at the absolute path `entry`, registering it on first sight. */
  nameFor(entry: string): string {
    const abs = normalizePath(path.resolve(entry));
    const existing = this.byPath.get(abs);
    if (existing) return existing.name;
    const lib = libraryFor(abs, this.librariesRoot, this.exists);
    let candidate = lib.name;
    for (let i = 2; this.byName.has(candidate); i++) candidate = `${lib.name} (${i})`;
    lib.name = candidate;
    this.byPath.set(abs, lib);
    this.byName.set(candidate, lib);
    return candidate;
  }

  /** The libraries named `names`, in registration order. */
  models(names: ReadonlySet<string>): LibraryModel[] {
    return [...this.byName.values()].filter((lib) => names.has(lib.name));
  }
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
