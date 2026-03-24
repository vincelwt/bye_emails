import type { Plugin, PluginContext } from "../types";
import { getGmailUrl } from "../types";
import { bold, escapeHtml, link } from "../channels/telegram";

export const notifyKeepPlugin: Plugin = {
  name: "notify-keep",

  async execute(ctx: PluginContext) {
    const { email, classification, channels } = ctx;
    const brief = classification.extracted.brief ?? email.subject;
    const action_link = classification.extracted.action_link;

    const lines: string[] = [
      `📩 ${bold(escapeHtml(email.from.name || email.from.address))}`,
      escapeHtml(brief),
    ];

    if (action_link) {
      lines.push(`\n${link("→ Open link", action_link)}`);
    }

    const callbackData = `archive:${email.accountName}:${email.uid}`;
    const emailUrl = getGmailUrl(email.messageId);

    for (const channel of channels) {
      await channel.send({
        text: lines.join("\n"),
        parse_mode: "HTML",
        buttons: [
          [
            { label: "📧 Open email", url: emailUrl },
            { label: "✓ Archive", callback_data: callbackData },
          ],
        ],
      });

      // Forward attachments
      for (const att of email.attachments) {
        await channel.sendDocument({
          filename: att.filename,
          content: att.content,
          contentType: att.contentType,
        });
      }
    }

    // Do NOT archive — leave in inbox
  },
};
