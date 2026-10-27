/**
 * Elide Build Extension APIs
 *
 * A build extension is a JavaScript or TypeScript module listed in a project's `elide.pkl` under
 * `extensions`. Elide calls its default export while configuring the build; every `task(...)` the
 * export declares becomes a real build task.
 *
 * @example
 *
 * ```ts
 * export default ({ task, manifest }: ElideBuild) => {
 *   task("protoc", { description: "Generate protobuf sources", outputs: ["src/generated"] },
 *     async (ctx) => {
 *       const { ok, stderr } = ctx.exec("protoc", ["--kotlin_out=src/generated", "api.proto"]);
 *       if (!ok) ctx.fail(stderr);
 *     });
 * };
 * ```
 */

/** Where the build reads and writes, as absolute paths. */
interface ElideBuildLayout {
  /** Project root: the directory holding `elide.pkl`. */
  readonly projectDir: string;

  /** Everything the build writes for this project (`.dev`). */
  readonly buildDir: string;

  /** Build state and the shared dependency repository; the workspace root's for a member. */
  readonly stateDir: string;

  /** Elide's bundled resources. */
  readonly resourcesDir: string;

  /** Built artifacts. */
  readonly artifacts: string;

  /** Staging area used while assembling artifacts. */
  readonly staging: string;

  /** Resolved dependencies, shared across a workspace. */
  readonly dependencies: string;
}

/** The workspace a project belongs to. */
interface ElideBuildWorkspace {
  /** Workspace root project's name. */
  readonly name: string;

  /** Absolute path of the workspace root. */
  readonly root: string;

  /** This project's member name, or `null` when it is the workspace root. */
  readonly member: string | null;

  /** Every member's name, in declaration order. */
  readonly members: readonly string[];
}

/** Identity of the project being built. */
interface ElideBuildProject {
  /** Declared name, falling back to the project directory's name. */
  readonly name: string | null;

  /** Declared version, or `null` when the manifest declares none. */
  readonly version: string | null;

  /** Declared description, or `null` when the manifest declares none. */
  readonly description: string | null;

  /** Absolute path of the project root. */
  readonly root: string;

  /** The workspace this project belongs to, or `null` when it stands alone. */
  readonly workspace: ElideBuildWorkspace | null;
}

/**
 * Build options as parsed from the command line; `args` maps each option's name to every value
 * passed for it in command-line order, and a bare flag maps to a single empty string.
 */
interface ElideBuildOptions {
  readonly args: Readonly<Record<string, readonly string[]>>;

  /** Tokens that appeared after the `--` separator, verbatim. */
  readonly flags: readonly string[];
}

/**
 * The resolved project manifest, exactly as `elide project export --format=json` writes it: property
 * names from `elide.pkl`, an `@type` discriminator on polymorphic entries, defaults absent.
 */
type ElideBuildManifest = Readonly<Record<string, unknown>>;

/** The `config` block of this extension's entry in `extensions`, uninterpreted by Elide; empty when none. */
type ElideBuildConfig = Readonly<Record<string, unknown>>;

/** Result of running an external program. */
interface ElideBuildExecResult {
  /** The program's exit status. */
  readonly exitCode: number;

  /** Whether the program exited zero. */
  readonly ok: boolean;

  /**
   * What the program wrote to standard output, kept up to 1 MiB; output past the cap is dropped here
   * but still streamed.
   */
  readonly stdout: string;

  /** What the program wrote to standard error, under the same cap as {@link stdout}. */
  readonly stderr: string;
}

/** Options for {@link ElideBuildTaskContext.exec}. */
interface ElideBuildExecOptions {
  /** Working directory; relative paths resolve against the project root. Defaults to the root. */
  readonly cwd?: string;

  /**
   * Environment entries added on top of the inherited environment; a non-string value is set as the
   * guest displays it. An entry whose value is `undefined` or `null` is left as inherited rather than
   * set.
   */
  readonly env?: Readonly<
    Record<string, string | number | boolean | null | undefined>
  >;

