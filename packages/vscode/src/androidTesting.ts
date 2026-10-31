import path from "node:path";
import {
  ANDROID_DEVICE_OPTION,
  ANDROID_TESTS_OPTION,
  AndroidTestResultParser,
  ElideCli,
  ElideCommandFailedError,
  androidTestTask,
  elideInvocationArgs,
  isPathUnder,
  mergeElideInvocationOptions,
  normalizePath,
  resolveElideDistribution,
  scanJvmTestSource,
  type AndroidTargetModel,
  type AndroidTestResult,
} from "@elide/ide-core";
import * as vscode from "vscode";
import { toAndroidTarget } from "./android.js";
import type { AndroidDeploymentController } from "./androidDeployment.js";
import { androidApks } from "./androidDeploymentState.js";
import { configuredInvocation, readConfig } from "./config.js";
import type { ElideUi } from "./output.js";
import type { ElideProject, ElideWorkspace } from "./projects.js";

const SOURCE_GLOB = "**/*.{kt,java}";
const JVM_SOURCE = /\.(?:kt|java)$/;
/** A stack frame of a failure: `at sample.DeviceTest.works(DeviceTest.java:15)`. */
const FRAME_LOCATION = /\((\w+\.(?:kt|java)):(\d+)\)/;
const RESCAN_DEBOUNCE_MS = 300;
const STDERR_TAIL_LINES = 20;

/** The test APK one top-level item stands for, with its tests by the `<class>#<method>` name the runner reports. */
interface Suite {
  root: string;
  artifact: string;
  item: vscode.TestItem;
  /** Source roots of the source sets the APK packages: where its instrumented tests are declared. */
  dirs: string[];
  tests: Map<string, vscode.TestItem>;
}

/**
 * Test Explorer for the instrumented tests of Android test APKs: an APK declaring `instrumentation` in Pkl or an
 * `<instrumentation>` element in its manifest, whose tests `elide build android-test-<artifact>` installs and runs on
 * a device.
 *
 * The tests are found as the JVM ones are, statically, in the source sets the APK packages. A run goes to the
 * deployment target's device, passed as `--device`, narrowed to the selected classes and methods with `--tests`, and
 * each result the target reports is mapped back onto its item. There is no Debug profile: the target attaches no
 * debugger.
 */
export class ElideAndroidTestController implements vscode.Disposable {
  private readonly controller = vscode.tests.createTestController("elide-android", "Elide Android Instrumented Tests");
  private readonly profile: vscode.TestRunProfile;
  private readonly suites = new Map<string, Suite>();
  private readonly subscriptions: vscode.Disposable[];
  private readonly rescans = new Map<string, NodeJS.Timeout>();
  private queue: Promise<void> = Promise.resolve();
  /** The `android-test-*` processes of the runs in flight: the CLI is detached, so it would outlive the window. */
  private readonly running = new Set<AbortController>();
  private disposed = false;

