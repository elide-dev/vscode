/**
 * Argument vectors for Elide CLI invocations.
 *
 * Every editor integration ends up assembling the same command line: a subcommand, global build flags (`-f`), CLI
 * options, positional arguments (build targets, test paths, the file `elide run` runs) and — after `--` — the
 * arguments the program or subprocess receives. Options are kept as a plain record instead of a typed field per
 * flag: the set a given Elide release accepts changes, and both the task definitions and the launch configurations
 * feeding this module come from user-authored JSON.
 */

/** Elide subcommands the integration drives directly. */
export type ElideCommand = "build" | "run" | "test" | "install";

/**
 * Value of one CLI option. `true` emits the bare flag, `false` drops it (so a launch configuration or task can
 * cancel an option inherited from the settings), and an array repeats the option once per element.
 */
export type ElideOptionValue = string | number | boolean | readonly (string | number)[];

export interface ElideInvocationOptions {
  /** Positional arguments of the subcommand: build targets, test paths, or the file `elide run` runs. */
  args?: readonly string[];
  /** `-f NAME[=VALUE]` build flags, visible to the manifest as `build.flags`. */
  flags?: readonly string[];
  /** CLI options, keyed by name with or without dashes: `{ "no-cache": true, reporter: "tap" }`. */
  options?: Readonly<Record<string, ElideOptionValue>>;
  /** Arguments after `--`: the application's own arguments for `run`, subprocess passthrough for `build`/`test`. */
  programArgs?: readonly string[];
  /** Extra environment variables for the Elide process. */
  env?: Readonly<Record<string, string>>;
}

/** `-f` tokens for build flags; empty entries are dropped. */
export function elideFlagArgs(flags: readonly string[] | undefined): string[] {
  const argv: string[] = [];
  for (const flag of flags ?? []) {
    const trimmed = flag.trim();
    if (trimmed.length > 0) argv.push("-f", trimmed);
  }
  return argv;
}

/**
 * Tokens for one option. A name without a leading dash is dashed by length (`t` → `-t`, `reporter` →
 * `--reporter`); long options take their value with `=`, short ones as a separate token.
 */
function optionArgs(name: string, value: ElideOptionValue): string[] {
  const trimmed = name.trim();
  if (trimmed.length === 0) return [];
  const flag = trimmed.startsWith("-") ? trimmed : trimmed.length === 1 ? `-${trimmed}` : `--${trimmed}`;
  const long = flag.startsWith("--");
  const argv: string[] = [];
  for (const entry of Array.isArray(value) ? value : [value as string | number | boolean]) {
    if (entry === false) continue;
    if (entry === true) {
      argv.push(flag);
      continue;
    }
    if (long) argv.push(`${flag}=${entry}`);
    else argv.push(flag, String(entry));
  }
  return argv;
}

/**
 * Complete argument vector for `elide <command>`.
 *
 * Flags and options come before the positional arguments, which is the order `elide run` documents
 * (`elide run [FLAGS] [FILE] [-- SCRIPT_ARGS]`) and which `build` and `test` accept in any order.
 */
export function elideInvocationArgs(command: string, options: ElideInvocationOptions = {}): string[] {
  const argv = [command, ...elideFlagArgs(options.flags)];
  for (const [name, value] of Object.entries(options.options ?? {})) argv.push(...optionArgs(name, value));
  argv.push(...(options.args ?? []));
  if (options.programArgs && options.programArgs.length > 0) argv.push("--", ...options.programArgs);
  return argv;
}

/**
 * Layer invocation options left to right: `args`, `flags` and `programArgs` concatenate, `options` and `env` keys
 * override. Used to apply workspace-level defaults under a task definition or launch configuration.
 */
export function mergeElideInvocationOptions(...layers: readonly (ElideInvocationOptions | undefined)[]): ElideInvocationOptions {
  const args: string[] = [];
  const flags: string[] = [];
  const programArgs: string[] = [];
  const options: Record<string, ElideOptionValue> = {};
  const env: Record<string, string> = {};
  for (const layer of layers) {
    if (!layer) continue;
    args.push(...(layer.args ?? []));
    flags.push(...(layer.flags ?? []));
    programArgs.push(...(layer.programArgs ?? []));
    Object.assign(options, layer.options);
    Object.assign(env, layer.env);
  }
  return {
    ...(args.length > 0 ? { args } : {}),
    ...(flags.length > 0 ? { flags } : {}),
    ...(programArgs.length > 0 ? { programArgs } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

/** Strings of an unknown JSON array; anything else yields an empty list. */
export function elideStringArrayFrom(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Option record read out of user-authored JSON (a setting, a task definition, a launch configuration). Entries of
 * an unsupported type are dropped rather than stringified, so a mistyped setting cannot smuggle `[object Object]`
 * onto the command line.
 */
export function elideOptionsFrom(value: unknown): Record<string, ElideOptionValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const options: Record<string, ElideOptionValue> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry))) {
      options[name] = entry;
      continue;
    }
    if (!Array.isArray(entry)) continue;
    const list = entry.filter((item): item is string | number => typeof item === "string" || (typeof item === "number" && Number.isFinite(item)));
    if (list.length > 0) options[name] = list;
  }
  return options;
}

/** Environment record read out of user-authored JSON; non-string values are dropped. */
export function elideEnvFrom(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const env: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) if (typeof entry === "string") env[name] = entry;
  return env;
}

/** Every invocation option a user-authored object carries; absent or mistyped fields are simply left out. */
export function elideInvocationOptionsFrom(value: unknown): ElideInvocationOptions {
  if (typeof value !== "object" || value === null) return {};
  const source = value as Record<string, unknown>;
  const args = elideStringArrayFrom(source.args);
  const flags = elideStringArrayFrom(source.flags);
  const programArgs = elideStringArrayFrom(source.programArgs);
  const options = elideOptionsFrom(source.options);
  const env = elideEnvFrom(source.env);
  return {
    ...(args.length > 0 ? { args } : {}),
    ...(flags.length > 0 ? { flags } : {}),
    ...(programArgs.length > 0 ? { programArgs } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}
