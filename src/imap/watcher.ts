import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { ParsedEmail, ImapAccountConfig, EmailAttachment } from "../types";

export interface WatcherEvents {
  onEmail: (email: ParsedEmail) => Promise<void>;
  onError: (error: Error, account: string) => void;
}

export class ImapWatcher {
  private client: ImapFlow | null = null;
  private running = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isGmail = false;

  constructor(
    private account: ImapAccountConfig,
    private auth: { user: string; pass: string },
    private events: WatcherEvents
  ) {}

  async start() {
    this.running = true;
    await this.connect();
  }

  async stop() {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        // ignore logout errors during shutdown
      }
      this.client = null;
    }
  }

  private async connect() {
    if (!this.running) return;

    try {
      this.client = new ImapFlow({
        host: this.account.host,
        port: this.account.port,
        secure: this.account.secure,
        auth: this.auth,
        logger: false,
      });

      this.client.on("error", (err: Error) => {
        this.events.onError(err, this.account.name);
        this.scheduleReconnect();
      });

      this.client.on("close", () => {
        if (this.running) {
          console.log(
            `[${this.account.name}] Connection closed, reconnecting...`
          );
          this.scheduleReconnect();
        }
      });

      await this.client.connect();

      // Detect Gmail support via X-GM-EXT-1 capability
      this.isGmail =
        (this.client as any).capabilities?.has?.("X-GM-EXT-1") ?? false;

      console.log(
        `[${this.account.name}] Connected to ${this.account.host}${this.isGmail ? " (Gmail)" : ""}`
      );

      // Process any unprocessed emails first
      await this.processUnprocessed();

      // Start IDLE loop
      await this.idleLoop();
    } catch (err) {
      this.events.onError(err as Error, this.account.name);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (!this.running || this.reconnectTimer) return;
    const delay = 5000;
    console.log(`[${this.account.name}] Reconnecting in ${delay / 1000}s...`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.client = null;
      await this.connect();
    }, delay);
  }

  private async processUnprocessed() {
    if (!this.client) return;

    const lock = await this.client.getMailboxLock(this.account.mailbox);
    try {
      // Fetch all messages and check which ones lack our processed label/flag
      const unprocessedUids: number[] = [];

      if (this.isGmail) {
        // Gmail: check X-GM-LABELS for processed label
        for await (const msg of this.client.fetch("1:*", {
          uid: true,
          labels: true,
        })) {
          const labels = msg.labels ? Array.from(msg.labels) : [];
          if (!labels.includes(this.account.processed_label)) {
            unprocessedUids.push(msg.uid);
          }
        }
      } else {
        // Non-Gmail: check for custom flag
        for await (const msg of this.client.fetch("1:*", {
          uid: true,
          flags: true,
        })) {
          const flags = msg.flags ? Array.from(msg.flags) : [];
          if (!flags.includes("bye_emails_processed")) {
            unprocessedUids.push(msg.uid);
          }
        }
      }

      if (unprocessedUids.length > 0) {
        console.log(
          `[${this.account.name}] Found ${unprocessedUids.length} unprocessed email(s)`
        );
        for (const uid of unprocessedUids) {
          await this.fetchAndEmit(uid);
        }
      } else {
        console.log(`[${this.account.name}] No unprocessed emails`);
      }
    } finally {
      lock.release();
    }
  }

  private async fetchAndEmit(uid: number): Promise<void> {
    if (!this.client) return;

    try {
      const message = await this.client.fetchOne(
        String(uid),
        { uid: true, source: true, envelope: true },
        { uid: true }
      );

      if (!message || !message.source) return;

      const parsed = await simpleParser(message.source as Buffer);

      const from = parsed.from?.value?.[0] ?? { name: "", address: "" };
      const to = parsed.to
        ? Array.isArray(parsed.to)
          ? parsed.to.flatMap((t) => t.value)
          : parsed.to.value
        : [];

      const email: ParsedEmail = {
        uid,
        messageId: parsed.messageId ?? "",
        from: { name: from.name ?? "", address: from.address ?? "" },
        to: to.map((t) => ({ name: t.name ?? "", address: t.address ?? "" })),
        subject: parsed.subject ?? "(no subject)",
        text: parsed.text ?? "",
        html: parsed.html || "",
        date: parsed.date ?? new Date(),
        headers: Object.fromEntries(
          [...parsed.headers].map(([k, v]) => [
            k,
            typeof v === "string" ? v : String(v),
          ])
        ),
        accountName: this.account.name,
        attachments: (parsed.attachments ?? []).map((att): EmailAttachment => ({
          filename: att.filename ?? "attachment",
          contentType: att.contentType ?? "application/octet-stream",
          content: att.content,
          size: att.size,
        })),
      };

      await this.events.onEmail(email);
    } catch (err) {
      console.error(
        `[${this.account.name}] Error processing UID ${uid}:`,
        err
      );
    }
  }

  private async idleLoop() {
    while (this.running && this.client) {
      const lock = await this.client.getMailboxLock(this.account.mailbox);
      try {
        // Listen for new messages during IDLE
        const existsHandler = async (data: {
          count: number;
          prevCount: number;
        }) => {
          if (data.count > data.prevCount) {
            const newCount = data.count - data.prevCount;
            console.log(
              `[${this.account.name}] ${newCount} new email(s) arrived`
            );

            for (let seq = data.prevCount + 1; seq <= data.count; seq++) {
              try {
                const msg = await this.client!.fetchOne(String(seq), {
                  uid: true,
                  ...(this.isGmail ? { labels: true } : { flags: true }),
                });

                if (!msg) continue;

                const isProcessed = this.isGmail
                  ? Array.from((msg as any).labels ?? []).includes(
                      this.account.processed_label
                    )
                  : Array.from((msg as any).flags ?? []).includes(
                      "bye_emails_processed"
                    );

                if (!isProcessed) {
                  await this.fetchAndEmit((msg as any).uid);
                }
              } catch (err) {
                console.error(
                  `[${this.account.name}] Error fetching seq ${seq}:`,
                  err
                );
              }
            }
          }
        };

        this.client.on("exists", existsHandler);

        try {
          await this.client.idle();
        } catch {
          // IDLE can throw on disconnect, that's fine
        }

        this.client.removeListener("exists", existsHandler);
      } finally {
        lock.release();
      }

      // Small delay before re-entering IDLE
      if (this.running) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  async markProcessed(uid: number) {
    if (!this.client) return;
    const lock = await this.client.getMailboxLock(this.account.mailbox);
    try {
      if (this.isGmail) {
        // Gmail: add custom label via X-GM-LABELS
        await this.client.messageFlagsAdd(
          String(uid),
          [this.account.processed_label],
          { uid: true, useLabels: true } as any
        );
      } else {
        // Non-Gmail: add custom flag
        await this.client.messageFlagsAdd(
          String(uid),
          ["bye_emails_processed"],
          { uid: true }
        );
      }
    } finally {
      lock.release();
    }
  }

  async archiveEmail(uid: number) {
    if (!this.client) return;
    const lock = await this.client.getMailboxLock(this.account.mailbox);
    try {
      if (this.isGmail) {
        // Gmail: move to All Mail = archive (removes from Inbox)
        await this.client.messageMove(String(uid), "[Gmail]/All Mail", {
          uid: true,
        });
      } else {
        // Non-Gmail: move to Archive/Archives folder
        try {
          await this.client.messageMove(String(uid), "Archive", {
            uid: true,
          });
        } catch {
          await this.client.messageMove(String(uid), "Archives", {
            uid: true,
          });
        }
      }
    } finally {
      lock.release();
    }
  }
}
