/**
 * First-run setup of JetBrains.kotlin-server: until a region and a data-sharing choice are recorded (and its terms
 * accepted), the extension activates but never starts its language server or debug adapter, so none of its
 * `jetbrains.kotlin.*` commands are registered. The choices are stored as the application-scoped settings below,
 * whose default `not_set` means unanswered; the extension reads only the user (global) value.
 */
export const KOTLIN_REGION_SETTING = "intellij.region";
export const KOTLIN_DATA_SHARING_SETTING = "intellij.dataSharing";
/** Opens the Kotlin extension's setup page (region, terms, data sharing). */
export const KOTLIN_SETUP_COMMAND = "jetbrains.showLicenseSetup";

const UNSET = "not_set";

export type KotlinSetupStep = "region" | "data sharing";

/** The setup questions still unanswered, given the user values of the region and data-sharing settings. */
export function unansweredKotlinSetupSteps(region: unknown, dataSharing: unknown): KotlinSetupStep[] {
  const answered = (v: unknown) => typeof v === "string" && v !== "" && v !== UNSET;
  const steps: KotlinSetupStep[] = [];
  if (!answered(region)) steps.push("region");
  if (!answered(dataSharing)) steps.push("data sharing");
  return steps;
}

/** User-facing explanation for a Kotlin extension held back by its setup; `steps` may be empty (terms pending). */
export function kotlinSetupPendingMessage(steps: readonly KotlinSetupStep[]): string {
  const which = steps.length > 0 ? ` (${steps.join(", ")})` : "";
  return `the Kotlin extension is waiting for its first-run setup${which}; its language server and debugger start once you complete it.`;
}
