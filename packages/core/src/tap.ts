/** A `SKIP`/`TODO` directive on a test point; `reason` is empty when the directive carried none. */
export interface TapDirective {
  type: "skip" | "todo";
  reason: string;
}

/** The YAMLish block a failing test point carries: the failure's message, the runner's code, and raw detail lines. */
export interface TapDiagnostics {
  message?: string;
  severity?: string;
  /** Detail lines (assertion rendering, stack frames) with the block's own indentation removed. */
  detail: string[];
}

/** One event decoded from the TAP 13 stream `elide test --reporter=tap` writes on stdout. */
export type TapEvent =
  | { kind: "version"; version: number }
  | { kind: "plan"; count: number }
  /**
   * A test began. Start numbers are a sequence of their own, in start order, and tag the test's output lines; the
   * label, not the number, is what joins a start to its result.
   */
  | { kind: "start"; n: number; label: string }
  /** One line a test wrote: `# out <n>: <text>`, or `# out: <text>` for output no test owns. */
  | { kind: "output"; n: number | undefined; text: string }
  | {
      kind: "result";
      n: number | undefined;
      label: string;
      ok: boolean;
      directive?: TapDirective;
      diagnostics?: TapDiagnostics;
    }
  /** A line that is not part of the protocol: build progress, or another tool writing to the same stream. */
  | { kind: "other"; line: string };

const VERSION = /^TAP version (\d+)\s*$/;
const PLAN = /^(\d+)\.\.(\d+)\s*$/;
const START = /^# start (\d+): (.*)$/;
const OUTPUT = /^# out(?: (\d+))?: (.*)$/;
const POINT = /^(not ok|ok)\b\s*(\d+)?\s*(?:-\s*)?(.*)$/;

const BLOCK_START = "  ---";
const BLOCK_END = "  ...";
const FIELD_INDENT = "  ";
const DETAIL_INDENT = "    ";
const DETAIL_FIELD = "  detail: |";
const MESSAGE_FIELD = "  message:";
const SEVERITY_FIELD = "  severity:";

/** Index of the first unescaped `#` in a test point's description, or `-1`: the writer escapes a literal one. */
function directiveStart(description: string): number {
  for (let i = 0; i < description.length; i++) {
    const char = description[i];
    if (char === "\\") i++;
    else if (char === "#") return i;
  }
  return -1;
}

/** Undo a description's escaping: a backslash quotes the character after it (`\#` → `#`, `\\` → `\`). */
function unescapeDescription(value: string): string {
  if (!value.includes("\\")) return value;
  let out = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "\\" && i + 1 < value.length) i++;
    out += value[i];
  }
  return out;
}

/** Decode the double-quoted YAML scalar the writer gives a diagnostic field; unquoted input is returned as-is. */
function decodeYamlScalar(value: string): string {
  const quoted = value.trim();
  if (quoted.length < 2 || !quoted.startsWith('"') || !quoted.endsWith('"')) return quoted;
  const body = quoted.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\" || i + 1 >= body.length) {
      out += body[i];
      continue;
    }
    const escaped = body[i + 1];
    out += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped === "r" ? "\r" : escaped;
    i++;
  }
  return out;
}

/** A result line held back until its diagnostic block is known to be complete, or known not to exist. */
interface PendingResult {
  n: number | undefined;
  label: string;
  ok: boolean;
  directive: TapDirective | undefined;
  inBlock: boolean;
  inDetail: boolean;
  message: string | undefined;
  severity: string | undefined;
  detail: string[];
}

/**
 * Incremental decoder for the TAP 13 stream `elide test --reporter=tap` produces.
 *
 * Lines are fed as they arrive and decoded in place, so a run is reported while it is still going. Only the framing
 * Elide's writer produces is recognised; anything else is passed through as an `other` event rather than dropped,
 * because the CLI shares stdout with whatever a test prints outside a test point.
 */
export class TapParser {
  private pending: PendingResult | undefined;

  constructor(private readonly emit: (event: TapEvent) => void) {}

