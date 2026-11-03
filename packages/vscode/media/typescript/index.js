"use strict";

const path = require("node:path");

// build.d.ts is vendored verbatim from elide-dev/elide, packages/types/build.d.ts
// (@elide-dev/types, MIT). Its notice is included in LICENSE beside this file.
const buildTypes = path.join(__dirname, "build.d.ts");

module.exports = function init({ typescript: ts }) {
  const projects = new WeakMap();

  function declaresBuild(source) {
    const declaresName = (statement) =>
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ||
        ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
      statement.name?.text === "ElideBuild";
    if (!ts.isExternalModule(source) && source.statements.some(declaresName)) return true;
    return source.statements.some((statement) =>
      ts.isModuleDeclaration(statement) &&
      (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0 &&
      statement.body && ts.isModuleBlock(statement.body) &&
      statement.body.statements.some(declaresName));
  }

  function filesFor(state, roots) {
    const { project, serverHost } = state.info;
    const program = project.getCurrentProgram(); // Never getProgram(): that updates the graph recursively.
    const version = project.getProjectVersion();
    if (state.version === version && state.program === program) return state.files;
    state.version = version;
    state.program = program;

    // Only inspect ancestors of project locations, not the filesystem tree. No extra watchers.
    // Recheck on the next graph update, rather than caching absent manifests forever.
    const directories = new Map();
    function inElide(directory) {
      directory = path.resolve(directory);
      if (directories.has(directory)) return directories.get(directory);
      const parent = path.dirname(directory);
      const found = serverHost.fileExists(path.join(directory, "elide.pkl")) ||
        (parent !== directory && inElide(parent));
      directories.set(directory, found);
      return found;
    }
    const currentDirectory = project.getCurrentDirectory();
    const resolve = (file) => path.resolve(currentDirectory, file);
    const isOurs = (file) => state.canonical(resolve(file)) === state.canonical(buildTypes);
    const projectName = project.getProjectName();
    const scoped = inElide(currentDirectory) ||
      (path.isAbsolute(projectName) && !projectName.startsWith("/dev/null/") &&
        inElide(path.dirname(projectName))) ||
      roots.some((file) => !isOurs(file) && /\.[cm]?[jt]sx?$/i.test(file) &&
        inElide(path.dirname(resolve(file))));

    let provided = false;
    if (scoped) {
      const rootNames = new Set(roots.map((file) => state.canonical(resolve(file))));
      const liveRoots = new Set();
      for (const file of roots) {
        if (isOurs(file)) continue;
        liveRoots.add(file);
        const scriptVersion = project.getScriptVersion(file);
        let cached = state.declarations.get(file);
        if (!cached || cached.version !== scriptVersion) {
          const snapshot = project.getScriptSnapshot(file);
          const text = snapshot?.getText(0, snapshot.getLength());
          cached = {
            version: scriptVersion,
            provided: !!text?.includes("ElideBuild") && declaresBuild(
              ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false)),
          };
          state.declarations.set(file, cached);
        }
        if (cached.provided) { provided = true; break; }
      }
      for (const file of state.declarations.keys()) {
        if (!liveRoots.has(file)) state.declarations.delete(file);
      }
      // Includes ambient declarations supplied by imported packages and triple-slash references.
      if (!provided && program) {
        provided = program.getSourceFiles().some((source) =>
          !isOurs(source.fileName) && !rootNames.has(state.canonical(resolve(source.fileName))) &&
          !program.isSourceFileDefaultLibrary(source) && declaresBuild(source));
      }
    }
    const status = !scoped ? "outside an Elide project" : provided ? "using project-provided ElideBuild" : "providing build.d.ts";
    if (status !== state.status) {
      project.projectService.logger.info(`[elide-build] ${status}: ${projectName}`);
      state.status = status;
    }
    state.files = scoped && !provided ? [buildTypes] : [];
    return state.files;
  }

  return {
    create(info) {
      if (projects.has(info.project)) return info.languageService;
      const host = info.languageServiceHost;
      const originalFiles = host.getScriptFileNames.bind(host);
      const caseSensitive = info.project.useCaseSensitiveFileNames();
      const state = {
        info,
        originalFiles,
        canonical: caseSensitive ? (file) => file : (file) => file.toLowerCase(),
        declarations: new Map(),
        files: [],
      };
      projects.set(info.project, state);
      // getExternalFiles alone only attaches ScriptInfos for inferred projects; it does not
      // add them to their program roots. Use the native host for both project kinds.
      host.getScriptFileNames = () => {
        const roots = originalFiles();
        const files = filesFor(state, roots);
        const withoutOurs = roots.filter((file) =>
          state.canonical(path.resolve(info.project.getCurrentDirectory(), file)) !== state.canonical(buildTypes));
        return files.length || withoutOurs.length !== roots.length ? withoutOurs.concat(files) : roots;
      };
      return info.languageService;
    },
    getExternalFiles(project) {
      const state = projects.get(project);
      if (!state) return [];
      const files = filesFor(state, state.originalFiles());
      const program = project.getCurrentProgram();
      // Imported ambient declarations become visible only after the first program is built.
      // Invalidate its roots if that discovery changes which declaration supplies the API.
      if (program && !!program.getSourceFile(buildTypes) !== (files.length !== 0)) {
        project.markAsDirty();
      }
      return files;
    },
  };
};
