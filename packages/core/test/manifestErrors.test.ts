import { describe, expect, test } from "bun:test";
import { parseManifestError } from "../src/index.js";

const manifestPath = "/work/app/elide.pkl";
const manifest = `amends "elide:project.pkl"

name = "ktjvm-sample"

jvm {
    main = "sample.MainKt"
}

kotlin {
    features {
        compose = "yes"
        kapt = "yes"
    }
}
`;
const read = (file: string) => (file === manifestPath ? manifest : undefined);

describe("parseManifestError", () => {
  test("a type error (Elide 1.6.1) points at the value in the manifest, past Elide's own schema frame", () => {
    const stderr = `Manifest error: Expected value of type \`Boolean\`, but got type \`String\`.
Value: "yes"

105 | compose: Boolean = false
               ^^^^^^^
at elide.kotlin#KotlinFeatureOptions.compose (elide:Kotlin.pkl)

11 | compose = "yes"
               ^^^^^

Error: Project manifest is invalid or contains errors; see --help`;
    expect(parseManifestError(stderr, manifestPath, read)).toEqual({
      message: 'Expected value of type `Boolean`, but got type `String`.\nValue: "yes"',
      locations: [{ file: manifestPath, line: 11, column: 19, endColumn: 24 }],
    });
  });

  test("an unknown property names its module by file URI; the list of alternatives is not part of the message", () => {
    const stderr = `Manifest error: Cannot find property \`kapt\` in object of type \`elide.kotlin#KotlinFeatureOptions\`.

12 | kapt = "yes"
     ^^^^
at elide#kotlin.features (file:///work/app/elide.pkl)

Available properties:
atomicfu
compose

Error: Project manifest is invalid or contains errors; see --help`;
    expect(parseManifestError(stderr, manifestPath, read)).toEqual({
      message: "Cannot find property `kapt` in object of type `elide.kotlin#KotlinFeatureOptions`.",
      locations: [{ file: manifestPath, line: 12, column: 9, endColumn: 13 }],
    });
  });

  test("a frame in another local module is located there; an unattributed frame that the manifest does not hold is dropped", () => {
    const stderr = `Manifest error: Cannot find property \`guava\`.

3 | guava = 1
    ^^^^^
at versions (file:///work/app/versions.pkl:3:5)

7 | main = "other"
    ^^^^`;
    expect(parseManifestError(stderr, manifestPath, read)?.locations).toEqual([{ file: "/work/app/versions.pkl", line: 3, column: 1, endColumn: 6 }]);
  });

  test("a syntax error with an empty message (Elide 1.6.1) still says what failed; no manifest error is no result", () => {
    expect(parseManifestError("Manifest error: \n\nError: Project manifest is invalid or contains errors; see --help", manifestPath, read)).toEqual({
      message: "Project manifest is invalid or contains errors",
      locations: [],
    });
    expect(parseManifestError("error: could not resolve dependencies", manifestPath, read)).toBeUndefined();
  });
});

  test("a syntax error as upstream Elide prints it carries its message and the frame naming the manifest", () => {
    const stderr = `Manifest error: Unexpected token \`{\`. Expected \`}\`.

4 | jvm {{
         ^
at elide (file:///work/app/elide.pkl)

Error: Project manifest is invalid or contains errors; see --help`;
    const broken = (file: string) => (file === manifestPath ? 'amends "elide:project.pkl"\n\nname = "x"\njvm {{\n' : undefined);
    expect(parseManifestError(stderr, manifestPath, broken)).toEqual({
      message: "Unexpected token `{`. Expected `}`.",
      locations: [{ file: manifestPath, line: 4, column: 6, endColumn: 7 }],
    });
  });

test("the header Elide localizes from LANG is recognized in every locale it ships", () => {
  const frame = "\n\n12 | kapt = \"yes\"\n     ^^^^\nat elide#kotlin.features (file:///work/app/elide.pkl)\n";
  for (const header of ["Manifestfehler:", "Error de manifiesto:", "Erreur de manifeste:", "Ошибка манифеста:", "Помилка маніфесту:"]) {
    expect(parseManifestError(`${header} Cannot find property \`kapt\`.${frame}`, manifestPath, read)).toEqual({
      message: "Cannot find property `kapt`.",
      locations: [{ file: manifestPath, line: 12, column: 9, endColumn: 13 }],
    });
  }
  expect(parseManifestError("Manifestfehler: \n\nFehler: Projektmanifest ist ungültig oder enthält Fehler; siehe --help", manifestPath, read)?.message)
    .toBe("Projektmanifest ist ungültig oder enthält Fehler");
});
