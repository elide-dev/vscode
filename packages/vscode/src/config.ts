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
  };
}
