import { DAVClient } from "tsdav";
import type {
  Plugin,
  PluginContext,
  CalendarConfig,
  ExtractedData,
  TravelLeg,
} from "../types";
import { resolveCalendarCredentials } from "../config";
import { bold, escapeHtml } from "../channels/telegram";

// Stable UID generation from email content — ensures dedup across runs
function generateEventUid(
  email: { messageId: string },
  travelType: string,
  legIndex?: number
): string {
  const raw = `${email.messageId}:${travelType}:${legIndex ?? 0}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return `bye-emails-${Math.abs(hash).toString(36)}@bye-emails`;
}

// Search for existing events by confirmation number or UID
async function findExistingEvent(
  client: DAVClient,
  calendar: any,
  confirmationNumber: string | undefined,
  eventUid: string
): Promise<{ url: string; etag: string; data: string } | null> {
  try {
    const objects = await client.fetchCalendarObjects({ calendar });
    for (const obj of objects) {
      const data = typeof obj.data === "string" ? obj.data : "";
      if (data.includes(`UID:${eventUid}`)) {
        return { url: obj.url, etag: obj.etag ?? "", data };
      }
      if (
        confirmationNumber &&
        data.includes(`Confirmation: ${confirmationNumber}`)
      ) {
        return { url: obj.url, etag: obj.etag ?? "", data };
      }
    }
  } catch (err) {
    console.error("[calendar] Error searching existing events:", err);
  }
  return null;
}

function formatICalDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function escapeICalText(text: string): string {
  return text.replace(/[,;\\]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");
}

function buildICalEvent(
  uid: string,
  summary: string,
  dtStart: string,
  dtEnd: string,
  location: string | undefined,
  description: string
): string {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${formatICalDate(new Date())}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${escapeICalText(summary)}`,
  ];

  if (location) {
    lines.push(`LOCATION:${escapeICalText(location)}`);
  }
  if (description) {
    lines.push(`DESCRIPTION:${escapeICalText(description)}`);
  }

  lines.push("STATUS:CONFIRMED", "END:VEVENT");
  return lines.join("\r\n");
}

// Format an ISO 8601 date with timezone to iCal format
// Input: "2026-03-26T14:30:00+09:00" -> "20260326T143000" with TZID
function formatICalDateFromISO(isoStr: string): string {
  // Parse the date and convert to UTC for simplicity
  const d = new Date(isoStr);
  return formatICalDate(d);
}

function buildICalString(
  details: NonNullable<ExtractedData["travel_details"]>,
  travelType: string,
  email: { messageId: string }
): string {
  const events: string[] = [];
  const legs = details.legs ?? [];

  const descParts = [
    details.provider ? `Provider: ${details.provider}` : "",
    details.confirmation_number
      ? `Confirmation: ${details.confirmation_number}`
      : "",
    details.notes ? `Notes: ${details.notes}` : "",
  ]
    .filter(Boolean)
    .join("\\n");

  if (legs.length > 0) {
    // Multi-leg: create one event per leg
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i]!;
      const uid = generateEventUid(email, travelType, i);

      const legSummary =
        leg.flight_number
          ? `${leg.carrier ?? ""} ${leg.flight_number} ${leg.departure_airport ?? leg.departure_city ?? ""} → ${leg.arrival_airport ?? leg.arrival_city ?? ""}`.trim()
          : leg.train_number
            ? `${leg.carrier ?? ""} ${leg.train_number} ${leg.departure_city ?? ""} → ${leg.arrival_city ?? ""}`.trim()
            : `${details.title} (Leg ${i + 1})`;

      const location =
        leg.departure_airport ?? leg.departure_city ?? details.location;

      const legDesc = [
        descParts,
        leg.departure_airport
          ? `Departure: ${leg.departure_airport} (${leg.departure_city ?? ""})`
          : "",
        leg.arrival_airport
          ? `Arrival: ${leg.arrival_airport} (${leg.arrival_city ?? ""})`
          : "",
      ]
        .filter(Boolean)
        .join("\\n");

      events.push(
        buildICalEvent(
          uid,
          legSummary,
          formatICalDateFromISO(leg.departure_time),
          formatICalDateFromISO(leg.arrival_time),
          location,
          legDesc
        )
      );
    }
  } else {
    // Single event
    const uid = generateEventUid(email, travelType);
    events.push(
      buildICalEvent(
        uid,
        details.title,
        formatICalDateFromISO(details.start_time),
        formatICalDateFromISO(details.end_time),
        details.location,
        descParts
      )
    );
  }

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//bye_emails//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...events,
    "END:VCALENDAR",
  ].join("\r\n");
}

async function getOrCreateCalDavClient(
  calConfig: CalendarConfig,
  credentials: Record<string, string>
): Promise<DAVClient> {
  const client = new DAVClient({
    serverUrl: calConfig.server_url,
    credentials,
    authMethod: calConfig.auth_method,
    defaultAccountType: "caldav",
  });
  await client.login();
  return client;
}

