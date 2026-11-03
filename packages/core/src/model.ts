import { existsSync } from "node:fs";
import path from "node:path";
import {
  ANDROID_LIBRARIES_TASK,
  DEFAULT_AVD_NAME,
  androidArtifactFile,
  androidContentDirs,
  androidMappingFile,
  androidRClasses,
  androidRClassesArtifact,
  androidRTask,
  androidSdkRoot,
  explodedAndroidLibrary,
} from "./android.js";
import { buildTasksOf, unqualifiedTaskName, type BuildTaskInfo } from "./buildTasks.js";
import { ElideCli, MANIFEST_NAME, isLockfileCurrent, type ClasspathQuery, type RunOptions } from "./elide.js";
import { resolveJdk, type Jdk, type ResolveJdkOptions } from "./jdk.js";
import { DEFAULT_LIBRARIES_ROOT, libraryFor, type LibraryModel } from "./libraries.js";
import { effectiveType, type AndroidArtifactKind, type Manifest, type SourceSet, type SourceSetType } from "./manifest.js";
import { collectContentRoots, isPathUnder, normalizePath } from "./sourceRoots.js";
import {
  ArtifactIndex,
  artifactProjectRoot,
  packagedSourceSets,
  projectName,
  referencedSourceSets,
  sourceSetsForArtifactOutput,
  type ArtifactOutput,
} from "./workspace.js";

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
  /** Authoritative manifest selectors, relative to the owning project; never inferred content roots. */
  sourcePaths?: string[];
  kind: Exclude<SourceSetType, "other">;
  contentRoots: ContentRootModel[];
  libraries: { name: string; scope: DependencyScope }[];
  moduleDeps: ModuleDependency[];
  /** Exact declared JVM compilation targets, retained for host preview builds. */
  compilationTargets?: string[];
  /** Runtime entries from the CLI, excluding workspace artifacts represented by runtimeModuleDeps. */
  runtimeClassPath?: string[];
  /** Source-set and workspace dependencies actually present at runtime, never provided-only references. */
  runtimeModuleDeps?: ModuleDependency[];
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
  kotlin: { languageVersion?: string; apiVersion?: string; freeCompilerArgs: string[]; jvmTarget?: string; compose?: boolean };
  modules: ModuleModel[];
  libraries: LibraryModel[];
  entrypoints: Entrypoint[];
  warnings: string[];
  /** Roots of the members this project declares, in declaration order; empty unless it is a workspace root. */
  members: string[];
  /** Root of the workspace this project is a member of; absent for a workspace root or a standalone project. */
  workspaceRoot?: string;
  /** What this project builds for Android; absent unless its manifest declares an `android` block. */
  android?: AndroidProjectModel;
}

/**
 * The Android side of a project: the platform it builds against, the SDK a build would use, and the artifacts the
 * Android pipeline publishes for it.
 */
export interface AndroidProjectModel {
  /** API level the project compiles, links and dexes against. */
  compileSdk: number;
  /** Oldest API level the dex output runs on; the compile level when the manifest declares none. */
  minSdk: number;
  /** Installed SDK the build would resolve, absent when none was found on this machine. */
  sdkRoot?: string;
  /** Virtual device `android-avd`, `android-emulator` and the emulator run targets drive. */
  avd: string;
  targets: AndroidTargetModel[];
}

/** One Android artifact of a project. */
export interface AndroidTargetModel {
  /** Manifest artifact key; features build through `android-module-<name>` rather than a bare target. */
  name: string;
  kind: AndroidArtifactKind;
  /** Published archive, or the staged module ZIP for a dynamic feature. */
  output: string;
  /** `AndroidManifest.xml` the artifact is built from. */
  manifestFile: string;
  /** Source sets selected by the artifact, before following their dependsOn edges. */
  sourceSets?: string[];
  /** Obfuscation mapping `elide build <name>` publishes; absent unless the artifact minifies. */
  mapping?: string;
  features?: string[];
  base?: string;
  delivery?: "install-time" | "on-demand";
  featureDependencies?: string[];
}

