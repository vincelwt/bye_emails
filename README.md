# bye_emails

A micro agent that watches your inbox so you don't have to. Important stuff goes straight to your Telegram — everything else is archived automatically.

```
New email arrives → AI classifies it → Telegram notification → Auto-archived
                                              ↓
                          OTP codes extracted, travel added to calendar,
                          newsletters summarized, spam silently archived
```

## Why

Email is a todo list that anyone can add to. Most of it doesn't need you. OTP codes, newsletters, booking confirmations, notifications — they just need to be acknowledged and archived.

bye_emails connects to your inbox via IMAP, classifies every incoming email with an LLM, and handles it based on rules you define in plain English. You get a Telegram message with just the important bits. Your inbox stays empty.

## Features

- **Real-time** — IMAP IDLE (push, not polling). OTP codes arrive in Telegram within seconds
- **Smart triage** — LLM classifies emails using your natural language rules
- **OTP extraction** — security codes and action links pulled out and sent directly
- **Newsletter summaries** — financial newsletters broken down by company with bull/bear thesis
- **Travel to calendar** — flights, hotels, trains auto-added via CalDAV (iCloud, Google, Nextcloud). Handles multi-leg flights, timezones, and booking updates without creating duplicates
- **Attachments forwarded** — email attachments sent to Telegram alongside notifications
- **Action buttons** — important emails get "Open email" + "Archive" buttons in Telegram
- **Multi-account** — monitor as many inboxes as you want
- **Stateless** — no database. Uses Gmail labels / IMAP flags to track what's processed
- **Extensible** — plugin system for actions, channel system for notification targets

## Quick start

### You'll need

- [Bun](https://bun.sh)
- A [Telegram bot](https://t.me/botfather)
- An [Anthropic API key](https://console.anthropic.com/)
- A Gmail [App Password](https://myaccount.google.com/apppasswords) (or any IMAP credentials)

### Setup

```bash
git clone https://github.com/vincelwt/bye_emails.git
cd bye_emails
bun install
cp config.example.yaml config.yaml
```

Create a `.env`:

```env
ANTHROPIC_OAUTH_TOKEN=sk-ant-...
GMAIL_USER=you@gmail.com
GMAIL_APP_PASSWORD=abcd-efgh-ijkl-mnop
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=123456789
```

> **Telegram chat ID**: message your bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` to find it.

### Run

```bash
bun run start
```

## Configuration

Everything lives in `config.yaml`. Rules are plain English — the LLM uses them directly to classify emails.

```yaml
rules:
  - name: security
    description: >
      OTP codes, login verification, 2FA codes, password reset links,
      security alerts, login notifications.
    action: extract_and_archive

  - name: newsletters
    description: >
      Newsletters, especially financial ones. Investment analysis,
      market commentary, stock picks.
    action: summarize_and_archive

  - name: spam-like
    description: >
      Marketing, promotions, social notifications, automated emails
      that don't need action.
    action: notify_and_archive

  - name: travel
    description: >
      Flight confirmations, hotel reservations, train tickets,
      booking modifications.
    action: calendar_and_archive

  - name: needs_attention
    description: >
      Emails from real people needing a response, important business
      emails, anything requiring direct action.
    action: notify_keep
```

### Actions

| Action | What happens |
|--------|-------------|
| `notify_and_archive` | Brief notification, auto-archive |
| `extract_and_archive` | Extract OTP/links, notify, auto-archive |
| `summarize_and_archive` | Detailed summary (smarter model), auto-archive |
| `calendar_and_archive` | Add to calendar via CalDAV (or attach .ics), auto-archive |
| `notify_keep` | Full notification with Open + Archive buttons, stays in inbox |

### Multiple accounts

```yaml
accounts:
  - name: personal
    host: imap.gmail.com
    auth:
      user_env: GMAIL_USER
      pass_env: GMAIL_APP_PASSWORD

  - name: work
    host: imap.gmail.com
    auth:
      user_env: WORK_GMAIL_USER
      pass_env: WORK_GMAIL_APP_PASSWORD
```

### Calendar (CalDAV)

Works with iCloud, Google Calendar, Nextcloud, Fastmail — anything that speaks CalDAV.

Events are deduplicated: if a booking is modified (flight delay, room change), the existing calendar event is updated rather than duplicated. When CalDAV isn't configured, an `.ics` file is attached to the Telegram message instead.

```yaml
plugins:
  calendar:
    provider: icloud
    server_url: https://caldav.icloud.com
    auth_method: Basic
    credentials:
      username: CALDAV_USERNAME
      password: CALDAV_PASSWORD
    calendar_name: Travel
```

<details>
<summary>Google Calendar setup</summary>

```yaml
plugins:
  calendar:
    provider: google
    server_url: https://apidata.googleusercontent.com/caldav/v2/
    auth_method: Oauth
    credentials:
      tokenUrl: GOOGLE_TOKEN_URL
      username: GOOGLE_EMAIL
      refreshToken: GOOGLE_REFRESH_TOKEN
      clientId: GOOGLE_CLIENT_ID
      clientSecret: GOOGLE_CLIENT_SECRET
```

Create OAuth credentials in [Google Cloud Console](https://console.cloud.google.com/), enable CalDAV API, get a refresh token via the OAuth playground.
</details>

## Deploy

### Docker

```bash
docker build -t bye_emails .
docker run -d --env-file .env -v $(pwd)/config.yaml:/app/config.yaml bye_emails
```

### Docker Compose

```yaml
services:
  bye_emails:
    build: .
    env_file: .env
    volumes:
      - ./config.yaml:/app/config.yaml
    restart: unless-stopped
```

### Dokku

```bash
dokku apps:create bye-emails
dokku builder:set bye-emails selected dockerfile
dokku proxy:disable bye-emails
dokku checks:disable bye-emails
dokku config:set bye-emails ANTHROPIC_OAUTH_TOKEN=... GMAIL_USER=... # etc
git remote add dokku dokku@your-server:bye-emails
git push dokku main
```

## Extending

### Custom plugin

```typescript
import type { Plugin, PluginContext } from "../types";

export const myPlugin: Plugin = {
  name: "my-plugin",
  async execute(ctx: PluginContext) {
    // ctx.email — parsed email with attachments
    // ctx.classification — LLM result with extracted data
    // ctx.channels — send notifications
    // ctx.archiveEmail() — archive via IMAP
  },
};
```

Register in `src/index.ts` → `ACTION_TO_PLUGIN`.

### Custom channel

Implement the `Channel` interface — `start()`, `stop()`, `send()`, `sendDocument()`.

## Stack

- [Bun](https://bun.sh) runtime
- [ImapFlow](https://github.com/postalsys/imapflow) for IMAP + IDLE
- [pi-ai](https://github.com/badlogic/pi-mono/tree/main/packages/ai) for LLM calls (Claude)
- [tsdav](https://github.com/natelindev/tsdav) for CalDAV
- Telegram Bot API (direct HTTP, no library)

## License

MIT
