/**
 * A real Android `elide-android` launch through Komodo, on the runner's clean sample copy.
 * The explicitly selected emulator must already be ready and have no copy of this application installed.
 * Only this run's application is removed afterward; the emulator and source checkout are left alone.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { androidArtifactFile, androidKeystoreTask, androidSdkRoot, listAndroidDevices } from "@elide/ide-core";
import * as vscode from "vscode";
import type { ElideExtensionApi as ElideApi } from "../../src/extension.js";
import { findRow, taskExit } from "./android.js";
import { log, waitFor } from "./helpers.js";

interface DapEvent {
  type: string;
  event?: string;
  body?: { threadId?: number; reason?: string };
}

interface StackFrame {
  id: number;
  line: number;
  source?: { path?: string };
}

interface Variable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}

export async function runKomodoAndroidDebugScenario(): Promise<void> {
  const sample = process.env.ELIDE_TEST_SAMPLE!;
  const memberName = process.env.ELIDE_ANDROID_APP_MEMBER!;
  const member = path.join(sample, memberName);
  const artifact = process.env.ELIDE_ANDROID_APP_ARTIFACT!;
  const applicationId = process.env.ELIDE_ANDROID_APP_ID!;
  const serial = process.env.ELIDE_ANDROID_DEVICE!;
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "sample workspace folder open");
  assert.equal(folder.uri.fsPath, sample);
  assert.equal(vscode.workspace.getConfiguration("elide", folder).get("kotlinLsp.server"), "komodo");
  assert.match(serial, /^emulator-\d+$/, "select a disposable emulator explicitly, not a physical device");
  const manifest = readFileSync(path.join(member, "src", "main", "AndroidManifest.xml"), "utf8");
  assert.equal(manifest.match(/\bpackage\s*=\s*"([^"]+)"/)?.[1], applicationId, "application ID matches the fixture manifest");

  const sdk = androidSdkRoot();
  assert.ok(sdk, "an Android SDK");
  assert.ok((await listAndroidDevices(sdk))?.some((device) => device.serial === serial && device.ready), `${serial} already ready`);
  const adb = (...args: string[]) => execFileSync(path.join(sdk, "platform-tools", "adb"), ["-s", serial, ...args], {
    encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  }).trim();
  const installed = () => adb("shell", "pm", "list", "packages", applicationId).split(/\r?\n/).includes(`package:${applicationId}`);
  assert.equal(installed(), false, "refusing to replace an existing app or its data; use a clean disposable emulator");

  const extension = vscode.extensions.all.find((candidate) => candidate.id.endsWith(".elide"));
  assert.ok(extension, "elide extension found");
  const api = await waitFor("extension api", () => extension.exports as ElideApi | undefined, 60_000, 200);
  const sync = await waitFor("startup sync", () => api.activity.getChildren().find((operation) => operation.label.startsWith("Sync ") && !operation.running), 1_200_000, 500);
  assert.equal(sync.state, "succeeded", `sync ${sync.state}: ${sync.detail}`);
  assert.ok(sync.children.some((step) => step.label === "Starting the Komodo language server" && /· (started|reloaded)$/.test(step.detail ?? "")), "startup sync started Komodo");

  // The existing Android scenario's sidebar lookup and task listener: create the copied fixture's debug key.
  const row = await waitFor("APK row", () => findRow(api.explorer, (candidate) => candidate.kind === "androidTarget" && candidate.root === member && candidate.artifact === artifact), 60_000);
  let keyResult: { code: number | undefined } | undefined;
  void taskExit(androidKeystoreTask(artifact)).then((code) => { keyResult = { code }; });
  await vscode.commands.executeCommand("elide.androidCreateKeystore", row);
  assert.equal((await waitFor("debug signing keystore", () => keyResult, 120_000)).code, 0, "debug signing key created");

  const source = vscode.Uri.file(path.join(member, "src", "main", "kotlin", "sample", "app", "MainActivity.kt"));
  const document = await vscode.workspace.openTextDocument(source);
  await vscode.window.showTextDocument(document, { preview: false });
  const lines = document.getText().split("\n");
  const breakpointLine = lines.findIndex((line) => line.includes("val dao = JourneyDatabase.get(this).journeys()"));
  const contentLine = lines.findIndex((line) => line.includes("setContent { JourneyApp(dao) }"));
  assert.ok(breakpointLine > 0 && contentLine > breakpointLine, "the sample's onCreate breakpoint and next source line exist");
  const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(source, new vscode.Position(breakpointLine, 0)));
  const events = new Map<string, DapEvent[]>();
  let session: vscode.DebugSession | undefined;
  let terminated = false;
  let launched = false;
  const subscriptions = [
    vscode.debug.registerDebugAdapterTrackerFactory("komodo-kotlin", {
      createDebugAdapterTracker: (debugSession) => ({
        onDidSendMessage: (message: DapEvent) => {
          if (message.type !== "event") return;
          const list = events.get(debugSession.id) ?? [];
          list.push(message);
          events.set(debugSession.id, list);
        },
      }),
    }),
    vscode.debug.onDidStartDebugSession((started) => {
      if (started.type === "komodo-kotlin") session = started;
    }),
    vscode.debug.onDidTerminateDebugSession((ended) => {
      if (ended.id === session?.id) terminated = true;
    }),
  ];
  vscode.debug.addBreakpoints([breakpoint]);
  try {
    launched = true;
    // No forwarded port or direct adapter launch: this must build/install/start through the extension provider.
    assert.equal(await vscode.debug.startDebugging(folder, {
      type: "elide-android", request: "launch", name: "Elide: Komodo Android acceptance",
      project: memberName, artifact, device: serial,
    }), false, "the elide-android pseudo-session never starts itself");
    const debug = await waitFor("Komodo Android attach after APK build/install", () => session, 1_800_000, 500);
    const attachedAt = Date.now();
    assert.equal(debug.configuration.request, "attach");
    assert.equal(debug.configuration.hostName, "127.0.0.1");
    const port = Number(debug.configuration.port);
    assert.ok(Number.isInteger(port) && port > 0, "the attach uses a forwarded JDWP port");
    assert.ok(existsSync(androidArtifactFile(member, artifact, "apk", `${artifact}.apk`)), "the launch built the APK in the copied workspace");
    assert.ok(installed(), "the launch installed the application on the pinned emulator");
    const pid = adb("shell", "pidof", applicationId);
    assert.match(pid, /^\d+$/, "one application process");
    assert.ok(adb("forward", "--list").split(/\r?\n/).some((line) => line.trim() === `${serial} tcp:${port} jdwp:${pid}`), "the adapter's port forwards to this emulator and application process");
    log("Android attach:", serial, applicationId, "pid", pid, "port", port);

    const sessionEvents = () => events.get(debug.id) ?? [];
    const topFrame = async (threadId: number): Promise<StackFrame> => {
      const trace: { stackFrames: StackFrame[] } = await debug.customRequest("stackTrace", { threadId, startFrame: 0, levels: 1 });
      assert.ok(trace.stackFrames[0], "a stopped stack frame");
      return trace.stackFrames[0];
    };
    const locals = async (frameId: number): Promise<Variable[]> => {
      const response: { scopes: { variablesReference: number }[] } = await debug.customRequest("scopes", { frameId });
      return (await Promise.all(response.scopes.map(async (scope) => {
        const result: { variables: Variable[] } = await debug.customRequest("variables", { variablesReference: scope.variablesReference });
        return result.variables;
      }))).flat();
    };

    // Binding asks only project-package classes for their sources, not the ~30,000 framework classes ART has loaded
    // (a 55-79 s scan before): 30 s leaves a wide margin over the ~2 s measured, but fails such a regression.
    const hit = await waitFor("Android Kotlin source breakpoint", () => sessionEvents().find((event) => event.event === "stopped"), 30_000, 200);
    log("Android attach to first breakpoint:", Date.now() - attachedAt, "ms");
    assert.equal(hit.body?.reason, "breakpoint");
    const threadId = hit.body?.threadId;
    assert.equal(typeof threadId, "number", "the breakpoint names its thread");
    const top = await topFrame(threadId!);
    assert.equal(top.source?.path, source.fsPath, "Android source maps to the copied Kotlin file, not the original checkout");
    assert.equal(top.line, breakpointLine + 1, "stopped on the requested Kotlin line");
    const savedState = (await locals(top.id)).find((variable) => variable.name === "savedInstanceState");
    assert.ok(savedState, "onCreate's savedInstanceState parameter is visible in locals");
    assert.equal(savedState.value, "null", "a fresh launch has no saved state");
    const evaluated: { result: string } = await debug.customRequest("evaluate", { expression: "savedInstanceState", frameId: top.id, context: "watch" });
    assert.equal(evaluated.result, "null", "evaluation reads the real Android frame's local");
    log("Android breakpoint:", top.source?.path, top.line, "savedInstanceState =", evaluated.result);

    const beforeStep = sessionEvents().length;
    await debug.customRequest("next", { threadId });
    const stepped = await waitFor("Android next step", () => sessionEvents().slice(beforeStep).find((event) => event.event === "stopped"), 120_000, 200);
    assert.equal(stepped.body?.reason, "step");
    const steppedThread = stepped.body?.threadId ?? threadId!;
    const after = await topFrame(steppedThread);
    assert.equal(after.source?.path, source.fsPath);
    assert.equal(after.line, contentLine + 1, "next executes the DAO assignment and reaches setContent");
    const dao = (await locals(after.id)).find((variable) => variable.name === "dao");
    assert.ok(dao, "the assigned DAO is visible after stepping");
    assert.match(`${dao.type ?? ""} ${dao.value}`, /JourneyDao/, "the local is the real Room DAO");
    const evaluatedDao: { result: string } = await debug.customRequest("evaluate", { expression: "dao", frameId: after.id, context: "watch" });
    assert.equal(evaluatedDao.result, dao.value, "evaluation and locals identify the same assigned DAO");
    log("Android step:", after.line, "dao =", evaluatedDao.result);

    const beforeContinue = sessionEvents().length;
    await debug.customRequest("continue", { threadId: steppedThread });
    // Android doesn't exit like the JVM sample: onCreate must return and its app window must gain focus.
    await waitFor("continued Activity window", () => adb("shell", "dumpsys", "window").split(/\r?\n/)
      .some((line) => line.includes("mCurrentFocus=") && line.includes(`${applicationId}/`) && line.includes("MainActivity")), 60_000, 500);
    assert.equal(adb("shell", "pidof", applicationId), pid, "the same Android process remains alive after continue");
    assert.equal(terminated, false, "the debugger remains attached to the running Android app");
    assert.ok(!sessionEvents().slice(beforeContinue).some((event) => event.event === "stopped"), "continue did not stop again");
    log("komodo Android debug ok:", serial, applicationId, "continued with focused Activity");
  } finally {
    vscode.debug.removeBreakpoints([breakpoint]);
    try {
      if (session && !terminated) {
        await vscode.debug.stopDebugging(session);
        await waitFor("Android debug session termination", () => terminated, 30_000, 200);
      }
    } finally {
      for (const subscription of subscriptions) subscription.dispose();
      // The precondition proved this package absent. Never uninstall an app that preceded the test.
      if (launched && installed()) {
        adb("shell", "am", "force-stop", applicationId);
        assert.match(adb("uninstall", applicationId), /Success/, "remove only the application installed by this scenario");
      }
    }
  }
}
