import type { Classification, ParsedEmail } from "./types";

type LinearEmail = Pick<ParsedEmail, "from">;

export function isLinearSender(address: string): boolean {
  const normalizedAddress = address.trim().toLowerCase();
  const atIndex = normalizedAddress.lastIndexOf("@");
  if (atIndex <= 0) return false;

  const domain = normalizedAddress.slice(atIndex + 1);
  return domain === "linear.app" || domain.endsWith(".linear.app");
}

// Linear notifications are archived without a Telegram message. Security
// emails (login codes) keep their normal extract_and_archive handling.
export function applyLinearSilentArchiveOverride(
  email: LinearEmail,
  classification: Classification
): Classification {
  if (
    !isLinearSender(email.from.address) ||
    classification.action === "extract_and_archive"
  ) {
    return classification;
  }

  return {
    ...classification,
    rule: "linear",
    action: "archive_silently",
  };
}
