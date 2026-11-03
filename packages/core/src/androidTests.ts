import type { ElideRecord } from "./buildOutput.js";

/**
 * What `elide build android-test-<artifact>` reports about the instrumented tests it ran.
 *
 * The target has no structured result form: it reports each finished test as a message of its own — `<class>#<method>
 * passed` or `… skipped` as output, `… failed` as an error followed by an error carrying the stack trace — then a
 * `<n> passed, <n> failed, <n> skipped` summary, and an error of its own when the run did not finish or ran nothing.
 * Under `ELIDE_PROGRESS=json` each message is one record, which keeps a multi-line stack trace together.
 */

export type AndroidTestOutcome = "passed" | "failed" | "skipped";

export interface AndroidTestResult {
  /** Binary name of the test class: `sample.DeviceTest`, `sample.Outer$Inner`. */
  className: string;
  /** Test method; Android allows spaces in a method name from API 30. */
  method: string;
  outcome: AndroidTestOutcome;
  /** Stack trace of a failed test, as the runner reported it. */
  detail?: string;
}

/** `sample.DeviceTest#verifiesApi passed`: a class name holds neither `#` nor whitespace, a method name may. */
const RESULT = /^(?:error:\s+)?([^\s#]+)#(.+) (passed|failed|skipped)$/;
/** `2 passed, 0 failed, 0 skipped`. */
const SUMMARY = /^\d+ passed, \d+ failed, \d+ skipped$/;

/** The test result one message reports, if it reports one. */
export function parseAndroidTestResult(text: string): AndroidTestResult | undefined {
  const match = RESULT.exec(text.trim());
  return match ? { className: match[1]!, method: match[2]!, outcome: match[3] as AndroidTestOutcome } : undefined;
}

/**
 * Reads the message records of one `android-test-<artifact>` run. A failed test is reported once the message after
 * it says whether it carries the stack trace; every other error the target reports is a problem of the run itself.
 */
export class AndroidTestResultParser {
  private pending: AndroidTestResult | undefined;

  constructor(
    /** Unqualified name of the test target, whose messages are the ones read. */
    private readonly task: string,
    private readonly onResult: (result: AndroidTestResult) => void,
    /** An error message that is not a test's: no device, no instrumentation, no test ran, the run did not finish. */
    private readonly onProblem: (text: string) => void,
  ) {}

  accept(record: ElideRecord): void {
    if (record.type !== "message" || !this.ownTask(record.task)) return;
    const text = record.text.replace(/^error:\s+/, "");
    const result = parseAndroidTestResult(text);
    if (!result && record.level === "error" && this.pending) {
      this.onResult({ ...this.pending, detail: text });
      this.pending = undefined;
      return;
    }
    this.flush();
    if (result?.outcome === "failed") this.pending = result;
    else if (result) this.onResult(result);
    else if (record.level === "error" && !SUMMARY.test(text.trim())) this.onProblem(text);
  }

  /** The run ended: a failure still waiting for its stack trace is reported without one. */
  end(): void {
    this.flush();
  }

  private flush(): void {
    if (this.pending) this.onResult(this.pending);
    this.pending = undefined;
  }

  /** A workspace qualifies the task with its project (`app:android-test-app`); a record naming none is the build's. */
  private ownTask(task: string | undefined): boolean {
    return task === undefined || task === this.task || task.endsWith(`:${this.task}`);
  }
}
