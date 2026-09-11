import type { ChildProcess } from "node:child_process";
import path from "node:path";
import {
  ElideCli,
  ElideCommandFailedError,
  TapParser,
  isPathUnder,
  jvmTestNamePattern,
  normalizePath,
  parseTapLabel,
  resolveElideDistribution,
  scanJvmTestSource,
  type ScannedTestClass,
  type TapDiagnostics,
  type TapEvent,
} from "@elide/ide-core";
import * as vscode from "vscode";
import { readConfig } from "./config.js";
import { launchWithJdwp, resolveAttachType } from "./debug.js";
import type { ElideUi } from "./output.js";
import type { ElideProject, ElideWorkspace } from "./projects.js";

/** Test sources are scanned with a delay while the user types, so a keystroke does not re-parse the file. */
const RESCAN_DEBOUNCE_MS = 300;
const SOURCE_GLOB = "**/*.{kt,java}";
const JVM_SOURCE = /\.(?:kt|java)$/;
/** A stack frame in a failure's detail block: `at sample.MainTest.failing(MainTest.kt:15)`. */
const DETAIL_LOCATION = /\((\w+\.(?:kt|java)):(\d+)\)/;
/** How much of a failed run's stderr is shown on the test items it never reported a result for. */
const STDERR_TAIL_LINES = 20;

type Outcome = "passed" | "failed" | "skipped" | "errored";

/** Item ids grouped by outcome, filled while a run reports results. */
export type TestRunSummary = Record<Outcome, string[]>;

/** What `activate` exposes for the extension-host integration test. */
export interface ElideTestApi {
  runAll(): Promise<TestRunSummary>;
}

/** Item ids: `p:<root>` project, `c:<root>:<binaryName>` class, `m:<root>:<binaryName>#<method>` test method. */
const projectItemId = (root: string): string => `p:${root}`;
const methodItemId = (root: string, binaryName: string, method: string): string => `m:${root}:${binaryName}#${method}`;

/** Everything a run does for one project: which tests were asked for, and which leaves they cover. */
interface RunGroup {
  project: ElideProject;
  projectItem: vscode.TestItem;
  /** Nothing narrower than the project was selected: run the whole suite instead of a `-t` pattern. */
  wholeProject: boolean;
  targets: { binaryName: string; method?: string }[];
  leaves: vscode.TestItem[];
}

/**
 * Test Explorer for JVM tests of Elide projects.
 *
 * Discovery is static: the test source roots of the project model are scanned for JUnit declarations, so the tree is
 * populated without compiling or running anything. A run shells out to `elide test --reporter=tap` and maps the TAP
 * stream back onto those items; the Debug profile runs the same command under a JDWP agent and attaches.
 */
