import { complete, getModel } from "@mariozechner/pi-ai";
import type { Config, ParsedEmail, Classification, ExtractedData } from "../types";
import {
  buildClassificationPrompt,
  buildEmailContext,
  buildSummarizationPrompt,
} from "./prompts";
import { resolveLlmApiKey } from "../config";

function resolveConfiguredModel(config: Config, modelId: string) {
  const model = getModel(config.llm.provider as any, modelId as any);
  if (!model) {
    throw new Error(
      `Unknown LLM model "${modelId}" for provider "${config.llm.provider}"`
    );
  }
  return model;
}

function extractText(
  content: Array<{ type: string; text?: string }>
): string {
  return content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("");
}

function parseJsonResponse(text: string): any {
  // Strip markdown code fences if present
  const cleaned = text
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/```\s*$/m, "")
    .trim();
  return JSON.parse(cleaned);
}

function fallbackClassification(email: ParsedEmail): Classification {
  const sender = email.from.name || email.from.address || "unknown sender";
  return {
    rule: "needs_attention",
    action: "notify_keep",
    confidence: 0,
    extracted: {
      brief: `Could not classify email from ${sender}: ${email.subject}`,
    },
  };
}

export async function classifyEmail(
  email: ParsedEmail,
  config: Config
): Promise<Classification> {
  const apiKey = resolveLlmApiKey(config);
  const model = resolveConfiguredModel(config, config.llm.model);
  const systemPrompt = buildClassificationPrompt(config.rules);
  const emailContext = buildEmailContext(email);

  const result = await complete(
    model,
    {
      systemPrompt,
      messages: [
        {
          role: "user" as const,
          content: emailContext,
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey, maxTokens: 1024, temperature: 0 }
  );

  const responseText = extractText(result.content);
  let parsed: any;
  try {
    parsed = parseJsonResponse(responseText);
  } catch (err) {
    console.warn(
      `[${email.accountName}] Failed to parse classification JSON for "${email.subject}" (${responseText.length} chars): ${err instanceof Error ? err.message : String(err)}`
    );
    return fallbackClassification(email);
  }

  // Match to a configured rule
  const matchedRule = config.rules.find((r) => r.name === parsed.rule);
  if (!matchedRule) {
    // Fallback to needs_attention if classification doesn't match
    console.warn(
      `Unknown rule "${parsed.rule}" from LLM, falling back to needs_attention`
    );
    return {
      rule: "needs_attention",
      action: "notify_keep",
      confidence: 0,
      extracted: { brief: parsed.extracted?.brief ?? email.subject },
    };
  }

  return {
    rule: matchedRule.name,
    action: matchedRule.action,
    confidence: parsed.confidence ?? 0.5,
    extracted: parsed.extracted as ExtractedData,
  };
}

export async function summarizeNewsletter(
  email: ParsedEmail,
  config: Config
): Promise<ExtractedData> {
  const apiKey = resolveLlmApiKey(config);
  const model = resolveConfiguredModel(config, config.llm.summarize_model);
  const systemPrompt = buildSummarizationPrompt();

  // Use the full email body for summarization
  const maxBodyLength = 12000;
  const body =
    email.text.length > maxBodyLength
      ? email.text.slice(0, maxBodyLength) + "\n[... truncated]"
      : email.text;

  const result = await complete(
    model,
    {
      systemPrompt,
      messages: [
        {
          role: "user" as const,
          content: `Newsletter from: ${email.from.name} <${email.from.address}>\nSubject: ${email.subject}\n\n${body}`,
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey, maxTokens: 2048, temperature: 0.2 }
  );

  const responseText = extractText(result.content);
  const parsed = parseJsonResponse(responseText);

  return {
    summary: parsed.summary,
    companies: parsed.companies,
    brief: parsed.summary,
  };
}
