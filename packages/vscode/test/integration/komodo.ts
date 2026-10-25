/**
 * Komodo's language server (runner.ts, `ELIDE_TEST_SCENARIO=komodo`, the JetBrains extension disabled): the sync writes
 * the Komodo project and starts `komodo-lsp-k2`, and every capability the server advertises answers through VS Code's
 * own provider commands, on the real project: completion with its auto-import, signature help, hover with KDoc,
 * definition into a library's sources (`komodo-library:` documents), type definition, implementation, references,
 * highlights, rename across modules, call and type hierarchies, code lenses and their command, quick fixes, organize
 * imports, formatting, semantic tokens, inlay hints, folding, selection ranges, symbols, navigation in a file with an
 * error, the Kotlin language and grammar this extension contributes, and edit-to-diagnostics latency.
 *
 * Fixtures: `samples/ktjvm` (a copy; main and test source sets, the test set a friend of main) or, with
 * `ELIDE_KOMODO_SAMPLE=android`, the built Elide Android sample in place (Compose plugin; `app` depends on the
 * `components` member; Room's kapt output). The in-place sample is never written: every edit is reverted unsaved, and
 * the files are compared with their content on disk at the end.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { ElideExtensionApi } from "../../src/extension.js";
import { errorsOf, log, waitFor } from "./helpers.js";

/** Diagnostics of the Kotlin compiler, as the server labels them. */
const KOTLIN = "kotlin";
const LIBRARY_SCHEME = "komodo-library";
/** Edit-to-diagnostics budget for the edited file, warm (§5 of the requirements). */
const LATENCY_BUDGET_MS = 150;

/** A position: the first occurrence of `needle` in a file, `delta` characters in. */
type At = [needle: string, delta: number];

interface Fixture {
  /** Files by role; `edit` is where edits, completion and latency run. */
  files: Record<"edit" | "from" | "into", string> & Partial<Record<"dao" | "impl", string>>;
  /** Call site in `from` resolving to `declaration` in `into` (or `from`). */
  call: string;
  declaration: At;
  declaredIn: "from" | "into";
  /** The outline of `from`: declarations, members as `Container.member`. */
  symbols: string[];
  /** Unsaved edit on `from` that makes `call` an error at `errorAt`; `stillResolves` must navigate meanwhile. */
  broken: string;
  errorAt: At;
  stillResolves: { at: At; to: At };
  /** Completion typed after `completeAfter` in `edit`: `typed` completes to `label`, importing `imports` if set. */
  completeAfter: string;
  typed: string;
  label: string;
  imports?: string;
  /** Signature help inside a call in `from`: the active signature names this parameter. */
  signatureAt: At;
  parameter: string;
  /** Hover in `edit` on a library function: its KDoc mentions `kdoc` when the library has sources. */
  hoverAt: At;
  kdoc?: RegExp;
  /** Definition in `edit` of a library declaration: a `komodo-library:` document containing `libraryText`. */
  libraryAt: At;
  libraryText: string;
  /**
   * Type definition of a variable in `edit`, to a document declaring `typeDeclaration`. The file it lives in depends
   * on the library's sources: kotlin-stdlib 2.5 declares `List` in `jvmMain/kotlin/Collections.kt`, not `List.kt`.
   */
  typeAt: At;
  typeDeclaration: string;
  /** Implementations of an interface (`files.dao`), into a generated Java file (`files.impl`). */
  implementationAt?: At;
  /** Highlights of a variable in `edit`: at least this many occurrences. */
  highlightAt: At;
  highlights: number;
  /** Rename of `declaration` to `renamed`: the edit touches both `from` and `into`. */
  renamed: string;
  /** Callers of `declaration` the call hierarchy lists. */
  callers: string[];
  /** Subtypes of the interface at `implementationAt`, and supertypes of a class in `from`/`into`. */
  subtypes?: string[];
  supertypesAt?: [file: "from" | "into" | "dao", at: At, names: string[]];
  /** A line inserted after `completeAfter` that needs an import, and the quick fix's title. */
  missingImport: string;
  importFix: RegExp;
  /** Text inserted in `into` that ktfmt reformats, or none when the file is already unformatted. */
  misformatted?: string;
  /** A call in `from` whose semantic token carries the `composable` modifier. */
  composableAt?: At;
  /** A type an inlay hint in `edit` names. */
  inlayType: string;
  /** Move `from` to this directory (relative to its own) through a file rename: `package` follows. */
  moveTo?: { directory: string; package: string };
}