export class ElideTestController implements vscode.Disposable {
  private readonly controller = vscode.tests.createTestController("elide", "Elide");
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly rescans = new Map<string, NodeJS.Timeout>();
  /** Discovery is serialized: a refresh triggered while one runs waits for it instead of racing its item updates. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly workspace: ElideWorkspace,
    private readonly ui: ElideUi,
    /** Attach sessions and the Elide process each owns, shared with the debug configuration provider. */
    private readonly sessions: Map<string, ChildProcess>,
  ) {
    this.controller.refreshHandler = () => this.refreshAll();
    const handler = (request: vscode.TestRunRequest, token: vscode.CancellationToken) => void this.run(request, token);
    this.controller.createRunProfile("Run", vscode.TestRunProfileKind.Run, handler, true);
    this.controller.createRunProfile("Debug", vscode.TestRunProfileKind.Debug, handler, true);

    const watcher = vscode.workspace.createFileSystemWatcher(SOURCE_GLOB);
    this.subscriptions.push(
      watcher,
      watcher.onDidCreate((uri) => this.scheduleRescan(uri)),
      watcher.onDidChange((uri) => this.scheduleRescan(uri)),
      watcher.onDidDelete((uri) => this.forget(uri)),
      // An unsaved edit is what the user sees in the gutter; the watcher only reports the file once it is written.
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length > 0) this.scheduleRescan(e.document.uri);
      }),
      // A new model can add, move or drop test source roots.
      this.workspace.onDidChange(() => void this.refreshAll()),
    );
  }

  dispose(): void {
    for (const timer of this.rescans.values()) clearTimeout(timer);
    this.rescans.clear();
    for (const d of this.subscriptions) d.dispose();
    this.controller.dispose();
  }

  /** Run every discovered test of every project, reporting the outcome per item id (used by the integration test). */
  async runAll(): Promise<TestRunSummary> {
    await this.refreshAll();
    const include = [...this.controller.items].map(([, item]) => item);
    const summary: TestRunSummary = { passed: [], failed: [], skipped: [], errored: [] };
    if (include.length === 0) return summary;
    const cancellation = new vscode.CancellationTokenSource();
    try {
      await this.run(new vscode.TestRunRequest(include), cancellation.token, summary);
    } finally {
      cancellation.dispose();
    }
    return summary;
  }

  // --- discovery -------------------------------------------------------------------------------------------------

  refreshAll(): Promise<void> {
    this.queue = this.queue.then(async () => {
      try {
        await this.refreshNow();
      } catch (e) {
        this.ui.log(`test discovery failed: ${describe(e)}`);
      }
    });
    return this.queue;
  }

  private async refreshNow(): Promise<void> {
    const live = new Set<string>();
    for (const project of this.workspace.projects) {
      // Without a model the test source roots are unknown; the project appears once its first sync resolves.
      if (!project.model) continue;
      live.add(projectItemId(project.root));
      await this.refreshProject(project);
    }
    const stale = [...this.controller.items].filter(([id]) => !live.has(id));
    for (const [id] of stale) this.controller.items.delete(id);
  }

  private async refreshProject(project: ElideProject): Promise<void> {
    const item = this.projectItem(project);
    const files = new Set<string>();
    for (const dir of testDirs(project)) {
      const found = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(dir), SOURCE_GLOB));
      for (const uri of found) files.add(uri.fsPath);
    }
    // Full rebuild: items of files that were deleted or moved out of a test root go with it.
    item.children.replace([]);
    for (const file of [...files].sort()) await this.scan(item, project, vscode.Uri.file(file));
  }

  private async scan(projectItem: vscode.TestItem, project: ElideProject, uri: vscode.Uri): Promise<void> {
    const text = await readSource(uri);
    if (text === undefined) {
      deleteFileItems(projectItem, uri.fsPath);
      return;
    }
    const language = path.extname(uri.fsPath) === ".java" ? "java" : "kotlin";
    this.applyScan(projectItem, project, uri, scanJvmTestSource(text, language).classes);
  }

  private applyScan(projectItem: vscode.TestItem, project: ElideProject, uri: vscode.Uri, classes: readonly ScannedTestClass[]): void {
    deleteFileItems(projectItem, uri.fsPath);
    // Declaration order: an enclosing class is always created before the classes nested in it.
    const created = new Map<string, vscode.TestItem>();
    for (const cls of classes) {
      const nested = cls.binaryName.lastIndexOf("$");
      const parent = (nested > 0 ? created.get(cls.binaryName.slice(0, nested)) : undefined) ?? projectItem;
      const item = this.controller.createTestItem(`c:${project.root}:${cls.binaryName}`, cls.simpleName, uri);
      item.range = new vscode.Range(cls.line, 0, cls.line, 0);
      parent.children.add(item);
      created.set(cls.binaryName, item);
      for (const method of cls.methods) {
        const child = this.controller.createTestItem(methodItemId(project.root, cls.binaryName, method.name), method.name, uri);
        child.range = new vscode.Range(method.line, 0, method.line, 0);
        item.children.add(child);
      }
    }
  }

  private scheduleRescan(uri: vscode.Uri): void {
    if (uri.scheme !== "file" || !JVM_SOURCE.test(uri.fsPath)) return;
    const project = this.testProjectFor(uri);
    if (!project) return;
    const key = uri.fsPath;
    clearTimeout(this.rescans.get(key));
    this.rescans.set(
      key,
      setTimeout(() => {
        this.rescans.delete(key);
        const item = this.controller.items.get(projectItemId(project.root));
        if (item) void this.scan(item, project, uri);
      }, RESCAN_DEBOUNCE_MS),
    );
  }

  private forget(uri: vscode.Uri): void {
    if (!JVM_SOURCE.test(uri.fsPath)) return;
    for (const [, item] of this.controller.items) deleteFileItems(item, uri.fsPath);
  }

  /** The project whose test source roots contain `uri`, if any. */
  private testProjectFor(uri: vscode.Uri): ElideProject | undefined {
    const file = normalizePath(uri.fsPath);
    return this.workspace.projects.find((project) => testDirs(project).some((dir) => isPathUnder(file, dir)));
  }

  private projectItem(project: ElideProject): vscode.TestItem {
    const id = projectItemId(project.root);
    const label = project.model?.name ?? path.basename(project.root);
    const existing = this.controller.items.get(id);
    if (existing) {
      if (existing.label !== label) existing.label = label;
      return existing;
    }
    const item = this.controller.createTestItem(id, label);
    item.description = path.basename(project.root);
    this.controller.items.add(item);
    return item;
  }

  // --- running ---------------------------------------------------------------------------------------------------

  private async run(request: vscode.TestRunRequest, token: vscode.CancellationToken, summary?: TestRunSummary): Promise<void> {
    const run = this.controller.createTestRun(request);
    try {
      for (const group of this.groupByProject(request)) {
        if (token.isCancellationRequested) break;
        await this.runGroup(run, request, group, token, summary);
      }
    } finally {
      run.end();
    }
  }

  /** Split the request into one invocation per project; an item selects its project through its ancestors. */
  private groupByProject(request: vscode.TestRunRequest): RunGroup[] {
    const excluded = new Set((request.exclude ?? []).map((i) => i.id));
    const selected = request.include ? [...request.include] : [...this.controller.items].map(([, item]) => item);
    const groups = new Map<string, RunGroup>();
    for (const item of selected) {
      if (excluded.has(item.id)) continue;
      const projectItem = rootItemOf(item);
      const project = this.workspace.projectAt(projectItem.id.slice(2));
      if (!project) continue;
      let group = groups.get(projectItem.id);
      if (!group) {
        group = { project, projectItem, wholeProject: false, targets: [], leaves: [] };
        groups.set(projectItem.id, group);
      }
      if (item === projectItem) group.wholeProject = true;
      const target = targetOf(item);
      if (target) group.targets.push(target);
      collectLeaves(item, excluded, group.leaves);
    }
    // Nothing narrower than a project item resolved to a `-t` target (e.g. only a dynamic label item was selected).
    for (const group of groups.values()) if (group.targets.length === 0) group.wholeProject = true;
    return [...groups.values()];
  }

  private async runGroup(
    run: vscode.TestRun,
    request: vscode.TestRunRequest,
    group: RunGroup,
    token: vscode.CancellationToken,
    summary?: TestRunSummary,
  ): Promise<void> {
    const { project, projectItem, leaves } = group;
    for (const leaf of leaves) run.enqueued(leaf);

    const settings = readConfig(project.folder);
    let dist;
    try {
      dist = resolveElideDistribution({ explicitHome: settings.home });
    } catch (e) {
      const message = new vscode.TestMessage(describe(e));
      for (const leaf of leaves) this.settle(run, summary, "errored", leaf, message);
      return;
    }

    const pattern = group.wholeProject ? undefined : jvmTestNamePattern(group.targets);
    const argv = ["test", "--reporter=tap", ...(pattern ? ["-t", pattern] : [])];
    this.ui.log(`test: ${dist.bin} ${argv.join(" ")} (cwd ${project.root})`);

    const index = classIndex(projectItem);
    const selectedIds = new Set(leaves.map((l) => l.id));
    const byNumber = new Map<number, vscode.TestItem>();
    /** Items a start event announced, per label, consumed in settle order by the matching result. */
    const started = new Map<string, vscode.TestItem[]>();
    /** How many invocations of one item this run has seen; a parameterized test reports the same label repeatedly. */
    const invocations = new Map<string, number>();
    const stderrTail: string[] = [];
    let sawResult = false;

    const claim = (label: string): vscode.TestItem => {
      const base = this.matchLabel(index, projectItem, project.root, label, selectedIds);
      const seen = (invocations.get(base.id) ?? 0) + 1;
      invocations.set(base.id, seen);
      if (seen === 1) return base;
      const id = `${base.id}[${seen}]`;
      const existing = base.children.get(id);
      if (existing) return existing;
      const invocation = this.controller.createTestItem(id, `${base.label}[${seen}]`, base.uri);
      invocation.range = base.range;
      base.children.add(invocation);
      return invocation;
    };

    const parser = new TapParser((event: TapEvent) => {
      switch (event.kind) {
        case "start": {
          const item = claim(event.label);
          byNumber.set(event.n, item);
          const queue = started.get(event.label);
          if (queue) queue.push(item);
          else started.set(event.label, [item]);
          run.started(item);
          return;
        }
        case "output":
          run.appendOutput(terminalText(event.text), undefined, event.n === undefined ? undefined : byNumber.get(event.n));
          return;
        case "result": {
          sawResult = true;
          const item = started.get(event.label)?.shift() ?? claim(event.label);
          const skip = event.directive?.type === "skip";
          const todo = event.directive?.type === "todo";
          if (skip || (todo && !event.ok)) this.settle(run, summary, "skipped", item);
          else if (event.ok) this.settle(run, summary, "passed", item);
          else this.settle(run, summary, "failed", item, failureMessage(event.diagnostics, item));
          return;
        }
        case "other":
          // The CLI shares stdout with build progress and anything a test prints outside a test point.
          if (event.line.trim().length > 0) run.appendOutput(terminalText(event.line));
          return;
        default:
          return;
      }
    });

    const onLine = (line: string, stderr: boolean) => {
      if (!stderr) {
        parser.feed(line);
        return;
      }
      this.ui.log(`  ${line}`);
      run.appendOutput(terminalText(line));
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
    };

    const debug = request.profile?.kind === vscode.TestRunProfileKind.Debug;
    let failure: string | undefined;
    if (debug) {
      const attachType = await resolveAttachType(settings);
      if (!attachType) {
        run.appendOutput(terminalText("No JVM debugger available; see elide.debug.adapter"));
        return;
      }
      // Bare `--debugger`: on `test` the flag takes no address and JDWP binds 5005, so one debug run at a time.
      const session = launchWithJdwp(
        { dist: dist.bin, argv: [...argv, "--debugger"], cwd: project.root, name: "Elide: Test (debug)", folder: project.folder, attachType, onLine },
        this.ui,
        this.sessions,
      );
      const cancel = token.onCancellationRequested(() => session.cancel());
      try {
        const code = await session.exit;
        if (code !== 0 && code !== null) failure = stderrTail.join("\n") || `elide test exited with ${code}`;
      } finally {
        cancel.dispose();
      }
    } else {
      const abort = new AbortController();
      const cancel = token.onCancellationRequested(() => abort.abort(new Error("test run cancelled")));
      try {
        await new ElideCli(dist, project.root).run(argv, { onLine, signal: abort.signal });
      } catch (e) {
        if (!abort.signal.aborted) {
          failure =
            e instanceof ElideCommandFailedError
              ? e.stderr.trim().split("\n").slice(-STDERR_TAIL_LINES).join("\n") || `elide test exited with ${e.exitCode ?? "signal"}`
              : describe(e);
        }
      } finally {
        cancel.dispose();
      }
    }

    parser.end();
    if (token.isCancellationRequested || failure === undefined) return;
    // A failing test already exits non-zero: only a run that reported nothing at all is an error of its own.
    if (sawResult) {
      run.appendOutput(terminalText(failure));
      return;
    }
    const message = new vscode.TestMessage(failure);
    for (const leaf of leaves) this.settle(run, summary, "errored", leaf, message);
  }

  private settle(run: vscode.TestRun, summary: TestRunSummary | undefined, outcome: Outcome, item: vscode.TestItem, message?: vscode.TestMessage): void {
    switch (outcome) {
      case "passed":
        run.passed(item);
        break;
      case "skipped":
        run.skipped(item);
        break;
      case "failed":
        run.failed(item, message ?? new vscode.TestMessage("Test failed"));
        break;
      case "errored":
        run.errored(item, message ?? new vscode.TestMessage("Test errored"));
        break;
    }
    summary?.[outcome].push(item.id);
  }

  /**
   * Find the item a TAP label names.
   *
   * The label's container chain spells the class's binary name (`sample.Outer > Inner > works()` →
   * `sample.Outer$Inner`), which is the fast path. When that misses — an engine that qualifies the outer class
   * differently, say — the chain is suffix-matched against the discovered classes, preferring the items the user
   * selected. A label that matches nothing becomes a dynamic item so the result is never dropped.
   */
  private matchLabel(
    index: Map<string, vscode.TestItem>,
    projectItem: vscode.TestItem,
    root: string,
    label: string,
    selected: ReadonlySet<string>,
  ): vscode.TestItem {
    const { containers, name } = parseTapLabel(label);
    const exact = index.get(containers.join("$"))?.children.get(methodItemId(root, containers.join("$"), name));
    if (exact) return exact;

    const candidates: vscode.TestItem[] = [];
    for (const [binaryName, classItem] of index) {
      if (!chainMatches(binaryName, containers)) continue;
      const method = classItem.children.get(methodItemId(root, binaryName, name));
      if (method) candidates.push(method);
    }
    const preferred = candidates.filter((c) => selected.has(c.id));
    const pool = preferred.length > 0 ? preferred : candidates;
    if (pool.length > 1) this.ui.log(`ambiguous test label: ${label}`);
    const picked = pool[0];
    if (picked) return picked;

    const id = `t:${root}:${label}`;
    const existing = projectItem.children.get(id);
    if (existing) return existing;
    const dynamic = this.controller.createTestItem(id, label);
    projectItem.children.add(dynamic);
    return dynamic;
  }
}