export interface BuildModelOptions {
  /** The steps the workspace takes as a whole: reading manifests, installing dependencies. */
  onProgress?: (step: string) => void;
  onLine?: (line: string, stderr: boolean) => void;
  onCommand?: RunOptions["onCommand"];
  /**
   * Called as each project starts resolving. The projects of a workspace resolve concurrently once its dependencies
   * are installed, so each one's steps and CLI processes report to what this returns rather than to `onProgress` and
   * `onCommand`, which see them only when it is absent.
   */
  onProject?: (name: string) => ProjectProgress;
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

/** Where the resolution of one project reports while the other projects of its workspace resolve alongside it. */
export interface ProjectProgress {
  onProgress?: (step: string) => void;
  onCommand?: RunOptions["onCommand"];
  /**
   * The project is resolved, failed with `error`, or was cancelled: by the caller's signal, or because another
   * project failed.
   */
  end?: (outcome: "succeeded" | "failed" | "cancelled", error?: unknown) => void;
}

const EXCLUDED_AT_ROOT = [".dev", "node_modules", ".git"];

/** One project a model is built for: where it is, the CLI focused on it, and its decoded manifest. */
interface ProjectSpec {
  name: string;
  root: string;
  cli: ElideCli;
  manifest: Manifest;
}

/** What a project needs built before every entry its classpaths name exists. */
interface AndroidPreparation {
  /** `android-libraries`: a classpath names a published Android library that is not unpacked yet. */
  libraries: boolean;
  /** The `R` targets of the project's Android artifacts whose identifiers were never generated, or not recorded. */
  rTasks: string[];
}

/** Why each step of a project's {@link AndroidPreparation} failed; absent when it did not. */
interface PreparationFailures {
  libraries?: unknown;
  r?: unknown;
}

/** What the models of one workspace share while they are built. */
interface BuildContext {
  opts: BuildModelOptions;
  run: RunOptions;
  elideVersion: string;
  libraries: LibraryRegistry;
  artifacts: ArtifactIndex;
  previewTasks?: BuildTaskInfo[];
  /** `elide build` in the directory of `cli`, never while another build of the workspace runs. */
  build: (cli: ElideCli, targets: readonly string[], run: RunOptions) => Promise<void>;
  /**
   * Report what `project` needs built, and wait until it is: the needs of every project are built together, once
   * each has reported. A project that needs nothing is not held up.
   */
  prepare: (project: ProjectSpec, need: AndroidPreparation) => Promise<PreparationFailures>;
}

/**
 * Resolve the models of the Elide project the CLI points at and of the workspace members its manifest declares:
 * the project first, then the members in declaration order. A standalone project is a workspace of one.
 *
 * A workspace resolves and builds as one graph from its root: one `elide install` there covers every member, into
 * the root's repository. Each member's classpath is then resolved by the CLI focused on that member — invoked in its
 * directory — which is the member's own classpath within the workspace. A sibling's JAR on it becomes a dependency
 * on the modules packaged into that JAR, since those are what an editor can compile against and navigate into.
 *
 * Once dependencies are installed, the projects resolve concurrently: a classpath query only reads what the install
 * left behind. What their classpaths need built (unpacking Android libraries, generating `R`) is built by one
 * `elide build` at the root, which runs a task two members share once; builds never overlap, since two of them could
 * run such a task at the same time. The first project that fails cancels the others.
 */
export async function buildProjectModels(cli: ElideCli, manifest: Manifest, opts: BuildModelOptions = {}): Promise<ProjectModel[]> {
  const root = normalizePath(path.resolve(cli.projectRoot));
  const failure = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, failure.signal]) : failure.signal;
  const run: RunOptions = { onLine: opts.onLine, onCommand: opts.onCommand, signal };

  opts.onProgress?.("Querying Elide version");
  const elideVersion = await cli.version(run);

  // The exported project model has already validated the member list at the root: every entry is a directory below
  // it holding a manifest, and no two members share a name.
  if (manifest.workspaceMembers.length > 0) opts.onProgress?.("Reading member manifests");
  const members = await Promise.all(
    manifest.workspaceMembers.map(async (entry): Promise<ProjectSpec> => {
      const memberRoot = normalizePath(path.resolve(root, entry));
      const memberCli = new ElideCli(cli.dist, memberRoot, cli.flags);
      const memberManifest = await memberCli.manifest(run);
      return { name: projectName(memberManifest, memberRoot), root: memberRoot, cli: memberCli, manifest: memberManifest };
    }),
  );
  const projects: ProjectSpec[] = [{ name: projectName(manifest, root), root, cli, manifest }, ...members];

  const manifests = projects.map((p) => path.join(p.root, MANIFEST_NAME));
  if (!opts.skipInstall && (opts.forceInstall || !(await isLockfileCurrent(root, manifests)))) {
    opts.onProgress?.("Installing dependencies");
    await cli.install({ ...run, with: opts.installWith });
  }
  let previewTasks: BuildTaskInfo[] | undefined;
  if (projects.some((p) => p.manifest.android)) {
    // A step of its own: with the install skipped, the listing would otherwise count towards reading the manifests.
    opts.onProgress?.("Listing build tasks");
    previewTasks = await cli.buildInspect(run);
  }

  let builds: Promise<unknown> = Promise.resolve();
  const needs = new Map<ProjectSpec, AndroidPreparation>();
  const prepared = Promise.withResolvers<Map<ProjectSpec, PreparationFailures>>();
  // Rejected when a project fails before reporting what it needs, which may be after everyone stopped waiting.
  prepared.promise.catch(() => undefined);
  signal.addEventListener("abort", () => prepared.reject(signal.reason), { once: true });
  const ctx: BuildContext = {
    opts,
    run,
    elideVersion,
    // Members resolve into the root's repository, so the layout library names are read against is the root's.
    libraries: new LibraryRegistry(
      normalizePath(path.resolve(root, manifest.dependencies.maven?.localRepository ?? DEFAULT_LIBRARIES_ROOT)),
      opts.exists,
    ),
    artifacts: new ArtifactIndex(projects),
    ...(previewTasks ? { previewTasks } : {}),
    build: (projectCli, targets, buildRun) => {
      const turn = builds.then(() => projectCli.build(targets, buildRun));
      builds = turn.catch(() => undefined);
      return turn;
    },
    prepare: (project, need) => {
      needs.set(project, need);
      if (needs.size === projects.length) prepareProjects(cli, projects, needs, ctx).then(prepared.resolve, prepared.reject);
      if (!need.libraries && need.rTasks.length === 0) return Promise.resolve({});
      return prepared.promise.then((failures) => failures.get(project) ?? {});
    },
  };
  opts.onProgress?.(projects.length === 1 ? "Resolving the project" : `Resolving ${projects.length} projects`);
  const answers = await Promise.all(projects.map(async (project) => {
    const progress = opts.onProject?.(project.name);
    try {
      const result = await queryProject(project, ctx, progress);
      progress?.end?.("succeeded");
      return result;
    } catch (e) {
      // Already aborted: by the user, or by another project's failure, which is the one to report.
      progress?.end?.(signal.aborted ? "cancelled" : "failed", e);
      failure.abort(e);
      throw e;
    }
  }));
  // In declaration order, whichever project's answers came first: libraries are named as they are first met.
  const resolved = projects.map((project, i) => assembleProject(project, answers[i]!, ctx));

  if (members.length > 0) {
    resolved[0]!.model.members = members.map((p) => p.root);
    for (const r of resolved.slice(1)) r.model.workspaceRoot = root;
  }
  wireProjectDependencies(resolved);
  return resolved.map((r) => r.model);
}

