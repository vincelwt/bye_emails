import type { Plugin, PluginContext } from "../types";

export const archiveSilentPlugin: Plugin = {
  name: "archive-silent",

  async execute(ctx: PluginContext) {
    await ctx.archiveEmail();
  },
};
