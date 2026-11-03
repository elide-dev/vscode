import { isEmulatorSerial, type AndroidDevice } from "@elide/ide-core";
import type { ElideProject } from "./projects.js";

/** A device pinned by serial; an emulator also records the AVD it ran, so a stopped one can be booted again. */
export type AndroidDeploymentDestination = { kind: "device"; serial: string; avd?: string } | { kind: "emulator" };
export interface AndroidDeploymentTarget {
  root: string;
  artifact: string;
  destination: AndroidDeploymentDestination;
}

/** Only APKs are runnable, even when the active editor belongs to an Android library. */
export function androidApks(project: ElideProject) {
  return (project.model?.android?.targets ?? []).filter((target) => target.kind === "apk");
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
export function preferredAndroidProject(projects: readonly ElideProject[], owner: ElideProject | undefined, rememberedRoot: string | undefined): ElideProject | undefined {
  if (owner && androidApks(owner).length > 0) return owner;
  return projects.find((project) => project.root === rememberedRoot && androidApks(project).length > 0);
}

/** A ready alternative never makes an unavailable pinned serial valid. */
export function androidDeviceProblem(devices: readonly AndroidDevice[], serial: string): string | undefined {
  const device = devices.find((candidate) => candidate.serial === serial);
  return device?.ready ? undefined : device?.state ?? "disconnected";
}

/**
 * The AVD to boot for a pinned emulator that is not ready, or undefined when the serial is usable or is a physical
 * device (which only the user can reconnect or authorize). A selection that predates AVD recording falls back to
 * the project's own AVD, the only one the build itself creates.
 */
export function androidAvdToBoot(devices: readonly AndroidDevice[], destination: { serial: string; avd?: string }, projectAvd: string): string | undefined {
  if (!androidDeviceProblem(devices, destination.serial) || !isEmulatorSerial(destination.serial)) return undefined;
  return destination.avd ?? projectAvd;
}
