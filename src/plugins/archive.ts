import type { Plugin, PluginContext } from "../types";
import { escapeHtml } from "../channels/telegram";
import { isLowPriorityNotification } from "../notifications";

export const archivePlugin: Plugin = {
  name: "archive",

  async execute(ctx: PluginContext) {
    const { email, classification, channels } = ctx;
    const brief = classification.extracted.brief ?? email.subject;
    const silent = isLowPriorityNotification(classification);

    const text = `📬 ${escapeHtml(brief)}\n\n<i>Auto-archived</i>`;

    for (const channel of channels) {
      await channel.send({ text, parse_mode: "HTML", silent });
    }

    await ctx.archiveEmail();
  },
};
