import { androidIncompatibleUpdatePackage, androidKeystoreHintArtifact, type ElideFailure } from "@elide/ide-core";
import * as vscode from "vscode";
import type { ElideUi } from "./output.js";
import type { ElideProject } from "./projects.js";

/** A fix a failure notification offers, beside showing where Elide's whole output is: a command, or a step of the run that failed. */
export type FailureAction = { label: string } & ({ command: string; arguments?: unknown[] } | { run: () => Promise<void> });

const SHOW_TERMINAL = "Show Terminal";

/** The notification text of a failure: Elide's first error and its hint, else `fallback`. */
export function elideFailureMessage(failure: ElideFailure, fallback: string): string {
  const more = failure.errors > 1 ? ` (and ${failure.errors - 1} more error${failure.errors > 2 ? "s" : ""})` : "";
  return `Elide: ${failure.error ? `${failure.error}${more}` : fallback}${failure.hint ? ` — hint: ${failure.hint}` : ""}`;
}

/**
 * Fixes a failed Android build offers for what Elide said. A missing keystore names the target that mints it
 * (`hint: Create one with: elide build android-keystore-<artifact>`): Create Android Signing Keystore, in the first of
 * `projects` that declares the artifact — a workspace build reports its members' artifacts. An install Android
 * refused because the app on the device is signed with another key (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`) offers
 * Uninstall and Retry when the failed run says how: `reinstall` uninstalls that application, once confirmed, and
 * runs again.
 */
export function androidFailureActions(projects: readonly ElideProject[], failure: ElideFailure, reinstall?: (application: string) => Promise<void>): FailureAction[] {
  const actions: FailureAction[] = [];
  const artifact = failure.hint ? androidKeystoreHintArtifact(failure.hint) : undefined;
  const owner = artifact && projects.find((project) => project.model?.android?.targets.some((target) =>
    target.name === artifact && (target.kind === "apk" || target.kind === "aab")));
  if (owner) actions.push({ label: "Create Android Signing Keystore", command: "elide.androidCreateKeystore", arguments: [{ root: owner.root, artifact }] });
  const application = reinstall && androidIncompatibleUpdatePackage(`${failure.error ?? ""}\n${failure.hint ?? ""}`);
  if (application) actions.push({ label: "Uninstall and Retry", run: () => reinstall(application) });
  return actions;
}

/**
 * Tell the user an Elide run failed, in Elide's own words, and log the same line to the Elide output channel. The
 * run's whole output is in a terminal, which `reveal` brings forward.
 */
export function showElideFailure(ui: ElideUi, failure: ElideFailure, fallback: string, reveal: () => void, actions: readonly FailureAction[] = []): void {
  const message = elideFailureMessage(failure, fallback);
  ui.log(message);
  void vscode.window.showErrorMessage(message, ...actions.map((action) => action.label), SHOW_TERMINAL).then((pick) => {
    const action = actions.find((candidate) => candidate.label === pick);
    if (!action) {
      if (pick === SHOW_TERMINAL) reveal();
    } else if ("run" in action) {
      action.run().catch((error: unknown) => {
        void vscode.window.showErrorMessage(`Elide: ${action.label} failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    } else {
      void vscode.commands.executeCommand(action.command, ...(action.arguments ?? []));
    }
  });
}
