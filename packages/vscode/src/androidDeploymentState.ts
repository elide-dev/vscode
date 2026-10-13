import type { AndroidDevice } from "@elide/ide-core";
import type { ElideProject } from "./projects.js";

export type AndroidDeploymentDestination = { kind: "device"; serial: string } | { kind: "emulator" };
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
    return { root: target.root, artifact: target.artifact, destination: { kind: "device", serial: destination.serial } };
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
