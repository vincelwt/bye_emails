import { describe, expect, test } from "bun:test";
import { applyLinearSilentArchiveOverride, isLinearSender } from "./linear";
import type { Classification, RuleAction } from "./types";

function classification(
  rule: string,
  action: RuleAction,
  extracted: Classification["extracted"] = {}
): Classification {
  return { rule, action, confidence: 0.9, extracted };
}

const linearEmail = {
  from: { name: "Linear", address: "notifications@linear.app" },
};

describe("isLinearSender", () => {
  test.each([
    "notifications@linear.app",
    "NOTIFICATIONS@Linear.App",
    "foo@sub.linear.app",
    "  notifications@linear.app  ",
  ])("matches Linear sender %s", (address) => {
    expect(isLinearSender(address)).toBe(true);
  });

  test.each([
    "notifications@linear.app.evil.com",
    "notifications@notlinear.app",
    "notifications@github.com",
    "linear.app",
    "",
  ])("rejects non-Linear sender %s", (address) => {
    expect(isLinearSender(address)).toBe(false);
  });
});

describe("applyLinearSilentArchiveOverride", () => {
  test.each([
    classification("needs_attention", "notify_keep"),
    classification("spam-like", "notify_and_archive"),
    classification("gmail_updates", "notify_and_archive"),
    classification("newsletters", "summarize_and_archive"),
  ])("archives Linear $rule email silently", (input) => {
    expect(applyLinearSilentArchiveOverride(linearEmail, input)).toEqual({
      ...input,
      rule: "linear",
      action: "archive_silently",
    });
  });

  test("keeps extracted data", () => {
    const input = classification("needs_attention", "notify_keep", {
      brief: "gloombot assigned the issue to you: [GLO-877] Fix sync",
    });

    expect(
      applyLinearSilentArchiveOverride(linearEmail, input).extracted
    ).toEqual(input.extracted);
  });

  test("leaves Linear security codes unchanged", () => {
    const input = classification("security", "extract_and_archive", {
      otp_code: "123456",
      security_summary: "Linear login code",
    });

    expect(applyLinearSilentArchiveOverride(linearEmail, input)).toBe(input);
  });

  test("leaves other senders unchanged", () => {
    const input = classification("needs_attention", "notify_keep");

    expect(
      applyLinearSilentArchiveOverride(
        { from: { name: "Example", address: "hello@example.com" } },
        input
      )
    ).toBe(input);
  });
});
