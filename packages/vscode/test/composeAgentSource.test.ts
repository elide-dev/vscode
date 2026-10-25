import { describe, expect, test } from "bun:test";
import {
  composableDeclarations,
  jvmFacade,
  parseReference,
  placeholder,
  previewWrapper,
  WrapperError,
  type ComposableDeclaration,
  type KotlinParameter,
  type WrapperRequest,
} from "../src/composeAgentSource.js";

const declarations = (text: string) => composableDeclarations(text, "/app/src/Card.kt");
const only = (text: string) => {
  const found = declarations(text);
  expect(found).toHaveLength(1);
  return found[0]!;
};
const parameter = (type: string, name = "value"): KotlinParameter => ({ name, type, vararg: false, annotations: [] });

describe("Kotlin source scanning", () => {
  test("ignores functions and braces inside comments, strings, raw strings, templates and character literals", () => {
    const text = [
      "package app",
      "// @Composable fun InLineComment() {",
      "/* outer /* nested } */ @Composable fun InBlockComment() { */",
      'val brace = "{ @Composable fun InString() {"',
      'val raw = """',
      "  { @Composable fun InRaw() {",
      '  ${"}"} ${listOf("{").first()} $brace "" \\"',
      '"""""',
      "val char = '{'",
      "val quote = '\\''",
      "@Composable",
      "fun Real(label: String = \"a, b) {\") {",
      '  Text("}")',
      "}",
    ].join("\n");
    const found = declarations(text);
    expect(found.map((declaration) => declaration.name)).toEqual(["Real"]);
    expect(found[0]!.line).toBe(12);
    expect(found[0]!.offset).toBe(text.indexOf("fun Real"));
    expect(found[0]!.parameters).toEqual([{ name: "label", type: "String", defaultValue: '"a, b) {"', vararg: false, annotations: [] }]);
  });

  test("finds top-level composables only, never nested, member, anonymous or non-composable functions", () => {
    const text = [
      "package app",
      "@Composable fun Outer() {",
      "  @Composable fun Inner() {}",
      "}",
      "class Host {",
      "  @Composable fun Member() {}",
      "  companion object { @Composable fun Companion() {} }",
      "}",
      "object Holder { @Composable fun InObject() {} }",
      "val anonymous = @Composable fun() {}",
      "fun interface Callback { fun call() }",
      "fun helper(): Int = listOf(1).size",
      "@Composable fun Second() = Outer()",
      "@Composable",
      "fun Third() {}",
    ].join("\n");
    expect(declarations(text).map((declaration) => [declaration.name, declaration.line])).toEqual([["Outer", 2], ["Second", 13], ["Third", 15]]);
  });

  test("detects @Composable and previews by simple name, qualified and multipreview annotations included", () => {
    const text = [
      "package `my`.app",
      "@androidx.compose.runtime.Composable",
      '@androidx.compose.ui.tooling.preview.Preview(name = "a)b", widthDp = 10)',
      "fun Qualified() {}",
      "@PreviewLightDark @Composable fun Multi() {}",
      "@Composable",
      "@ThemePreviews",
      "internal fun Custom() {}",
      "@[Composable]",
      "fun Grouped() {}",
      "@Composable fun Plain() {}",
      "@Preview fun NotComposable() {}",
    ].join("\n");
    const found = declarations(text);
    expect(found.map((declaration) => [declaration.name, declaration.previews])).toEqual([
      ["Qualified", true],
      ["Multi", true],
      ["Custom", true],
      ["Grouped", false],
      ["Plain", false],
    ]);
    expect(found[0]!.packageName).toBe("my.app");
    expect(found[0]!.annotations).toEqual(["@androidx.compose.runtime.Composable", '@androidx.compose.ui.tooling.preview.Preview(name = "a)b", widthDp = 10)']);
    expect(found[1]!.annotations).toEqual(["@PreviewLightDark", "@Composable"]);
  });

  test("reads visibility and modifiers between annotations and fun", () => {
    const text = [
      "@Composable private fun Hidden() {}",
      "@Composable internal inline fun Module() {}",
      "@Composable\n/** docs */\npublic fun Open() {}",
      "@Composable fun Default() {}",
      "@Composable protected actual fun Guarded() {}",
    ].join("\n");
    expect(declarations(text).map((declaration) => [declaration.name, declaration.visibility])).toEqual([
      ["Hidden", "private"],
      ["Module", "internal"],
      ["Open", "public"],
      ["Default", "public"],
      ["Guarded", "protected"],
    ]);
    expect(declarations(text)[0]!.packageName).toBe("");
  });

  test("parses extension receivers and type parameters", () => {
    const text = [
      "@Composable fun ColumnScope.Item(text: String) {}",
      "@Composable fun androidx.compose.foundation.layout.RowScope.Cell() {}",
      "@Composable fun <T> List<T>?.Items(render: @Composable (T) -> Unit) {}",
      "@Composable fun <T : Comparable<T>, reified R> Generic(items: List<T>, lookup: Map<String, List<R>>) {}",
      "@Composable fun (@Composable () -> Unit).Invoke() {}",
    ].join("\n");
    const found = declarations(text);
    expect(found.map((declaration) => [declaration.name, declaration.receiver, declaration.typeParameters])).toEqual([
      ["Item", "ColumnScope", []],
      ["Cell", "androidx.compose.foundation.layout.RowScope", []],
      ["Items", "List<T>?", ["T"]],
      ["Generic", undefined, ["T : Comparable<T>", "reified R"]],
      ["Invoke", "(@Composable () -> Unit)", []],
    ]);
    expect(found[3]!.parameters.map((parameter) => parameter.type)).toEqual(["List<T>", "Map<String, List<R>>"]);
  });

  test("discovers composables with context parameters, with annotations before or after them", () => {
    const text = [
      "@Composable context(theme: Theme, _: Log)",
      "fun Themed() {}",
      "context(scope: pkg.Scope<Int>) @Composable internal fun Scoped() {}",
      "context(Legacy)",
      "@Composable fun Old() {}",
      "@Composable fun Plain() {}",
      "context(theme: Theme) fun NotComposable() {}",
    ].join("\n");
    expect(declarations(text).map((declaration) => [declaration.name, declaration.visibility, declaration.contexts])).toEqual([
      ["Themed", "public", [{ name: "theme", type: "Theme" }, { type: "Log" }]],
      ["Scoped", "internal", [{ name: "scope", type: "pkg.Scope<Int>" }]],
      ["Old", "public", [{ type: "Legacy" }]],
      ["Plain", "public", undefined],
    ]);
  });

  test("splits parameters over brackets and generics, with annotations, vararg, function types and defaults", () => {
    const { parameters } = only([
      "@Composable",
      "fun Card(",
      "  @PreviewParameter(NamesProvider::class) name: String,",
      "  pair: Pair<Int, Int> = 1 to 2,",
      "  sum: (Int, Int) -> Int = { a, b -> a + b },",
      "  smaller: Boolean = a < b,",
      "  content: @Composable RowScope.() -> Unit = { Text(\"x, y\") },",
      "  callback: suspend (Map<String, Int>, Int) -> Unit, // trailing comment",
      "  /* block */ vararg tags: String,",
      "  noinline `odd name`: Array<out Int> = arrayOf(1, 2),",
      "  multiline: Map<",
      "    String,",
      "    Int",
      "  >,",
      ") {}",
    ].join("\n"));
    expect(parameters).toEqual([
      { name: "name", type: "String", vararg: false, annotations: ["@PreviewParameter(NamesProvider::class)"] },
      { name: "pair", type: "Pair<Int, Int>", defaultValue: "1 to 2", vararg: false, annotations: [] },
      { name: "sum", type: "(Int, Int) -> Int", defaultValue: "{ a, b -> a + b }", vararg: false, annotations: [] },
      { name: "smaller", type: "Boolean", defaultValue: "a < b", vararg: false, annotations: [] },
      { name: "content", type: "@Composable RowScope.() -> Unit", defaultValue: '{ Text("x, y") }', vararg: false, annotations: [] },
      { name: "callback", type: "suspend (Map<String, Int>, Int) -> Unit", vararg: false, annotations: [] },
      { name: "tags", type: "String", vararg: true, annotations: [] },
      { name: "odd name", type: "Array<out Int>", defaultValue: "arrayOf(1, 2)", vararg: false, annotations: [] },
      { name: "multiline", type: "Map< String, Int >", vararg: false, annotations: [] },
    ]);
  });
});

