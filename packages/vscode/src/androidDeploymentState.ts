import { androidDebugTask, androidRunTask, androidTestTask, currentAndroidDeviceTargets, isEmulatorSerial, type AndroidDevice, type AndroidTargetModel } from "@elide/ide-core";
import type { ElideProject } from "./projects.js";

/** A device pinned by serial; an emulator also records the AVD it ran, so a stopped one can be booted again. */
export type AndroidDeploymentDestination = { kind: "device"; serial: string; avd?: string } | { kind: "emulator" };
export interface AndroidDeploymentTarget {
  root: string;
  artifact: string;
  destination: AndroidDeploymentDestination;
}

/**
 * Every APK of the live model, deployable or not: libraries and bundles are never installed. Each offers what it
 * offers now: a build that turned out not to be debuggable withdraws Debug ({@link currentAndroidDeviceTargets}).
 */
export function androidApks(project: ElideProject): AndroidTargetModel[] {
  return (project.model?.android?.targets ?? []).filter((target) => target.kind === "apk").map((target) => {
    const device = currentAndroidDeviceTargets(project.root, target);
    return device === target.device ? target : { ...target, ...(device ? { device } : {}) };
  });
}

/**
 * Whether any synced project declares an `android` block, application or library: the `elide.hasAndroidProjects`
 * context key that shows the Android commands and menu entries.
 */
export function hasAndroidProjects(projects: readonly Pick<ElideProject, "model">[]): boolean {
  return projects.some((project) => project.model?.android !== undefined);
}

/** What every Android command says, as a warning, when invoked in a workspace without an Android project. */
export const NO_ANDROID_PROJECT = "Elide: no synced project declares an `android` block, so there is no Android application or library to act on.";

/**
 * The project the shared Android devices & tools rows of a workspace tree act for, given its projects in tree order:
 * the first that builds an APK, else the first with an `android` block. A library's SDK finds the same devices.
 */
export function androidToolsProject(projects: readonly ElideProject[]): ElideProject | undefined {
  return projects.find((project) => androidApks(project).length > 0) ?? projects.find((project) => project.model?.android !== undefined);
}

/**
 * The emulators a workspace tree offers to start, stop and create: one per AVD its APK projects declare, owned by the
 * first such project. Library-only projects build nothing to install, so they own no emulator.
 */
export function androidEmulatorOwners(projects: readonly ElideProject[]): { avd: string; project: ElideProject }[] {
  const owners = new Map<string, ElideProject>();
  for (const project of projects) {
    const avd = project.model?.android?.avd;
    if (avd && androidApks(project).length > 0 && !owners.has(avd)) owners.set(avd, project);
  }
  return [...owners].map(([avd, project]) => ({ avd, project }));
}

/** What a deployment does with its APK, which decides the build target Elide has to offer for it. */
export type AndroidDeploymentUse = "run" | "debug" | "test";

const USES: Record<AndroidDeploymentUse, { offered: (apk: AndroidTargetModel) => boolean; task: (artifact: string) => string }> = {
  run: { offered: (apk) => apk.device?.runnable === true, task: (artifact) => androidRunTask(artifact) },
  debug: { offered: (apk) => apk.device?.debuggable === true, task: androidDebugTask },
  test: { offered: (apk) => apk.device?.instrumented === true, task: androidTestTask },
};

/** Whether Elide lists the target `use` needs for `apk`; without `use`, whether it lists any of them. */
export function androidApkOffers(apk: AndroidTargetModel, use?: AndroidDeploymentUse): boolean {
  return use ? USES[use].offered(apk) : Object.values(USES).some((entry) => entry.offered(apk));
}

/** The build target `use` runs for `artifact`. */
export function androidUseTask(use: AndroidDeploymentUse, artifact: string): string {
  return USES[use].task(artifact);
}

/**
 * APKs a deployment can use: those Elide lists the needed device target for. An APK it cannot install — unsigned,
 * say — has none, so it is never offered for a Run or Debug that would only fail after the whole build.
 */
export function deployableApks(project: ElideProject, use?: AndroidDeploymentUse): AndroidTargetModel[] {
  return androidApks(project).filter((apk) => androidApkOffers(apk, use));
}

/** Persistence is untrusted until both its shape and, at deployment time, the live model/devices are checked. */
export function restoredAndroidTarget(value: unknown): AndroidDeploymentTarget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const target = value as Partial<AndroidDeploymentTarget>;
  if (typeof target.root !== "string" || !target.root || typeof target.artifact !== "string" || !target.artifact) return undefined;
  const destination = target.destination;
  if (destination?.kind === "emulator") return { root: target.root, artifact: target.artifact, destination: { kind: "emulator" } };
  if (destination?.kind === "device" && typeof destination.serial === "string" && destination.serial) {
    const avd = typeof destination.avd === "string" && destination.avd ? { avd: destination.avd } : {};
    return { root: target.root, artifact: target.artifact, destination: { kind: "device", serial: destination.serial, ...avd } };
  }
  return undefined;
}

/** An active library must not outrank the selected application. Explicit invocations bypass this preference. */
export function preferredAndroidProject(projects: readonly ElideProject[], owner: ElideProject | undefined, rememberedRoot: string | undefined, use?: AndroidDeploymentUse): ElideProject | undefined {
  if (owner && deployableApks(owner, use).length > 0) return owner;
  return projects.find((project) => project.root === rememberedRoot && deployableApks(project, use).length > 0);
}

/** A ready alternative never makes an unavailable pinned serial valid. */
export function androidDeviceProblem(devices: readonly AndroidDevice[], serial: string): string | undefined {
  const device = devices.find((candidate) => candidate.serial === serial);
  return device?.ready ? undefined : device?.state ?? "disconnected";
}

/**
 * The AVD to boot for an unavailable pinned emulator, or one whose serial now belongs to a different AVD.
 * A recorded identity must match the live console response before reusing a ready serial. Legacy selections
 * without an identity retain the project's AVD fallback when disconnected.
 */
export function androidAvdToBoot(devices: readonly AndroidDevice[], destination: { serial: string; avd?: string }, projectAvd: string, currentAvd?: string): string | undefined {
  if (!isEmulatorSerial(destination.serial)) return undefined;
  if (!androidDeviceProblem(devices, destination.serial) && (!destination.avd || destination.avd === currentAvd)) return undefined;
  return destination.avd ?? projectAvd;
}
