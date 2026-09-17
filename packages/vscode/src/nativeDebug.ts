import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { nativeImageBinary, nativeImageDebugInfo, parseManifestArtifacts, whichExecutable } from "@elide/ide-core";
import * as vscode from "vscode";
import { readConfig, type ElideConfig } from "./config.js";
import type { ElideUi } from "./output.js";
import type { ElideProject, ElideWorkspace } from "./projects.js";
import { executeElideTask, taskExitCode } from "./tasks.js";

export const ELIDE_NATIVE_DEBUG_TYPE = "elide-native";
/** Contributes `cppdbg`, which drives GDB (or LLDB) over the machine interface. */
const CPPTOOLS_EXTENSION = "ms-vscode.cpptools";
const CPPDBG_TYPE = "cppdbg";

/**
 * `elide-native` launch configuration: build a Native Image artifact of the project, then debug the binary it
 * produced. `artifact` is the build target `elide build` takes, which is the mapping key of the entry in the
 * `artifacts` block of `elide.pkl`.
 */
interface ElideNativeLaunchConfig extends vscode.DebugConfiguration {
  /** Native Image artifact to build and debug. */
  artifact?: string;
  /** Binary to debug, when it is not the one the artifact's build writes; relative paths resolve against the project. */
  program?: string;
  /** Build the artifact before debugging it; `false` debugs whatever the last build left behind. */
  build?: boolean;
  /** Arguments passed to the debugged program. */
  args?: string[];
  /** Working directory of the debugged program; defaults to the project root. */
  cwd?: string;
  env?: Record<string, string>;
  project?: string;
  /** Break on the image's entry point instead of running to the first breakpoint. */
  stopAtEntry?: boolean;
}

/**
 * `elide-native` launch configurations build a Native Image artifact and hand the binary to the C/C++ extension's
 * `cppdbg` adapter, which drives GDB against the DWARF `native-image -g` emits. The provider never lets a session of
 * type `elide-native` start itself: the session that matters is the `cppdbg` one, started once the image exists.
 */
export class ElideNativeDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  constructor(
    private readonly workspace: ElideWorkspace,
    private readonly ui: ElideUi,
  ) {}

  provideDebugConfigurations(): vscode.DebugConfiguration[] {
    return [{ type: ELIDE_NATIVE_DEBUG_TYPE, request: "launch", name: "Elide: Debug Native Image", artifact: "" }];
  }

  async resolveDebugConfigurationWithSubstitutedVariables(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined> {
    const launch = config as ElideNativeLaunchConfig;
    const targetFolder = folder ?? vscode.workspace.workspaceFolders?.[0];
    if (!targetFolder) {
      void vscode.window.showErrorMessage("Elide: open a workspace folder containing elide.pkl to debug.");
      return undefined;
    }
    if (!launch.artifact && !launch.program) {
      void vscode.window.showErrorMessage("Elide: name the Native Image artifact to debug in `artifact`, or the binary in `program`.");
      return undefined;
    }
    const root = launch.project
      ? path.resolve(targetFolder.uri.fsPath, launch.project)
      : (this.workspace.projectsIn(targetFolder)[0]?.root ?? targetFolder.uri.fsPath);
    const project = this.workspace.projectAt(root);
    if (!project) {
      void vscode.window.showWarningMessage(`Elide: project ${root} is not synced; run 'Elide: Sync Project(s)'.`);
      return undefined;
    }
    // The build runs in its own task terminal and can take minutes, so it must not hold up this resolve; the
    // `cppdbg` session starts from the detached continuation once the image is on disk.
    void this.build(project, targetFolder, launch);
    return undefined;
  }

  /** Build the artifact, then start a native session on the image it produced. */
  private async build(project: ElideProject, folder: vscode.WorkspaceFolder, launch: ElideNativeLaunchConfig): Promise<void> {
    const settings = readConfig(folder);
    if (!(await nativeAdapterReady())) return;

    if (launch.artifact && launch.build !== false) {
      const execution = await executeElideTask(this.workspace, project, "build", { args: [launch.artifact] });
      if (!execution) return;
      // A failed or cancelled build already reports itself in its terminal and in the Problems view.
      if ((await taskExitCode(execution)) !== 0) return;
    }

    const binary = launch.program
      ? path.resolve(project.root, launch.program)
      : nativeImageBinary(project.root, {
          outputName: await outputNameOf(project, launch.artifact ?? "", this.ui),
          projectName: project.model?.name,
        });
    if (!existsSync(binary)) {
      this.ui.log(`native debug: no binary at ${binary}`);
      void vscode.window.showErrorMessage(`Elide: no Native Image binary at ${binary}.`);
      return;
    }
    warnMissingDebugInfo(binary, project, launch.artifact, this.ui);

    const native = cppdbgConfig(launch, project, binary, settings);
    this.ui.log(`native debug: ${native.MIMode} on ${binary}${native.miDebuggerPath ? ` via ${native.miDebuggerPath}` : ""}`);
    if (!(await vscode.debug.startDebugging(folder, native))) {
      this.ui.log("native debug: session did not start");
      void vscode.window.showErrorMessage(`Elide: could not start a ${native.MIMode} session for ${path.basename(binary)}.`);
    }
  }
}