  /** Suppress forwarding the program's output to the build display. Defaults to `false`. */
  readonly quiet?: boolean;

  /**
   * Milliseconds to wait before killing the program and failing the task; omitted, zero or negative
   * waits as long as the program runs. Bounds the named program only: once it exits, output still
   * arriving from anything it left running is read for one more second and then dropped.
   */
  readonly timeout?: number;
}

/** One diagnostic a built-in compiler reported. */
interface ElideBuildToolDiagnostic {
  readonly severity: "error" | "warning" | "info";

  /** The compiler's message, without the rendered source excerpt. */
  readonly message: string;

  /** Path of the source file, as the compiler reported it; `null` when it named none. */
  readonly file: string | null;

  /** 1-based line, or `null` when the diagnostic has no position. */
  readonly line: number | null;

  /** 1-based column, or `null` when the diagnostic has no position. */
  readonly column: number | null;
}

/** Result of running a built-in tool in-process. */
interface ElideBuildToolResult {
  /** Whether the tool succeeded. */
  readonly ok: boolean;

  /** The tool's exit status: `0` on success, its own code otherwise, `1` for a failure with none. */
  readonly exitCode: number;

  /** Which tool ran: `"kotlinc"`, `"javac"`, `"jar"`, `"native-image"` or a formatter's name. */
  readonly tool: string;

  /**
   * What a compiler reported, in order and already shown in the build output. Empty for `jar` and
   * `native-image`, whose output is text streamed to the build log.
   */
  readonly diagnostics: readonly ElideBuildToolDiagnostic[];
}

/** Result of a {@link ElideBuildTools.format} run. */
interface ElideBuildFormatResult extends ElideBuildToolResult {
  /**
   * Absolute paths of the files rewritten, or — under `check` — that would be rewritten. Empty
   * when everything was already formatted.
   */
  readonly changed: readonly string[];
}

/** Options for {@link ElideBuildTools.format}. */
interface ElideBuildFormatOptions {
  /** Which formatter to drive: ktfmt for Kotlin, google-java-format for Java. */
  readonly tool: "ktfmt" | "javaformat";

  /**
   * Files, directories or globs, project-relative; narrowed to what the formatter accepts (`.kt`
   * and `.kts` for `"ktfmt"`, `.java` for `"javaformat"`). Matching nothing is a successful no-op.
   */
  readonly files: readonly string[];

  /** Report what would change and write nothing. Defaults to `false`, which rewrites in place. */
  readonly check?: boolean;

  /** Further flags for the formatter's own parser, e.g. `["--google-style"]`. */
  readonly args?: readonly string[];
}

/** Options for {@link ElideBuildTools.kotlinc}. */
interface ElideBuildKotlincOptions {
  /** Files, directories or globs, project-relative; only `.kt`, `.kts` and `.java` entries are passed. */
  readonly sources: readonly string[];

  /** Output directory, or a path ending in `.jar` to package the classes directly. */
  readonly out: string;

  /** Compile classpath entries, project-relative or absolute. */
  readonly classpath?: readonly string[];

  /** Output directories or JARs whose `internal` declarations this compilation may see. */
  readonly friendPaths?: readonly string[];

  /** Further `kotlinc` flags, passed verbatim ahead of the classpath. */
  readonly args?: readonly string[];

  /** Compile incrementally against the toolchain's cache for `out`. Defaults to `false`. */
  readonly incremental?: boolean;

  /**
   * Mount the compiler plugins the manifest's `kotlin.features` and `kotlin.plugins` enable, the way
   * `compile-kotlin-main` does; the runtimes those features provide join the classpath with them,
   * since a plugin without its runtime fails the compiler rather than doing nothing. `false` runs
   * the bare compiler: what annotation-only or plugin-free sources want. Defaults to `true`.
   */
  readonly plugins?: boolean;
}

