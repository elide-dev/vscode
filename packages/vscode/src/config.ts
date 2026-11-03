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
/** Machine-interface debugger the C/C++ extension drives for a Native Image; `auto` prefers a GDB on `PATH`. */
export type NativeMiMode = "auto" | "gdb" | "lldb";

export interface ElideConfig {
  home: string | undefined;
  jdkHome: string | undefined;
  syncOnStartup: boolean;
  onManifestChange: ManifestChangePolicy;
  /** Show a notification with the current step (and Cancel) while a sync runs longer than a moment. */
  syncNotification: boolean;
  writeWorkspaceJson: boolean;
  debugAdapter: DebugAdapterChoice;
  nativeMiMode: NativeMiMode;
  /** Explicit `gdb`/`lldb-mi` binary for Native Image sessions; empty resolves one from `PATH`. */
  miDebuggerPath: string | undefined;
  /** Classifier jars fetched during sync (`elide install --with …`). */
  installClassifiers: string[];
  /** Android SDK root for the device list; empty resolves the one the build would use. */
  androidSdk: string | undefined;
  /** Whether `Elide: Start Android Emulator` boots the AVD with a window. */
  androidEmulatorWindow: boolean;
  /** Start Compose preview infrastructure when a previewable Kotlin file is focused. */
  composePreviewPrewarm: boolean;
  /** Minutes an unused Compose preview backend stays warm; 0 stops it with its panel. */
  composePreviewKeepAlive: number;
  /** The Compose preview engine: layoutlib snapshots (default) or the opt-in live Komodo engine. */
  composePreviewEngine: "layoutlib" | "komodo";
  /** The komodo-preview daemon; undefined resolves it beside the Elide binary, then on PATH. */
  composePreviewKomodoPath: string | undefined;
  /** Cards the Komodo engine cannot render keep their layoutlib snapshot (else they show the reason). */
  composePreviewKomodoFallback: boolean;
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
    syncNotification: c.get<boolean>("sync.showProgressNotification", true),
    writeWorkspaceJson: c.get<boolean>("kotlinLsp.writeWorkspaceJson", true),
    debugAdapter: c.get<DebugAdapterChoice>("debug.adapter", "intellij"),
    nativeMiMode: c.get<NativeMiMode>("debug.nativeMiMode", "auto"),
    miDebuggerPath: nonEmpty(c.get<string>("debug.miDebuggerPath")),
    installClassifiers: c.get<string[]>("install.classifiers", ["sources"]),
    androidSdk: nonEmpty(c.get<string>("android.sdk")),
    androidEmulatorWindow: c.get<boolean>("android.emulatorWindow", true),
    composePreviewPrewarm: c.get<boolean>("android.composePreview.prewarm", true),
    composePreviewKeepAlive: Math.max(0, c.get<number>("android.composePreview.keepAliveMinutes", 10)),
    composePreviewEngine: c.get<string>("android.composePreview.engine", "layoutlib") === "komodo" ? "komodo" : "layoutlib",
    composePreviewKomodoPath: nonEmpty(c.get<string>("android.composePreview.komodo.path")),
    composePreviewKomodoFallback: c.get<boolean>("android.composePreview.komodo.fallback", true),
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
