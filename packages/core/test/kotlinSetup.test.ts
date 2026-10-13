import { describe, expect, test } from "bun:test";
import { kotlinSetupPendingMessage, unansweredKotlinSetupSteps } from "../src/index.js";

describe("unansweredKotlinSetupSteps", () => {
  test("missing or `not_set` values are unanswered", () => {
    expect(unansweredKotlinSetupSteps(undefined, undefined)).toEqual(["region", "data sharing"]);
    expect(unansweredKotlinSetupSteps("not_set", "not_set")).toEqual(["region", "data sharing"]);
    expect(unansweredKotlinSetupSteps("europe", "not_set")).toEqual(["data sharing"]);
    expect(unansweredKotlinSetupSteps("", "none")).toEqual(["region"]);
  });

  test("any recorded choice counts as answered", () => {
    expect(unansweredKotlinSetupSteps("americas", "none")).toEqual([]);
    expect(unansweredKotlinSetupSteps("europe", "full")).toEqual([]);
  });
});

describe("kotlinSetupPendingMessage", () => {
  test("names the open questions, if known", () => {
    expect(kotlinSetupPendingMessage(["region", "data sharing"])).toContain("first-run setup (region, data sharing)");
    expect(kotlinSetupPendingMessage([])).toContain("first-run setup;");
  });
});