/** Absolute test source roots of a synced project. */
function testDirs(project: ElideProject): string[] {
  const dirs = new Set<string>();
  for (const module of project.model?.modules ?? []) {
    if (module.kind !== "test") continue;
    for (const contentRoot of module.contentRoots) {
      for (const sourceRoot of contentRoot.sourceRoots) if (sourceRoot.kind === "test") dirs.add(sourceRoot.path);
    }
  }
  return [...dirs];
}

/** Text of a file, preferring the editor's buffer so unsaved declarations are discovered too. */
async function readSource(uri: vscode.Uri): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
  if (open) return open.getText();
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

/** Drop every item that came from `fsPath`, wherever it sits in the subtree. */
function deleteFileItems(item: vscode.TestItem, fsPath: string): void {
  const doomed: string[] = [];
  for (const [id, child] of item.children) {
    if (child.uri?.fsPath === fsPath) doomed.push(id);
    else deleteFileItems(child, fsPath);
  }
  for (const id of doomed) item.children.delete(id);
}

/** The project item an item belongs to (itself, for a project item). */
function rootItemOf(item: vscode.TestItem): vscode.TestItem {
  let current = item;
  while (current.parent) current = current.parent;
  return current;
}

/** Runnable descendants of a selected item: the leaves are the test methods and their invocations. */
function collectLeaves(item: vscode.TestItem, excluded: ReadonlySet<string>, out: vscode.TestItem[]): void {
  if (excluded.has(item.id)) return;
  if (item.children.size === 0) {
    if (!item.id.startsWith("p:")) out.push(item);
    return;
  }
  for (const [, child] of item.children) collectLeaves(child, excluded, out);
}