/**
 * Build what the projects of a workspace reported they need, as one `elide build` at the root when the root's task
 * listing names every target. A target that fails fails that build, so it is built again one project and one step at
 * a time: the rest still build, and each failure is the project's own.
 */
async function prepareProjects(
  cli: ElideCli,
  projects: readonly ProjectSpec[],
  needs: ReadonlyMap<ProjectSpec, AndroidPreparation>,
  ctx: BuildContext,
): Promise<Map<ProjectSpec, PreparationFailures>> {
  const failures = new Map<ProjectSpec, PreparationFailures>();
  const wanted = projects
    .map((project): [ProjectSpec, AndroidPreparation] => [project, needs.get(project)!])
    .filter(([, need]) => need.libraries || need.rTasks.length > 0);
  if (wanted.length === 0) return failures;
  const aborted = (e: unknown) => {
    if (ctx.run.signal?.aborted) throw e;
    return e;
  };
  const qualified = wanted.flatMap(([project, need]) => {
    const tasks = buildTasksOf(ctx.previewTasks ?? [], project.name);
    return [...(need.libraries ? [ANDROID_LIBRARIES_TASK] : []), ...need.rTasks]
      .map((target) => tasks.find((task) => unqualifiedTaskName(task) === target)?.name);
  });
  if (qualified.every((target) => target !== undefined)) {
    try {
      await ctx.build(cli, qualified, ctx.run);
      return failures;
    } catch (e) {
      aborted(e);
    }
  }
  for (const [project, need] of wanted) {
    const failed: PreparationFailures = {};
    if (need.libraries) await ctx.build(project.cli, [ANDROID_LIBRARIES_TASK], ctx.run).catch((e: unknown) => (failed.libraries = aborted(e)));
    if (need.rTasks.length > 0) await ctx.build(project.cli, need.rTasks, ctx.run).catch((e: unknown) => (failed.r = aborted(e)));
    failures.set(project, failed);
  }
  return failures;
}

