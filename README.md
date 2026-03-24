# bye_emails

An AI-powered email automation agent that triages your inbox, sends notifications to Telegram, and takes action — so you never have to manually manage emails again.

## What it does

- **Monitors your email** in real-time via IMAP IDLE (push-based, low latency)
- **Classifies emails** using an LLM with your custom rules (natural language)
- **Takes action** automatically based on classification:
  - **Spam/notifications** — notify + auto-archive
  - **Newsletters** — summarize key points + auto-archive
  - **Security codes** — extract OTP/links, notify instantly + auto-archive
  - **Travel bookings** — add to calendar (CalDAV) + auto-archive
  - **Important emails** — notify with archive button, keep in inbox
- **Completely stateless** — uses Gmail labels (or IMAP flags) to track processed emails
- **Multi-account** — monitor multiple email accounts simultaneously
- **Extensible** — plugin system for custom actions, channel system for notification targets

## Quick start

### Prerequisites

- [Bun](https://bun.sh) runtime
- A Telegram bot (create one via [@BotFather](https://t.me/botfather))
- An Anthropic API key or Claude OAuth token
- Gmail App Password (or IMAP credentials for your provider)

### 1. Clone and install

```bash
git clone https://github.com/your-username/bye_emails.git
cd bye_emails
bun install
```

### 2. Set up Gmail App Password

1. Go to [Google Account Security](https://myaccount.google.com/security)
2. Enable 2-Factor Authentication if not already enabled
3. Go to [App Passwords](https://myaccount.google.com/apppasswords)
4. Create an app password for "Mail"
5. Copy the 16-character password

### 3. Set up Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/botfather)
2. Send `/newbot` and follow the prompts
3. Copy the bot token
4. To get your chat ID:
   - Send a message to your bot
   - Visit `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
   - Find your `chat.id` in the response

### 4. Configure

```bash
cp config.example.yaml config.yaml
```

Edit `config.yaml` with your rules. See the example file for all options.

Create a `.env` file:

```env
# LLM
ANTHROPIC_OAUTH_TOKEN=your_token_here

# Gmail
GMAIL_USER=you@gmail.com
GMAIL_APP_PASSWORD=abcd-efgh-ijkl-mnop

# Telegram
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
TELEGRAM_CHAT_ID=123456789

# CalDAV (optional)
CALDAV_USERNAME=your_apple_id@icloud.com
CALDAV_PASSWORD=abcd-efgh-ijkl-mnop
```

### 5. Run

```bash
bun run start
```

Or with watch mode for development:

```bash
bun run dev
```

## Configuration

All behavior is defined in `config.yaml`. Here's what you can configure:

### LLM

```yaml
llm:
  provider: anthropic
  model: claude-haiku-4-5-20251001       # fast triage
  summarize_model: claude-sonnet-4-6     # detailed summaries
  api_key_env: ANTHROPIC_OAUTH_TOKEN
```

### Email accounts

```yaml
accounts:
  - name: personal
    host: imap.gmail.com
    port: 993
    secure: true
    auth:
      user_env: GMAIL_USER
      pass_env: GMAIL_APP_PASSWORD
    mailbox: INBOX
    processed_label: bye_emails/processed  # Gmail label for tracking
```

### Rules

Rules are defined in natural language. The LLM uses these descriptions to classify incoming emails:

```yaml
rules:
  - name: security
    description: >
      OTP codes, login verification, 2FA codes, password reset links,
      security alerts, login notifications from services.
    action: extract_and_archive
    notify_template: security
```

Available actions:

| Action | Behavior |
|--------|----------|
| `notify_and_archive` | Short notification + archive |
| `summarize_and_archive` | Detailed summary (uses smarter model) + archive |
| `extract_and_archive` | Extract OTP/links + archive |
| `calendar_and_archive` | Add to calendar + archive |
| `notify_keep` | Full notification with archive button, stays in inbox |

### Calendar (CalDAV)

Supports any CalDAV server: iCloud, Google Calendar, Nextcloud, Fastmail, etc.

**iCloud:**
```yaml
plugins:
  calendar:
    provider: icloud
    server_url: https://caldav.icloud.com
    auth_method: Basic
    credentials:
      username: CALDAV_USERNAME    # env var name
      password: CALDAV_PASSWORD    # env var name (app-specific password)
    calendar_name: Travel
```

**Google Calendar:**
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

To get Google OAuth credentials:
1. Create a project in [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the CalDAV API
3. Create OAuth 2.0 credentials
4. Use the OAuth playground to get a refresh token with CalDAV scope

Calendar events are deduplicated — if a booking is modified (flight delay, room change), the existing event is updated instead of creating a duplicate.

## Docker

```bash
docker build -t bye_emails .
docker run -d \
  --env-file .env \
  -v $(pwd)/config.yaml:/app/config.yaml \
  --name bye_emails \
  bye_emails
```

Or with docker-compose:

```yaml
version: "3.8"
services:
  bye_emails:
    build: .
    env_file: .env
    volumes:
      - ./config.yaml:/app/config.yaml
    restart: unless-stopped
```

## Architecture

```
IMAP IDLE → Email arrives → LLM classifies → Plugin executes → Channel notifies
                                                    ↓
                                              Archive/Calendar/etc.
```

- **Watchers** — One IMAP connection per account, using IDLE for real-time push
- **Classifier** — Single LLM call classifies + extracts data; second call for newsletter summaries
- **Plugins** — Modular actions (archive, summarize, extract OTP, calendar)
- **Channels** — Notification targets (Telegram, extensible to others)

## Extending

### Adding a new plugin

Create a file in `src/plugins/`:

```typescript
import type { Plugin, PluginContext } from "../types";

export const myPlugin: Plugin = {
  name: "my-plugin",
  async execute(ctx: PluginContext) {
    // Access ctx.email, ctx.classification, ctx.channels, ctx.config
    // Send notifications via ctx.channels
    // Archive via ctx.archiveEmail()
  },
};
```

Register it in `src/index.ts` by adding it to `ACTION_TO_PLUGIN`.

### Adding a new channel

Implement the `Channel` interface from `src/types.ts`:

```typescript
import type { Channel, ChannelMessage } from "../types";

export class PushbulletChannel implements Channel {
  name = "pushbullet";
  async start() { /* init */ }
  async stop() { /* cleanup */ }
  async send(message: ChannelMessage) { /* send notification */ }
}
```

## License

MIT