/** The `-t` target an item selects, or `undefined` for a project or dynamic label item. */
function targetOf(item: vscode.TestItem): { binaryName: string; method?: string } | undefined {
  // A binary name holds no `:`, so the tail after the last one is the item's own coordinate (Windows roots included).
  const tail = item.id.slice(item.id.lastIndexOf(":") + 1);
  if (item.id.startsWith("c:")) return { binaryName: tail };
  if (!item.id.startsWith("m:")) return undefined;
  const hash = tail.indexOf("#");
  if (hash < 0) return undefined;
  // An invocation item (`…#test[2]`) is one run of its method; the pattern can only select the method.
  return { binaryName: tail.slice(0, hash), method: tail.slice(hash + 1).replace(/\[\d+\]$/, "") };
}

function classIndex(projectItem: vscode.TestItem): Map<string, vscode.TestItem> {
  const index = new Map<string, vscode.TestItem>();
  const visit = (collection: vscode.TestItemCollection) => {
    for (const [id, item] of collection) {
      if (id.startsWith("c:")) index.set(id.slice(id.lastIndexOf(":") + 1), item);
      visit(item.children);
    }
  };
  visit(projectItem.children);
  return index;
}

/**
 * Whether a class's simple-name chain ends with the label's container chain.
 *
 * The package qualifier is stripped from both outermost names, so `sample.Outer$Inner` matches `Outer > Inner` as
 * well as `sample.Outer > Inner`.
 */
