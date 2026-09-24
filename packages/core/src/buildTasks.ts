/** One flag a build task declares, as `elide build --inspect` lists it. */
export interface BuildTaskOption {
  option: string;
  description: string;
}

/** A target of `elide build <name>`, with the options it accepts. */
export interface BuildTaskInfo {
  /** Target name exactly as listed, which is what `elide build` accepts back: qualified (`core:jar`) in a workspace. */
  name: string;
  description: string;
  options: BuildTaskOption[];
  /** Workspace project the listing groups the task under; absent for a project outside a workspace. */
  project?: string;
}

/**
 * `8 tasks available:` for a standalone project, `43 tasks across 5 projects:` for a workspace — the line the task
 * table starts after.
 */
const HEADER = /^\d+ tasks? (?:available|across \d+ projects?):$/;
/** A workspace group header: an unindented project name, which Elide forbids whitespace and colons in. */
const GROUP = /^[^\s:]+$/;
/** `  compile-kotlin-main   Compile main Kotlin source files to bytecode` */
const TASK = /^ {2}(\S+)(?: {2,}(.*))?$/;
/** `    --debugger   Attach JDWP debugger, optionally specify host:port` */
const OPTION = /^ {4}(-\S+)(?: {2,}(.*))?$/;
/** Separator between the project a workspace task belongs to and the task's own name. */
const SCOPE_SEPARATOR = ":";

/**
 * Parse the task table `elide build --inspect` prints (there is no JSON form).
 *
 * The table is indented under a `<n> tasks available:` header and ends at the first unindented line, which is the
 * `Global options:` section. Indented lines that are neither a task nor an option row (`no options declared`) are
 * ignored; without a header the output holds no table and the result is empty.
 *
 * In a workspace the listing covers every project of the build graph, wherever it is run from: the header reads
 * `<n> tasks across <m> projects:` and the rows are grouped by project, each group opened by the bare project name at
 * column zero. An unindented line then no longer ends the table by itself; a project name is told apart from a
 * trailing section (`Global options:`) by carrying neither whitespace nor a colon.
 */
export function parseBuildInspect(text: string): BuildTaskInfo[] {
  const lines = text.split("\n").map((line) => line.replace(/\s+$/, ""));
  let index = lines.findIndex((line) => HEADER.test(line));
  if (index < 0) return [];

  const tasks: BuildTaskInfo[] = [];
  let project: string | undefined;
  for (index++; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.length === 0) continue;
    if (!line.startsWith(" ")) {
      if (!GROUP.test(line)) break;
      project = line;
      continue;
    }

    const option = OPTION.exec(line);
    const last = tasks[tasks.length - 1];
    if (option && last) {
      last.options.push({ option: option[1] ?? "", description: option[2]?.trim() ?? "" });
      continue;
    }
    const task = TASK.exec(line);
    if (task) tasks.push({ name: task[1] ?? "", description: task[2]?.trim() ?? "", options: [], ...(project ? { project } : {}) });
  }
  return tasks;
}

/**
 * The tasks of the project Elide knows as `project`, out of a listing that may cover a whole workspace. A listing
 * that groups nothing belongs to a standalone project, which is all of it.
 */
export function buildTasksOf(tasks: readonly BuildTaskInfo[], project: string): BuildTaskInfo[] {
  return tasks.filter((task) => task.project === undefined || task.project === project);
}

/** A task's own name, without the project scope a workspace listing qualifies it with (`core:jar` → `jar`). */
export function unqualifiedTaskName(task: BuildTaskInfo): string {
  const scope = `${task.project}${SCOPE_SEPARATOR}`;
  return task.project !== undefined && task.name.startsWith(scope) ? task.name.slice(scope.length) : task.name;
}