const FIXTURES: Record<string, (sample: string) => Fixture> = {
  ktjvm: (sample) => ({
    files: {
      edit: path.join(sample, "src", "main", "sample", "Main.kt"),
      from: path.join(sample, "src", "main", "sample", "Main.kt"),
      into: path.join(sample, "src", "test", "sample", "MainTest.kt"),
    },
    call: "greeting(words)",
    declaration: ["fun greeting", 4],
    declaredIn: "from",
    symbols: ["greeting", "main"],
    broken: "greeting(words, 1)",
    errorAt: [", 1)", 2],
    stillResolves: { at: ["println(greeting(words, 1))", 17], to: ["val words", 4] },
    completeAfter: "    println(greeting(words))\n",
    typed: "    gree",
    label: "greeting",
    signatureAt: ["greeting(words)", 9],
    parameter: "words",
    hoverAt: ["listOf(", 1],
    libraryAt: ["listOf(", 1],
    libraryText: "fun <T> listOf(",
    typeAt: ["val words", 4],
    typeDeclaration: "interface List<out E>",
    highlightAt: ["val words", 4],
    highlights: 2,
    renamed: "salutation",
    callers: ["main", "testGreeting"],
    missingImport: "    val tabs: TreeMap<String, Int>? = null\n",
    importFix: /^Import 'java\.util\.TreeMap'$/,
    misformatted: "\nfun  spaced( a:Int )=a\n",
    inlayType: "List<String>",
    moveTo: { directory: "other", package: "sample.other" },
  }),
  android: (sample) => ({
    files: {
      edit: path.join(sample, "app", "src", "main", "kotlin", "sample", "app", "MainActivity.kt"),
      from: path.join(sample, "app", "src", "main", "kotlin", "sample", "app", "PreviewGallery.kt"),
      into: path.join(sample, "components", "src", "main", "kotlin", "sample", "components", "JourneyCard.kt"),
      dao: path.join(sample, "app", "src", "main", "kotlin", "sample", "data", "JourneyDatabase.kt"),
      impl: path.join(sample, "app", ".dev", "jvm", "generated-sources", "main", "kapt", "sample", "data", "JourneyDao_Impl.java"),
    },
    call: "JourneyCard(example)",
    declaration: ["fun JourneyCard", 4],
    declaredIn: "into",
    symbols: ["ActionButton", "AppearancePreview", "DataPreview", "DeviceConfigurationPreview", "LocalizedPreview", "MemberPreviews", "MemberPreviews.MemberCard", "MultiPreview", "SampleScreen", "ScreenSizes", "StatePreview", "example", "generatedJourneySchema"],
    broken: "JourneyCard(example, 1)",
    errorAt: [", 1)", 2],
    stillResolves: { at: ["JourneyCard(example, 1)", 12], to: ["val example", 4] },
    completeAfter: "  val scope = rememberCoroutineScope()\n",
    typed: "  JourneyCa",
    label: "JourneyCard",
    imports: "import sample.components.JourneyCard",
    signatureAt: ["JourneyCard(example)", 12],
    parameter: "journey",
    hoverAt: ["remember(dao)", 1],
    kdoc: /Remember the value/,
    libraryAt: ["remember(dao)", 1],
    libraryText: "fun <T> remember(",
    typeAt: ["val dao", 4],
    typeDeclaration: "interface JourneyDao",
    implementationAt: ["interface JourneyDao", 10],
    highlightAt: ["dao: JourneyDao", 0],
    highlights: 5,
    renamed: "JourneyTile",
    callers: ["AppearancePreview", "LibraryCardPreview"],
    subtypes: ["JourneyDao_Impl"],
    supertypesAt: ["dao", ["abstract class JourneyDatabase", 15], ["RoomDatabase"]],
    missingImport: "  val provider: JourneyProvider? = null\n",
    importFix: /^Import 'sample\.components\.JourneyProvider'$/,
    composableAt: ["JourneyCard(example)", 0],
    inlayType: "JourneyDao",
  }),
};

interface Outcome { name: string; status: "passed" | "failed" | "skipped"; detail: string }

