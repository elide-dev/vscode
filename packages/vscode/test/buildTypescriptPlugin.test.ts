import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const extensionRoot = fileURLToPath(new URL("../", import.meta.url));
const buildTypes = join(extensionRoot, "node_modules/elide-build-typescript-plugin/build.d.ts");
const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function projectFixture(files: Record<string, string>, configured = false) {
  const root = mkdtempSync(join(tmpdir(), "elide-build-types-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const projectRoot = join(workspace, "project");
  mkdirSync(projectRoot, { recursive: true });
  if (configured) {
    files = {
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, allowJs: true, checkJs: true, target: "ES2022", types: [] },
        include: ["**/*"],
      }),
      ...files,
    };
  }
  for (const [name, text] of Object.entries(files)) {
    const file = join(projectRoot, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  const logger: ts.server.Logger = {
    close() {}, hasLevel: () => false, loggingEnabled: () => true,
    perftrc() {}, info() {}, msg() {},
    startGroup() {}, endGroup() {}, getLogFileName: () => undefined,
  };
  const host: ts.server.ServerHost = {
    ...ts.sys,
    getCurrentDirectory: () => workspace,
    writeFile() { throw new Error("Language service must not write project files"); },
    watchFile: () => ({ close() {} }),
    watchDirectory: () => ({ close() {} }),
    setTimeout: () => 0, clearTimeout() {},
    setImmediate: () => 0, clearImmediate() {},
  };
  const service = new ts.server.ProjectService({
    host, logger,
    cancellationToken: ts.server.nullCancellationToken,
    useSingleInferredProject: false,
    useInferredProjectPerProjectRoot: true,
    globalPlugins: ["elide-build-typescript-plugin"],
    pluginProbeLocations: [extensionRoot],
    session: undefined,
  });
  service.setCompilerOptionsForInferredProjects({
    strict: true, allowJs: true, checkJs: true, target: "ES2022", types: [],
  });
  cleanup.push(() => {
    for (const project of service.configuredProjects.values()) project.close();
    for (const project of service.inferredProjects) if (!project.isClosed()) project.close();
  });
  function open(name: string) {
    const file = join(projectRoot, name);
    service.openClientFile(file, undefined, undefined, workspace);
    const project = service.getDefaultProjectForFile(ts.server.toNormalizedPath(file), true)!;
    const language = project.getLanguageService();
    return { file, project, language };
  }
  return { open, service, root: projectRoot };
}

const body = `{
  build.task("generate", { description: "Generate sources", cache: "invalid" }, (ctx) => {
    ctx.tools.javac({ sources: ["src/Main.java"], out: "out" });
    ctx.exec("echo", { quiet: false });
  });
};`;
const typed = `export default (build: ElideBuild) => ${body}`;
const javascript = `// @ts-check\n/** @param {ElideBuild} build */\nexport default (build) => ${body}`;

function completions(language: ts.LanguageService, file: string, text: string, prefix: string) {
  const position = text.indexOf(prefix) + prefix.length;
  expect(position).toBeGreaterThan(prefix.length - 1);
  return language.getCompletionsAtPosition(file, position, {})?.entries.map((entry) => entry.name) ?? [];
}

test.each(["ts", "mts", "tsx", "js", "mjs", "jsx"])(
  "inferred tools/tasks.%s uses the contributed loader and native completions, diagnostics and hover",
  (extension) => {
    const text = /^(js|mjs|jsx)$/.test(extension) ? javascript : typed;
    const name = `tools/tasks.${extension}`;
    const fixture = projectFixture({ "elide.pkl": "", [name]: text });
    const { file, project, language } = fixture.open(name);
    expect(project.projectKind).toBe(ts.server.ProjectKind.Inferred);
    expect(project.getExternalFiles()).toContain(buildTypes);
    expect(completions(language, file, text, "build.")).toContain("task");
    expect(completions(language, file, text, "ctx.")).toEqual(expect.arrayContaining(["tools", "exec", "inputs", "dirty"]));
    expect(completions(language, file, text, "ctx.tools.")).toEqual(expect.arrayContaining(["javac", "kotlinc", "format"]));
    const diagnostics = language.getSemanticDiagnostics(file);
    expect(diagnostics.some((diagnostic) => diagnostic.code === 2304)).toBe(false);
    expect(diagnostics.some((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n").includes("boolean"))).toBe(true);
    const hover = language.getQuickInfoAtPosition(file, text.indexOf("javac") + 1)!;
    expect(ts.displayPartsToString(hover.displayParts)).toContain("ElideBuildJavacOptions");
    expect(ts.displayPartsToString(hover.documentation)).toContain("Compile Java sources");
  },
);

test("configured projects supply the API without changing their tsconfig or requiring extension synchronization", () => {
  const fixture = projectFixture({ "elide.pkl": "", "tools/tasks.ts": typed }, true);
  const { file, project, language } = fixture.open("tools/tasks.ts");
  expect(project.projectKind).toBe(ts.server.ProjectKind.Configured);
  expect(project.getExternalFiles()).toContain(buildTypes);
  expect(completions(language, file, typed, "ctx.tools.")).toContain("javac");
  expect(language.getProgram()!.getSourceFile(buildTypes)).toBeDefined();
});

test("async task actions and prepare hooks accept explicitly declared void promises", () => {
  const text = `declare function stamp(ctx: ElideBuildTaskContext): Promise<void>;
declare function prepare(ctx: ElideBuildPrepareContext): Promise<void>;
declare function decide(ctx: ElideBuildTaskContext): Promise<boolean>;
export default (build: ElideBuild) => {
  build.task("stamp", { prepare }, stamp);
  build.task("decide", decide);
};`;
  const fixture = projectFixture({ "elide.pkl": "", "tools/tasks.ts": text }, true);
  const { file, language } = fixture.open("tools/tasks.ts");
  expect(language.getSemanticDiagnostics(file)).toEqual([]);
});

test("ordinary TypeScript projects keep ElideBuild unresolved", () => {
  const fixture = projectFixture({ "tools/tasks.ts": typed }, true);
  const { file, project, language } = fixture.open("tools/tasks.ts");
  expect(project.getExternalFiles()).not.toContain(buildTypes);
  expect(language.getProgram()!.getSourceFile(buildTypes)).toBeUndefined();
  expect(language.getSemanticDiagnostics(file).some((diagnostic) => diagnostic.code === 2304)).toBe(true);
});

test.each([
  "type ElideBuild = { custom: string }; type ElideBuildConfig = string;",
  "export {}; declare global { interface ElideBuild { custom: string } }",
])("project-provided global declarations take precedence: %s", (declaration) => {
  const text = "export default (build: ElideBuild) => build.custom;";
  const fixture = projectFixture({ "elide.pkl": "", "tools/tasks.ts": text, "build.d.ts": declaration }, true);
  const { file, project, language } = fixture.open("tools/tasks.ts");
  expect(project.getExternalFiles()).not.toContain(buildTypes);
  expect(language.getProgram()!.getSourceFile(buildTypes)).toBeUndefined();
  expect(language.getSemanticDiagnostics(file)).toHaveLength(0);
  expect(completions(language, file, text, "build.")).toContain("custom");
});

test("module-local declarations and text mentions do not shadow the canonical ambient API", () => {
  const fixture = projectFixture({
    "elide.pkl": "",
    "tools/tasks.ts": typed,
    "local.ts": "export interface ElideBuild { local: true }; // interface ElideBuild {}",
    "comment.d.ts": "// type ElideBuild = never;\ndeclare const label: 'ElideBuild';",
  }, true);
  const { file, project, language } = fixture.open("tools/tasks.ts");
  expect(project.getExternalFiles()).toContain(buildTypes);
  expect(completions(language, file, typed, "build.")).toContain("task");
});

test("ambient declarations reached through imports take precedence over vendored globals", () => {
  const text = 'import "../ambient";\nexport default (build: ElideBuild) => build.custom;';
  const fixture = projectFixture({
    "elide.pkl": "",
    "tools/tasks.ts": text,
    "ambient.d.ts": "export {}; declare global { type ElideBuild = { custom: string } }",
    "tsconfig.json": JSON.stringify({ compilerOptions: { types: [], strict: true }, files: ["tools/tasks.ts"] }),
  }, true);
  const { file, project, language } = fixture.open("tools/tasks.ts");
  // A dependency is discovered while constructing the first program. getExternalFiles
  // invalidates the native graph when that changes which declaration supplies the API.
  project.getExternalFiles();
  project.getLanguageService();
  expect(project.getExternalFiles()).not.toContain(buildTypes);
  expect(language.getSemanticDiagnostics(file)).toHaveLength(0);
});

test("adding and removing a project declaration in an unsaved buffer refreshes the ambient API", () => {
  const fixture = projectFixture({ "elide.pkl": "", "tools/tasks.ts": typed, "own.d.ts": "" }, true);
  const { project, language } = fixture.open("tools/tasks.ts");
  fixture.open("own.d.ts");
  expect(language.getProgram()!.getSourceFile(buildTypes)).toBeDefined();
  const info = fixture.service.getScriptInfo(join(fixture.root, "own.d.ts"))!;
  const own = "type ElideBuild = { custom: string };";
  info.editContent(0, 0, own);
  project.updateGraph();
  expect(project.getExternalFiles()).not.toContain(buildTypes);
  expect(language.getProgram()!.getSourceFile(buildTypes)).toBeUndefined();
  info.editContent(0, own.length, "");
  project.updateGraph();
  expect(project.getExternalFiles()).toContain(buildTypes);
  expect(language.getProgram()!.getSourceFile(buildTypes)).toBeDefined();
});
