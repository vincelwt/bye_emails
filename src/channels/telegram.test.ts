import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  TELEGRAM_MESSAGE_LIMIT,
  TelegramChannel,
  htmlToPlainText,
  splitTelegramText,
} from "./telegram";

describe("htmlToPlainText", () => {
  test("strips tags and unescapes entities", () => {
    expect(
      htmlToPlainText(
        "<b>A &amp; B</b> &lt;tag&gt; &quot;q&quot; &amp;lt; <i>done</i>"
      )
    ).toBe('A & B <tag> "q" &lt; done');
  });

  test("keeps link URLs", () => {
    expect(
      htmlToPlainText('<a href="https://example.com/x?a=1">→ Open link</a>')
    ).toBe("→ Open link (https://example.com/x?a=1)");
  });
});

describe("splitTelegramText", () => {
  test("returns short text unchanged", () => {
    expect(splitTelegramText("hello\nworld")).toEqual(["hello\nworld"]);
  });

  test("returns text of exactly the limit as one chunk", () => {
    const text = "a".repeat(TELEGRAM_MESSAGE_LIMIT);
    expect(splitTelegramText(text)).toEqual([text]);
  });

  test("splits on line breaks", () => {
    const lines = Array.from({ length: 200 }, (_, i) =>
      `line ${i} `.padEnd(50, "x")
    );
    const text = lines.join("\n");
    const chunks = splitTelegramText(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    }
    expect(chunks.join("\n")).toBe(text);
    // Every chunk ends on a full line
    for (const chunk of chunks) {
      expect(lines).toContain(chunk.split("\n").at(-1)!);
    }
  });

  test("falls back to spaces, then a hard cut, for long lines", () => {
    expect(splitTelegramText("aaaa bbbb", 6)).toEqual(["aaaa", "bbbb"]);
    expect(splitTelegramText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  test("never splits a surrogate pair", () => {
    const text = "😀".repeat(3000);
    const chunks = splitTelegramText(text);

    expect(chunks.length).toBe(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
      expect(chunk.length % 2).toBe(0);
    }
    expect(chunks.join("")).toBe(text);
  });

  test("drops whitespace-only chunks", () => {
    expect(splitTelegramText("abc\n\n\n\ndef", 4)).toEqual(["abc", "def"]);
  });
});

describe("TelegramChannel.send", () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  function captureFetch(responses: Response[]) {
    const bodies: Array<Record<string, any>> = [];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      _url: string | URL | Request,
      init?: RequestInit
    ) => {
      bodies.push(JSON.parse(String(init?.body)));
      return responses.shift() ?? new Response("{}", { status: 200 });
    }) as typeof fetch);
    return bodies;
  }

  const channel = new TelegramChannel({ botToken: "test", chatId: "1" });
  const buttons = [[{ label: "✓ Archive", callback_data: "archive:a:1" }]];

  test("sends short messages once as HTML", async () => {
    const bodies = captureFetch([]);
    await channel.send({ text: "<b>hi</b>", silent: true, buttons });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      text: "<b>hi</b>",
      parse_mode: "HTML",
      disable_notification: true,
    });
    expect(bodies[0]!.reply_markup).toBeDefined();
  });

  test("splits long messages into plain-text parts", async () => {
    const bodies = captureFetch([]);
    const line = `<b>Company</b>: ${"x".repeat(80)} &amp; more`;
    const text = Array.from({ length: 100 }, () => line).join("\n");

    await channel.send({ text, parse_mode: "HTML", silent: true, buttons });

    expect(bodies.length).toBeGreaterThan(1);
    bodies.forEach((body, index) => {
      expect(body.text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
      expect(body.parse_mode).toBeUndefined();
      expect(body.disable_notification).toBe(true);
      expect(body.text).not.toContain("<b>");
      expect(body.text).not.toContain("&amp;");
      expect(body.reply_markup !== undefined).toBe(index === bodies.length - 1);
    });
  });

  test("splits once when Telegram says the message is too long", async () => {
    const bodies = captureFetch([
      new Response(
        '{"ok":false,"error_code":400,"description":"Bad Request: message is too long"}',
        { status: 400 }
      ),
    ]);

    await channel.send({ text: "<i>short</i>", silent: true });

    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ text: "short", disable_notification: true });
    expect(bodies[1]!.parse_mode).toBeUndefined();
  });

  test("does not resend on other errors", async () => {
    const bodies = captureFetch([
      new Response('{"ok":false,"description":"Bad Request: chat not found"}', {
        status: 400,
      }),
    ]);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    await channel.send({ text: "hello" });

    expect(bodies).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});
