import { noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type { Classification, Config, ParsedEmail, Rule } from "../types";
import { resolveJevApiKey } from "../config";
import { emailBodyForModel } from "./prompts";

// Starting yes-band from Jev's own guidance. At or above this, the matching
// rule is clear enough to act on. Below it, a person should see the email.
// The gate is the noul, not the separate confidence number.
export const NOUL_YES = 0.7;

const MAX_RULES = 255;

export function buildJevState(email: ParsedEmail) {
  const attachmentNames = email.attachments
    .map((attachment) => attachment.filename)
    .filter((filename) => filename.length > 0);
  return {
    email: {
      from_name: email.from.name,
      from_address: email.from.address,
      subject: email.subject,
      date: email.date.toISOString(),
      body: emailBodyForModel(email.text),
      ...(attachmentNames.length > 0
        ? { attachment_names: attachmentNames }
        : {}),
    },
  };
}

export function buildRuleQuestions(rules: Rule[]) {
  const questions: Record<string, ReturnType<typeof noul>> = {};
  for (const rule of rules) {
    if (questions[rule.name]) {
      throw new Error(`Duplicate rule name "${rule.name}"`);
    }
    questions[rule.name] = noul("Does `email` match the yes criterion?", {
      true: rule.description.trim(),
      false: "The sender, subject, and body are about something else.",
    });
  }
  return questions;
}

export function decideFromNouls(
  rules: Rule[],
  nouls: Readonly<Record<string, number>>
): Classification {
  let best: { rule: Rule; noul: number; index: number } | undefined;
  let top = 0;

  rules.forEach((rule, index) => {
    const raw = nouls[rule.name];
    const score = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
    if (score > top) top = score;
    if (score < NOUL_YES) return;
    if (
      !best ||
      score > best.noul ||
      (score === best.noul && index < best.index)
    ) {
      best = { rule, noul: score, index };
    }
  });

  if (best) {
    return {
      rule: best.rule.name,
      action: best.rule.action,
      confidence: best.noul,
      extracted: {},
    };
  }

  const keep = rules.find((rule) => rule.action === "notify_keep");
  if (keep) {
    return {
      rule: keep.name,
      action: keep.action,
      confidence: top,
      extracted: {},
    };
  }

  return {
    rule: "needs_attention",
    action: "notify_keep",
    confidence: top,
    extracted: {},
  };
}

let client: TypeSafeClient | undefined;
let clientModel: string | undefined;

function clientFor(config: Config): TypeSafeClient {
  const model = config.jev.model || "jev-latest";
  if (!client || clientModel !== model) {
    client = new TypeSafeClient({
      apiKey: resolveJevApiKey(config),
      defaultModel: model,
    });
    clientModel = model;
  }
  return client;
}

export async function askJev(
  email: ParsedEmail,
  config: Config
): Promise<Record<string, number>> {
  if (config.rules.length > MAX_RULES) {
    throw new Error(
      `Jev supports at most ${MAX_RULES} rules (got ${config.rules.length})`
    );
  }

  const questions = buildRuleQuestions(config.rules);
  const result = await clientFor(config).systemOne({
    state: buildJevState(email),
    questions,
    model: config.jev.model,
  });

  const scores: Record<string, number> = {};
  for (const rule of config.rules) {
    scores[rule.name] = result.answers[rule.name]?.noul ?? 0;
  }

  const summary = config.rules
    .map((rule) => `${rule.name}=${(scores[rule.name] ?? 0).toFixed(2)}`)
    .join(" ");
  console.log(`[${email.accountName}] Jev ${result.model}: ${summary}`);
  return scores;
}