/** Options for {@link ElideBuildTools.javac}. */
interface ElideBuildJavacOptions {
  /** Files, directories or globs, project-relative; only `.java` entries are passed. */
  readonly sources: readonly string[];

  /** Output directory for class files. */
  readonly out: string;

  /** Compile classpath entries, project-relative or absolute. */
  readonly classpath?: readonly string[];

  /** Annotation processor path entries; processing runs when present. */
  readonly processorPath?: readonly string[];

  /** Further `javac` flags, passed verbatim after the classpath. */
  readonly args?: readonly string[];
}

/** One thing {@link ElideBuildTools.jar} packages. */
interface ElideBuildJarEntry {
  /** A directory, whose contents are packaged, or a single file; project-relative or absolute. */
  readonly from: string;

  /** Directory inside the archive the entry lands under; the root when omitted. */
  readonly into?: string;

  /**
   * Read `from` as an archive and package the entries it holds, rather than adding the file
   * itself. Never inferred from the extension, so a JAR named without it is added as one file. The
   * source archive's own `META-INF/MANIFEST.MF` is dropped — the written archive carries the
   * manifest `manifest` and `mainClass` describe — and `into` re-roots what is left. A member whose
   * path would land outside the archive (`../x`, `/x`) fails the call.
   */
  readonly archive?: boolean;

  /** Globs dropped from this entry alone, on top of {@link ElideBuildJarOptions.exclude}. */
  readonly exclude?: readonly string[];
}

/** Options for {@link ElideBuildTools.jar}. */
interface ElideBuildJarOptions {
  /** Where the archive is written; parent directories are created. */
  readonly out: string;

  /**
   * What to package, in order. Two entries contributing the same archive path is not an error: the
   * last one wins, and the build warns naming the path and the source it was taken from. Nothing
   * is merged — a manifest `Jar` artifact unions `META-INF/services` files, this does not.
   */
  readonly entries: readonly ElideBuildJarEntry[];

  /**
   * Archive-relative path globs dropped from every entry, whatever its source, matched against the
   * path the entry would take inside the archive — after `into` re-roots it. Paths, not package
   * names: `"kotlin/**"` drops a package tree, `"META-INF/*.SF"` a file kind.
   */
  readonly exclude?: readonly string[];

  /**
   * Timestamp every entry is stamped with, ISO-8601 (`"2024-01-01T00:00:00Z"`). Makes a repack of
   * unchanged input byte-identical; without it entry times are not reproducible — an entry may carry
   * its file's modification time or the time of the call.
   */
  readonly date?: string;

  /** Main-section manifest attributes, added to `Manifest-Version` and `Created-By`. */
  readonly manifest?: Readonly<Record<string, string>>;

  /** The `Main-Class` attribute; wins over the same key in `manifest`. */
  readonly mainClass?: string;

  /** Keep the tool's output out of the build log. Defaults to `false`. */
  readonly quiet?: boolean;
}

/** Options for {@link ElideBuildTools.nativeImage}. */
interface ElideBuildNativeImageOptions {
  /** The `native-image` argument vector; relative paths in path-valued flags anchor on `cwd`. */
  readonly args: readonly string[];

  /** Working directory; relative paths resolve against the project root. Defaults to the root. */
  readonly cwd?: string;

  /** Keep the builder's output out of the build log. Defaults to `false`. */
  readonly quiet?: boolean;
}

/** Options for {@link ElideBuildTools.classpath}. */
interface ElideBuildClasspathOptions {
  /** Source set to answer for. Defaults to `"main"`, or `"test"` when `usage` is `"test"`. */
  readonly sourceSet?: string;

  /**
   * Which classpath: `"compile"` (what the compile tasks see), `"runtime"`, `"test"` (the test
   * set's runtime classpath), `"processor"` (annotation processors) or `"modules"`. Defaults to
   * `"compile"`.
   */
  readonly usage?: "compile" | "runtime" | "test" | "processor" | "modules";
}

