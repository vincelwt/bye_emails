import type { Plugin, PluginContext } from "../types";
import { summarizeNewsletter } from "../triage/classifier";
import { bold, escapeHtml } from "../channels/telegram";
import { isLowPriorityNotification } from "../notifications";

export const summarizePlugin: Plugin = {
  name: "summarize",

  async execute(ctx: PluginContext) {
    const { email, classification, config, channels } = ctx;
    const silent = isLowPriorityNotification(classification);

    // Run the detailed summarization with the smarter model
    const summary = await summarizeNewsletter(email, config);

    const lines: string[] = [
      `📰 ${bold(escapeHtml(email.from.name || email.from.address))}`,
      `${escapeHtml(email.subject)}`,
    ];

    if (summary.summary) {
      lines.push(`\n${escapeHtml(summary.summary)}`);
    }

    if (summary.companies?.length) {
      lines.push("");
      for (const company of summary.companies) {
        const emoji =
          company.sentiment === "bullish"
            ? "📈"
            : company.sentiment === "bearish"
              ? "📉"
              : "➖";
        lines.push(
          `${emoji} ${bold(escapeHtml(company.name))}: ${escapeHtml(company.thesis)}`
        );
      }
    }

    lines.push(`\n<i>Auto-archived</i>`);

    for (const channel of channels) {
      await channel.send({ text: lines.join("\n"), parse_mode: "HTML", silent });
    }

    await ctx.archiveEmail();
  },
};
