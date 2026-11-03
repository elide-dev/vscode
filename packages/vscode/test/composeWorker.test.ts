import { describe, expect, test } from "bun:test";
import { decodeWorkResponse, encodeWorkRequest } from "../src/composeWorker.js";


describe("Compose worker protocol", () => {
  test("preserves whitespace, empty argv and Unicode without shell tokenization", () => {
    expect(encodeWorkRequest(["a b", "", "λ"], 7)).toEqual(Buffer.from([13, 10, 3, 97, 32, 98, 10, 0, 10, 2, 206, 187, 24, 7]));
  });

  test("decodes omitted defaults, unknown fields and negative exit codes", () => {
    expect(decodeWorkResponse(Buffer.from([24, 7, 42, 3, 1, 2, 3]))).toEqual({ exitCode: 0, output: "", requestId: 7, wasCancelled: false });
    const negative = Buffer.from([8, 255, 255, 255, 255, 255, 255, 255, 255, 255, 1, 32, 1]);
    expect(decodeWorkResponse(negative)).toEqual({ exitCode: -1, output: "", requestId: 0, wasCancelled: true });
    expect(() => decodeWorkResponse(Buffer.from([18, 4, 1]))).toThrow("Truncated");
  });
});

