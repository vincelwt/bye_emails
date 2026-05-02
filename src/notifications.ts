import type { Classification } from "./types";

export function isLowPriorityNotification(classification: Classification) {
  return (
    classification.action === "notify_and_archive" ||
    classification.action === "summarize_and_archive"
  );
}