/**
 * The built-in toolchain, called in-process: no child process, no second manifest parse, and
 * diagnostics reported through the build the way a built-in compile reports them. Every call
 * blocks until the tool returns. Paths are project-relative unless absolute; an output written
 * outside the project can be produced but never cached or restored.
 */
interface ElideBuildTools {
  /**
   * Version of this surface's option and result shapes. Moves on any incompatible change to them;
   * an addition does not move it. Branch on it when an extension must run against more than one.
   */
  readonly version: number;

  /**
   * Compile Kotlin (and mixed Java) sources with the embedded compiler. Plugins the manifest
   * declares or enables are applied as they are for `compile-kotlin-main`; no `-jvm-target` is
   * added unless `args` carries one. Requires the embedded toolchain: a manifest selecting a custom
   * or managed `kotlin.toolchain` is refused with a pointer to `exec`.
   */
  kotlinc(options: ElideBuildKotlincOptions): ElideBuildToolResult;

  /**
   * Compile Java sources with the embedded compiler. Requires the embedded toolchain: a manifest
   * selecting the external `jvm.java.compiler.mode` is refused with a pointer to `exec`.
   */
  javac(options: ElideBuildJavacOptions): ElideBuildToolResult;

  /**
   * Package directories, files and the contents of other archives into a JAR with the embedded
   * `jar` tool: one in-process call opens a source archive, drops entries by glob and writes a
   * reproducible result.
   */
  jar(options: ElideBuildJarOptions): ElideBuildToolResult;

  /** Run the embedded Native Image driver; the builder runs as a child JVM pinned to Elide's JDK. */
  nativeImage(options: ElideBuildNativeImageOptions): ElideBuildToolResult;

  /**
   * Format Kotlin or Java sources with the embedded ktfmt or google-java-format. Rewrites in
   * place unless `check`, which only reports; either way `changed` names the files that are not
   * already formatted, and each one arrives as a diagnostic too — a warning under `check`, an
   * info for a rewrite, an error for a file that could not be read or parsed. The exit status is
   * non-zero when a file failed, or when `check` found one to reformat.
   */
  format(options: ElideBuildFormatOptions): ElideBuildFormatResult;

  /**
   * The resolved dependency classpath, as absolute paths in classpath order. Answers what has been
   * resolved in this build, so a task reading it should `dependsOn: "maven-dependencies"`.
   */
  classpath(options?: ElideBuildClasspathOptions): readonly string[];
}

/** How a task was declared, as the build sees it. */
interface ElideBuildTaskInfo {
  readonly name: string;
  readonly description: string | null;

  /** Absolute path of the extension that declared this task. */
  readonly extension: string;

  /** Input patterns, the declared ones first and anything `prepare` added after them. */
  readonly inputs: readonly string[];

  /** Output patterns, declared and added alike. */
  readonly outputs: readonly string[];

  /** Whether the build cache may archive and restore this task's outputs. */
  readonly cache: boolean;

  /** The options this task declared, as the build validates and prints them. */
  readonly options: readonly ElideBuildTaskOption[];
}

/** One command-line option a task accepts, declared by {@link ElideBuildTaskOptions.options}. */
interface ElideBuildTaskOption {
  /** The flag's name, without leading dashes and in kebab-case: `"dry-run"` is `--dry-run`. */
  readonly name: string;

  /** Shown by `elide build --inspect` and `elide build <task> --help`. */
  readonly description?: string;

  /**
   * Whether the option takes a value: `"none"` is a bare flag and rejects `--name=x`, `"optional"`
   * accepts both spellings, and `"required"` rejects the bare form. Defaults to `"none"`.
   */
  readonly arity?: "none" | "optional" | "required";

  /** Whether the option may be passed more than once; read with `ctx.values`. Defaults to `false`. */
  readonly repeatable?: boolean;

  /** Whether `--no-<name>` is accepted, reading as `"false"`. Defaults to `false`. */
  readonly negatable?: boolean;

  /**
   * What a read falls back to when the option was not passed; a number or boolean is read back as
   * the string it was written as.
   */
  readonly default?: string | number | boolean;

