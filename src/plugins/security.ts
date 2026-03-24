import type { Plugin, PluginContext } from "../types";
import { code, escapeHtml, link } from "../channels/telegram";

export const securityPlugin: Plugin = {
  name: "security",

  async execute(ctx: PluginContext) {
    const { email, classification, channels } = ctx;
    const { otp_code, action_link, security_summary } =
      classification.extracted;

    const lines: string[] = [];

    // Lead with the summary — it already contains the service name
    if (security_summary) {
      lines.push(`🔐 ${escapeHtml(security_summary)}`);
    } else {
      lines.push(
        `🔐 Security alert from ${escapeHtml(email.from.name || email.from.address)}`
      );
    }

    if (otp_code) {
      lines.push(`\nCode: ${code(otp_code)}`);
    }

    if (action_link) {
      lines.push(`\n${link("→ Open link", action_link)}`);
    }

    lines.push(`\n<i>Auto-archived</i>`);

    for (const channel of channels) {
      await channel.send({ text: lines.join("\n"), parse_mode: "HTML" });
    }

    await ctx.archiveEmail();
  },
};
