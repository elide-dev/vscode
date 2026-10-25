import { describe, expect, test } from "bun:test";
import { renderWorkersFor, screenshotErrorText } from "../src/composeRender.js";

describe("Compose renderer diagnostics", () => {
  test("a composable's exception reads as its stack trace, reported once", () => {
    const cause = "java.lang.IllegalStateException: preview failure\n\tat sample.app.MemberPreviews.MemberCard(PreviewGallery.kt:72)\n\tat java.base/java.lang.reflect.Method.invoke(Method.java:565)";
    const text = screenshotErrorText({
      status: "SUCCESS", message: "", stackTrace: "",
      problems: [
        { html: "View layout failed (<A HREF=\"\">Details</A>)", stackTrace: cause },
        { html: "Exception raised during rendering (<A HREF=\"\">Details</A>)", stackTrace: `java.lang.reflect.InvocationTargetException\n\tat java.base/java.lang.reflect.Method.invoke(Method.java:565)\nCaused by: ${cause.split("\n")[0]}\n\t... 78 more` },
      ],
      brokenClasses: [], missingClasses: [],
    });
    expect(text).toBe(`View layout failed\n${cause}`);
  });

  test("render setup failures keep their message and the classes layoutlib could not load", () => {
    expect(screenshotErrorText({ status: "ERROR_INFLATION", message: "Inflation failed", stackTrace: "", problems: [], missingClasses: ["sample.Missing"], brokenClasses: [{ className: "sample.Broken", stackTrace: "java.lang.ExceptionInInitializerError" }] }))
      .toBe("Inflation failed\n\nMissing classes:\nsample.Missing\n\nClasses that could not be initialized:\nsample.Broken\njava.lang.ExceptionInInitializerError");
    expect(screenshotErrorText({ status: "ERROR_UNKNOWN", problems: [] })).toBe("The renderer reported a failure without details (status ERROR_UNKNOWN).");
  });
});

describe("Compose render pool", () => {
  test("one JVM per few previews, at most four and half the cores", () => {
    expect([0, 1, 4, 5, 11, 13, 40].map((weight) => renderWorkersFor(weight, 16))).toEqual([1, 1, 1, 2, 3, 4, 4]);
    expect(renderWorkersFor(40, 4)).toBe(2);
    expect(renderWorkersFor(40, 1)).toBe(1);
  });
});