function chainMatches(binaryName: string, containers: readonly string[]): boolean {
  if (containers.length === 0) return true;
  const chain = binaryName.split("$");
  const outer = chain[0] ?? "";
  chain[0] = outer.slice(outer.lastIndexOf(".") + 1);
  const wanted = containers.map((c, i) => (i === 0 ? c.slice(c.lastIndexOf(".") + 1) : c));
  if (wanted.length > chain.length) return false;
  const offset = chain.length - wanted.length;
  return wanted.every((segment, i) => chain[offset + i] === segment);
}

function failureMessage(diagnostics: TapDiagnostics | undefined, item: vscode.TestItem): vscode.TestMessage {
  const headline = diagnostics?.message ?? "Test failed";
  const detail = diagnostics?.detail ?? [];
  const message = new vscode.TestMessage(detail.length > 0 ? `${headline}\n\n${detail.join("\n")}` : headline);
  const uri = item.uri;
  if (!uri) return message;
  // The first frame naming this item's own file is where the assertion failed.
  const base = path.basename(uri.fsPath);
  for (const line of detail) {
    const frame = DETAIL_LOCATION.exec(line);
    if (frame?.[1] !== base) continue;
    message.location = new vscode.Location(uri, new vscode.Position(Math.max(0, Number(frame[2]) - 1), 0));
    break;
  }
  return message;
}

/** Test-run output is written to a terminal: every newline needs a carriage return. */
function terminalText(text: string): string {
  return `${text.replace(/\r?\n/g, "\r\n")}\r\n`;
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
