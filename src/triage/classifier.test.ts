import { describe, expect, test } from "bun:test";
import type { Config, ParsedEmail, Rule } from "../types";
import { classifyEmail, normaliseExtracted } from "./classifier";

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

const rules: Rule[] = [
  {
    name: "security",
    description: "OTP codes.",
    action: "extract_and_archive",
    notify_template: "security",
  },
  {
    name: "spam-like",
    description: "Marketing.",
    action: "notify_and_archive",
    notify_template: "short",
  },
  {
    name: "needs_attention",
    description: "Needs a reply.",
    action: "notify_keep",
    notify_template: "full",
  },
];

const config = {
  llm: {
    provider: "anthropic",
    model: "claude-haiku-5-5",
    summarize_model: "claude-haiku-5-5",
    api_key_env: "ANTHROPIC_API_KEY",
  },
  jev: { model: "jev-latest", api_key_env: "TYPESAFE_API_KEY" },
  accounts: [],
  channels: {},
  rules,
} as Config;

function email(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    uid: 7,
    messageId: "<id@example.com>",
    from: { name: "GitHub", address: "notifications@github.com" },
    to: [],
    subject: "Review requested",
    text: "Please review",
    html: "",
    date: new Date("2026-10-24T00:00:00Z"),
    headers: {},
    accountName: "personal",
    attachments: [],
    ...overrides,
  };
}

describe("classifyEmail", () => {
  test("does not ask Jev about a GitHub sender", async () => {
    const result = await classifyEmail(email(), config, {
      ask: async () => {
        throw new Error("should not ask");
      },
      extract: async () => {
        throw new Error("should not extract");
      },
    });
    expect(result.rule).toBe("github");
    expect(result.action).toBe("notify_and_archive");
  });

  test("files a clear marketing email without a generation call", async () => {
    let extracted = false;
    const result = await classifyEmail(
      email({
        from: { name: "Shop", address: "deals@shop.example" },
        subject: "20% off",
      }),
      config,
      {
        ask: async () => ({
          security: 0.01,
          "spam-like": 0.93,
          needs_attention: 0.05,
        }),
        extract: async () => {
          extracted = true;
          return {};
        },
      }
    );
    expect(extracted).toBe(false);
    expect(result.rule).toBe("spam-like");
    expect(result.extracted.brief).toBe("Shop: 20% off");
  });

  test("extracts a code when the security rule is clear", async () => {
    const result = await classifyEmail(
      email({
        from: { name: "Stripe", address: "noreply@stripe.com" },
        subject: "Your code",
      }),
      config,
      {
        ask: async () => ({
          security: 0.97,
          "spam-like": 0.02,
          needs_attention: 0.2,
        }),
        extract: async (_email, _config, action) => {
          expect(action).toBe("extract_and_archive");
          return { otp_code: "123456", brief: "Stripe login code" };
        },
      }
    );
    expect(result.extracted.otp_code).toBe("123456");
    expect(result.extracted.brief).toBe("Stripe login code");
  });

  test("keeps the email when extraction fails", async () => {
    const result = await classifyEmail(
      email({
        from: { name: "Stripe", address: "noreply@stripe.com" },
        subject: "Your code",
      }),
      config,
      {
        ask: async () => ({
          security: 0.97,
          "spam-like": 0,
          needs_attention: 0.1,
        }),
        extract: async () => {
          throw new Error("bad json");
        },
      }
    );
    expect(result.action).toBe("notify_keep");
    expect(result.rule).toBe("needs_attention");
    expect(result.extracted.brief).toBe("Stripe: Your code");
  });

  test("rethrows a missing Jev key instead of guessing", async () => {
    await expect(
      classifyEmail(
        email({ from: { name: "A", address: "a@example.com" } }),
        config,
        {
          ask: async () => {
            throw new Error(
              "Missing required environment variable: TYPESAFE_API_KEY"
            );
          },
        }
      )
    ).rejects.toThrow("TYPESAFE_API_KEY");
  });
});
