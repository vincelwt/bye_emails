import type { Rule, RuleAction } from "../types";

const MAX_BODY_LENGTH = 4000;
const MAX_URL_LENGTH = 300;

export function emailBodyForModel(text: string): string {
  const truncated =
    text.length > MAX_BODY_LENGTH
      ? text.slice(0, MAX_BODY_LENGTH) + "\n[... truncated]"
      : text;
  return omitLongUrls(truncated);
}

export function buildClassificationPrompt(rules: Rule[]): string {
  const rulesBlock = rules
    .map(
      (r, i) =>
        `${i + 1}. "${r.name}" (action: ${r.action})\n   Description: ${r.description.trim()}`
    )
    .join("\n\n");

  return `You are an email triage assistant. Your job is to classify incoming emails and extract relevant information.

## Rules

The user has defined the following classification rules:

${rulesBlock}

## Instructions

For each email, you must:
1. Classify it into exactly ONE of the rules above
2. Extract relevant data based on the rule type

Respond with valid JSON only (no markdown, no code fences). Use this schema:

{
  "rule": "<rule name>",
  "confidence": <0.0-1.0>,
  "extracted": {
    // For "security" emails:
    "otp_code": "<the code if present>",
    "action_link": "<the most important URL the user needs to click, if any>",
    "security_summary": "<one-line description of what this security email is about, include the service name>",

    // For "travel" emails:
    "travel_type": "flight|hotel|train|car_rental|other",
    "travel_details": {
      "title": "<concise title, e.g. 'Delta DL123 LAX → JFK' or 'Hotel Marriott Tokyo, 3 nights'>",
      "location": "<for hotels: full address. for flights/trains: departure station/airport>",
      "start_time": "<ISO 8601 with timezone offset, e.g. '2026-03-26T14:30:00+09:00'. Use the LOCAL timezone of the departure/check-in location>",
      "end_time": "<ISO 8601 with timezone offset. For flights: arrival time in ARRIVAL timezone. For hotels: checkout time>",
      "timezone": "<IANA timezone of the start location, e.g. 'Asia/Tokyo', 'America/New_York'>",
      "confirmation_number": "<booking reference>",
      "provider": "<airline/hotel chain name>",
      "notes": "<any other important details: seat number, room type, terminal, gate, etc.>",
      "legs": [
        {
          "departure_airport": "<IATA code, e.g. LAX>",
          "departure_city": "<city name>",
          "arrival_airport": "<IATA code>",
          "arrival_city": "<city name>",
          "departure_time": "<ISO 8601 with timezone of departure city>",
          "arrival_time": "<ISO 8601 with timezone of arrival city>",
          "carrier": "<airline/train operator>",
          "flight_number": "<flight number>",
          "train_number": "<train number if applicable>"
        }
      ]
    },

    // IMPORTANT for travel: Always include timezone offsets in times. For multi-leg journeys, include each leg separately.
    // For flights: start_time = first departure, end_time = final arrival (in arrival timezone).
    // For hotels: start_time = check-in, end_time = check-out (in hotel timezone).

    // For "newsletters":
    "summary": "<2-3 sentence overview>",

    // For all types:
    "action_link": "<the most relevant actionable URL from the email, e.g. payment update link, dashboard link, review link. Only include real, full URLs from the email body. Omit if none found>",
    "brief": "<one-line summary that is self-contained — include WHO (service/sender name) and WHAT (the action/event). Do NOT repeat the subject line verbatim, rephrase it concisely>"
  }
}

Only include the fields relevant to the matched rule. Always include "brief".
Do not include URLs that are marked as omitted or that are too long to fit comfortably in JSON.
If travel dates/times cannot be determined, use your best estimate and note uncertainty in "notes".
For security emails, extract ONLY the actionable information (codes, links).
The "brief" should be a complete, self-contained summary — do not assume the reader sees the subject line or sender separately.`;
}