  /** Decode one line, without its terminator. */
  feed(line: string): void {
    if (!this.consumedByBlock(line)) this.dispatch(line);
  }

  /** Flush a result whose diagnostic block the stream cut short. */
  end(): void {
    this.flushPending();
  }

  private flushPending(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;

    const hasDiagnostics = pending.message !== undefined || pending.severity !== undefined || pending.detail.length > 0;
    this.emit({
      kind: "result",
      n: pending.n,
      label: pending.label,
      ok: pending.ok,
      ...(pending.directive ? { directive: pending.directive } : {}),
      ...(hasDiagnostics
        ? {
            diagnostics: {
              ...(pending.message !== undefined ? { message: pending.message } : {}),
              ...(pending.severity !== undefined ? { severity: pending.severity } : {}),
              detail: pending.detail,
            },
          }
        : {}),
    });
  }

  /**
   * Consume a line as part of a held-back result's diagnostic block, reporting whether it belonged to one.
   *
   * The writer emits a result and its block as one contiguous run, so the line right after a result is the only
   * place a block can open, and every line inside one is indented. A block the stream cut short therefore ends at
   * the first line that is not, rather than swallowing everything that follows it.
   */
  private consumedByBlock(line: string): boolean {
    const pending = this.pending;
    if (!pending) return false;

    if (!pending.inBlock) {
      if (line !== BLOCK_START) {
        this.flushPending();
        return false;
      }
      pending.inBlock = true;
      return true;
    }

    if (line === BLOCK_END) {
      this.flushPending();
      return true;
    }
    if (!line.startsWith(FIELD_INDENT)) {
      this.flushPending();
      return false;
    }

    if (pending.inDetail && line.startsWith(DETAIL_INDENT)) {
      pending.detail.push(line.slice(DETAIL_INDENT.length));
    } else if (line === DETAIL_FIELD) {
      pending.inDetail = true;
    } else if (line.startsWith(MESSAGE_FIELD)) {
      pending.inDetail = false;
      pending.message = decodeYamlScalar(line.slice(MESSAGE_FIELD.length));
    } else if (line.startsWith(SEVERITY_FIELD)) {
      pending.inDetail = false;
      pending.severity = decodeYamlScalar(line.slice(SEVERITY_FIELD.length));
    } else {
      pending.inDetail = false;
    }
    return true;
  }

  private dispatch(line: string): void {
    const version = VERSION.exec(line);
    if (version) return this.emit({ kind: "version", version: Number(version[1]) });

    const plan = PLAN.exec(line);
    if (plan) return this.emit({ kind: "plan", count: Number(plan[2]) });

    const point = POINT.exec(line);
    if (point) {
      this.pending = this.pendingResult(point[1] === "not ok", point[2], point[3] ?? "");
      return;
    }

    const start = START.exec(line);
    if (start) return this.emit({ kind: "start", n: Number(start[1]), label: unescapeDescription(start[2] ?? "") });

    const output = OUTPUT.exec(line);
    if (output) {
      return this.emit({ kind: "output", n: output[1] === undefined ? undefined : Number(output[1]), text: output[2] ?? "" });
    }

    this.emit({ kind: "other", line });
  }

  /** Split a test point's description into its label and its directive. */
  private pendingResult(notOk: boolean, number: string | undefined, description: string): PendingResult {
    const hash = directiveStart(description);
    const label = unescapeDescription((hash < 0 ? description : description.slice(0, hash)).trimEnd());
    const text = hash < 0 ? undefined : description.slice(hash + 1).trim();

    let directive: TapDirective | undefined;
    if (text !== undefined) {
      const type = /^skip\b/i.test(text) ? "skip" : /^todo\b/i.test(text) ? "todo" : undefined;
      if (type) directive = { type, reason: unescapeDescription(text.slice(4).trim()) };
    }

    return {
      n: number === undefined ? undefined : Number(number),
      label,
      ok: !notOk,
      directive,
      inBlock: false,
      inDetail: false,
      message: undefined,
      severity: undefined,
      detail: [],
    };
  }
}
