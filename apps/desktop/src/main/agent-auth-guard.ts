// Desktop-side anti-phishing guardrails & transport-aware sign-in mode selection (docs/harness-settings.md, CYCL-233).
// The allowed authorization/verification hosts are hardcoded ONLY in the desktop main process —
// never declared or overridden by the daemon — so a compromised remote daemon cannot redirect
// `shell.openExternal` to an attacker domain or arbitrary URI scheme.
import type { AgentAuthMode, AgentSignInMode } from "@cycle/ui";

/**
 * Exact HTTPS hostnames permitted for each agent's subscription sign-in (`authorizationUrl` and `verificationUrl`).
 * No wildcards, no HTTP, no non-standard ports, no embedded credentials.
 */
export const AGENT_AUTH_ALLOWED_HOSTS: Readonly<Record<string, readonly string[]>> = {
  claude: ["claude.com", "claude.ai", "platform.claude.com"],
  codex: ["auth.openai.com"],
  agy: ["accounts.google.com"],
};

export type ValidatedAuthUrl =
  | { ok: true; url: string; host: string }
  | { ok: false; reason: "untrusted_url" };

/**
 * Validates a daemon-supplied `authorizationUrl` or `verificationUrl` against the hardcoded
 * per-agent allowlist. Returns the normalized URL and hostname to display in the confirmation modal.
 */
export const validateAgentAuthUrl = (agent: string, rawUrl: string): ValidatedAuthUrl => {
  const allowed = AGENT_AUTH_ALLOWED_HOSTS[agent];
  if (allowed === undefined || allowed.length === 0) return { ok: false, reason: "untrusted_url" };

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "untrusted_url" };
  }

  if (parsed.protocol !== "https:") return { ok: false, reason: "untrusted_url" };
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "untrusted_url" };
  }
  // Standard HTTPS port 443 only (`URL` normalizes `:443` to `""`).
  if (parsed.port !== "") return { ok: false, reason: "untrusted_url" };

  const host = parsed.hostname.toLowerCase();
  if (!allowed.includes(host)) return { ok: false, reason: "untrusted_url" };

  return { ok: true, url: parsed.toString(), host };
};

/**
 * Selects the best sign-in mode for an environment's transport (`local` vs `remote`) from the
 * daemon's ordered `signInModes` capability list:
 * - `local`: accepts any mode (preferring daemon order, e.g. Codex `browser` first).
 * - `remote`: excludes modes requiring a local loopback callback (`requiresLocalLoopback: true`).
 */
export const selectAgentSignInMode = (
  environmentKind: "local" | "remote",
  signInModes: readonly AgentSignInMode[],
): AgentAuthMode | undefined => {
  const compatible =
    environmentKind === "local"
      ? signInModes
      : signInModes.filter((entry) => !entry.requiresLocalLoopback);
  return compatible[0]?.mode;
};
