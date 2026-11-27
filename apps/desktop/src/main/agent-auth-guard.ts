// Desktop-side anti-phishing guardrails & transport-aware sign-in mode selection (docs/harness-settings.md, CYCL-233).
// The allowed authorization/verification hosts are hardcoded ONLY in the desktop main process —
// never declared or overridden by the daemon — so a compromised remote daemon cannot redirect
// `shell.openExternal` to an attacker domain or arbitrary URI scheme.
import type { AgentAuthMode, AgentSignInMode } from "@cycle/ui";

/**
 * Where each agent's sign-in may send the person: an exact HTTPS host and the path the official CLI opens there.
 * The host alone is not enough: a daemon that is not ours (a compromised remote) could hand over a real consent page of
 * the same host for someone else's app, and the dialog would truthfully name the host. So the path is pinned too, and
 * a `redirect_uri`, when there is one, must lead back to the agent's own callback (or the local loopback for Codex).
 * No wildcards, no HTTP, no non-standard ports, no embedded credentials.
 */
type AuthTarget = { host: string; paths: readonly string[] };

const AGENT_AUTH_TARGETS: Readonly<Record<string, readonly AuthTarget[]>> = {
  claude: [
    { host: "claude.com", paths: ["/cai/oauth/authorize"] },
    { host: "claude.ai", paths: ["/oauth/authorize"] },
    { host: "platform.claude.com", paths: ["/oauth/authorize"] },
  ],
  codex: [{ host: "auth.openai.com", paths: ["/oauth/authorize", "/codex/device"] }],
  agy: [{ host: "accounts.google.com", paths: ["/o/oauth2/auth", "/o/oauth2/v2/auth"] }],
};

/** The hosts a `redirect_uri` may name, per agent: the official hosted callback, or Codex's loopback server. */
const AGENT_AUTH_REDIRECT_HOSTS: Readonly<Record<string, readonly string[]>> = {
  claude: ["platform.claude.com", "console.anthropic.com", "claude.ai", "claude.com"],
  codex: ["localhost", "127.0.0.1"],
  agy: ["antigravity.google"],
};

export type ValidatedAuthUrl =
  | { ok: true; url: string; host: string }
  | { ok: false; reason: "untrusted_url" };

const UNTRUSTED: ValidatedAuthUrl = { ok: false, reason: "untrusted_url" };

const redirectAllowed = (agent: string, raw: string): boolean => {
  let redirect: URL;
  try {
    redirect = new URL(raw);
  } catch {
    return false;
  }
  if (redirect.username !== "" || redirect.password !== "") return false;
  const hosts = AGENT_AUTH_REDIRECT_HOSTS[agent] ?? [];
  if (!hosts.includes(redirect.hostname.toLowerCase())) return false;
  // Plain HTTP only to the loopback (Codex's own callback server); every hosted callback is HTTPS on 443.
  const loopback = redirect.hostname === "localhost" || redirect.hostname === "127.0.0.1";
  return loopback
    ? redirect.protocol === "http:"
    : redirect.protocol === "https:" && redirect.port === "";
};

/**
 * Validates a daemon-supplied `authorizationUrl` or `verificationUrl` against the hardcoded
 * per-agent allowlist. Returns the normalized URL and hostname to display in the confirmation modal.
 */
export const validateAgentAuthUrl = (agent: string, rawUrl: string): ValidatedAuthUrl => {
  if (!Object.hasOwn(AGENT_AUTH_TARGETS, agent)) return UNTRUSTED;
  const targets = AGENT_AUTH_TARGETS[agent] ?? [];

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return UNTRUSTED;
  }

  if (parsed.protocol !== "https:") return UNTRUSTED;
  if (parsed.username !== "" || parsed.password !== "") return UNTRUSTED;
  // Standard HTTPS port 443 only (`URL` normalizes `:443` to `""`).
  if (parsed.port !== "") return UNTRUSTED;

  const host = parsed.hostname.toLowerCase();
  const target = targets.find((t) => t.host === host);
  if (target === undefined) return UNTRUSTED;
  // The exact path (a trailing slash allowed): `URL` has already resolved `..` and percent-decoding of dots.
  const path = parsed.pathname.replace(/\/$/, "");
  if (!target.paths.includes(path)) return UNTRUSTED;
  const redirects = parsed.searchParams.getAll("redirect_uri");
  if (redirects.some((r) => !redirectAllowed(agent, r))) return UNTRUSTED;

  return { ok: true, url: parsed.toString(), host };
};

/**
 * Selects the best sign-in mode for a location's transport (`local` vs `remote`) from the
 * daemon's ordered `signInModes` capability list:
 * - `local`: accepts any mode (preferring daemon order, e.g. Codex `browser` first).
 * - `remote`: excludes modes requiring a local loopback callback (`requiresLocalLoopback: true`).
 */
export const selectAgentSignInMode = (
  locationKind: "local" | "remote",
  signInModes: readonly AgentSignInMode[],
): AgentAuthMode | undefined => {
  const compatible =
    locationKind === "local"
      ? signInModes
      : signInModes.filter((entry) => !entry.requiresLocalLoopback);
  return compatible[0]?.mode;
};
