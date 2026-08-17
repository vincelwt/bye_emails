import type { GmailCategory } from "./types";

export const GMAIL_AUTO_ARCHIVE_CATEGORIES: GmailCategory[] = ["updates"];

export function isGmailAutoArchiveCategory(
  category: GmailCategory | undefined
): category is GmailCategory {
  return (
    category !== undefined && GMAIL_AUTO_ARCHIVE_CATEGORIES.includes(category)
  );
}