  /** `onInvoke` sees the argument of every `elide.androidTest` invocation, before the run starts. */
  constructor(
    private readonly workspace: ElideWorkspace,
    private readonly ui: ElideUi,
    private readonly deployments: AndroidDeploymentController,
    onInvoke: (target: unknown) => void,
  ) {
    this.controller.refreshHandler = () => this.refresh();
    this.profile = this.controller.createRunProfile("Run on Android Deployment Target", vscode.TestRunProfileKind.Run,
      (request, token) => void this.run(request, token), true);
    const watcher = vscode.workspace.createFileSystemWatcher(SOURCE_GLOB);
    this.subscriptions = [
      watcher,
      watcher.onDidCreate((uri) => this.scheduleRescan(uri)),
      watcher.onDidChange((uri) => this.scheduleRescan(uri)),
      watcher.onDidDelete((uri) => this.scheduleRescan(uri)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length > 0) this.scheduleRescan(e.document.uri);
      }),
      // A new model can declare, drop or re-target a test APK, or change what Elide lists for it.
      workspace.onDidChange(() => void this.refresh()),
      vscode.commands.registerCommand("elide.androidTest", (target: unknown) => {
        onInvoke(target);
        return this.runCommand(target);
      }),
    ];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.running) controller.abort(new Error("extension disposed"));
    this.running.clear();
    for (const timer of this.rescans.values()) clearTimeout(timer);
    this.rescans.clear();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.controller.dispose();
  }

  /** `elide.androidTest`: run every instrumented test of the APK a row or lens names, or of the one picked. */
  private async runCommand(value: unknown): Promise<void> {
    await this.refresh();
    if (this.disposed) return;
    const target = toAndroidTarget(value);
    const suites = [...this.suites.values()].filter((suite) => !target || (suite.root === target.root && (!target.artifact || suite.artifact === target.artifact)));
    if (suites.length === 0) {
      void vscode.window.showWarningMessage(target?.artifact
        ? `Elide: '${target.artifact}' has no instrumented tests to run: it declares no \`instrumentation\` and its manifest no \`<instrumentation>\`, or Elide lists no ${androidTestTask(target.artifact)} target for it.`
        : "Elide: no synced Android APK declares instrumentation (Pkl `instrumentation` or a manifest `<instrumentation>`) with an `android-test-<artifact>` target Elide lists.");
      return;
    }
    const suite = suites.length === 1 ? suites[0] : (await vscode.window.showQuickPick(
      suites.map((candidate) => ({ label: candidate.artifact, description: this.workspace.projectAt(candidate.root)?.model?.name ?? candidate.root, suite: candidate })),
      { placeHolder: "Android test APK to run on the deployment target" },
    ))?.suite;
    if (!suite) return;
    const cancellation = new vscode.CancellationTokenSource();
    try {
      await this.run(new vscode.TestRunRequest([suite.item], undefined, this.profile), cancellation.token);
    } finally {
      cancellation.dispose();
    }
  }

  // --- discovery -------------------------------------------------------------------------------------------------

  refresh(): Promise<void> {
    this.queue = this.queue.then(async () => {
      try {
        await this.refreshNow();
      } catch (e) {
        this.ui.log(`instrumented test discovery failed: ${describe(e)}`);
      }
    });
    return this.queue;
  }

  private async refreshNow(): Promise<void> {
    const live = new Set<string>();
    for (const project of this.workspace.projects) {
      for (const apk of androidApks(project)) {
        if (!apk.device?.instrumented) continue;
        const suite = this.suite(project, apk);
        live.add(suite.item.id);
        suite.item.children.replace([]);
        suite.tests.clear();
        const files = new Set<string>();
        for (const dir of suite.dirs) {
          for (const uri of await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(dir), SOURCE_GLOB))) files.add(uri.fsPath);
        }
        for (const file of [...files].sort()) await this.scan(suite, vscode.Uri.file(file));
      }
    }
    for (const id of [...this.suites.keys()]) {
      if (live.has(id)) continue;
      this.suites.delete(id);
      this.controller.items.delete(id);
    }
  }

  private suite(project: ElideProject, apk: AndroidTargetModel): Suite {
    const id = `a:${project.root}:${apk.name}`;
    const sets = new Set(apk.sourceSets ?? []);
    const dirs = (project.model?.modules ?? [])
      .filter((module) => sets.has(module.sourceSet))
      .flatMap((module) => module.contentRoots.flatMap((content) => content.sourceRoots))
      .filter((root) => root.kind === "source" || root.kind === "test")
      .map((root) => normalizePath(root.path));
    const existing = this.suites.get(id);
    if (existing) {
      existing.dirs = dirs;
      return existing;
    }
    const item = this.controller.createTestItem(id, apk.name);
    item.description = `${project.model?.name ?? path.basename(project.root)} · on device`;
    this.controller.items.add(item);
    const suite: Suite = { root: project.root, artifact: apk.name, item, dirs, tests: new Map() };
    this.suites.set(id, suite);
    return suite;
  }

  private async scan(suite: Suite, uri: vscode.Uri): Promise<void> {
    for (const [id, child] of suite.item.children) if (child.uri?.fsPath === uri.fsPath) suite.item.children.delete(id);
    for (const [key, test] of suite.tests) if (test.uri?.fsPath === uri.fsPath) suite.tests.delete(key);
    const text = await readSource(uri);
    if (text === undefined) return;
    const language = path.extname(uri.fsPath) === ".java" ? "java" : "kotlin";
    for (const cls of scanJvmTestSource(text, language).classes) {
      if (cls.methods.length === 0) continue;
      // Flat by class: the runner names a nested class by its binary name, which is also what `--tests` takes.
      const item = this.controller.createTestItem(`${suite.item.id}/${cls.binaryName}`, cls.binaryName.slice(cls.binaryName.lastIndexOf(".") + 1), uri);
      item.range = new vscode.Range(cls.line, 0, cls.line, 0);
      suite.item.children.add(item);
      for (const method of cls.methods) {
        const name = `${cls.binaryName}#${method.name}`;
        const child = this.controller.createTestItem(`${suite.item.id}/${name}`, method.name, uri);
        child.range = new vscode.Range(method.line, 0, method.line, 0);
        item.children.add(child);
        suite.tests.set(name, child);
      }
    }
  }

  private scheduleRescan(uri: vscode.Uri): void {
    if (uri.scheme !== "file" || !JVM_SOURCE.test(uri.fsPath)) return;
    const file = normalizePath(uri.fsPath);
    const owners = [...this.suites.values()].filter((suite) => suite.dirs.some((dir) => isPathUnder(file, dir)));
    if (owners.length === 0) return;
    clearTimeout(this.rescans.get(uri.fsPath));
    this.rescans.set(uri.fsPath, setTimeout(() => {
      this.rescans.delete(uri.fsPath);
      for (const suite of owners) void this.scan(suite, uri);
    }, RESCAN_DEBOUNCE_MS));
  }

  // --- running ---------------------------------------------------------------------------------------------------

  private async run(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    if (this.disposed) return;
    const run = this.controller.createTestRun(request);
    try {
      const excluded = new Set((request.exclude ?? []).map((item) => item.id));
      const selected = request.include ?? [...this.suites.values()].map((suite) => suite.item);
      const bySuite = new Map<Suite, vscode.TestItem[]>();
      for (const item of selected) {
        let top = item;
        while (top.parent) top = top.parent;
        const suite = this.suites.get(top.id);
        if (!suite || excluded.has(item.id)) continue;
        bySuite.set(suite, [...(bySuite.get(suite) ?? []), item]);
      }
      for (const [suite, items] of bySuite) {
        if (token.isCancellationRequested) break;
        await this.runSuite(run, suite, items, excluded, token);
      }
    } finally {
      run.end();
    }
  }

  private async runSuite(run: vscode.TestRun, suite: Suite, items: readonly vscode.TestItem[], excluded: ReadonlySet<string>, token: vscode.CancellationToken): Promise<void> {
    const leaves: vscode.TestItem[] = [];
    for (const item of items) collectLeaves(item, excluded, leaves);
    // No remaining methods means no device operation, never an unfiltered run of the entire APK.
    if (!leaves.length || this.disposed || token.isCancellationRequested) return;
    for (const leaf of leaves) run.enqueued(leaf);
    const errored = (message: string) => {
      for (const leaf of leaves) run.errored(leaf, new vscode.TestMessage(message));
    };

    const project = this.workspace.projectAt(suite.root);
    if (!project) return errored(`Project ${suite.root} is not synced; run 'Elide: Sync Project(s)'.`);
    const saved = await vscode.workspace.saveAll(false);
    if (this.disposed || token.isCancellationRequested) return;
    if (!saved) return errored("Saving the open files failed, so the tests did not run.");
    const deployment = await this.deployments.resolve({ root: suite.root });
    if (this.disposed || token.isCancellationRequested) return;
    const serial = deployment ? await this.deployments.readyDevice(deployment) : undefined;
    if (this.disposed || token.isCancellationRequested) return;
    if (!serial) return errored("No Android deployment target device: select one with 'Elide: Select Android Deployment Target…'.");

    const settings = readConfig(project.folder);
    let dist;
    try {
      dist = resolveElideDistribution({ explicitHome: settings.home });
    } catch (e) {
      return errored(describe(e));
    }
    // A selection that leaves nothing out runs the whole suite; anything narrower names exactly what is still in.
    const whole = items.includes(suite.item) && ![...excluded].some((id) => id.startsWith(`${suite.item.id}/`));
    const filters = whole ? [] : excluded.size > 0 ? leaves.map((leaf) => leaf.id.slice(suite.item.id.length + 1)) : items.map((item) => item.id.slice(suite.item.id.length + 1));
    const task = androidTestTask(suite.artifact);
    const invocation = mergeElideInvocationOptions(configuredInvocation(settings, "build"), {
      args: [task],
      options: { [ANDROID_DEVICE_OPTION]: serial, ...(filters.length > 0 ? { [ANDROID_TESTS_OPTION]: filters } : {}) },
    });
    const argv = elideInvocationArgs("build", invocation);
    this.ui.log(`android test: ${dist.bin} ${argv.join(" ")} (cwd ${project.root})`);
    for (const leaf of leaves) run.started(leaf);

    const reported = new Set<string>();
    const problems: string[] = [];
    const parser = new AndroidTestResultParser(task, (result) => {
      reported.add(`${result.className}#${result.method}`);
      this.settle(run, suite, result);
    }, (text) => problems.push(text));
    const stderrTail: string[] = [];
    const abort = new AbortController();
    this.running.add(abort);
    const cancel = token.onCancellationRequested(() => abort.abort(new Error("test run cancelled")));
    let failure: string | undefined;
    try {
      await new ElideCli(dist, project.root).run(argv, {
        signal: abort.signal,
        ...(invocation.env ? { env: { ...invocation.env } } : {}),
        onCommand: () => ({ record: (record) => parser.accept(record), end: () => undefined }),
        onLine: (line, stderr) => {
          run.appendOutput(`${line}\r\n`);
          if (!stderr) return;
          stderrTail.push(line);
          if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
        },
      });
    } catch (e) {
      if (!abort.signal.aborted) {
        failure = e instanceof ElideCommandFailedError ? `elide build ${task} exited with ${e.exitCode ?? "a signal"}` : describe(e);
      }
    } finally {
      cancel.dispose();
      parser.end();
      this.running.delete(abort);
    }
    if (token.isCancellationRequested || failure === undefined) return;
    // A failing test already fails the target; tests the run never reached (a crash, a lost device) get its reason.
    const message = new vscode.TestMessage([...(problems.length > 0 ? problems : stderrTail), failure].join("\n"));
    // Leaves are methods, or the suite itself when nothing was discovered: then any result counts.
    for (const leaf of leaves) {
      const name = leaf.id.slice(suite.item.id.length + 1);
      if (name === "" ? reported.size === 0 : !reported.has(name)) run.errored(leaf, message);
    }
  }

  private settle(run: vscode.TestRun, suite: Suite, result: AndroidTestResult): void {
    const name = `${result.className}#${result.method}`;
    let item = suite.tests.get(name);
    if (!item) {
      // A test the static scan did not find — declared in a library, or generated — still gets its result.
      item = this.controller.createTestItem(`${suite.item.id}/${name}`, name);
      suite.item.children.add(item);
      suite.tests.set(name, item);
    }
    if (result.outcome === "passed") run.passed(item);
    else if (result.outcome === "skipped") run.skipped(item);
    else run.failed(item, failureMessage(result.detail, item));
  }
}

/** Runnable descendants of a selected item: its test methods, or the item itself when nothing was discovered in it. */
function collectLeaves(item: vscode.TestItem, excluded: ReadonlySet<string>, out: vscode.TestItem[]): void {
  if (excluded.has(item.id)) return;
  if (item.children.size === 0) {
    out.push(item);
    return;
  }
  for (const [, child] of item.children) collectLeaves(child, excluded, out);
}

/** A failure with its stack trace, located at the first frame in the test's own file. */
function failureMessage(detail: string | undefined, item: vscode.TestItem): vscode.TestMessage {
  const message = new vscode.TestMessage(detail ?? "Test failed");
  const uri = item.uri;
  if (!uri || !detail) return message;
  const base = path.basename(uri.fsPath);
  for (const line of detail.split("\n")) {
    const frame = FRAME_LOCATION.exec(line);
    if (frame?.[1] !== base) continue;
    message.location = new vscode.Location(uri, new vscode.Position(Math.max(0, Number(frame[2]) - 1), 0));
    break;
  }
  return message;
}

/** Text of a file, preferring the editor's buffer so unsaved declarations are discovered too. */
async function readSource(uri: vscode.Uri): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find((document) => document.uri.fsPath === uri.fsPath);
  if (open) return open.getText();
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
