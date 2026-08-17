import type { ParsedEmail } from "./types";

function gmailIdToHex(id: string | undefined): string | undefined {
  if (!id || !/^\d+$/.test(id)) return undefined;

  return BigInt(id).toString(16);
}

export function getGmailUrl(email: ParsedEmail): string | undefined {
  const gmailConversationId = gmailIdToHex(
    email.gmailThreadId ?? email.gmailMessageId
  );
  if (gmailConversationId) {
    return `https://mail.google.com/mail/u/0/#all/${gmailConversationId}`;
  }

  const rfcMessageId = email.messageId.replace(/^<|>$/g, "");
  if (!rfcMessageId) return undefined;

  return `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(rfcMessageId)}`;
}