export function buildEmailContext(email: {
  from: { name: string; address: string };
  subject: string;
  text: string;
  date: Date;
}): string {
  return `From: ${email.from.name} <${email.from.address}>
Subject: ${email.subject}
Date: ${email.date.toISOString()}

${emailBodyForModel(email.text)}`;
}

const JSON_ONLY =
  "Respond with valid JSON only (no markdown, no code fences).";

export function buildExtractionPrompt(action: RuleAction): string | undefined {
  if (action === "extract_and_archive") {
    return `${JSON_ONLY}

{
  "otp_code": "<the code if present>",
  "action_link": "<the most important URL the user needs to click, if any>",
  "security_summary": "<one-line description of what this security email is about, include the service name>",
  "brief": "<one line: who sent it and what the user must do>"
}

Extract only the actionable code and link. Omit a field when the email does not contain it. Always include "brief".`;
  }

  if (action === "calendar_and_archive") {
    return `${JSON_ONLY}

{
  "travel_type": "flight|hotel|train|car_rental|other",
  "brief": "<one line naming the provider and the trip>",
  "travel_details": {
    "title": "<concise title, e.g. 'Delta DL123 LAX → JFK' or 'Hotel Marriott Tokyo, 3 nights'>",
    "location": "<for hotels: full address. for flights/trains: departure station/airport>",
    "start_time": "<ISO 8601 with timezone offset, e.g. '2026-03-26T14:30:00+09:00'. Use the LOCAL timezone of the departure/check-in location>",
    "end_time": "<ISO 8601 with timezone offset. For flights: arrival time in ARRIVAL timezone. For hotels: checkout time>",
    "timezone": "<IANA timezone of the start location, e.g. 'Asia/Tokyo', 'America/New_York'>",
    "confirmation_number": "<booking reference>",
    "provider": "<airline/hotel chain name>",
    "notes": "<seat, room type, terminal, gate, or uncertainty about a time>",
    "legs": [
      {
        "departure_airport": "<IATA code, e.g. LAX>",
        "departure_city": "<city name>",
        "arrival_airport": "<IATA code>",
        "arrival_city": "<city name>",
        "departure_time": "<ISO 8601 with timezone of departure city>",
        "arrival_time": "<ISO 8601 with timezone of arrival city>",
        "carrier": "<airline/train operator>",
        "flight_number": "<flight number>",
        "train_number": "<train number if applicable>"
      }
    ]
  }
}

Always include timezone offsets. For a multi-leg journey, list each leg. start_time is the first departure or check-in. end_time is the final arrival or check-out. If a time is uncertain, still give the best estimate and say so in "notes".`;
  }

  if (action === "notify_keep") {
    return `${JSON_ONLY}

{
  "action_link": "<the most relevant actionable URL from the email, or omit>",
  "brief": "<one line that names who wrote and what they need. Do not copy the subject verbatim>"
}

Only include a real, full URL from the email. Always include "brief".`;
  }

  return undefined;
}

function omitLongUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s<>"')\]]+/g, (url) => {
    if (url.length <= MAX_URL_LENGTH) return url;
    return `[long URL omitted: ${getUrlOrigin(url)}]`;
  });
}

function getUrlOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "unparseable URL";
  }
}

export function buildSummarizationPrompt(): string {
  return `You are a financial newsletter analyst. Summarize the newsletter content with a focus on actionable investment information.

Respond with valid JSON only (no markdown, no code fences). Use this schema:

{
  "summary": "<2-3 sentence overview of the newsletter's main thesis>",
  "companies": [
    {
      "name": "<company name>",
      "ticker": "<stock ticker if mentioned>",
      "thesis": "<why the newsletter is bullish/bearish on this company, 1-2 sentences>",
      "sentiment": "bullish|bearish|neutral"
    }
  ],
  "key_takeaways": ["<takeaway 1>", "<takeaway 2>"]
}

If the newsletter is not financial, still provide a structured summary but omit the companies array.
Focus on extracting the core thesis and reasoning, not just listing what was mentioned.`;
}
