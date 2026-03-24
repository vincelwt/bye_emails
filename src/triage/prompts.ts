import type { Rule } from "../types";

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
  // Truncate body to avoid token waste
  const maxBodyLength = 4000;
  const body =
    email.text.length > maxBodyLength
      ? email.text.slice(0, maxBodyLength) + "\n[... truncated]"
      : email.text;

  return `From: ${email.from.name} <${email.from.address}>
Subject: ${email.subject}
Date: ${email.date.toISOString()}

${body}`;
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
