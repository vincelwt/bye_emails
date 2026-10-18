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
    const parseMode = message.parse_mode ?? "HTML";

    if (message.text.length <= TELEGRAM_MESSAGE_LIMIT) {
      const res = await this.postMessage(message, message.text, parseMode, true);
      if (res.ok) return;

      const err = await res.text();
      if (res.status !== 400 || !err.includes("message is too long")) {
        console.error(`[telegram] Failed to send message: ${err}`);
        return;
      }
    }

    // Too long for one message: send plain-text chunks so no HTML tag or
    // entity is cut in half. Buttons go on the last chunk only.
    const plainText =
      parseMode === "HTML" ? htmlToPlainText(message.text) : message.text;
    const chunks = splitTelegramText(plainText);
    console.warn(
      `[telegram] Message too long (${message.text.length} chars); sending ${chunks.length} part(s)`
    );

    for (const [index, chunk] of chunks.entries()) {
      const isLast = index === chunks.length - 1;
      const res = await this.postMessage(message, chunk, undefined, isLast);
      if (!res.ok) {
        const err = await res.text();
        console.error(
          `[telegram] Failed to send message part ${index + 1}/${chunks.length}: ${err}`
        );
      }
    }
  }

  private postMessage(
    message: ChannelMessage,
    text: string,
    parseMode: ChannelMessage["parse_mode"],
    withButtons: boolean
  ) {
    const body: Record<string, any> = {
      chat_id: this.config.chatId,
      text,
      disable_web_page_preview: true,
    };
    if (parseMode) {
      body.parse_mode = parseMode;
    }
    if (message.silent) {
      body.disable_notification = true;
    }

    if (withButtons && message.buttons?.length) {
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

    return fetch(`${this.baseUrl}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
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

export const TELEGRAM_MESSAGE_LIMIT = 4096;

// Turn Telegram HTML into plain text. Links keep their URL.
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

// Split text into chunks of at most `limit` UTF-16 units, preferring line
// breaks, then spaces, and never splitting a surrogate pair.
export function splitTelegramText(
  text: string,
  limit = TELEGRAM_MESSAGE_LIMIT
): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    let cut = window.lastIndexOf("\n");
    let skip = 1;
    if (cut <= 0) cut = window.lastIndexOf(" ");
    if (cut <= 0) {
      cut = limit;
      skip = 0;
      const code = remaining.charCodeAt(cut - 1);
      if (cut > 1 && code >= 0xd800 && code <= 0xdbff) cut -= 1;
    }

    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut + skip).replace(/^\n+/, "");
  }
  chunks.push(remaining);

  const nonEmpty = chunks.filter((chunk) => chunk.trim() !== "");
  return nonEmpty.length ? nonEmpty : [text];
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
