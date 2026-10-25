import {
  elideOptionsFrom,
  elideStringArrayFrom,
  installClassifierOptions,
  type ElideCommand,
  type ElideInvocationOptions,
  type ElideOptionValue,
} from "@elide/ide-core";
import * as vscode from "vscode";

export type ManifestChangePolicy = "always" | "prompt" | "never";
/** JVM debugger the Elide debug launches attach with: JetBrains' Kotlin debugger, Debugger for Java, or Komodo's. */
export type DebugAdapterChoice = "intellij" | "java" | "komodo";
/**
 * Kotlin language server for a folder's Elide projects: the JetBrains server imports a generated `workspace.json`;
 * Komodo's native `komodo` reads a manifest in extension storage and replaces it for the folder.
 */
export type KotlinLspServer = "jetbrains" | "komodo";
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
  kotlinLspServer: KotlinLspServer;
  /** `komodo` executable; empty resolves `<elide home>/lib/komodo/bin`, `<elide home>/bin`, then `PATH`. */
  komodoLspPath: string | undefined;
  /** Compiler plugin jars for Komodo's compiler; empty is `plugins/` beside the launcher. */
  komodoPluginDirectory: string | undefined;
  /** JDK class/module resolution inputs of `komodo` (its JAVA_HOME); undefined: the Elide distribution's JDK for its own
   * `komodo`, else the environment's. */
  komodoLspJavaHome: string | undefined;
  /** Heap cap (`-Xmx`) of the native `komodo`, such as `768m`; undefined leaves the image's default. */
  komodoLspMaxHeap: string | undefined;
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

/**
 * Settings declared with `window` scope (in `package.json`, by omitting `scope`): they describe this window — its
 * notifications, its emulator, its one Compose preview backend — rather than a folder, so they are read without a
 * resource. Every other `elide.*` setting is `resource` or `machine-overridable` and read for the folder at hand,
 * which is what makes a multi-root folder's own value apply.
 */
export const WINDOW_SETTINGS = [
  "sync.showProgressNotification",
  "android.emulatorWindow",
  "android.composePreview.prewarm",
  "android.composePreview.keepAliveMinutes",
  "android.composePreview.engine",
  "android.composePreview.komodo.fallback",
] as const;

/**
 * The `elide.*` settings that apply to `scope`: a workspace folder, or a file in one. Without a scope, folder-level
 * settings resolve as for no particular folder (VS Code's `null` resource), which is what a window-wide action wants.
 */
export function readConfig(scope?: vscode.ConfigurationScope): ElideConfig {
  // A window-scoped setting read for a resource, or a resource-scoped one read without, makes VS Code log a warning.
  const c = vscode.workspace.getConfiguration("elide", scope ?? null);
  const window = vscode.workspace.getConfiguration("elide");
  const nonEmpty = (v: string | undefined) => (v && v.trim().length > 0 ? v.trim() : undefined);
  return {
    home: nonEmpty(c.get<string>("home")),
    jdkHome: nonEmpty(c.get<string>("jdk.home")),
    syncOnStartup: c.get<boolean>("sync.onStartup", true),
    onManifestChange: c.get<ManifestChangePolicy>("sync.onManifestChange", "prompt"),
    syncNotification: window.get<boolean>("sync.showProgressNotification", true),
    writeWorkspaceJson: c.get<boolean>("kotlinLsp.writeWorkspaceJson", true),
    kotlinLspServer: c.get<KotlinLspServer>("kotlinLsp.server", "jetbrains"),
    komodoLspPath: nonEmpty(c.get<string>("kotlinLsp.komodo.path")),
    komodoPluginDirectory: nonEmpty(c.get<string>("kotlinLsp.komodo.pluginDirectory")),
    komodoLspJavaHome: nonEmpty(c.get<string>("kotlinLsp.komodo.javaHome")),
    komodoLspMaxHeap: nonEmpty(c.get<string>("kotlinLsp.komodo.maxHeap")),
    debugAdapter: debugAdapter(c),
    nativeMiMode: c.get<NativeMiMode>("debug.nativeMiMode", "auto"),
    miDebuggerPath: nonEmpty(c.get<string>("debug.miDebuggerPath")),
    installClassifiers: c.get<string[]>("install.classifiers", ["sources"]),
    androidSdk: nonEmpty(c.get<string>("android.sdk")),
    androidEmulatorWindow: window.get<boolean>("android.emulatorWindow", true),
    composePreviewPrewarm: window.get<boolean>("android.composePreview.prewarm", true),
    composePreviewKeepAlive: Math.max(0, window.get<number>("android.composePreview.keepAliveMinutes", 10)),
    composePreviewEngine: window.get<string>("android.composePreview.engine", "layoutlib") === "komodo" ? "komodo" : "layoutlib",
    composePreviewKomodoPath: nonEmpty(c.get<string>("android.composePreview.komodo.path")),
    composePreviewKomodoFallback: window.get<boolean>("android.composePreview.komodo.fallback", true),
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

/** Whether the JetBrains server imports the folder's model: Komodo's folders get no `workspace.json`. */
export function importsWorkspaceJson(config: ElideConfig): boolean {
  return config.writeWorkspaceJson && config.kotlinLspServer === "jetbrains";
}

/**
 * `elide.debug.adapter`, defaulting by the folder's language server: the JetBrains debugger runs inside the JetBrains
 * server, so a Komodo folder that leaves the setting alone attaches with Komodo's own debugger.
 */
function debugAdapter(c: vscode.WorkspaceConfiguration): DebugAdapterChoice {
  const set = c.inspect<DebugAdapterChoice>("debug.adapter");
  const explicit = set?.workspaceFolderLanguageValue ?? set?.workspaceFolderValue ?? set?.workspaceLanguageValue ?? set?.workspaceValue
    ?? set?.globalLanguageValue ?? set?.globalValue;
  if (explicit) return explicit;
  return c.get<KotlinLspServer>("kotlinLsp.server", "jetbrains") === "komodo" ? "komodo" : "intellij";
}

/**
 * Workspace-level defaults for one command: the shared build flags plus that command's configured options. `install`
 * fetches the classifiers `elide.install.classifiers` names, as sync does; `elide.install.options` overrides them.
 */
export function configuredInvocation(settings: ElideConfig, command: ElideCommand): ElideInvocationOptions {
  const configured = settings.commandOptions[command] ?? {};
  const options = command === "install" ? { ...installClassifierOptions(settings.installClassifiers), ...configured } : configured;
  return {
    ...(settings.flags.length > 0 ? { flags: settings.flags } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
}
