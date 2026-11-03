"use strict";

const { createWriteStream } = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pipeline } = require("node:stream/promises");
// vsce's pinned collector performs manifest/README/license processing and secret validation.
// Its --no-dependencies traversal always skips root node_modules, even when .vscodeignore includes it.
const vsce = require("@vscode/vsce/out/package");
const { ZipFile } = createRequire(require.resolve("@vscode/vsce"))("yazl");

async function main() {
  const cwd = process.cwd();
  const options = { cwd, dependencies: false, packagePath: process.argv[2] };
  const manifest = await vsce.readManifest(cwd);
  const files = await vsce.collect(manifest, options);
  const plugin = "node_modules/elide-build-typescript-plugin";
  for (const name of ["package.json", "index.js", "build.d.ts", "LICENSE"]) {
    const relative = `${plugin}/${name}`;
    files.push({ path: `extension/${relative}`, localPath: path.join(cwd, relative) });
  }
  // Include the declaration file's content type along with the regular extension assets.
  files.find((file) => file.path === "[Content_Types].xml").contents = Buffer.from(await vsce.toContentTypes(files));
  await vsce.printAndValidatePackagedFiles(files, cwd, manifest, options);
  const archive = new ZipFile();
  const written = pipeline(archive.outputStream, createWriteStream(options.packagePath));
  const mtime = new Date("2000-01-01T00:00:00Z");
  for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
    const zipOptions = { mtime, mode: file.mode };
    if (file.contents !== undefined) archive.addBuffer(Buffer.from(file.contents), file.path, zipOptions);
    else archive.addFile(file.localPath, file.path, zipOptions);
  }
  archive.end();
  await written;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
