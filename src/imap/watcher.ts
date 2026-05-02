import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { ParsedEmail, ImapAccountConfig, EmailAttachment } from "../types";

const IDLE_RESTART_INTERVAL_MS = 25 * 60 * 1000;
const MAX_PARALLEL_EMAIL_PROCESSING = 3;
const MIN_POLL_INTERVAL_SECONDS = 5;

type QueueSource = "startup" | "idle" | "poll";

interface ProcessingTask {
  uid: number;
  source: QueueSource;
  queuedAt: number;
}

export interface WatcherEvents {
  onEmail: (email: ParsedEmail) => Promise<void>;
  onError: (error: Error, account: string) => void;
}

export class ImapWatcher {
  private client: ImapFlow | null = null;
  private running = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private isGmail = false;
  private scanRunning = false;
  private processingQueue: ProcessingTask[] = [];
  private queuedOrProcessingUids = new Set<number>();
  private activeProcessors = 0;

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
    this.stopFallbackPolling();
    this.processingQueue = [];
    this.queuedOrProcessingUids.clear();
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
        maxIdleTime: IDLE_RESTART_INTERVAL_MS,
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
      await this.processUnprocessed("startup");

      this.startFallbackPolling();

      // Start IDLE loop
      await this.idleLoop();
    } catch (err) {
      this.events.onError(err as Error, this.account.name);
      this.stopFallbackPolling();
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (!this.running || this.reconnectTimer) return;
    this.stopFallbackPolling();
    const delay = 5000;
    console.log(`[${this.account.name}] Reconnecting in ${delay / 1000}s...`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.client = null;
      await this.connect();
    }, delay);
  }

  private startFallbackPolling() {
    this.stopFallbackPolling();
    const pollMs =
      Math.max(this.account.poll_interval, MIN_POLL_INTERVAL_SECONDS) * 1000;

    const runPoll = async () => {
      if (!this.running || !this.client) return;

      try {
        // Break IDLE so the fallback scan can acquire the mailbox lock promptly.
        await this.client.noop();
      } catch {
        // Connection errors are handled by the main IMAP event handlers.
      }

      await this.processUnprocessed("poll");

      if (this.running && this.client) {
        this.pollTimer = setTimeout(runPoll, pollMs);
      }
    };

    this.pollTimer = setTimeout(runPoll, pollMs);
  }

  private stopFallbackPolling() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async processUnprocessed(source: QueueSource) {
    if (!this.client || this.scanRunning) return;

    this.scanRunning = true;
    const startedAt = Date.now();

    let lock: Awaited<ReturnType<ImapFlow["getMailboxLock"]>> | null = null;
    try {
      lock = await this.client.getMailboxLock(this.account.mailbox);

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
        let queued = 0;
        for (const uid of unprocessedUids) {
          if (this.enqueueUid(uid, source)) queued++;
        }

        console.log(
          `[${this.account.name}] Found ${unprocessedUids.length} unprocessed email(s) via ${source}; queued ${queued}, already queued/processing ${unprocessedUids.length - queued} (${Date.now() - startedAt}ms)`
        );
      } else if (source !== "poll") {
        console.log(
          `[${this.account.name}] No unprocessed emails via ${source} (${Date.now() - startedAt}ms)`
        );
      }
    } finally {
      lock?.release();
      this.scanRunning = false;
    }
  }

  private enqueueUid(uid: number, source: QueueSource): boolean {
    if (this.queuedOrProcessingUids.has(uid)) return false;

    this.queuedOrProcessingUids.add(uid);
    this.processingQueue.push({ uid, source, queuedAt: Date.now() });
    console.log(
      `[${this.account.name}] Queued UID ${uid} from ${source} (queue: ${this.processingQueue.length}, active: ${this.activeProcessors})`
    );
    this.drainProcessingQueue();
    return true;
  }

  private drainProcessingQueue() {
    while (
      this.running &&
      this.activeProcessors < MAX_PARALLEL_EMAIL_PROCESSING &&
      this.processingQueue.length > 0
    ) {
      const task = this.processingQueue.shift()!;
      this.activeProcessors++;

      this.processQueuedUid(task)
        .catch((err) => {
          console.error(
            `[${this.account.name}] Error processing queued UID ${task.uid}:`,
            err
          );
        })
        .finally(() => {
          this.activeProcessors--;
          this.queuedOrProcessingUids.delete(task.uid);
          this.drainProcessingQueue();
        });
    }
  }

  private async processQueuedUid(task: ProcessingTask): Promise<void> {
    const startedAt = Date.now();
    const email = await this.fetchEmail(task.uid);
    if (!email) {
      console.log(
        `[${this.account.name}] UID ${task.uid} from ${task.source} no longer exists or has no source`
      );
      return;
    }

    console.log(
      `[${this.account.name}] Processing queued UID ${task.uid} from ${task.source} after ${startedAt - task.queuedAt}ms: "${email.subject}"`
    );

    await this.events.onEmail(email);

    console.log(
      `[${this.account.name}] Finished queued UID ${task.uid} from ${task.source} in ${Date.now() - startedAt}ms`
    );
  }

  private async fetchEmail(uid: number): Promise<ParsedEmail | null> {
    if (!this.client) return null;

    let lock: Awaited<ReturnType<ImapFlow["getMailboxLock"]>> | null = null;
    try {
      lock = await this.client.getMailboxLock(this.account.mailbox);

      const message = await this.client.fetchOne(
        String(uid),
        { uid: true, source: true, envelope: true },
        { uid: true }
      );

      if (!message || !message.source) return null;

      return await this.parseEmail(uid, message.source as Buffer);
    } catch (err) {
      console.error(
        `[${this.account.name}] Error fetching UID ${uid}:`,
        err
      );
      return null;
    } finally {
      lock?.release();
    }
  }

  private async parseEmail(
    uid: number,
    source: Buffer
  ): Promise<ParsedEmail> {
    const parsed = await simpleParser(source);

    const from = parsed.from?.value?.[0] ?? { name: "", address: "" };
    const to = parsed.to
      ? Array.isArray(parsed.to)
        ? parsed.to.flatMap((t) => t.value)
        : parsed.to.value
      : [];

    return {
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

                const uid = (msg as any).uid;
                if (!isProcessed && typeof uid === "number") {
                  this.enqueueUid(uid, "idle");
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
