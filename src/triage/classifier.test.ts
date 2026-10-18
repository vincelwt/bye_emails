import { describe, expect, test } from "bun:test";
import { normaliseExtracted } from "./classifier";

describe("normaliseExtracted", () => {
  test.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "brief text"],
    ["a number", 42],
    ["an array", [{ brief: "x" }]],
  ])("returns an empty object for %s", (_label, value) => {
    expect(normaliseExtracted(value)).toEqual({});
  });

  test("keeps an extracted object as is", () => {
    const extracted = { brief: "Hello", otp_code: "123456" };
    expect(normaliseExtracted(extracted)).toBe(extracted);
  });

  test("lets plugins read brief when the LLM omitted extracted", () => {
    const parsed = JSON.parse('{"rule":"spam-like","confidence":0.9}');
    expect(normaliseExtracted(parsed.extracted).brief ?? "subject").toBe(
      "subject"
    );
  });
});