describe("composable references", () => {
  test("parses every reference form", () => {
    expect(parseReference("sample.components.MemberCard")).toEqual({ packageName: "sample.components", name: "MemberCard" });
    expect(parseReference(" MemberCard ")).toEqual({ name: "MemberCard" });
    expect(parseReference("`my`.app.`Odd Name`")).toEqual({ packageName: "my.app", name: "Odd Name" });
    expect(parseReference("app/src/main/kotlin/Card.kt#MemberCard")).toEqual({ file: "app/src/main/kotlin/Card.kt", name: "MemberCard" });
    expect(parseReference("app/src/Card.kt:42")).toEqual({ file: "app/src/Card.kt", name: "", line: 42 });
    expect(parseReference("/abs/Card.kt#MemberCard:7")).toEqual({ file: "/abs/Card.kt", name: "MemberCard", line: 7 });
    expect(parseReference("C:\\src\\Card.kt:3")).toEqual({ file: "C:\\src\\Card.kt", name: "", line: 3 });
  });

  test("rejects anything else with the accepted forms", () => {
    for (const reference of ["", "app/Card.kt", "Card.kt#", "#Card", "a b", "Card.kt#a.B", "Card.kt:x"]) {
      expect(() => parseReference(reference)).toThrow(/use pkg\.Name, Name, path\/to\/File\.kt#Name/);
    }
    expect(() => parseReference("Card.kt:0")).toThrow("Invalid line 0");
  });
});

describe("JVM facades", () => {
  test("uses @file:JvmName or the capitalized, sanitized file name", () => {
    expect(jvmFacade('@file:JvmName("Cards")\npackage app.ui', "/x/Card.kt")).toBe("app.ui.Cards");
    expect(jvmFacade('@file : kotlin.jvm.JvmName( "Named" )\n', "/x/Card.kt")).toBe("Named");
    expect(jvmFacade('@file:JvmName(name = "ByName")\npackage app', "/x/Card.kt")).toBe("app.ByName");
    expect(jvmFacade('// @file:JvmName("Commented")\npackage app', "/x/card.kt")).toBe("app.CardKt");
    expect(jvmFacade("package app", "/x/my-card.screen.kt")).toBe("app.My_card_screenKt");
    expect(jvmFacade("package app", "/x/ärger.kt")).toBe("app.ärgerKt");
    expect(jvmFacade("", "Main.kt")).toBe("MainKt");
  });
});

describe("placeholders", () => {
  test("fill required parameters of well-known types", () => {
    const cases: [string, string | undefined][] = [
      ["String?", "null"],
      ["Member?", "null"],
      ["(() -> Unit)?", "null"],
      ["String", '"value"'],
      ["kotlin.CharSequence", '"value"'],
      ["Int", "0"],
      ["Long", "0L"],
      ["Short", "0.toShort()"],
      ["Byte", "0.toByte()"],
      ["Float", "0f"],
      ["Double", "0.0"],
      ["Boolean", "false"],
      ["Char", "'a'"],
      ["Modifier", "androidx.compose.ui.Modifier"],
      ["androidx.compose.ui.graphics.Color", "androidx.compose.ui.graphics.Color.Gray"],
      ["Dp", "androidx.compose.ui.unit.Dp(16f)"],
      ["List<Member>", "emptyList()"],
      ["Collection<Int>", "emptyList()"],
      ["Iterable<Int>", "emptyList()"],
      ["Set<Int>", "emptySet()"],
      ["Map<String, Int>", "emptyMap()"],
      ["MutableList<Int>", "mutableListOf()"],
      ["MutableSet<Int>", "mutableSetOf()"],
      ["MutableMap<String, Int>", "mutableMapOf()"],
      ["() -> Unit", "{}"],
      ["@Composable () -> Unit", "{}"],
      ["@Composable ColumnScope.() -> Unit", "{}"],
      ["(Int) -> Unit", "{ _ -> }"],
      ["suspend (Map<String, Int>, (Int) -> Unit) -> kotlin.Unit", "{ _, _ -> }"],
      ["(@Composable () -> Unit)", "{}"],
      ["() -> Int", undefined],
      ["Member", undefined],
      ["T", undefined],
    ];
    for (const [type, expected] of cases) expect([type, placeholder(parameter(type))]).toEqual([type, expected]);
    expect(placeholder(parameter("String", "say$\"hi\""))).toBe('"say\\$\\"hi\\""');
  });
});

const SOURCE = [
  "package sample.components",
  "",
  "@Composable",
  "private fun MemberCard(title: String, member: Member, onClick: () -> Unit, subtitle: String? = null, modifier: Modifier = Modifier) {}",
  "@Composable fun ColumnScope.Row(count: Int) {}",
  "@Composable fun LazyItemScope.Item() {}",
  "@Composable fun <T> Picker(items: List<T>, selected: T? = null, onPick: (T) -> Unit) {}",
  "@Composable fun <T> Unused(label: String) {}",
  "@Composable fun Tags(vararg tags: String) {}",
].join("\n");
const THEME = only("package sample.theme\n@Composable fun ElideTheme(dark: Boolean, content: @Composable () -> Unit) {}");
const target = (name: string): ComposableDeclaration => composableDeclarations(SOURCE, "/app/Card.kt").find((declaration) => declaration.name === name)!;
const wrapper = (request: Partial<WrapperRequest> & { target: ComposableDeclaration }) =>
  previewWrapper({ facade: "sample.components.CardKt", arguments: {}, configuration: {}, annotate: false, ...request });

describe("preview wrappers", () => {
  test("generates the annotated, themed wrapper with arguments and placeholders", () => {
    const result = wrapper({
      target: target("MemberCard"),
      arguments: { member: "Member(\"Ada\")" },
      theme: THEME,
      configuration: { widthDp: 360, heightDp: 640, showBackground: true, backgroundColor: 0xff336699, darkTheme: true, fontScale: 1.5,
        locale: "fr-rFR", device: "id:pixel_5", showSystemUi: false, apiLevel: 34 },
      annotate: true,
    });
    expect(result.name).toMatch(/^ElideAgentPreview_[0-9a-f]{10}$/);
    expect(result.methodFQN).toBe(`sample.components.CardKt.${result.name}`);
    expect(result.text).toBe([
      "",
      "",
      "// Generated by Elide for an agent's Compose preview; never saved.",
      '@androidx.compose.ui.tooling.preview.Preview(name = "MemberCard", widthDp = 360, heightDp = 640, showBackground = true, '
        + 'backgroundColor = 0xFF336699L, uiMode = 0x21, fontScale = 1.5f, locale = "fr-rFR", device = "id:pixel_5", showSystemUi = false, '
        + "apiLevel = 34)",
      "@androidx.compose.runtime.Composable",
      `fun ${result.name}() {`,
      "  sample.theme.ElideTheme(dark = false) {",
      "    sample.components.MemberCard(",
      '      title = "title"',
      '      , member = Member("Ada")',
      "      , onClick = {}",
      "    )",
      "  }",
      "}",
      "",
    ].join("\n"));
    expect(result.previewParams).toEqual({ name: "MemberCard", widthDp: "360", heightDp: "640", showBackground: "true", backgroundColor: "4281558681",
      uiMode: "33", fontScale: "1.5", locale: "fr-rFR", device: "id:pixel_5", showSystemUi: "false", apiLevel: "34" });
    expect(result.arguments).toEqual([
      { name: "title", value: '"title"', source: "placeholder" },
      { name: "member", value: 'Member("Ada")', source: "argument" },
      { name: "onClick", value: "{}", source: "placeholder" },
    ]);
  });

  test("wraps scope receivers in their layout and omits the annotation unless asked", () => {
    const result = wrapper({ target: target("Row"), configuration: { fontScale: 2 } });
    expect(result.text).toBe([
      "",
      "",
      "// Generated by Elide for an agent's Compose preview; never saved.",
      "@androidx.compose.runtime.Composable",
      `fun ${result.name}() {`,
      "  androidx.compose.foundation.layout.Column {",
      "    Row(",
      "      count = 0",
      "    )",
      "  }",
      "}",
      "",
    ].join("\n"));
    expect(result.previewParams).toEqual({ name: "Row", fontScale: "2.0" });
    expect(wrapper({ target: target("Tags") }).text).toContain(" {\n  sample.components.Tags()\n}\n");
  });

  test("passes vararg arguments spread, as named form requires", () => {
    expect(wrapper({ target: target("Tags"), arguments: { tags: '"a", "b"' } }).text).toContain('sample.components.Tags(\n    tags = *arrayOf("a", "b"\n)\n  )');
    expect(wrapper({ target: target("Tags"), arguments: { tags: "*names" } }).text).toContain("sample.components.Tags(\n    tags = *names\n  )");
    const numbers = only("@Composable fun Numbers(vararg values: Int) {}");
    expect(wrapper({ target: numbers, arguments: { values: "1, 2" } }).text).toContain("Numbers(\n    values = *intArrayOf(1, 2\n)");
  });

  test("ends each argument's line, so a trailing line comment in it comments out nothing else", () => {
    const result = wrapper({ target: target("MemberCard"), arguments: { member: "m // the member", title: '"t" // one' } });
    expect(result.text).toContain('MemberCard(\n    title = "t" // one\n    , member = m // the member\n    , onClick = {}\n  )\n}\n');
    expect(wrapper({ target: target("Tags"), arguments: { tags: '"a" // a' } }).text).toContain('tags = *arrayOf("a" // a\n)\n  )');
  });

  test("supplies contexts from arguments keyed by context name or receiver type", () => {
    const themed = only("package t\n@Composable context(theme: Theme, _: Log) fun Themed(title: String) {}");
    const result = wrapper({ target: themed, theme: THEME, arguments: { theme: "Theme() // dark", Log: "Log()", title: '"t"' } });
    expect(result.text).toContain([
      "  sample.theme.ElideTheme(dark = false) {",
      "    with(",
      "      Theme() // dark",
      "    ) {",
      "      with(",
      "        Log()",
      "      ) {",
      "        t.Themed(",
      '          title = "t"',
      "        )",
      "      }",
      "    }",
      "  }",
    ].join("\n"));
    expect(result.arguments).toEqual([{ name: "title", value: '"t"', source: "argument" }]);
    expect(() => wrapper({ target: themed, arguments: { title: '"t"' } })).toThrow(new WrapperError(
      "`Themed` needs context theme: Theme, Log, which the preview supplies with `with(…)` from arguments keyed by context name "
        + '(by type for a context receiver). Pass arguments: {"theme": "<Kotlin expression>", "Log": "<Kotlin expression>"}.'));
    expect(() => wrapper({ target: themed, arguments: { theme: "x", Log: "y", colour: "1" } })).toThrow(
      "`Themed` has no parameter named colour; its parameters are title: String and its contexts are theme: Theme, Log.");
    const contextual = only("package t\ncontext(_: Palette) @Composable fun Contextual(content: @Composable () -> Unit) {}");
    expect(() => wrapper({ target: target("Row"), theme: contextual })).toThrow("Theme `Contextual` cannot wrap a preview: it needs context Palette.");
  });

  test("infers type parameters from the agent's arguments", () => {
    const result = wrapper({ target: target("Picker"), arguments: { items: "listOf(1, 2)" } });
    expect(result.text).toContain("sample.components.Picker(\n    items = listOf(1, 2)\n    , onPick = { _ -> }\n  )");
  });

  test("names each missing parameter with its type and how to pass it", () => {
    expect(() => wrapper({ target: target("MemberCard") })).toThrow(new WrapperError(
      '`MemberCard` needs a value for member: Member: no placeholder fits its type. Pass arguments: {"member": "<Kotlin expression>"}.'));
    expect(() => wrapper({ target: target("Picker") })).toThrow(new WrapperError(
      "`Picker` has type parameter T, which only an argument for a parameter whose type uses it determines "
        + '(items: List<T>, selected: T?, onPick: (T) -> Unit). Pass arguments: {"items": "<Kotlin expression>", '
        + '"selected": "<Kotlin expression>", "onPick": "<Kotlin expression>"}.'));
    expect(() => wrapper({ target: target("Unused") })).toThrow("no parameter determines its type parameter T");
  });

  test("rejects unknown arguments, unsupported receivers and unusable themes", () => {
    expect(() => wrapper({ target: target("MemberCard"), arguments: { member: "m", colour: "1", size: "2" } })).toThrow(new WrapperError(
      "`MemberCard` has no parameter named colour, size; its parameters are title: String, member: Member, onClick: () -> Unit, "
        + "subtitle: String?, modifier: Modifier."));
    expect(() => wrapper({ target: target("Item") })).toThrow(
      "`Item` extends LazyItemScope: only ColumnScope, RowScope and BoxScope receivers can be previewed.");
    const plain = only("package t\n@Composable fun Plain(dark: Boolean) {}");
    expect(() => wrapper({ target: target("Row"), theme: plain })).toThrow("its last parameter must be a composable lambda");
    const needy = only("package t\n@Composable fun Needy(palette: Palette, content: @Composable () -> Unit) {}");
    expect(() => wrapper({ target: target("Row"), theme: needy })).toThrow("no placeholder fits its required parameters palette: Palette");
  });

  test("names wrappers deterministically from the request", () => {
    const base = { target: target("MemberCard"), arguments: { member: "m", title: '"t"' }, configuration: { widthDp: 200, heightDp: 100 } };
    const name = wrapper(base).name;
    expect(wrapper({ ...base, arguments: { title: '"t"', member: "m" }, configuration: { heightDp: 100, widthDp: 200 } }).name).toBe(name);
    expect(wrapper({ ...base, arguments: { member: "n", title: '"t"' } }).name).not.toBe(name);
    expect(wrapper({ ...base, annotate: true }).name).not.toBe(name);
    expect(wrapper({ ...base, theme: THEME }).name).not.toBe(name);
    expect(wrapper({ ...base, facade: "sample.components.Cards" }).name).not.toBe(name);
    expect(wrapper({ ...base, configuration: { widthDp: 201, heightDp: 100 } }).name).not.toBe(name);
  });
});
