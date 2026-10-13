/**
 * The `android` scenario (see runner.ts), on a clean copy of an Android application workspace: no `.dev`, so the
 * sync installs every dependency and the build compiles, dexes and packages the APK from scratch.
 *
 * Drives what a user does: the startup sync, watched live through the Activity view the way the status bar shows
 * it; **Build** on the APK's row of the Android section; **Start emulator** when no device is attached; **Run** on
 * the device. The app is running when `adb` finds its process.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ANDROID_EMULATOR_TASK,
  androidArtifactFile,
  androidRunTask,
  androidSdkRoot,
  listAndroidDevices,
  liveStatus,
  type TimelineNode,
} from "@elide/ide-core";
import * as vscode from "vscode";
import type { ElideExtensionApi as ElideApi } from "../../src/extension.js";
import { log, waitFor } from "./helpers.js";

const MEMBER = process.env.ELIDE_ANDROID_APP_MEMBER ?? "apps/android";
const ARTIFACT = process.env.ELIDE_ANDROID_APP_ARTIFACT ?? "sample-dev";
const APPLICATION_ID = process.env.ELIDE_ANDROID_APP_ID ?? "app.sample.android.dev";

interface Row {
  kind: string;
  artifact?: string;
  root?: string;
}

/** Breadth-first through the Elide sidebar until `match` finds a row. */
async function findRow(explorer: ElideApi["explorer"], match: (row: Row) => boolean): Promise<Row | undefined> {
  const queue: (Row | undefined)[] = [undefined];
  for (let depth = 0; queue.length > 0 && depth < 200; depth++) {
    const parent = queue.shift();
    for (const child of (await explorer.getChildren(parent)) as Row[]) {
      if (match(child)) return child;
      queue.push(child);
    }
  }
  return undefined;
}

/** The exit code of the next `elide` task process whose arguments include `arg`. */
function taskExit(arg: string): Promise<number | undefined> {
  const { promise, resolve } = Promise.withResolvers<number | undefined>();
  const subscription = vscode.tasks.onDidEndTaskProcess((event) => {
    const args: unknown = event.execution.task.definition.args;
    if (!Array.isArray(args) || !args.includes(arg)) return;
    subscription.dispose();
    resolve(event.exitCode);
  });
  return promise;
}

function descendants(node: TimelineNode): TimelineNode[] {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}

export async function runAndroidScenario(): Promise<void> {
  const sample = process.env.ELIDE_TEST_SAMPLE!;
  const member = path.join(sample, MEMBER);
  const extension = vscode.extensions.all.find((e) => e.id.endsWith(".elide"));
  assert.ok(extension, "elide extension found");
  const api = await waitFor("extension api", () => extension.exports as ElideApi | undefined, 60_000, 200);

  // 1. The startup sync, from a checkout that has never been built: what the status bar and the Activity view show
  //    while it runs, sampled the way they render.
  const statuses = new Set<string>();
  const runningTasks = new Set<string>();
  const watch = setInterval(() => {
    for (const operation of api.activity.getChildren()) {
      if (!operation.running) continue;
      const status = liveStatus(operation);
      if (status) statuses.add(status);
      for (const node of descendants(operation)) {
        if (node.running && node.parent?.label.startsWith("elide ")) runningTasks.add(node.label);
      }
    }
  }, 50);
  log("waiting for the startup sync");
  const sync = await waitFor("startup sync", () => api.activity.getChildren().find((operation) => operation.label.startsWith("Sync ") && !operation.running), 1_200_000, 500);
  clearInterval(watch);
  assert.equal(sync.state, "succeeded", `sync ${sync.state}: ${sync.detail}`);
  log(`sync: ${Math.round(sync.durationMs)} ms; ${statuses.size} live statuses, e.g.`, [...statuses].slice(0, 8));
  log(`tasks seen running: ${[...runningTasks].slice(0, 12).join(" | ")}`);
  assert.ok(statuses.size > 0, "the sync reported what Elide was doing while it ran");
  assert.ok(runningTasks.size > 0, "build tasks showed in the Activity view while they ran");
  const classpathCalls = descendants(sync).filter((node) => node.label.startsWith("elide classpath"));
  assert.ok(classpathCalls.length > 0 && classpathCalls.every((node) => node.label.startsWith("elide classpath --json ")), `classpaths batched: ${classpathCalls.map((node) => node.label).join(", ")}`);

  // 2. Build the APK from its row in the Android section.
  const row = await waitFor("APK row", () => findRow(api.explorer, (r) => r.kind === "androidTarget" && r.artifact === ARTIFACT), 60_000);
  assert.equal(row.root, member);
  const apk = androidArtifactFile(member, ARTIFACT, "apk", `${ARTIFACT}.apk`);
  const built = taskExit(ARTIFACT);
  let started = performance.now();
  await vscode.commands.executeCommand("elide.build", row);
  assert.equal(await waitFor("APK build", () => built, 1_800_000), 0, "elide build exited 0");
  log(`built ${apk} in ${Math.round(performance.now() - started)} ms`);
  assert.ok(existsSync(apk), `${apk} published`);

  // 3. A device to run on: the one attached, or the project's emulator, booted from the sidebar action.
  const sdk = androidSdkRoot();
  assert.ok(sdk, "an Android SDK");
  const ready = async () => (await listAndroidDevices(sdk))?.find((device) => device.ready);
  let device = await ready();
  const booted = !device;
  if (!device) {
    log("no device attached; starting the emulator");
    const emulatorExit = taskExit(ANDROID_EMULATOR_TASK);
    await vscode.commands.executeCommand("elide.androidStartEmulator", { root: member });
    assert.equal(await emulatorExit, 0, "android-emulator exited 0");
    device = await waitFor("a ready device", ready, 120_000);
  }
  const serial = device.serial;
  log(`running on ${serial}`);

  // 4. Run: install and launch on that device, as its row in the device list does.
  const adb = path.join(sdk, "platform-tools", "adb");
  const pidOf = () => {
    try {
      return execFileSync(adb, ["-s", serial, "shell", "pidof", APPLICATION_ID], { encoding: "utf8" }).trim() || undefined;
    } catch {
      return undefined;
    }
  };
  try {
    execFileSync(adb, ["-s", serial, "shell", "am", "force-stop", APPLICATION_ID]);
  } catch {
    // not installed yet
  }
  started = performance.now();
  const runExit = taskExit(androidRunTask(ARTIFACT));
  await vscode.commands.executeCommand("elide.androidRun", { root: member, artifact: ARTIFACT, device: serial });
  assert.equal(await runExit, 0, "android-run exited 0");
  const pid = await waitFor("app process", pidOf, 60_000, 500);
  log(`${APPLICATION_ID} running as pid ${pid} after ${Math.round(performance.now() - started)} ms`);

  // The device and the app outlive the terminal task that started them; an emulator left in the session of the
  // `elide` that booted it shuts itself down 20 s after that pseudo-terminal goes away.
  await sleep(30_000);
  assert.equal(pidOf(), pid, `${APPLICATION_ID} still running 30 s after the run task ended`);

  if (booted && !process.env.KEEP_EMULATOR) {
    const stopped = taskExit("android-emulator-stop");
    await vscode.commands.executeCommand("elide.androidStopEmulator", { root: member });
    await waitFor("emulator stop", () => stopped, 120_000);
  }
}
