import {
  elideOptionsFrom,
  elideStringArrayFrom,
  type ElideCommand,
  type ElideInvocationOptions,
  type ElideOptionValue,
} from "@elide/ide-core";
import * as vscode from "vscode";

export type ManifestChangePolicy = "always" | "prompt" | "never";
export type DebugAdapterChoice = "intellij" | "java";

export interface ElideConfig {
  home: string | undefined;
  jdkHome: string | undefined;
  syncOnStartup: boolean;
  onManifestChange: ManifestChangePolicy;
  writeWorkspaceJson: boolean;
  debugAdapter: DebugAdapterChoice;
  /** Classifier jars fetched during sync (`elide install --with …`). */
  installClassifiers: string[];
  codeLens: boolean;
  /** `-f` build flags added to every Elide invocation (`elide.flags`). */
  flags: string[];
  /** Default CLI options per command (`elide.build.options`, `elide.run.options`, …). */
  commandOptions: Record<ElideCommand, Record<string, ElideOptionValue>>;
}

export function readConfig(scope?: vscode.ConfigurationScope): ElideConfig {
  const c = vscode.workspace.getConfiguration("elide", scope);
  const nonEmpty = (v: string | undefined) => (v && v.trim().length > 0 ? v.trim() : undefined);
  return {
    home: nonEmpty(c.get<string>("home")),
    jdkHome: nonEmpty(c.get<string>("jdk.home")),
    syncOnStartup: c.get<boolean>("sync.onStartup", true),
    onManifestChange: c.get<ManifestChangePolicy>("sync.onManifestChange", "prompt"),
    writeWorkspaceJson: c.get<boolean>("kotlinLsp.writeWorkspaceJson", true),
    debugAdapter: c.get<DebugAdapterChoice>("debug.adapter", "intellij"),
    installClassifiers: c.get<string[]>("install.classifiers", ["sources"]),
    codeLens: c.get<boolean>("codeLens.enabled", true),
    flags: elideStringArrayFrom(c.get("flags")),
    commandOptions: {
      build: elideOptionsFrom(c.get("build.options")),
      run: elideOptionsFrom(c.get("run.options")),
      test: elideOptionsFrom(c.get("test.options")),
      install: elideOptionsFrom(c.get("install.options")),
    },
  };
}

/** Workspace-level defaults for one command: the shared build flags plus that command's configured options. */
export function configuredInvocation(settings: ElideConfig, command: ElideCommand): ElideInvocationOptions {
  const options = settings.commandOptions[command] ?? {};
  return {
    ...(settings.flags.length > 0 ? { flags: settings.flags } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
}
