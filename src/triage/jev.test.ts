import { describe, expect, test } from "bun:test";
import type { ParsedEmail, Rule } from "../types";
import {
  buildJevState,
  buildRuleQuestions,
  decideFromNouls,
  NOUL_YES,
} from "./jev";

const rules: Rule[] = [
  {
    name: "security",
    description: "OTP codes and login links.",
    action: "extract_and_archive",
    notify_template: "security",
  },
  {
    name: "travel",
    description: "Flights and hotels.",
    action: "calendar_and_archive",
    notify_template: "travel",
  },
  {
    name: "spam-like",
    description: "Marketing.",
    action: "notify_and_archive",
    notify_template: "short",
  },
  {
    name: "needs_attention",
    description: "A person needs a reply.",
    action: "notify_keep",
    notify_template: "full",
  },
];

function email(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    uid: 1,
    messageId: "<id@example.com>",
    from: { name: "Ada", address: "ada@example.com" },
    to: [],
    subject: "Hello",
    text: "Body",
    html: "",
    date: new Date("2026-10-24T00:00:00Z"),
    headers: {},
    accountName: "personal",
    attachments: [],
    ...overrides,
  };
}

describe("decideFromNouls", () => {
  test("acts on the clearest rule at or above the yes band", () => {
    const decision = decideFromNouls(rules, {
      security: 0.81,
      travel: 0.95,
      "spam-like": 0.2,
      needs_attention: 0.4,
    });
    expect(decision.rule).toBe("travel");
    expect(decision.action).toBe("calendar_and_archive");
    expect(decision.confidence).toBe(0.95);
  });

  test("keeps the earlier rule when two scores tie", () => {
    const decision = decideFromNouls(rules, {
      security: NOUL_YES,
      travel: NOUL_YES,
      "spam-like": 0,
      needs_attention: 0,
    });
    expect(decision.rule).toBe("security");
  });

  test("leaves an unsettled email for a person", () => {
    const decision = decideFromNouls(rules, {
      security: 0.69,
      travel: 0.1,
      "spam-like": 0.55,
      needs_attention: 0.4,
    });
    expect(decision).toMatchObject({
      rule: "needs_attention",
      action: "notify_keep",
      confidence: 0.69,
    });
  });

  test("synthesizes a keep action when no rule hands mail to a person", () => {
    const decision = decideFromNouls(
      rules.filter((rule) => rule.action !== "notify_keep"),
      { security: 0.2, travel: 0.1, "spam-like": 0.4 }
    );
    expect(decision.action).toBe("notify_keep");
    expect(decision.rule).toBe("needs_attention");
  });

  test("ignores a non-numeric score", () => {
    const decision = decideFromNouls(rules, {
      security: Number.NaN,
      travel: 0,
      "spam-like": 0.2,
      needs_attention: 0.1,
    });
    expect(decision.action).toBe("notify_keep");
    expect(decision.confidence).toBe(0.2);
  });
});

describe("buildRuleQuestions", () => {
  test("asks one yes-or-no question per rule", () => {
    const questions = buildRuleQuestions(rules);
    expect(Object.keys(questions)).toEqual(rules.map((rule) => rule.name));
    expect(questions.security?.type).toBe("noul");
    expect(questions.security?.criteria?.true).toBe(rules[0]?.description);
  });

  test("rejects duplicate rule names", () => {
    expect(() => buildRuleQuestions([rules[0]!, rules[0]!])).toThrow(
      'Duplicate rule name "security"'
    );
  });
});

describe("buildJevState", () => {
  test("names the message fields and skips an empty attachment list", () => {
    const state = buildJevState(email());
    expect(state.email).toEqual({
      from_name: "Ada",
      from_address: "ada@example.com",
      subject: "Hello",
      date: "2026-10-24T00:00:00.000Z",
      body: "Body",
    });
    expect(state.email).not.toHaveProperty("attachment_names");
  });

  test("includes attachment names when the email has them", () => {
    const state = buildJevState(
      email({
        attachments: [
          {
            filename: "boarding-pass.pdf",
            contentType: "application/pdf",
            content: Buffer.from(""),
            size: 0,
          },
        ],
      })
    );
    expect(state.email.attachment_names).toEqual(["boarding-pass.pdf"]);
  });
});
