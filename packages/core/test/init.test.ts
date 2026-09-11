import { describe, expect, test } from "bun:test";
import { decodeInitTemplates, initArgs, validateInitParameter, type InitParameter } from "../src/index.js";

/** Abridged `elide init --templates --json` output (the `ktjvm` template and one of its blocks). */
const TEMPLATES = JSON.stringify([
  {
    id: "ktjvm",
    title: "Kotlin Hello World Project",
    description: "Simple Elide Kotlin/JVM project that prints a greeting.",
    default: true,
    parameters: [
      { id: "project_name", title: "Name", description: "The name of your project.", default: "Sample Project", attributes: [] },
      { id: "package", title: "Package", description: "The main package.", default: "com.example", attributes: ["JavaPackage"] },
    ],
    actions: ["build", "run"],
    blocks: [
      {
        id: "mcp",
        title: "MCP",
        description: "Use MCP in your project.",
        default: false,
        parameters: [
          { id: "mcp_elide", title: "Register Elide", description: "Register Elide as an MCP tool.", default: "true", attributes: ["Boolean"] },
        ],
        actions: [],
        blocks: [],
      },
    ],
  },
]);

const parameter = (attributes: string[]): InitParameter => ({ id: "p", title: "P", description: "", default: "", attributes });

describe("decodeInitTemplates", () => {
  test("decodes templates with their parameters and nested blocks", () => {
    const [template] = decodeInitTemplates(TEMPLATES);
    expect(template?.id).toBe("ktjvm");
    expect(template?.default).toBe(true);
    expect(template?.parameters.map((p) => p.id)).toEqual(["project_name", "package"]);
    expect(template?.parameters[1]?.attributes).toEqual(["JavaPackage"]);
    expect(template?.blocks.map((b) => [b.id, b.default])).toEqual([["mcp", false]]);
    expect(template?.blocks[0]?.parameters[0]?.default).toBe("true");
  });

  test("missing fields fall back to empty values instead of undefined", () => {
    const [template] = decodeInitTemplates('[{"id":"bare"}]');
    expect(template).toEqual({ id: "bare", title: "", description: "", default: false, parameters: [], actions: [], blocks: [] });
  });

  test("output that is not a JSON array is rejected", () => {
    expect(() => decodeInitTemplates('{"id":"ktjvm"}')).toThrow("expected an array");
    expect(() => decodeInitTemplates("not json")).toThrow("invalid JSON");
  });
});

describe("validateInitParameter", () => {
  test("Java package answers must be dotted lowercase segments", () => {
    expect(validateInitParameter(parameter(["JavaPackage"]), "com.example.app")).toBeUndefined();
    expect(validateInitParameter(parameter(["JavaPackage"]), "Com.Example")).toBe(
      "must be a Java package name (lowercase segments separated by dots)",
    );
    expect(validateInitParameter(parameter(["JavaPackage"]), "")).toBeTruthy();
  });

  test("Java class answers must be identifiers", () => {
    expect(validateInitParameter(parameter(["JavaClass"]), "Hello")).toBeUndefined();
    expect(validateInitParameter(parameter(["JavaClass"]), "Hello World")).toBe("must be a Java class name");
    expect(validateInitParameter(parameter(["JavaClass"]), "1Hello")).toBe("must be a Java class name");
  });

  test("Boolean answers are the two literals", () => {
    expect(validateInitParameter(parameter(["Boolean"]), "true")).toBeUndefined();
    expect(validateInitParameter(parameter(["Boolean"]), "false")).toBeUndefined();
    expect(validateInitParameter(parameter(["Boolean"]), "yes")).toBe("must be true or false");
  });

  test("a parameter without validators accepts anything", () => {
    expect(validateInitParameter(parameter([]), "Hello Elide!")).toBeUndefined();
  });
});

describe("initArgs", () => {
  test("generates non-interactively, answers after the argument separator", () => {
    expect(initArgs("ktjvm", { project_name: "demo", package: "com.example", mcp: "false" })).toEqual([
      "init",
      "--plain",
      "--skip-defaults",
      "--skip-run",
      "--template",
      "ktjvm",
      "--",
      "project_name=demo",
      "package=com.example",
      "mcp=false",
    ]);
  });

  test("values keep their spaces as a single argv entry", () => {
    expect(initArgs("ktjvm", { greeting: "Hello Elide!" }).at(-1)).toBe("greeting=Hello Elide!");
  });
});