  /**
   * Whether what this option was passed decides what the task produces, making it part of the
   * task's up-to-date check and of its cache key: a task that ran under `--release` is then neither
   * reported up to date nor restored from the cache for a run without it. Defaults to `true`.
   *
   * Turn it off for an option that changes whether or how loudly work happens rather than what it
   * produces — `--verbose`, a force switch — which would otherwise make every build spelled
   * differently miss the cache for no reason. An option the task reads without declaring is keyed
   * on by nothing at all.
   */
  readonly keyed?: boolean;
}

/** What changed since the last run the build recorded for a task. */
interface ElideBuildTaskChanges {
  /** Declared input patterns whose files changed. */
  readonly inputs: readonly string[];

  /** Declared output patterns that are missing or no longer what the last run left. */
  readonly outputs: readonly string[];

  /** Names of values `prepare` declared that differ from the last run's. */
  readonly values: readonly string[];

  /** Whether the extension file itself changed; it is an input like any other. */
  readonly extension: boolean;
}

/** One file a task declared, as the build stamps it. */
interface ElideBuildFile {
  /** Project-relative path, `/`-separated whatever the platform writes. */
  readonly path: string;

  /** Absolute path, for handing to a program or to `node:fs`. */
  readonly absolute: string;

  /** Size in bytes. */
  readonly size: number;

  /** Last modification, in epoch milliseconds. */
  readonly modified: number;

  /**
   * SHA-256 over the file's mode and contents, hex. Contents, not metadata: an edit that preserves
   * a file's size and modification time changes this.
   */
  readonly stamp: string;
}

/**
 * A task's declared inputs or outputs, resolved against the project and stamped — the same walk and
 * the same digest the build's own up-to-date checking runs on them.
 *
 * Resolution happens per call: an action reading `ctx.outputs` after writing them sees what it
 * produced, which is what the build is about to record.
 */
interface ElideBuildTaskFiles {
  /**
   * Every regular file the declarations name, sorted by path and without duplicates; a declaration
   * naming nothing contributes none. Narrow with one or more project-relative paths or globs, which
   * need not be ones this task declared.
   */
  files(
    ...patterns: readonly (string | readonly string[])[]
  ): readonly ElideBuildFile[];

  /**
   * SHA-256 over the paths, modes and contents of those same files, hex.
   *
   * One pattern answers exactly what the build recorded for that declaration, so comparing it with
   * a stamp kept in {@link ElideBuildTaskContext.state} tells a task what changed within a
   * declaration that {@link ElideBuildTaskChanges} only names as a whole.
   */
  stamp(...patterns: readonly (string | readonly string[])[]): string;
}

/**
 * A task's outputs, which its `prepare` hook and its action may both add to.
 *
 * An output added while the action runs is recorded with the rest when it returns, so a task that
 * only learns what it wrote by writing it still has its tree stamped and archived.
 */
interface ElideBuildTaskOutputs extends ElideBuildTaskFiles {
  /** Declare more project-relative paths or globs this task writes. */
  add(...patterns: readonly (string | readonly string[])[]): void;
}

/**
 * A task's inputs while `prepare` runs, which is the one phase that may add to them: the question
 * they answer — whether the task runs at all — is settled before the action starts.
 */
interface ElideBuildTaskInputs extends ElideBuildTaskFiles {
  /**
   * Declare more project-relative paths or globs whose contents decide whether the task re-runs.
   * Stamped exactly as a declared `inputs` entry is.
   */
  add(...patterns: readonly (string | readonly string[])[]): void;

  /**
   * Declare an input that is not a file: `value` decides whether the task re-runs, and keys its
   * cache entry, the way a declared pattern's contents do. Use it for anything the build can
   * compute but not stat — a resolved classpath, a tool version, what a task this one depends on
   * published through `ctx.state.of`.
   *
   * Strings, numbers, booleans, `null`, arrays and plain objects are stored, as in
   * {@link ElideBuildTaskState}. Declaring `undefined` or `null` declares nothing. A changed value
   * is named by {@link ElideBuildTaskChanges.values}.
   */
  value(name: string, value: unknown): void;
}

