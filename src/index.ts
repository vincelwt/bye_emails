import { loadConfig, resolveAccountAuth, resolveTelegramConfig } from "./config";
import { ImapWatcher } from "./imap/watcher";
import { classifyEmail } from "./triage/classifier";
import { TelegramChannel } from "./channels/telegram";
import { archivePlugin } from "./plugins/archive";
import { securityPlugin } from "./plugins/security";
import { summarizePlugin } from "./plugins/summarize";
import { calendarPlugin } from "./plugins/calendar";
import { notifyKeepPlugin } from "./plugins/notify-keep";
import type { Channel, Plugin, ParsedEmail, RuleAction, Config } from "./types";

const ACTION_TO_PLUGIN: Record<RuleAction, Plugin> = {
  notify_and_archive: archivePlugin,
  summarize_and_archive: summarizePlugin,
  extract_and_archive: securityPlugin,
  calendar_and_archive: calendarPlugin,
  notify_keep: notifyKeepPlugin,
};

async function main() {
  const configPath = process.env.CONFIG_PATH ?? "./config.yaml";
  console.log(`Loading config from ${configPath}...`);

  const config = await loadConfig(configPath);
  console.log(
    `Loaded config: ${config.accounts.length} account(s), ${config.rules.length} rule(s)`
  );

  // Set up channels
  const channels: Channel[] = [];

  const tgConfig = resolveTelegramConfig(config);
  if (tgConfig) {
    const telegram = new TelegramChannel(tgConfig);
    channels.push(telegram);
  }

  // Resolve account credentials
  const accounts = resolveAccountAuth(config);

  // Set up IMAP watchers
  const watchers: ImapWatcher[] = [];

  for (const account of accounts) {
    const watcher = new ImapWatcher(
      config.accounts.find((a) => a.name === account.name)!,
      account.auth,
      {
        onEmail: async (email: ParsedEmail) => {
          await handleEmail(email, config, channels, watcher);
        },
        onError: (err: Error, accountName: string) => {
          console.error(`[${accountName}] Error:`, err.message);
        },
      }
    );
    watchers.push(watcher);
  }

  // Set up archive callback from Telegram buttons
  for (const channel of channels) {
    if (channel.onCallback) {
      channel.onCallback(async (data: string) => {
        // Format: "archive:<accountName>:<uid>"
        const [action, accountName, uidStr] = data.split(":");
        if (action !== "archive") return;

        const uid = parseInt(uidStr ?? "0", 10);
        const watcher = watchers.find(
          (_w, i) => config.accounts[i]?.name === accountName
        );

        if (watcher) {
          await watcher.archiveEmail(uid);
          await watcher.markProcessed(uid);
          console.log(
            `[${accountName}] Archived UID ${uid} via Telegram button`
          );
        }
      });
    }
  }

  // Start everything
  for (const channel of channels) {
    await channel.start();
  }

  for (const watcher of watchers) {
    // Start watchers concurrently but don't await — they run forever
    watcher.start().catch((err) => {
      console.error("Watcher failed to start:", err);
    });
  }

  console.log("bye_emails is running. Press Ctrl+C to stop.");

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    for (const watcher of watchers) {
      await watcher.stop();
    }
    for (const channel of channels) {
      await channel.stop();
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep the process alive
  await new Promise(() => {});
}

async function handleEmail(
  email: ParsedEmail,
  config: Config,
  channels: Channel[],
  watcher: ImapWatcher
) {
  console.log(
    `[${email.accountName}] Processing: "${email.subject}" from ${email.from.address}`
  );

  try {
    // Classify
    const classification = await classifyEmail(email, config);
    console.log(
      `[${email.accountName}] Classified as "${classification.rule}" (confidence: ${classification.confidence})`
    );

    // Execute the appropriate plugin
    const plugin = ACTION_TO_PLUGIN[classification.action];
    if (!plugin) {
      console.error(
        `[${email.accountName}] No plugin for action: ${classification.action}`
      );
      return;
    }

    await plugin.execute({
      email,
      classification,
      config,
      channels,
      archiveEmail: async () => {
        await watcher.archiveEmail(email.uid);
      },
    });

    // Forward email attachments (unless notify-keep already handled them)
    if (classification.action !== "notify_keep" && email.attachments.length > 0) {
      for (const channel of channels) {
        for (const att of email.attachments) {
          await channel.sendDocument({
            filename: att.filename,
            content: att.content,
            contentType: att.contentType,
          });
        }
      }
    }

    // Mark as processed
    await watcher.markProcessed(email.uid);

    console.log(
      `[${email.accountName}] Done: "${email.subject}" -> ${classification.rule}`
    );
  } catch (err) {
    console.error(
      `[${email.accountName}] Error handling "${email.subject}":`,
      err
    );
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
