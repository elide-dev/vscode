/** One flag a build task declares, as `elide build --inspect` lists it. */
export interface BuildTaskOption {
  option: string;
  description: string;
}

/** A target of `elide build <name>`, with the options it accepts. */
export interface BuildTaskInfo {
  name: string;
  description: string;
  options: BuildTaskOption[];
}

/** `8 tasks available:` — the line the task table starts after. */
const HEADER = /^\d+ tasks? available:$/;
/** `  compile-kotlin-main   Compile main Kotlin source files to bytecode` */
const TASK = /^ {2}(\S+)(?: {2,}(.*))?$/;
/** `    --debugger   Attach JDWP debugger, optionally specify host:port` */
const OPTION = /^ {4}(-\S+)(?: {2,}(.*))?$/;

/**
 * Parse the task table `elide build --inspect` prints (there is no JSON form).
 *
 * The table is indented under a `<n> tasks available:` header and ends at the first unindented line, which is the
 * `Global options:` section. Indented lines that are neither a task nor an option row (`no options declared`) are
 * ignored; without a header the output holds no table and the result is empty.
 */
export function parseBuildInspect(text: string): BuildTaskInfo[] {
  const lines = text.split("\n").map((line) => line.replace(/\s+$/, ""));
  let index = lines.findIndex((line) => HEADER.test(line));
  if (index < 0) return [];

  const tasks: BuildTaskInfo[] = [];
  for (index++; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.length === 0) continue;
    if (!line.startsWith(" ")) break;

    const option = OPTION.exec(line);
    const last = tasks[tasks.length - 1];
    if (option && last) {
      last.options.push({ option: option[1] ?? "", description: option[2]?.trim() ?? "" });
      continue;
    }
    const task = TASK.exec(line);
    if (task) tasks.push({ name: task[1] ?? "", description: task[2]?.trim() ?? "", options: [] });
  }
  return tasks;
}