export async function runKomodoScenario(): Promise<void> {
  const sampleName = process.env.ELIDE_KOMODO_SAMPLE ?? "ktjvm";
  const fixture = FIXTURES[sampleName]!(process.env.ELIDE_TEST_SAMPLE!);
  if (process.env.ELIDE_KOMODO_COEXIST) return await runCoexistence(fixture);
  const inPlace = sampleName === "android";
  const disk = new Map(Object.values(fixture.files).filter(existsSync).map((file) => [file, readFileSync(file, "utf8")]));
  const uri = (role: keyof Fixture["files"]) => vscode.Uri.file(fixture.files[role]!);
  const open = async (role: keyof Fixture["files"]) => vscode.workspace.openTextDocument(uri(role));
  const show = async (role: keyof Fixture["files"]) => vscode.window.showTextDocument(await open(role), { preview: false });
  const at = (doc: vscode.TextDocument, [needle, delta]: At) => {
    const offset = doc.getText().indexOf(needle);
    assert.ok(offset >= 0, `${needle} not found in ${path.basename(doc.uri.fsPath)}`);
    return doc.positionAt(offset + delta);
  };
  const outcomes: Outcome[] = [];
  const check = async (name: string, run: () => Promise<string | void>, skip?: string) => {
    if (skip) {
      outcomes.push({ name, status: "skipped", detail: skip });
      log(`SKIP ${name}: ${skip}`);
      return;
    }
    const started = Date.now();
    try {
      const detail = (await run()) ?? "";
      outcomes.push({ name, status: "passed", detail });
      log(`PASS ${name} (${Date.now() - started} ms)${detail ? `: ${detail}` : ""}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcomes.push({ name, status: "failed", detail });
      log(`FAIL ${name}: ${detail}`);
    } finally {
      await revertAll();
    }
  };
  /** Insert `text` after `anchor` in the edited file; returns the editor and the inserted range's end. */
  const insertAfter = async (anchor: string, text: string, role: keyof Fixture["files"] = "edit") => {
    const editor = await show(role);
    const position = at(editor.document, [anchor, anchor.length]);
    assert.ok(await editor.edit((edit) => edit.insert(position, text)), `inserting into ${path.basename(editor.document.uri.fsPath)}`);
    return { editor, end: editor.document.positionAt(editor.document.offsetAt(position) + text.length) };
  };

  const from = await open("from");
  const into = await open("into");
  const declared = fixture.declaredIn === "from" ? from : into;
  const started = Date.now();

  // Startup sync, then the first analysis: the call resolves to its declaration, in the same file or another module.
  await show("from");
  const definitions = await waitFor(`Komodo definition of ${fixture.call}`, async () => {
    const found = await vscode.commands.executeCommand<vscode.Location[]>("vscode.executeDefinitionProvider", from.uri, at(from, [fixture.call, 1]));
    return found && found.length > 0 ? found : undefined;
  }, 240_000, 2_000);
  log(`first definition after ${Date.now() - started} ms`);

  await check("language and grammar", async () => {
    // With the JetBrains extension disabled, `kotlin` and its grammar are this extension's.
    assert.equal(from.languageId, "kotlin");
    const tokens = await vscode.commands.executeCommand<{ c: string; t: string }[]>("_workbench.captureSyntaxTokens", from.uri);
    const scopes = (text: string) => tokens.find((token) => token.c === text)?.t ?? "";
    assert.match(scopes("fun"), /\bsource\.kotlin\b.*\bkeyword\b|\bkeyword\b.*\bsource\.kotlin\b|storage/, `fun: ${scopes("fun")}`);
    assert.ok(tokens.some((token) => /\bcomment\b/.test(token.t)) || !from.getText().includes("//"), "comments are scoped");
    const customizations = vscode.workspace.getConfiguration("editor").inspect<{ rules?: Record<string, unknown> }>("semanticTokenColorCustomizations");
    assert.ok(customizations?.defaultValue?.rules?.["function.composable:kotlin"], `composable colour default: ${JSON.stringify(customizations?.defaultValue)}`);
    return `fun → ${scopes("fun")}`;
  });

  await check("definition across modules", async () => {
    assert.equal(definitions.length, 1);
    assert.equal(definitions[0]!.uri.fsPath, declared.uri.fsPath);
    assert.deepEqual(definitions[0]!.range.start, at(declared, fixture.declaration));
  });

  await check("references across modules", async () => {
    const references = await vscode.commands.executeCommand<vscode.Location[]>("vscode.executeReferenceProvider", declared.uri, at(declared, fixture.declaration));
    const other = declared === from ? into : from;
    assert.ok(references.some((reference) => reference.uri.fsPath === other.uri.fsPath), `a reference in ${path.basename(other.uri.fsPath)}: ${JSON.stringify(references.map((r) => r.uri.fsPath))}`);
    return `${references.length} references`;
  });

  await check("document and workspace symbols", async () => {
    const symbols = await waitFor("document symbols", () => vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>("vscode.executeDocumentSymbolProvider", from.uri), 30_000, 1_000);
    const outline = symbols.flatMap((symbol) => [symbol.name, ...symbol.children.map((child) => `${symbol.name}.${child.name}`)]);
    assert.deepEqual(outline.sort(), fixture.symbols);
    const name = at(declared, fixture.declaration);
    const declaredName = declared.getText(declared.getWordRangeAtPosition(name));
    const found = await vscode.commands.executeCommand<vscode.SymbolInformation[]>("vscode.executeWorkspaceSymbolProvider", declaredName.slice(0, -2));
    assert.ok(found.some((symbol) => symbol.name === declaredName && symbol.location.uri.fsPath === declared.uri.fsPath), `workspace symbol ${declaredName}: ${found.map((s) => s.name).join(", ")}`);
  });

  await check("completion with auto-import", async () => {
    const { editor, end } = await insertAfter(fixture.completeAfter, `${fixture.typed}\n`);
    const position = end.translate(-1).with({ character: fixture.typed.length });
    const list = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", editor.document.uri, position, undefined, 30);
    const item = list.items.find((candidate) => (typeof candidate.label === "string" ? candidate.label : candidate.label.label) === fixture.label);
    assert.ok(item, `${fixture.label} among ${list.items.slice(0, 20).map((i) => (typeof i.label === "string" ? i.label : i.label.label)).join(", ")}`);
    // Accept it as the suggest widget does: the main edit (a snippet when the server sends one), then the import.
    const range = item.range instanceof vscode.Range ? item.range : item.range?.replacing ?? editor.document.getWordRangeAtPosition(position)!;
    const insert = item.insertText ?? (typeof item.label === "string" ? item.label : item.label.label);
    assert.ok(await editor.insertSnippet(insert instanceof vscode.SnippetString ? insert : new vscode.SnippetString(insert.replace(/\$/g, "\\$")), range));
    if (item.additionalTextEdits?.length) assert.ok(await editor.edit((edit) => item.additionalTextEdits!.forEach((e) => edit.replace(e.range, e.newText))));
    const text = editor.document.getText();
    assert.ok(text.includes(`${fixture.label}(`) || text.includes(fixture.label), `inserted ${fixture.label}`);
    if (fixture.imports) assert.ok(text.includes(`${fixture.imports}\n`), `auto-import ${fixture.imports}; edits ${JSON.stringify(item.additionalTextEdits)}`);
    return `${list.items.length} items; inserted ${JSON.stringify(insert instanceof vscode.SnippetString ? insert.value : insert)}`;
  });

  await check("signature help", async () => {
    const help = await vscode.commands.executeCommand<vscode.SignatureHelp>("vscode.executeSignatureHelpProvider", from.uri, at(from, fixture.signatureAt), "(");
    const signature = help?.signatures[help.activeSignature];
    assert.ok(signature, "a signature");
    const parameter = signature.parameters[help.activeParameter];
    const label = typeof parameter?.label === "string" ? parameter.label : parameter ? signature.label.slice(...parameter.label) : "";
    assert.match(label, new RegExp(`^${fixture.parameter}\\b`), `active parameter of ${signature.label}`);
    return signature.label;
  });

  const edit = await open("edit");
  await check("hover with KDoc", async () => {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", edit.uri, at(edit, fixture.hoverAt));
    const text = hovers.flatMap((hover) => hover.contents).map((content) => (typeof content === "string" ? content : content.value)).join("\n");
    assert.ok(text.includes(fixture.hoverAt[0].replace(/\(.*$/, "")), `hover names the symbol: ${text.slice(0, 200)}`);
    if (fixture.kdoc) assert.match(text, fixture.kdoc);
    return text.replace(/\s+/g, " ").slice(0, 160);
  });

  await check("reload preserves analysis and unsaved declarations", async () => {
    const extension = vscode.extensions.all.find((candidate) => candidate.id.endsWith(".elide"));
    const activity = (extension?.exports as ElideExtensionApi).activity;
    const { editor } = await insertAfter(edit.getText(), "\nfun unsavedReloadProbe() = 42\n");
    for (let pass = 0; pass < 2; pass++) {
      const previous = activity.getChildren()[0];
      await vscode.commands.executeCommand("elide.sync");
      const sync = activity.getChildren().find((operation) => operation !== previous && operation.label.startsWith("Sync "));
      assert.ok(sync, "manual sync recorded");
      assert.equal(sync.state, "succeeded", sync.detail);
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", edit.uri, at(edit, fixture.hoverAt));
      const text = hovers.flatMap((hover) => hover.contents).map((content) => typeof content === "string" ? content : content.value).join("\n");
      assert.ok(text.includes(fixture.hoverAt[0].replace(/\(.*$/, "")), `library hover survives reload ${pass + 1}: ${text}`);
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>("vscode.executeDocumentSymbolProvider", edit.uri);
      assert.ok(symbols.some((symbol) => symbol.name === "unsavedReloadProbe"), "reloaded session uses the unsaved buffer");
      assert.equal(editor.document.isDirty, true);
    }
  });

  await check("definition into library sources", async () => {
    const locations = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>("vscode.executeDefinitionProvider", edit.uri, at(edit, fixture.libraryAt));
    const target = locations.map((location) => ("targetUri" in location ? location.targetUri : location.uri))[0];
    assert.equal(target?.scheme, LIBRARY_SCHEME, `library location: ${String(target)}`);
    const library = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(library, { preview: true });
    assert.equal(library.languageId, "kotlin");
    assert.ok(library.getText().includes(fixture.libraryText), `${fixture.libraryText} in ${target.toString()}`);
    return `${target.path} (${library.lineCount} lines)`;
  });

  await check("type definition", async () => {
    const locations = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>("vscode.executeTypeDefinitionProvider", edit.uri, at(edit, fixture.typeAt));
    const location = locations[0];
    assert.ok(location, "type definition: no location");
    const [target, range] = "targetUri" in location
      ? [location.targetUri, location.targetSelectionRange ?? location.targetRange]
      : [location.uri, location.range];
    const document = await vscode.workspace.openTextDocument(target);
    // The declaration's own lines (a range may start at its KDoc or annotations), not merely somewhere in the file.
    const first = range.start.line;
    const last = Math.min(document.lineCount - 1, Math.max(range.end.line, first + 2));
    const text = Array.from({ length: last - first + 1 }, (_, i) => document.lineAt(first + i).text).join("\n");
    assert.ok(text.includes(fixture.typeDeclaration), `type definition: ${fixture.typeDeclaration} not at ${String(target)}:${first + 1}`);
    return target.toString().slice(0, 120);
  });

  await check("implementation", async () => {
    const dao = await open("dao");
    const locations = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>("vscode.executeImplementationProvider", dao.uri, at(dao, fixture.implementationAt!));
    const targets = locations.map((location) => ("targetUri" in location ? location.targetUri : location.uri).fsPath);
    assert.ok(targets.includes(fixture.files.impl!), `implementations: ${targets.join(", ")}`);
  }, fixture.implementationAt ? undefined : "no interface with a generated implementation in this sample");

  await check("document highlight", async () => {
    const highlights = await vscode.commands.executeCommand<vscode.DocumentHighlight[]>("vscode.executeDocumentHighlights", edit.uri, at(edit, fixture.highlightAt));
    assert.ok(highlights.length >= fixture.highlights, `${highlights.length} highlights`);
    return `${highlights.length} highlights`;
  });

  await check("rename across modules", async () => {
    const position = at(declared, fixture.declaration);
    const prepared = await vscode.commands.executeCommand<{ range: vscode.Range; placeholder: string }>("vscode.prepareRename", declared.uri, position);
    const original = declared.getText(declared.getWordRangeAtPosition(position));
    assert.equal(prepared.placeholder, original);
    const rename = await vscode.commands.executeCommand<vscode.WorkspaceEdit>("vscode.executeDocumentRenameProvider", declared.uri, position, fixture.renamed);
    const files = rename.entries().map(([target]) => target.fsPath);
    assert.ok(files.includes(from.uri.fsPath) && files.includes(into.uri.fsPath), `rename edits ${files.join(", ")}`);
    // Applied in this window only: the documents change unsaved, then revert.
    assert.ok(await vscode.workspace.applyEdit(rename));
    assert.ok(from.getText().includes(fixture.call.replace(original, fixture.renamed)), "the call site is renamed");
    return `${rename.size} files, ${rename.entries().reduce((sum, [, edits]) => sum + edits.length, 0)} edits`;
  });

  await check("call hierarchy", async () => {
    const [item] = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>("vscode.prepareCallHierarchy", declared.uri, at(declared, fixture.declaration));
    assert.ok(item, "a call hierarchy item");
    const incoming = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>("vscode.provideIncomingCalls", item);
    const callers = incoming.map((call) => call.from.name);
    for (const caller of fixture.callers) assert.ok(callers.includes(caller), `${caller} among callers ${callers.join(", ")}`);
    const outgoing = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>("vscode.provideOutgoingCalls", incoming[0]!.from);
    assert.ok(outgoing.some((call) => call.to.name === item.name), `${incoming[0]!.from.name} calls ${item.name}`);
    return `callers ${callers.join(", ")}`;
  });

  await check("type hierarchy", async () => {
    const dao = await open("dao");
    const [item] = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>("vscode.prepareTypeHierarchy", dao.uri, at(dao, fixture.implementationAt!));
    assert.ok(item, "a type hierarchy item");
    const subtypes = (await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>("vscode.provideSubtypes", item)).map((sub) => sub.name);
    for (const name of fixture.subtypes!) assert.ok(subtypes.includes(name), `${name} among subtypes ${subtypes.join(", ")}`);
    const [file, position, names] = fixture.supertypesAt!;
    const document = await open(file);
    const [cls] = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>("vscode.prepareTypeHierarchy", document.uri, at(document, position));
    const supertypes = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>("vscode.provideSupertypes", cls);
    for (const name of names) assert.ok(supertypes.some((type) => type.name === name), `${name} among supertypes ${supertypes.map((s) => s.name).join(", ")}`);
    return `subtypes ${subtypes.join(", ")}; supertypes ${supertypes.map((s) => `${s.name} (${s.uri.scheme})`).join(", ")}`;
  }, fixture.implementationAt ? undefined : "no type hierarchy fixture in this sample");

  await check("code lens and its command", async () => {
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", declared.uri, 100);
    const name = at(declared, fixture.declaration);
    const lens = lenses.find((candidate) => candidate.range.contains(name) && candidate.command?.command === "komodo.showReferences");
    assert.ok(lens?.command, `a resolved references lens: ${JSON.stringify(lenses.map((l) => l.command?.title))}`);
    await vscode.commands.executeCommand(lens.command.command, ...(lens.command.arguments ?? []));
    await vscode.commands.executeCommand("closeReferenceSearch");
    return lens.command.title;
  });

  await check("reference lenses survive declaration edits and reverts", async () => {
    const target = fixture.files.dao ? await open("dao") : declared;
    const editor = await vscode.window.showTextDocument(target, { preview: false });
    const original = target.getText();
    const anchor = fixture.files.dao ? "  val createdAt: Long,\n" : "fun greeting(words: List<String>)";
    const offset = original.indexOf(anchor);
    assert.ok(offset >= 0, `declaration edit anchor: ${anchor}`);
    const replacement = fixture.files.dao
      ? `${anchor}  val note: String = "",\n`
      : "fun greeting(words: List<String>, suffix: String = \"\")";
    // Warm Java/light-class reference caches before changing the declaration's signature.
    const resolve = async () => {
      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", target.uri, 1_000);
      const references = lenses.filter((lens) => lens.command?.command === "komodo.showReferences");
      const needle: At = fixture.files.dao ? ["interface JourneyDao", 10] : fixture.declaration;
      assert.ok(references.some((lens) => lens.range.contains(at(target, needle))), "the declaration keeps its resolved reference lens");
    };
    await resolve();
    for (let pass = 0; pass < 3; pass++) {
      assert.ok(await editor.edit((builder) => builder.replace(
        new vscode.Range(target.positionAt(offset), target.positionAt(offset + anchor.length)), replacement,
      )));
      await resolve();
      await vscode.commands.executeCommand("workbench.action.files.revert");
      assert.equal(target.getText(), original);
      await resolve();
    }
  });

  await check("quick fix: missing import", async () => {
    const { editor } = await insertAfter(fixture.completeAfter, fixture.missingImport);
    const diagnostic = await waitFor("unresolved reference", () => errorsOf(editor.document.uri).find((d) => d.source === KOTLIN && /UNRESOLVED_REFERENCE/.test(String(d.code))), 30_000, 200);
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>("vscode.executeCodeActionProvider", editor.document.uri, diagnostic.range, vscode.CodeActionKind.QuickFix.value, 20);
    const fix = actions.find((action) => fixture.importFix.test(action.title));
    assert.ok(fix?.edit, `import fix among ${actions.map((a) => a.title).join(", ")}`);
    assert.ok(await vscode.workspace.applyEdit(fix.edit));
    await waitFor("the unresolved reference cleared", () => !errorsOf(editor.document.uri).some((d) => d.source === KOTLIN && /UNRESOLVED_REFERENCE/.test(String(d.code))), 30_000, 200);
    return fix.title;
  });

  await check("organize imports", async () => {
    // An unused import above the file's own: organize imports drops it and keeps the used ones.
    const unused = "import kotlin.math.max";
    const { editor } = await insertAfter(from.getText().match(/^package .*\n/m)![0], `\n${unused}\n`, "from");
    const document = editor.document;
    const imports = document.getText().split("\n").filter((line) => line.startsWith("import ") && line !== unused);
    const all = new vscode.Range(0, 0, document.lineCount, 0);
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>("vscode.executeCodeActionProvider", document.uri, all, vscode.CodeActionKind.SourceOrganizeImports.value, 5);
    const organize = actions.find((action) => action.kind?.value === vscode.CodeActionKind.SourceOrganizeImports.value);
    assert.ok(organize?.edit, `organize imports among ${actions.map((a) => a.title).join(", ")}`);
    assert.ok(await vscode.workspace.applyEdit(organize.edit));
    assert.ok(!document.getText().includes(unused), `${unused} removed`);
    for (const kept of imports) assert.ok(document.getText().includes(`${kept}\n`), `${kept} kept`);
    return organize.title;
  });

  await check("formatting (document, range, on type)", async () => {
    let document = into;
    if (fixture.misformatted) document = (await insertAfter(into.getText(), fixture.misformatted, "into")).editor.document;
    const options = { tabSize: 4, insertSpaces: true };
    const all = new vscode.Range(0, 0, document.lineCount, 0);
    // The unformatted text first: a range over all of it gets ktfmt's edits; on type, none or some (null is none).
    const range = await vscode.commands.executeCommand<vscode.TextEdit[] | undefined>("vscode.executeFormatRangeProvider", document.uri, all, options) ?? [];
    assert.ok(range.length > 0, "range formatting changes the unformatted text");
    const typed = await vscode.commands.executeCommand<vscode.TextEdit[] | undefined>("vscode.executeFormatOnTypeProvider", document.uri, document.positionAt(document.getText().lastIndexOf("}") + 1), "}", options) ?? [];
    const edits = await vscode.commands.executeCommand<vscode.TextEdit[] | undefined>("vscode.executeFormatDocumentProvider", document.uri, options) ?? [];
    assert.ok(edits.length > 0, "ktfmt changes the file");
    const whole = new vscode.WorkspaceEdit();
    whole.set(document.uri, edits);
    assert.ok(await vscode.workspace.applyEdit(whole));
    assert.ok(!/[ \t]+$/m.test(document.getText()), "no trailing whitespace left");
    if (fixture.misformatted) assert.ok(document.getText().includes("fun spaced(a: Int) = a"), "ktfmt layout");
    const again = await vscode.commands.executeCommand<vscode.TextEdit[] | undefined>("vscode.executeFormatDocumentProvider", document.uri, options) ?? [];
    assert.equal(again.length, 0, "formatted text stays as it is");
    return `${edits.length} document edits, ${range.length} range edits, ${typed.length} on-type edits`;
  });

  await check("semantic tokens", async () => {
    const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>("vscode.provideDocumentSemanticTokensLegend", from.uri);
    const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>("vscode.provideDocumentSemanticTokens", from.uri);
    assert.ok(tokens.data.length > 0, "tokens");
    const decoded: { line: number; character: number; length: number; type: string; modifiers: string[] }[] = [];
    let line = 0;
    let character = 0;
    for (let i = 0; i < tokens.data.length; i += 5) {
      line += tokens.data[i]!;
      character = tokens.data[i]! === 0 ? character + tokens.data[i + 1]! : tokens.data[i + 1]!;
      const bits = tokens.data[i + 4]!;
      decoded.push({ line, character, length: tokens.data[i + 2]!, type: legend.tokenTypes[tokens.data[i + 3]!]!, modifiers: legend.tokenModifiers.filter((_, bit) => bits & (1 << bit)) });
    }
    const ranged = await vscode.commands.executeCommand<vscode.SemanticTokens>("vscode.provideDocumentRangeSemanticTokens", from.uri, new vscode.Range(0, 0, 10, 0));
    assert.ok(ranged.data.length > 0, "range tokens");
    const declaration = at(from, fixture.declaredIn === "from" ? fixture.declaration : [fixture.call, 0]);
    const token = decoded.find((t) => t.line === declaration.line && t.character === declaration.character);
    assert.ok(token && (token.type === "function" || token.type === "method"), `function token at ${declaration.line + 1}:${declaration.character + 1}: ${JSON.stringify(token)}`);
    if (fixture.composableAt) {
      const call = at(from, fixture.composableAt);
      const composable = decoded.find((t) => t.line === call.line && t.character === call.character);
      assert.ok(composable?.modifiers.includes("composable"), `composable call: ${JSON.stringify(composable)}`);
    }
    return `${decoded.length} tokens; ${[...new Set(decoded.flatMap((t) => t.modifiers))].sort().join(" ")}`;
  });

  await check("inlay hints", async () => {
    const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>("vscode.executeInlayHintProvider", edit.uri, new vscode.Range(0, 0, edit.lineCount, 0));
    const labels = hints.map((hint) => (typeof hint.label === "string" ? hint.label : hint.label.map((part) => part.value).join("")));
    assert.ok(labels.some((label) => label.includes(fixture.inlayType)), `a hint naming ${fixture.inlayType}: ${labels.join(" | ")}`);
    return labels.slice(0, 6).join(" | ");
  });

  await check("folding and selection ranges", async () => {
    const document = fixture.declaredIn === "from" ? into : from;
    const folds = await vscode.commands.executeCommand<vscode.FoldingRange[]>("vscode.executeFoldingRangeProvider", document.uri);
    assert.ok(folds.some((fold) => fold.kind === vscode.FoldingRangeKind.Imports), `an imports fold among ${folds.length}`);
    const [selection] = await vscode.commands.executeCommand<vscode.SelectionRange[]>("vscode.executeSelectionRangeProvider", from.uri, [at(from, [fixture.call, 1])]);
    let depth = 0;
    for (let range: vscode.SelectionRange | undefined = selection; range; range = range.parent) {
      if (range.parent) assert.ok(range.parent.range.contains(range.range), "each selection contains the previous");
      depth++;
    }
    assert.ok(depth >= 3, `selection depth ${depth}`);
    return `${folds.length} folds; selection depth ${depth}`;
  });

  await check("file move updates the package", async () => {
    const target = vscode.Uri.file(path.join(path.dirname(from.uri.fsPath), fixture.moveTo!.directory, path.basename(from.uri.fsPath)));
    const move = new vscode.WorkspaceEdit();
    move.renameFile(from.uri, target);
    // `workspace/willRenameFiles` runs as a participant of the move and returns the edit for `package`.
    assert.ok(await vscode.workspace.applyEdit(move));
    try {
      const moved = await vscode.workspace.openTextDocument(target);
      assert.ok(moved.getText().startsWith(`package ${fixture.moveTo!.package}\n`), `moved file: ${moved.getText().split("\n")[0]}`);
      await vscode.window.showTextDocument(moved);
      await vscode.commands.executeCommand("workbench.action.files.save");
    } finally {
      const back = new vscode.WorkspaceEdit();
      back.renameFile(target, from.uri);
      await vscode.workspace.applyEdit(back);
    }
    const restored = await vscode.workspace.openTextDocument(from.uri);
    await vscode.window.showTextDocument(restored);
    // Moving back returns the original package; whatever the participant did, the copy's file is restored as it was.
    const original = disk.get(from.uri.fsPath)!;
    if (restored.getText() !== original) {
      const editor = vscode.window.activeTextEditor!;
      await editor.edit((e) => e.replace(new vscode.Range(0, 0, restored.lineCount, 0), original));
    }
    await vscode.commands.executeCommand("workbench.action.files.save");
  }, inPlace ? "the sample is edited in place: files are never moved" : fixture.moveTo ? undefined : "no move fixture");

  await check("error at the edit, navigation meanwhile, and recovery", async () => {
    const editor = await show("from");
    const document = editor.document;
    await editor.edit((e) => e.replace(new vscode.Range(at(document, [fixture.call, 0]), at(document, [fixture.call, fixture.call.length])), fixture.broken));
    const edited = Date.now();
    const position = at(document, fixture.errorAt);
    const error = await waitFor("the error of the unsaved edit", () => errorsOf(document.uri).find((d) => d.source === KOTLIN && d.range.contains(position)), 60_000, 100)
      .catch((e: unknown) => { throw new Error(`${String(e)}; errors: ${JSON.stringify(errorsOf(document.uri).map((d) => [d.code, d.range.start.line, d.range.start.character, d.message]))}`); });
    const errorAfter = Date.now() - edited;
    // Navigation does not wait for the file to compile.
    const meanwhile = await vscode.commands.executeCommand<vscode.Location[]>("vscode.executeDefinitionProvider", document.uri, at(document, fixture.stillResolves.at));
    assert.equal(meanwhile.length, 1, "definition while the file has an error");
    assert.deepEqual(meanwhile[0]!.range.start, at(document, fixture.stillResolves.to));
    await editor.edit((e) => e.replace(new vscode.Range(at(document, [fixture.broken, 0]), at(document, [fixture.broken, fixture.broken.length])), fixture.call));
    await waitFor("the error cleared", () => !errorsOf(document.uri).some((d) => d.source === KOTLIN), 60_000, 100);
    return `${error.code}: ${error.message} after ${errorAfter} ms`;
  });

  await check(`edit → diagnostics under ${LATENCY_BUDGET_MS} ms (median, warm)`, async () => {
    const editor = await show("edit");
    const document = editor.document;
    const anchor = at(document, [fixture.completeAfter, fixture.completeAfter.length]);
    const indent = fixture.completeAfter.match(/^\s*/)![0];
    const samples: number[] = [];
    let previous: vscode.Range | undefined;
    for (let i = 0; i < 9; i++) {
      // Each edit adds an unused variable with a name of another length: its warning, over exactly that name, is how
      // the new analysis shows (a stale one would cover a different range).
      const name = `probe${"x".repeat(i)}`;
      const text = `${indent}val ${name} = ${i}\n`;
      const seen = new Promise<number>((resolve) => {
        const subscription = vscode.languages.onDidChangeDiagnostics((event) => {
          if (!event.uris.some((changed) => changed.toString() === document.uri.toString())) return;
          if (!vscode.languages.getDiagnostics(document.uri).some((d) => d.source === KOTLIN && document.getText(d.range) === name)) return;
          subscription.dispose();
          resolve(Date.now());
        });
      });
      const start = Date.now();
      assert.ok(await editor.edit((e) => (previous ? e.replace(previous, text) : e.insert(anchor, text))));
      previous = new vscode.Range(anchor, anchor.translate(1));
      const done = await Promise.race([seen, new Promise<number>((_, reject) => setTimeout(() => reject(new Error(`no diagnostics for ${name}`)), 30_000))]);
      // The first two warm the edited declaration's analysis.
      if (i >= 2) samples.push(done - start);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    assert.ok(median < LATENCY_BUDGET_MS, `median ${median} ms over ${samples.join(", ")}`);
    return `median ${median} ms (${samples.join(", ")})`;
  });

  await check("failed language server sync is reported and recovers", async () => {
    const extension = vscode.extensions.all.find((candidate) => candidate.id.endsWith(".elide"));
    const activity = (extension?.exports as ElideExtensionApi).activity;
    const config = vscode.workspace.getConfiguration("elide");
    const previous = config.inspect<string>("kotlinLsp.komodo.path")?.globalValue;
    try {
      await config.update("kotlinLsp.komodo.path", path.join(process.env.ELIDE_TEST_SAMPLE!, ".missing-komodo-launcher"), vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand("elide.sync");
      const sync = activity.getChildren().find((operation) => operation.label.startsWith("Sync "));
      assert.equal(sync?.state, "failed", "analysis startup failure must not report successful sync");
      assert.equal(sync?.children.find((step) => step.label === "Starting the Komodo language server")?.state, "failed");
    } finally {
      await config.update("kotlinLsp.komodo.path", previous, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand("elide.sync");
    }
    await waitFor("analysis recovers after failed sync", async () => {
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", edit.uri, at(edit, fixture.hoverAt));
      return hovers.some((hover) => hover.contents.some((content) =>
        (typeof content === "string" ? content : content.value).includes(fixture.hoverAt[0].replace(/\(.*$/, ""))));
    }, 60_000, 200);
    assert.equal(activity.getChildren().find((operation) => operation.label.startsWith("Sync "))?.state, "succeeded");
  });

  // Nothing the scenario did reached the disk: every edit was reverted unsaved (the copied ktjvm sample's move aside).
  await check("files on disk unchanged", async () => {
    for (const [file, text] of disk) assert.equal(readFileSync(file, "utf8"), text, `${file} unchanged`);
  });

  const count = (status: Outcome["status"]) => outcomes.filter((o) => o.status === status).length;
  log(`komodo ${sampleName}: ${count("passed")} passed, ${count("failed")} failed, ${count("skipped")} skipped of ${outcomes.length} checks`);
  const failed = outcomes.filter((o) => o.status === "failed");
  assert.deepEqual(failed.map((o) => `${o.name}: ${o.detail}`), [], "every Komodo check passes");
}

/** Revert every unsaved document: the scenario's edits never reach the disk. */
async function revertAll(): Promise<void> {
  for (const document of vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === "file")) {
    await vscode.window.showTextDocument(document, { preview: false });
    await vscode.commands.executeCommand("workbench.action.files.revert");
  }
}

/**
 * `ELIDE_KOMODO_COEXIST`: Komodo selected while the JetBrains extension is installed and enabled. The folder gets no
 * `workspace.json`, Komodo answers, and both extensions contribute `kotlin`: which grammar VS Code applies is logged
 * (ours scopes declarations as `meta.function.declaration.kotlin`, JetBrains' does not).
 */
async function runCoexistence(fixture: Fixture): Promise<void> {
  const jetBrains = vscode.extensions.getExtension("JetBrains.kotlin-server");
  assert.ok(jetBrains, "the JetBrains extension is installed and enabled for this run");
  const from = await vscode.workspace.openTextDocument(fixture.files.from);
  await vscode.window.showTextDocument(from, { preview: false });
  const call = from.positionAt(from.getText().indexOf(fixture.call) + 1);
  await waitFor("Komodo's definition", async () => {
    const found = await vscode.commands.executeCommand<vscode.Location[]>("vscode.executeDefinitionProvider", from.uri, call);
    return found && found.length > 0 ? found : undefined;
  }, 240_000, 2_000);
  const folder = vscode.workspace.getWorkspaceFolder(from.uri)!;
  assert.ok(!existsSync(path.join(folder.uri.fsPath, "workspace.json")), "no workspace.json for a Komodo folder");
  const tokens = await vscode.commands.executeCommand<{ c: string; t: string }[]>("_workbench.captureSyntaxTokens", from.uri);
  const fun = tokens.find((token) => token.c === "fun")?.t ?? "";
  const grammar = /meta\.function\.declaration\.kotlin/.test(fun) ? "Elide's" : "JetBrains'";
  log(`coexistence: language ${from.languageId}, grammar ${grammar} (fun → ${fun}); JetBrains extension ${jetBrains.isActive ? "active" : "inactive"}`);
}
