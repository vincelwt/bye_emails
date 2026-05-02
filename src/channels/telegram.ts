import type { Channel, ChannelMessage, ChannelDocument } from "../types";

interface TelegramConfig {
  botToken: string;
  chatId: string;
}

interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    data: string;
    message?: { message_id: number; chat: { id: number } };
  };
}

export class TelegramChannel implements Channel {
  name = "telegram";
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUpdateId = 0;
  private callbackHandler: ((data: string) => Promise<void>) | null = null;
  private running = false;

  constructor(private config: TelegramConfig) {}

  private get baseUrl() {
    return `https://api.telegram.org/bot${this.config.botToken}`;
  }

  async start() {
    this.running = true;
    this.startPolling();
    console.log("[telegram] Channel started (long-polling)");
  }

  async stop() {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async send(message: ChannelMessage) {
    const body: Record<string, any> = {
      chat_id: this.config.chatId,
      text: message.text,
      parse_mode: message.parse_mode ?? "HTML",
      disable_web_page_preview: true,
    };
    if (message.silent) {
      body.disable_notification = true;
    }

    if (message.buttons?.length) {
      body.reply_markup = {
        inline_keyboard: message.buttons.map((row) =>
          row.map((btn) => {
            if (btn.url) {
              return { text: btn.label, url: btn.url };
            }
            return { text: btn.label, callback_data: btn.callback_data };
          })
        ),
      };
    }

    const res = await fetch(`${this.baseUrl}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`[telegram] Failed to send message: ${err}`);
    }
  }

  async sendDocument(doc: ChannelDocument) {
    const formData = new FormData();
    formData.append("chat_id", this.config.chatId);
    formData.append(
      "document",
      new Blob([doc.content], { type: doc.contentType }),
      doc.filename
    );
    if (doc.caption) {
      formData.append("caption", doc.caption);
      formData.append("parse_mode", doc.parse_mode ?? "HTML");
    }
    if (doc.silent) {
      formData.append("disable_notification", "true");
    }

    const res = await fetch(`${this.baseUrl}/sendDocument`, {
      method: "POST",
      body: formData,
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`[telegram] Failed to send document: ${err}`);
    }
  }

  onCallback(handler: (data: string) => Promise<void>) {
    this.callbackHandler = handler;
  }

  private startPolling() {
    if (!this.running) return;
    this.poll();
  }

  private async poll() {
    if (!this.running) return;

    try {
      const res = await fetch(
        `${this.baseUrl}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=30&allowed_updates=["callback_query"]`,
        { signal: AbortSignal.timeout(35000) }
      );

      if (res.ok) {
        const data = (await res.json()) as {
          ok: boolean;
          result: TelegramUpdate[];
        };
        if (data.ok && data.result.length > 0) {
          for (const update of data.result) {
            this.lastUpdateId = update.update_id;
            if (update.callback_query) {
              await this.handleCallback(update.callback_query);
            }
          }
        }
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "TimeoutError")) {
        console.error("[telegram] Polling error:", err);
      }
    }

    // Schedule next poll
    if (this.running) {
      this.pollTimer = setTimeout(() => this.poll(), 500);
    }
  }

  private async handleCallback(query: TelegramUpdate["callback_query"]) {
    if (!query) return;

    // Acknowledge the callback
    await fetch(`${this.baseUrl}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: query.id }),
    });

    if (query.data && this.callbackHandler) {
      try {
        await this.callbackHandler(query.data);

        // Update the message to show it was handled
        if (query.message) {
          await fetch(`${this.baseUrl}/editMessageReplyMarkup`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: query.message.chat.id,
              message_id: query.message.message_id,
              reply_markup: { inline_keyboard: [] },
            }),
          });
        }
      } catch (err) {
        console.error("[telegram] Callback handler error:", err);
      }
    }
  }
}

// Telegram HTML formatting helpers
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function bold(text: string): string {
  return `<b>${escapeHtml(text)}</b>`;
}

export function italic(text: string): string {
  return `<i>${escapeHtml(text)}</i>`;
}

export function link(text: string, url: string): string {
  return `<a href="${url}">${escapeHtml(text)}</a>`;
}

export function code(text: string): string {
  return `<code>${escapeHtml(text)}</code>`;
}