/**
 * What one task is up to, read by another task in the same build.
 *
 * Obtained from {@link ElideBuildTaskState.of}, which answers `null` when the named task published
 * nothing at all; a view whose {@link get} answers `null` is a task that published nothing under
 * that key.
 */
interface ElideBuildTaskStateView {
  /** Value recorded under `key`, or `null` when there is none. */
  get(key: string): unknown;

  /** Whether anything is recorded under `key`; `null` is a recorded value. */
  has(key: string): boolean;

  /** Every key recorded, in insertion order. */
  keys(): readonly string[];
}

/**
 * Values a task keeps between builds, stored as structure rather than text, and the way it reads
 * what another task recorded in this build.
 *
 * Strings, numbers, booleans, `null`, arrays and plain objects are stored; functions, symbols and
 * `undefined` are not, and a self-referential value is rejected. A failed run discards the task's
 * state entirely.
 */
interface ElideBuildTaskState {
  /** Value stored under `key` by an earlier build, or `null` when there is none. */
  get(key: string): unknown;
  /**
   * Record `value` under `key`. Storing `undefined` or `null` removes it.
   *
   * What a task keeps is also one of its outputs: it is handed to dependents on a build that
   * skipped this task, and it is what an up-to-date check compares a task that declares no files
   * against — from the build after the one that first published it.
   */
  set(key: string, value: unknown): void;

  /** Drop the value stored under `key`. */
  delete(key: string): void;

  /** Every key this task has stored, in insertion order. */
  keys(): readonly string[];

  /**
   * What the task named `task` is up to, or `null` when it published nothing — it is not a task an
   * extension declared, it was not in this build, it failed, or it has not run yet. Depend on the
   * task you read, or the answer is a race.
   *
   * A task the build skipped as up to date, or restored from the cache, answers with what it kept
   * the last time it ran: being up to date is a statement about its outputs, and what it published
   * is one of them. Reading your own name answers what you hold right now.
   */
  of(task: string): ElideBuildTaskStateView | null;
}

/**
 * What a task's `prepare` hook is called with: the build, plus the declarations it is there to
 * complete.
 *
 * Narrower than what the action gets, because a hook runs on every build — including the ones
 * where the task turns out to have nothing to do. It cannot run programs, reach the toolchain,
 * take the terminal, or ask what is dirty: that is the question it is helping to answer.
 */
interface ElideBuildPrepareContext {
  readonly project: ElideBuildProject;
  readonly manifest: ElideBuildManifest;
  readonly config: ElideBuildConfig;
  readonly layout: ElideBuildLayout;
  readonly options: ElideBuildOptions;
  readonly task: ElideBuildTaskInfo;

  /** This task's inputs, which the hook may add files and values to. */
  readonly inputs: ElideBuildTaskInputs;

  /** This task's outputs, which the hook may add to. */
  readonly outputs: ElideBuildTaskOutputs;

  /**
   * What this task kept the last time it ran, and what other tasks are up to — the usual source of
   * a derived input. Read-only here: what a task keeps is what its action kept.
   */
  readonly state: Omit<ElideBuildTaskState, "set" | "delete">;

  /** First value passed for the named build option, or `null`; as on the action's context. */
  option(name: string): string | null;

  /** The named build option as a boolean; as on the action's context. */
  flag(name: string): boolean;

  /** Every value passed for the named build option, in command-line order. */
  values(name: string): readonly string[];

  /** Write a line to the build log, attributed to this task. */
  log(...message: unknown[]): void;

  /** Write a warning, attributed to this task. */
  warn(...message: unknown[]): void;

  /** Write an error, attributed to this task. Does not fail the task on its own. */
  error(...message: unknown[]): void;
}

