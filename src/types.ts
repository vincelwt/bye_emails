export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  size: number;
}

export interface ParsedEmail {
  uid: number;
  messageId: string;
  from: { name: string; address: string };
  to: Array<{ name: string; address: string }>;
  subject: string;
  text: string;
  html: string;
  date: Date;
  headers: Record<string, string>;
  accountName: string;
  attachments: EmailAttachment[];
}

export type RuleAction =
  | "notify_and_archive"
  | "summarize_and_archive"
  | "extract_and_archive"
  | "calendar_and_archive"
  | "notify_keep";

export interface Rule {
  name: string;
  description: string;
  action: RuleAction;
  notify_template: "short" | "summary" | "security" | "travel" | "full";
}

export interface Classification {
  rule: string;
  action: RuleAction;
  confidence: number;
  extracted: ExtractedData;
}

export interface TravelLeg {
  departure_airport?: string;
  departure_city?: string;
  arrival_airport?: string;
  arrival_city?: string;
  departure_time: string; // ISO 8601 with timezone
  arrival_time: string;   // ISO 8601 with timezone
  carrier?: string;
  flight_number?: string;
  train_number?: string;
}

export interface ExtractedData {
  // Security
  otp_code?: string;
  action_link?: string;
  security_summary?: string;

  // Newsletter
  summary?: string;
  companies?: Array<{
    name: string;
    thesis: string;
    sentiment: "bullish" | "bearish" | "neutral";
  }>;

  // Travel
  travel_type?: "flight" | "hotel" | "train" | "car_rental" | "other";
  travel_details?: {
    title: string;
    location?: string;
    start_time: string; // ISO 8601 with timezone
    end_time: string;   // ISO 8601 with timezone
    timezone?: string;  // IANA timezone e.g. "Asia/Tokyo"
    confirmation_number?: string;
    provider?: string;
    notes?: string;
    legs?: TravelLeg[]; // multi-leg flights/trains
  };

  // General
  brief?: string;
}

export interface ChannelMessage {
  text: string;
  buttons?: Array<{
    label: string;
    callback_data?: string;
    url?: string;
  }>[];  // array of rows, each row is array of buttons
  parse_mode?: "HTML" | "MarkdownV2";
  silent?: boolean;
}

export interface ChannelDocument {
  filename: string;
  content: Buffer;
  contentType: string;
  caption?: string;
  parse_mode?: "HTML" | "MarkdownV2";
  silent?: boolean;
}

export interface Channel {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: ChannelMessage): Promise<void>;
  sendDocument(doc: ChannelDocument): Promise<void>;
  onCallback?(handler: (data: string) => Promise<void>): void;
}

export interface PluginContext {
  email: ParsedEmail;
  classification: Classification;
  config: Config;
  channels: Channel[];
  archiveEmail: () => Promise<void>;
}

export interface Plugin {
  name: string;
  execute(ctx: PluginContext): Promise<void>;
}

// Config types
export interface ImapAccountConfig {
  name: string;
  host: string;
  port: number;
  secure: boolean;
  auth: {
    user_env: string;
    pass_env: string;
  };
  mailbox: string;
  processed_label: string;
  poll_interval: number;
}

export interface LlmConfig {
  provider: string;
  model: string;
  summarize_model: string;
  api_key_env: string;
}

export interface TelegramConfig {
  bot_token_env: string;
  chat_id_env: string;
}

export interface CalendarConfig {
  provider: "google" | "icloud" | "nextcloud" | "generic";
  server_url: string;
  auth_method: "Basic" | "Oauth";
  credentials: Record<string, string>; // env var references
  calendar_name?: string;
}

export interface Config {
  llm: LlmConfig;
  accounts: ImapAccountConfig[];
  channels: {
    telegram?: TelegramConfig;
  };
  rules: Rule[];
  plugins?: {
    calendar?: CalendarConfig;
  };
}

// Helper to build Gmail URL from message ID
export function getGmailUrl(messageId: string): string {
  // Strip angle brackets from Message-ID header
  const cleanId = messageId.replace(/^<|>$/g, "");
  return `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(cleanId)}`;
}