/** The C/C++ extension, installed: it owns `cppdbg`, and offers to install itself when it is missing. */
async function nativeAdapterReady(): Promise<boolean> {
  if (vscode.extensions.getExtension(CPPTOOLS_EXTENSION)) return true;
  const pick = await vscode.window.showErrorMessage(
    "Elide: debugging a Native Image needs the C/C++ extension, which provides the GDB/LLDB debug adapter.",
    "Install",
  );
  if (pick === "Install") void vscode.commands.executeCommand("workbench.extensions.installExtension", CPPTOOLS_EXTENSION);
  return false;
}

/**
 * `cppdbg` launch configuration for a Native Image.
 *
 * Both setup commands undo the same assumption: GraalVM writes the source cache and the pretty-printer beside the
 * image and expects GDB's working directory to be that same place, which it is not — the debugged program runs in
 * the project. `set directories` is the command the GraalVM debug-info guide prescribes for the cache; sourcing
 * `gdb-debughelpers.py` replaces the `.debug_gdb_scripts` auto-load that only fires in the image's own directory,
 * and is what makes Java objects, arrays and strings print as such.
 */
function cppdbgConfig(
  launch: ElideNativeLaunchConfig,
  project: ElideProject,
  binary: string,
  settings: ElideConfig,
): vscode.DebugConfiguration & { MIMode: string; miDebuggerPath?: string } {
  const info = nativeImageDebugInfo(binary);
  const driver = miDriver(settings);
  const setupCommands = [{ text: `set directories ${info.sources}`, description: "Native Image source cache", ignoreFailures: true }];
  if (driver.MIMode === "gdb" && existsSync(info.gdbHelpers)) {
    setupCommands.push({ text: `source ${info.gdbHelpers}`, description: "Native Image pretty-printers", ignoreFailures: true });
  }
  return {
    type: CPPDBG_TYPE,
    request: "launch",
    name: launch.name,
    program: binary,
    args: launch.args ?? [],
    cwd: launch.cwd ? path.resolve(project.root, launch.cwd) : project.root,
    environment: Object.entries(launch.env ?? {}).map(([name, value]) => ({ name, value })),
    stopAtEntry: launch.stopAtEntry ?? false,
    ...driver,
    setupCommands,
  };
}

/**
 * Machine-interface debugger `cppdbg` drives. GraalVM emits DWARF for GDB, so `auto` takes a GDB whenever there is
 * one and falls back to LLDB on macOS, which ships no GDB at all. An explicit `miDebuggerPath` wins; otherwise a GDB
 * is looked up on `PATH` (the adapter's own default is the fixed `/usr/bin/gdb`), while LLDB is left to the C/C++
 * extension, which bundles its own `lldb-mi`.
 */
function miDriver(settings: ElideConfig): { MIMode: string; miDebuggerPath?: string } {
  const gdb = settings.miDebuggerPath ?? whichExecutable("gdb");
  const mode = settings.nativeMiMode === "auto" ? (gdb ? "gdb" : process.platform === "darwin" ? "lldb" : "gdb") : settings.nativeMiMode;
  const debuggerPath = settings.miDebuggerPath ?? (mode === "gdb" ? gdb : undefined);
  return { MIMode: mode, ...(debuggerPath ? { miDebuggerPath: debuggerPath } : {}) };
}

/**
 * Output `name` the artifact declares, which decides the file `elide build` writes. Read from the manifest text so a
 * hand-written launch configuration resolves the same binary the code lens does.
 */
async function outputNameOf(project: ElideProject, artifact: string, ui: ElideUi): Promise<string | undefined> {
  try {
    const artifacts = parseManifestArtifacts(await readFile(project.manifestPath, "utf8"));
    return artifacts.find((a) => a.name === artifact)?.outputName;
  } catch (e) {
    ui.log(`could not read ${project.manifestPath}: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/**
 * Warn when source-level debugging cannot work, and say which of the two reasons it is: the artifact was built
 * without `-g`, so there are no line tables at all, or `-g` ran on a platform GraalVM emits no debug info for — it
 * still copies the GDB helpers, but no source cache and no DWARF. The session starts either way; machine-level
 * stepping and `info functions` still work.
 */
function warnMissingDebugInfo(binary: string, project: ElideProject, artifact: string | undefined, ui: ElideUi): void {
  const info = nativeImageDebugInfo(binary);
  if (existsSync(info.sources)) return;
  const image = path.basename(binary);
  const requested = existsSync(info.gdbHelpers);
  ui.log(`native debug: no source cache beside ${binary} (\`-g\` ${requested ? "was passed" : "missing"}); source breakpoints will not bind`);
  const message = requested
    ? `Elide: ${image} was built with \`-g\`, but this platform produced no debug info — GraalVM only emits it on Linux. Breakpoints in Kotlin and Java will not bind.`
    : `Elide: ${image} carries no debug info. Add \`-g\` (and \`-O0\`) to ${artifact ? `\`["${artifact}"]\`` : "the artifact"}'s \`options.flags\` in elide.pkl for source-level debugging.`;
  void vscode.window.showWarningMessage(message, "Open elide.pkl").then((pick) => {
    if (pick === "Open elide.pkl") void vscode.window.showTextDocument(vscode.Uri.file(project.manifestPath));
  });
}