/** A project's model, with what the dependency wiring across a workspace needs to know about it. */
interface ResolvedProject {
  spec: ProjectSpec;
  model: ProjectModel;
  /** Sibling artifacts each source set's classpath resolved, keyed by source set. */
  artifacts: Map<string, ArtifactOutput[]>;
  runtimeArtifacts: Map<string, ArtifactOutput[]>;
}

/** What the CLI and the machine said about one project, keyed by source set where it is per set. */
interface ProjectAnswers {
  sets: { setName: string; set: SourceSet; kind: Exclude<SourceSetType, "other"> }[];
  classpaths: Map<string, string[]>;
  runtimeClasspaths: Map<string, string[]>;
  provided: Map<string, string[]>;
  jdk: Jdk | undefined;
  warnings: string[];
}

/** Everything about `project` that takes a process or the file system: its classpaths, the builds they need, its JDK. */
async function queryProject(project: ProjectSpec, ctx: BuildContext, progress?: ProjectProgress): Promise<ProjectAnswers> {
  const { root, cli, manifest, name } = project;
  const { opts } = ctx;
  const run: RunOptions = progress?.onCommand ? { ...ctx.run, onCommand: progress.onCommand } : ctx.run;
  const step = progress ? progress.onProgress : opts.onProgress;
  const warnings: string[] = [];

  const sets = Object.entries(manifest.sources)
    .map(([setName, set]) => ({ setName, set, kind: effectiveType(setName, set) }))
    .filter((s): s is typeof s & { kind: Exclude<SourceSetType, "other"> } => s.kind !== "other");

  // The Android framework and the generated `R` classes reach a compile only as *provided* entries: the device
  // carries the framework and the APK's own dex carries `R`, so neither is on the compile or runtime classpath the
  // model is otherwise built from. Without them an editor resolves no `android.*` import and no resource
  // identifier, which is most of an Android source file.
  //
  // `R` is listed only once the target that compiles it has run, since the classpath is read from its recorded
  // output. Running it is cheap (it links resources that a build links anyway) and is the difference between a
  // freshly opened project resolving `R` and reporting it as unknown.
  const fileExists = opts.exists ?? existsSync;
  const rTasks = manifest.android
    ? Object.keys(manifest.androidTargets).filter((artifact) => !fileExists(androidRClasses(root, artifact))).map(androidRTask)
    : [];
  const providedQueries = manifest.android ? sets.map(({ setName }): ClasspathQuery => `${setName}:provided`) : [];

  step?.(`Resolving classpaths: ${name}`);
  const queries = sets.flatMap(({ setName, kind }): ClasspathQuery[] =>
    ctx.previewTasks && kind !== "test" ? [`${setName}:compile`, `${setName}:runtime`] : [`${setName}:compile`]);
  // Each `elide classpath` resolves the project anew, so with `R` already in place the platform is asked in the
  // same call. One query that fails fails the batch: the platform is then asked alone, after the rest.
  const early = rTasks.length === 0 ? providedQueries : [];
  let answers: Map<ClasspathQuery, string[]>;
  let providedFailed = false;
  try {
    answers = await cli.classpaths([...queries, ...early], run);
  } catch (e) {
    if (early.length === 0 || run.signal?.aborted) throw e;
    answers = await cli.classpaths(queries, run);
    providedFailed = true;
  }
  const classpaths = new Map<string, string[]>();
  const runtimeClasspaths = new Map<string, string[]>();
  for (const { setName } of sets) {
    classpaths.set(setName, answers.get(`${setName}:compile`)!);
    const runtime = answers.get(`${setName}:runtime`);
    if (runtime) runtimeClasspaths.set(setName, runtime);
  }
  // `R` on disk is not `R` recorded: a build stopped after compiling it, or build state lost since, leaves the classes
  // in place while the platform query lists none of them. An artifact whose `R` no source set was given is generated
  // again (a cached no-op when the classes are current), and the platform asked anew once it has been.
  const reused = early.length > 0 && !providedFailed;
  const listed = new Set(reused ? providedQueries.flatMap((query) => answers.get(query) ?? []).map(androidRClassesArtifact) : []);
  const unrecorded = reused ? Object.keys(manifest.androidTargets).filter((artifact) => !listed.has(artifact)) : [];
  rTasks.push(...unrecorded.map(androidRTask));
  // A published `.aar` reaches a classpath as the `classes.jar` of the directory `android-libraries` explodes it into,
  // and `elide classpath` resolves dependencies without running that target. Listing those paths before the first
  // build would hand the language server jars that are not there, so the target is run — once, and only when an entry
  // actually names a directory that is missing.
  const need: AndroidPreparation = {
    libraries: [...classpaths.values(), ...runtimeClasspaths.values()].flat().some((entry) => explodedAndroidLibrary(entry) && !fileExists(entry)),
    rTasks,
  };
  if (need.libraries || need.rTasks.length > 0) {
    step?.(need.libraries && need.rTasks.length > 0
      ? `Unpacking Android libraries and generating resource identifiers: ${name}`
      : need.libraries ? `Unpacking Android libraries: ${name}` : `Generating Android resource identifiers: ${name}`);
  }
  const failed = await ctx.prepare(project, need);
  if (failed.libraries !== undefined) {
    warnings.push(
      `Could not unpack the project's published Android libraries (elide build ${ANDROID_LIBRARIES_TASK}): ${failed.libraries instanceof Error ? failed.libraries.message : String(failed.libraries)}. Their classes resolve once the project is built.`,
    );
  }

  const provided = new Map<string, string[]>();
  if (manifest.android) {
    if (failed.r !== undefined) {
      warnings.push(
        `Could not generate the project's Android resource identifiers (elide build ${rTasks.join(" ")}): ${failed.r instanceof Error ? failed.r.message : String(failed.r)}. \`R\` resolves once the project is built.`,
      );
    }
    let batched: Map<ClasspathQuery, string[]> | undefined = reused && unrecorded.length === 0 ? answers : undefined;
    if (!batched && !providedFailed) {
      step?.(`Resolving Android platform: ${name}`);
      batched = await cli.classpaths(providedQueries, run).catch((e: unknown) => {
        if (run.signal?.aborted) throw e;
        return undefined;
      });
    }
    // Asked again one set at a time, the sets that resolve still do.
    for (const { setName } of sets) {
      try {
        provided.set(setName, batched?.get(`${setName}:provided`) ?? await cli.classpath(setName, "provided", run));
      } catch (e) {
        if (run.signal?.aborted) throw e;
        // An unresolvable platform is a reason to resolve less, never to fail the sync: the rest of the model —
        // sources, siblings, Maven libraries — is what it was before the Android pipeline had anything to say.
        warnings.push(
          `Could not resolve the Android platform classpath of ${setName} (elide classpath ${setName}:provided): ${e instanceof Error ? e.message : String(e)}. \`android.*\` imports and \`R\` will not resolve.`,
        );
      }
    }
  }

  if (manifest.hasAnnotationProcessors || manifest.android?.hilt) {
    step?.(`Generating annotation processor sources: ${name}`);
    try {
      // Empty source sets have no compile task; requesting one prevents every target in the build from running.
      const wanted = new Set(sets.map(({ setName }) => `compile-java-${setName}`));
      const targets = buildTasksOf(await cli.buildInspect(run), name)
        .filter((task) => wanted.has(unqualifiedTaskName(task)))
        .map((task) => task.name);
      if (targets.length > 0) await ctx.build(cli, targets, run);
    } catch (e) {
      if (run.signal?.aborted) throw e;
      warnings.push(`Could not generate annotation processor sources: ${e instanceof Error ? e.message : String(e)}. Build the project and sync again to resolve generated Dagger/Hilt declarations.`);
    }
  }

  step?.(`Resolving JDK: ${name}`);
  const jdk = await resolveJdk(manifest, cli.dist, opts.jdk);
  return { sets, classpaths, runtimeClasspaths, provided, jdk, warnings };
}