/** What a task's action is called with. */
interface ElideBuildTaskContext {
  readonly project: ElideBuildProject;
  readonly manifest: ElideBuildManifest;
  readonly config: ElideBuildConfig;
  readonly layout: ElideBuildLayout;
  readonly options: ElideBuildOptions;
  readonly task: ElideBuildTaskInfo;

  /** The files this task's `inputs` name, and their stamps. */
  readonly inputs: ElideBuildTaskFiles;

  /**
   * The files this task's `outputs` name, and their stamps. An action may `add` to them: an output
   * it only knows once it has written it is recorded with the rest when the action returns.
   */
  readonly outputs: ElideBuildTaskOutputs;

  /**
   * What changed since the last run. A task that never ran, or declared nothing, reports everything
   * as changed; a task with unchanged inputs and outputs is skipped without running.
   */
  readonly dirty: ElideBuildTaskChanges;

  /** Values this task keeps between builds, and what other tasks recorded in this one. */
  readonly state: ElideBuildTaskState;

  /**
   * First value passed for the named build option, or `null`. An option this task declared resolves
   * through its declaration, so `--no-<name>` reads as `"false"` and an absent option reads as its
   * declared default; any other name is read from the command line as parsed.
   */
  option(name: string): string | null;

  /**
   * The named build option as a boolean: a bare flag or `=true` is `true`, `--no-<name>` or
   * `=false` is `false`, and an option that was not passed reads as its declared default, else
   * `false`.
   */
  flag(name: string): boolean;

  /**
   * Every value passed for the named build option, in command-line order; empty when it was not
   * passed and declares no default. This is how a `repeatable` option is read.
   */
  values(name: string): readonly string[];

  /** Write a line to the build log, attributed to this task; build messages go to standard error. */
  log(...message: unknown[]): void;

  /** Write a warning, attributed to this task. */
  warn(...message: unknown[]): void;

  /** Write an error, attributed to this task. Does not fail the task on its own. */
  error(...message: unknown[]): void;

  /**
   * Fail this task, with [message] as the reason; the action keeps running and the failure is
   * reported when it returns.
   */
  fail(...message: unknown[]): void;

  /**
   * Fail this task and make the build exit with `code`, with [message] as the reason; `0` succeeds
   * instead, so `exit(exec(...).exitCode)` is the whole pass/fail decision. The code reaches the
   * process only when this task is the one that stopped the build; a code outside `0`-`255` wraps
   * the way a shell reports one, and never wraps to zero.
   */
  exit(code: number, ...message: unknown[]): void;

  /** Skip this task, with an optional reason shown in place of a completion message. */
  skip(...reason: unknown[]): void;

  /**
   * Run an external program and block until it exits; output streams through attributed to this task
   * unless `quiet` is set. No shell is involved: `args` reach the program as given. A bare `command`
   * is looked up on `PATH`; one containing a separator resolves against `cwd`.
   */
  exec(
    command: string,
    args?: readonly string[],
    options?: ElideBuildExecOptions,
  ): ElideBuildExecResult;

  /** Run an external program with no arguments of its own. */
  exec(command: string, options?: ElideBuildExecOptions): ElideBuildExecResult;

  /**
   * Run `body` with the terminal: the progress display stops drawing for exactly as long as it
   * takes, and resumes however it ends. Reach for it only when something writes to the build's own
   * descriptors — a child spawned with inherited stdio, a REPL, a debugger — which the display
   * cannot linearize. Output written through `ctx.log`, `ctx.exec`, `ctx.tools` or your task's own
   * `console` needs none of it.
   *
   * An `async` `body` keeps the terminal until its promise settles, so `await ctx.foreground(...)`
   * answers what `body` answered and rethrows what it threw.
   */
  foreground<T>(body: () => T): T;

  /** The built-in toolchain, called in-process. */
  readonly tools: ElideBuildTools;
}

/** Options accepted by {@link ElideBuild.task}. */
interface ElideBuildTaskOptions {
  /** Shown by `elide build --inspect`. */
  readonly description?: string;

