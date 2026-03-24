import { parse } from "yaml";
import type { Config } from "./types";

function resolveEnv(envVarName: string): string {
  const value = process.env[envVarName];
  if (!value) {
    throw new Error(`Missing required environment variable: ${envVarName}`);
  }
  return value;
}

export function resolveEnvOptional(envVarName: string): string | undefined {
  return process.env[envVarName] || undefined;
}

export function resolveAccountAuth(config: Config) {
  return config.accounts.map((account) => ({
    ...account,
    auth: {
      user: resolveEnv(account.auth.user_env),
      pass: resolveEnv(account.auth.pass_env),
    },
  }));
}

export function resolveLlmApiKey(config: Config): string {
  return resolveEnv(config.llm.api_key_env);
}

export function resolveTelegramConfig(config: Config) {
  const tg = config.channels.telegram;
  if (!tg) return undefined;
  return {
    botToken: resolveEnv(tg.bot_token_env),
    chatId: resolveEnv(tg.chat_id_env),
  };
}

export function resolveCalendarCredentials(
  config: Config
): Record<string, string> | undefined {
  const cal = config.plugins?.calendar;
  if (!cal) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, envVar] of Object.entries(cal.credentials)) {
    const value = resolveEnvOptional(envVar);
    if (!value) {
      // If any credential is missing, calendar is not configured
      return undefined;
    }
    resolved[key] = value;
  }
  return resolved;
}

export async function loadConfig(path: string): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Config file not found: ${path}`);
  }
  const content = await file.text();
  const config = parse(content) as Config;

  // Validate required fields
  if (!config.llm) throw new Error("Config missing 'llm' section");
  if (!config.accounts?.length)
    throw new Error("Config missing 'accounts' section");
  if (!config.rules?.length) throw new Error("Config missing 'rules' section");
  if (!config.channels?.telegram)
    throw new Error("Config missing 'channels.telegram' section");

  // Set defaults
  for (const account of config.accounts) {
    account.mailbox ??= "INBOX";
    account.processed_label ??= "bye_emails/processed";
    account.poll_interval ??= 30;
    account.port ??= 993;
    account.secure ??= true;
  }

  config.llm.provider ??= "anthropic";
  config.llm.model ??= "claude-haiku-4-5-20251001";
  config.llm.summarize_model ??= "claude-sonnet-4-6";
  config.llm.api_key_env ??= "ANTHROPIC_OAUTH_TOKEN";

  return config;
}
