import type { Classification, ParsedEmail } from "./types";

type GitHubEmail = Pick<ParsedEmail, "from" | "subject">;

export function isGitHubSender(address: string): boolean {
  const normalizedAddress = address.trim().toLowerCase();
  const atIndex = normalizedAddress.lastIndexOf("@");
  if (atIndex <= 0) return false;

  const domain = normalizedAddress.slice(atIndex + 1);
  return domain === "github.com" || domain.endsWith(".github.com");
}

export function classifyGitHubEmail(
  email: GitHubEmail
): Classification | undefined {
  if (!isGitHubSender(email.from.address)) return undefined;

  return {
    rule: "github",
    action: "notify_and_archive",
    confidence: 1,
    extracted: {
      brief: `GitHub: ${email.subject}`,
    },
  };
}