  /** Task keys that must complete before this one runs. */
  readonly dependsOn?: readonly string[] | string;

  /**
   * Tasks that must not start until this one has run; the inverse of `dependsOn`, and the only way to
   * precede a task this extension did not declare. `deps`, `compile` and `test` name every task in
   * that group; any other name is a task key, and an unregistered one fails the build. A task named
   * here pulls this one into the build whenever it runs, regardless of `default`.
   */
  readonly before?: readonly string[] | string;

  /**
   * Group this task joins: `deps`, `compile` and `test` are the groups `elide build <target>`
   * resolves; any other name mints a group, letting several tasks share one target name.
   */
  readonly group?: string;

  /** Whether a bare `elide build` runs this task. Defaults to `true`. */
  readonly default?: boolean;

  /**
   * Project-relative paths or globs whose contents decide whether the task re-runs; up-to-date
   * checking needs inputs — declared, or added by `prepare` — *and* something to compare them
   * against: `outputs`, or the state the task publishes through {@link ElideBuildTaskState.set}.
   * The extension file is always an input.
   *
   * "Contents" is literal: each declaration is stamped by hashing the mode and bytes of every file
   * it names, and the action reads the same files and the same stamps through `ctx.inputs`.
   */
  readonly inputs?: readonly string[];

  /** Project-relative paths or globs the task writes; stamped as `inputs` are, through `ctx.outputs`. */
  readonly outputs?: readonly string[];

  /**
   * Run before this task's up-to-date check, to declare what only the running build can name: a
   * generated source tree, a classpath another task resolved, a value that decides whether the
   * work is still current. What it adds is stamped, keyed and reported exactly as a declared
   * `inputs`/`outputs` entry is.
   *
   * Runs on every build the task is part of, including the ones where the action never does, so
   * keep it to deriving declarations. Returning `false` fails the task before it runs; throwing
   * reports the error. May be `async`.
   */
  readonly prepare?: ElideBuildTaskPrepare;

  /**
   * Whether the build cache may archive this task's outputs and restore them on a later build, in a
   * different checkout included. Defaults to `true`; applies only to a task that is up-to-date
   * checked at all. Turn it off for a task whose outputs depend on anything its inputs do not name.
   */
  readonly cache?: boolean;

  /**
   * Command-line options this task accepts, shown by `elide build --inspect` and `elide build
   * <task> --help` and checked before any task runs: a flag nobody declares fails the build. Read
   * them with `ctx.option`, `ctx.flag` and `ctx.values`.
   */
  readonly options?: readonly ElideBuildTaskOption[];
}

/**
 * A task's action; may be `async`, in which case the build waits for it. Returning `false` fails the
 * task; any other value, including none, succeeds.
 */
type ElideBuildTaskAction = (
  ctx: ElideBuildTaskContext,
) => void | boolean | Promise<void | boolean>;

/**
 * A task's `prepare` hook; may be `async`, in which case the build waits for it. Returning `false`
 * fails the task; any other value, including none, proceeds to the up-to-date check.
 */
type ElideBuildTaskPrepare = (
  ctx: ElideBuildPrepareContext,
) => void | boolean | Promise<void | boolean>;

/** What a build extension's default export is called with. */
interface ElideBuild {
  readonly project: ElideBuildProject;
  readonly manifest: ElideBuildManifest;
  readonly config: ElideBuildConfig;
  readonly layout: ElideBuildLayout;
  readonly options: ElideBuildOptions;

  /** First value passed for the named build option, or `null`. */
  option(name: string): string | null;

  /** Declare a build task. */
  task(name: string, action: ElideBuildTaskAction): void;

  /** Declare a build task with options. */
  task(
    name: string,
    options: ElideBuildTaskOptions,
    action: ElideBuildTaskAction,
  ): void;
}

/** A build extension module's default export; runs during configuration, before any task, and may be `async`. */
type ElideBuildExtension = (build: ElideBuild) => void | Promise<void>;