/** The model of `project` from what {@link queryProject} found; libraries are named in the registry as they are met. */
function assembleProject(project: ProjectSpec, answers: ProjectAnswers, ctx: BuildContext): ResolvedProject {
  const { root, cli, manifest, name } = project;
  const { opts } = ctx;
  const { sets, classpaths, runtimeClasspaths, provided, jdk, warnings } = answers;
  const fileExists = opts.exists ?? existsSync;

  // `res/` and `assets/` are the artifact's, not a source set's: the manifest declares them per Android artifact,
  // so each one contributes its directories to the source sets it packages, as resource roots of those modules.
  const androidContent = new Map<string, string[]>();
  for (const target of Object.values(manifest.androidTargets)) {
    const dirs = androidContentDirs(root, target, opts.exists);
    if (dirs.length === 0) continue;
    for (const setName of packagedSourceSets(manifest, target)) {
      androidContent.set(setName, [...(androidContent.get(setName) ?? []), ...dirs]);
    }
  }

  const modules: ModuleModel[] = [];
  const compileLibs = new Map<string, string[]>();
  const artifacts = new Map<string, ArtifactOutput[]>();
  const runtimeArtifacts = new Map<string, ArtifactOutput[]>();
  const used = new Set<string>();
  for (const { setName, set, kind } of sets) {
    const entries = classpaths.get(setName) ?? [];
    const outputs: ArtifactOutput[] = [];
    const names: string[] = [];
    for (const entry of entries) {
      const output = ctx.artifacts.resolve(entry);
      if (output) {
        const same = (o: ArtifactOutput) => o.project === output.project && o.name === output.name && o.staged === output.staged;
        if (!outputs.some(same)) outputs.push(output);
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
    // A provided entry is a library and nothing else: the framework and `R` are built by no project of the
    // workspace, so neither can name an artifact the sibling wiring would resolve.
    for (const entry of provided.get(setName) ?? []) {
      const libName = ctx.libraries.nameFor(path.resolve(cli.projectRoot, entry));
      if (!names.includes(libName)) names.push(libName);
      used.add(libName);
    }
    compileLibs.set(setName, names);
    artifacts.set(setName, outputs);
    const runtimeEntries: string[] = [];
    const runtimeOutputs: ArtifactOutput[] = [];
    for (const entry of runtimeClasspaths.get(setName) ?? []) {
      const absolute = path.resolve(root, entry);
      const output = ctx.artifacts.resolve(absolute);
      if (output) runtimeOutputs.push(output);
      else runtimeEntries.push(absolute);
    }
    runtimeArtifacts.set(setName, runtimeOutputs);

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
    // Processor outputs are source roots, but kapt stubs are not: importing stubs duplicates user declarations.
    for (const generator of ["java", "kapt"]) {
      const generated = normalizePath(path.join(root, ".dev", "jvm", "generated-sources", setName, generator));
      if (fileExists(generated)) contentRoots.push({
        path: generated,
        sourceRoots: [{ path: generated, kind: sourceKind }],
        excludedPatterns: [],
      });
    }
    const resourcePaths = [...Object.values(set.resources), ...(androidContent.get(setName) ?? [])];
    for (const [resRoot, folders] of collectContentRoots(cli.projectRoot, resourcePaths)) {
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
      sourcePaths: [...set.paths],
      kind,
      contentRoots,
      libraries: names.map((n) => ({ name: n, scope: kind === "test" ? "test" : "compile" })),
      moduleDeps: [],
      ...(ctx.previewTasks ? {
        compilationTargets: buildTasksOf(ctx.previewTasks, name)
          .filter((task) => ["java", "kotlin"].some((language) => unqualifiedTaskName(task) === `compile-${language}-${setName}`))
          .map((task) => task.name),
        runtimeClassPath: runtimeEntries,
        runtimeModuleDeps: [],
      } : {}),
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
    if (m.runtimeModuleDeps) {
      m.runtimeModuleDeps = m.moduleDeps.filter((dep) => modules.find((candidate) => candidate.name === dep.module)?.kind !== "test");
    }
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
    ...(manifest.kotlin?.compose ? { compose: true } : {}),
    freeCompilerArgs: ko?.freeCompilerArgs ?? [],
    jvmTarget: target?.kind === "version" ? (target.major === 8 ? "1.8" : String(target.major)) : undefined,
  };

  const entrypoints: Entrypoint[] = manifest.entrypoint.map((value) => ({ kind: "generic", value }));
  if (entrypoints.length === 0 && manifest.jvm?.main) entrypoints.push({ kind: "jvmMain", value: manifest.jvm.main });
  for (const script of Object.keys(manifest.scripts)) entrypoints.push({ kind: "script", value: script });

  if (!jdk) warnings.push("No JDK found for symbol resolution; set `elide.jdk.home` or `JAVA_HOME`.");

  let android: AndroidProjectModel | undefined;
  if (manifest.android) {
    const settings = manifest.android;
    const sdkRoot = androidSdkRoot({ declared: settings.sdk, projectRoot: root });
    if (!sdkRoot) {
      warnings.push(
        "No Android SDK found; set `android.sdk` in elide.pkl, or `ANDROID_HOME`. Build targets still run and report what is missing.",
      );
    }
    android = {
      compileSdk: settings.compileSdk,
      minSdk: settings.minSdk ?? settings.compileSdk,
      ...(sdkRoot ? { sdkRoot } : {}),
      // The build names the AVD after the manifest's declared name, not the directory's: a project that declares
      // neither a name nor an AVD boots `elide-android`, and a row offering to boot something else would lie.
      avd: settings.device.avd ?? manifest.name ?? DEFAULT_AVD_NAME,
      targets: Object.entries(manifest.androidTargets).map(([key, declared]) => ({
        name: key,
        kind: declared.kind,
        output: androidArtifactFile(root, key, declared.kind, declared.name),
        manifestFile: normalizePath(path.resolve(root, declared.manifestFile)),
        sourceSets: packagedSourceSets(manifest, declared),
        ...(declared.minify ? { mapping: androidMappingFile(root, key, declared.name) } : {}),
        ...(declared.features ? { features: declared.features } : {}),
        ...(declared.base ? { base: declared.base } : {}),
        ...(declared.delivery ? { delivery: declared.delivery } : {}),
        ...(declared.featureDependencies ? { featureDependencies: declared.featureDependencies } : {}),
      })),
    };
  }

  return {
    spec: project,
    model: {
      root,
      name,
      elideVersion: ctx.elideVersion,
      jdk,
      kotlin,
      modules,
      libraries,
      entrypoints,
      warnings,
      members: [],
      ...(android ? { android } : {}),
    },
    artifacts,
    runtimeArtifacts,
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
      if (!consumer.runtimeModuleDeps) continue;
      for (const output of project.runtimeArtifacts.get(consumer.sourceSet) ?? []) {
        const target = byName.get(output.project);
        if (!target) continue;
        const sourceSets = sourceSetsForArtifactOutput(target.spec.manifest, output);
        for (const module of target.model.modules) {
          if (module === consumer || module.kind === "test" || !sourceSets.includes(module.sourceSet)) continue;
          if (consumer.runtimeModuleDeps.some((dep) => dep.project === target.model.root && dep.module === module.name)) continue;
          consumer.runtimeModuleDeps.push({ project: target.model.root, module: module.name, scope: "compile", exported: true });
        }
      }
    }
  }

  for (const project of projects) {
    for (const consumer of project.model.modules) {
      const scope: DependencyScope = consumer.kind === "test" ? "test" : "compile";
      for (const output of project.artifacts.get(consumer.sourceSet) ?? []) {
        // a project's own artifacts stand for its own source sets, which are already related by type
        if (output.project === project.spec.name) continue;
        const target = byName.get(output.project);
        if (target) wire(consumer, target, sourceSetsForArtifactOutput(target.spec.manifest, output), scope);
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
 *
 * A coordinate is the identity when the entry's path carries one. A published `.aar` is exploded into the build
 * directory of each project that consumes it, so one archive reaches a workspace as several paths; naming them
 * apart would list the same dependency twice and give the language server two copies of it.
 */
class LibraryRegistry {
  private readonly byPath = new Map<string, LibraryModel>();
  private readonly byName = new Map<string, LibraryModel>();
  private readonly byCoordinate = new Map<string, LibraryModel>();

  constructor(
    /** Maven repository the entries resolve from, absolute: where the sources of an exploded `.aar` are. */
    private readonly librariesRoot: string,
    private readonly exists?: (p: string) => boolean,
  ) {}

  /** Name of the library for the classpath entry at the absolute path `entry`, registering it on first sight. */
  nameFor(entry: string): string {
    const abs = normalizePath(path.resolve(entry));
    const existing = this.byPath.get(abs);
    if (existing) return existing.name;
    const lib = libraryFor(abs, this.librariesRoot, this.exists);
    const sameCoordinate = lib.coordinate !== undefined ? this.byCoordinate.get(lib.coordinate) : undefined;
    if (sameCoordinate) {
      this.byPath.set(abs, sameCoordinate);
      return sameCoordinate.name;
    }
    let candidate = lib.name;
    for (let i = 2; this.byName.has(candidate); i++) candidate = `${lib.name} (${i})`;
    lib.name = candidate;
    this.byPath.set(abs, lib);
    this.byName.set(candidate, lib);
    if (lib.coordinate !== undefined) this.byCoordinate.set(lib.coordinate, lib);
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