async function findTargetCalendar(client: DAVClient, calendarName?: string) {
  const calendars = await client.fetchCalendars();

  if (calendarName) {
    const match = calendars.find(
      (c) =>
        String(c.displayName ?? "").toLowerCase() === calendarName.toLowerCase()
    );
    if (match) return match;
    console.warn(
      `[calendar] Calendar "${calendarName}" not found, using first available`
    );
  }

  if (calendars.length === 0) {
    throw new Error("No calendars found on CalDAV server");
  }

  return calendars[0]!;
}

function formatLegLine(leg: TravelLeg): string {
  const dep = leg.departure_airport ?? leg.departure_city ?? "";
  const arr = leg.arrival_airport ?? leg.arrival_city ?? "";
  const id = leg.flight_number ?? leg.train_number ?? "";
  const carrier = leg.carrier ? `${leg.carrier} ` : "";

  const depTime = new Date(leg.departure_time).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const arrTime = new Date(leg.arrival_time).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return `  ${carrier}${id} ${dep} ${depTime} → ${arr} ${arrTime}`;
}

export const calendarPlugin: Plugin = {
  name: "calendar",

  async execute(ctx: PluginContext) {
    const { email, classification, config, channels } = ctx;
    const { travel_details, travel_type } = classification.extracted;

    if (!travel_details) {
      for (const channel of channels) {
        await channel.send({
          text: `🧳 ${escapeHtml(classification.extracted.brief ?? email.subject)}\n\n<i>Auto-archived</i>`,
          parse_mode: "HTML",
        });
      }
      await ctx.archiveEmail();
      return;
    }

    // Build the .ics content
    const iCalString = buildICalString(travel_details, travel_type ?? "other", email);

    // Try CalDAV if configured
    const calConfig = config.plugins?.calendar;
    let calendarAction = "skipped";

    if (calConfig) {
      const credentials = resolveCalendarCredentials(config);
      if (credentials) {
        try {
          const client = await getOrCreateCalDavClient(calConfig, credentials);
          const calendar = await findTargetCalendar(
            client,
            calConfig.calendar_name
          );

          const eventUid = generateEventUid(
            email,
            travel_type ?? "other"
          );

          const existing = await findExistingEvent(
            client,
            calendar,
            travel_details.confirmation_number,
            eventUid
          );

          if (existing) {
            await client.updateCalendarObject({
              calendarObject: {
                url: existing.url,
                etag: existing.etag,
                data: iCalString,
              },
            });
            calendarAction = "updated";
            console.log(
              `[calendar] Updated existing event: ${travel_details.title}`
            );
          } else {
            await client.createCalendarObject({
              calendar,
              iCalString,
              filename: `bye-emails-${Date.now()}.ics`,
            });
            calendarAction = "created";
            console.log(
              `[calendar] Created event: ${travel_details.title}`
            );
          }
        } catch (err) {
          console.error("[calendar] CalDAV error:", err);
          calendarAction = "error";
        }
      }
    }

    // Build notification
    const travelEmoji =
      travel_type === "flight"
        ? "✈️"
        : travel_type === "hotel"
          ? "🏨"
          : travel_type === "train"
            ? "🚅"
            : travel_type === "car_rental"
              ? "🚗"
              : "🧳";

    const lines: string[] = [
      `${travelEmoji} ${bold(escapeHtml(travel_details.title))}`,
    ];

    const legs = travel_details.legs ?? [];
    if (legs.length > 1) {
      // Multi-leg: show each leg
      for (const leg of legs) {
        lines.push(escapeHtml(formatLegLine(leg)));
      }
    } else {
      const start = new Date(travel_details.start_time);
      const end = new Date(travel_details.end_time);
      lines.push(
        `📅 ${start.toLocaleDateString()} ${start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} – ${end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      );
    }

    if (travel_details.location) {
      lines.push(`📍 ${escapeHtml(travel_details.location)}`);
    }

    if (travel_details.confirmation_number) {
      lines.push(`🔖 ${escapeHtml(travel_details.confirmation_number)}`);
    }

    if (calendarAction === "created") {
      lines.push(`\n<i>📆 Added to calendar · auto-archived</i>`);
    } else if (calendarAction === "updated") {
      lines.push(`\n<i>📆 Calendar updated · auto-archived</i>`);
    } else if (calendarAction === "error") {
      lines.push(`\n<i>⚠️ Calendar error · auto-archived</i>`);
    } else {
      lines.push(`\n<i>Auto-archived</i>`);
    }

    for (const channel of channels) {
      await channel.send({ text: lines.join("\n"), parse_mode: "HTML" });

      // If calendar not connected via CalDAV, attach the .ics file
      if (calendarAction === "skipped" || calendarAction === "error") {
        await channel.sendDocument({
          filename: `${travel_type ?? "event"}-${Date.now()}.ics`,
          content: Buffer.from(iCalString),
          contentType: "text/calendar",
          caption: "📆 Tap to add to your calendar",
        });
      }
    }

    await ctx.archiveEmail();
  },
};
