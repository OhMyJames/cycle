import type { AccountInfo, LimitWindow } from "@cycle/protocol";

/** Who an account is, in a line. */
export function accountTitle(account: AccountInfo): string {
  if (account.email) return account.email;
  if (account.kind === "apiKey") return "API key";
  if (account.kind === "cloud" && account.provider) return `Through ${account.provider}`;
  return "Signed in";
}

/** The rest of what is known of an account, in a line: plan, organization, who serves it, how. */
export function accountDetails(account: AccountInfo): string {
  const parts: string[] = [];
  if (account.plan) parts.push(`Plan: ${account.plan}`);
  else if (account.kind === "apiKey") parts.push("Billed by usage");
  if (account.organization) parts.push(account.organization);
  if (account.provider && account.kind !== "cloud") parts.push(`Served by ${account.provider}`);
  if (account.source) parts.push(`Credential from ${account.source}`);
  return parts.join(" · ");
}

/** How much of a limit is used, or, when the agent says only that, whether it is reached. */
export function limitText(limit: LimitWindow): string {
  const status =
    limit.status === "exceeded"
      ? limit.overage
        ? "Reached · using overage"
        : "Reached"
      : limit.status === "warning"
        ? "Nearly reached"
        : null;
  if (limit.usedPercent === null) return status ?? "Within the limit";
  const used = `${Math.round(limit.usedPercent)}% used`;
  return status ? `${used} · ${status}` : used;
}
