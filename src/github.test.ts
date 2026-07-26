import { describe, expect, test } from "bun:test";
import { classifyGitHubEmail, isGitHubSender } from "./github";

describe("isGitHubSender", () => {
  test.each([
    "notifications@github.com",
    "NOREPLY@GITHUB.COM",
    "notifications@mail.github.com",
    "  notifications@github.com  ",
  ])("matches GitHub sender %s", (address) => {
    expect(isGitHubSender(address)).toBe(true);
  });

  test.each([
    "notifications@fakegithub.com",
    "notifications@github.com.example.com",
    "github@example.com",
    "github.com",
    "",
  ])("rejects non-GitHub sender %s", (address) => {
    expect(isGitHubSender(address)).toBe(false);
  });
});

describe("classifyGitHubEmail", () => {
  test("auto-archives GitHub email without LLM triage", () => {
    expect(
      classifyGitHubEmail({
        from: { name: "GitHub", address: "notifications@github.com" },
        subject: "Review requested on pull request #42",
      })
    ).toEqual({
      rule: "github",
      action: "notify_and_archive",
      confidence: 1,
      extracted: {
        brief: "GitHub: Review requested on pull request #42",
      },
    });
  });

  test("leaves other senders unclassified", () => {
    expect(
      classifyGitHubEmail({
        from: { name: "Example", address: "hello@example.com" },
        subject: "Hello",
      })
    ).toBeUndefined();
  });
});
