import { expect, test } from "bun:test";
import { AgentAuthFailureReasonSchema } from "@cycle/protocol";
import { authProblemReasonOf } from "../src/main/agent-auth-flows.ts";
import { selectAgentSignInMode, validateAgentAuthUrl } from "../src/main/agent-auth-guard.ts";

test("hardcoded per-agent auth domain allowlist permits exact official HTTPS hosts and blocks phishing / scheme / port / credential tricks", () => {
  // Permitted exact official HTTPS hosts
  expect(validateAgentAuthUrl("claude", "https://claude.ai/oauth/authorize?state=1")).toEqual({
    ok: true,
    url: "https://claude.ai/oauth/authorize?state=1",
    host: "claude.ai",
  });
  expect(
    validateAgentAuthUrl(
      "claude",
      "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback",
    ),
  ).toMatchObject({ ok: true, host: "claude.com" });
  expect(
    validateAgentAuthUrl("claude", "https://platform.claude.com/oauth/authorize"),
  ).toMatchObject({
    ok: true,
    host: "platform.claude.com",
  });
  expect(
    validateAgentAuthUrl(
      "codex",
      "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
    ),
  ).toMatchObject({ ok: true, host: "auth.openai.com" });
  expect(validateAgentAuthUrl("codex", "https://auth.openai.com/codex/device")).toMatchObject({
    ok: true,
    host: "auth.openai.com",
  });
  expect(
    validateAgentAuthUrl(
      "agy",
      "https://accounts.google.com/o/oauth2/auth?redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback",
    ),
  ).toMatchObject({ ok: true, host: "accounts.google.com" });
  expect(validateAgentAuthUrl("codex", "https://auth.openai.com/oauth/authorize")).toMatchObject({
    ok: true,
    host: "auth.openai.com",
  });
  expect(validateAgentAuthUrl("agy", "https://accounts.google.com/o/oauth2/v2/auth")).toMatchObject(
    {
      ok: true,
      host: "accounts.google.com",
    },
  );

  // Blocked schemes, subdomains, spoofing, ports, credentials, cross-agent hosts, unknown agents
  const blocked: [string, string][] = [
    ["claude", "http://claude.ai/oauth/authorize"],
    ["claude", "javascript:alert(1)"],
    ["claude", "file:///etc/passwd"],
    ["claude", "https://evil.claude.ai/oauth"],
    ["claude", "https://claude.ai.evil.com/oauth"],
    ["claude", "https://claude.ai@evil.com/oauth"],
    ["claude", "https://user:pass@claude.ai/oauth"],
    ["claude", "https://claude.ai:8443/oauth"],
    ["codex", "https://accounts.google.com/o/oauth2/v2/auth"],
    ["agy", "https://auth.openai.com/oauth/authorize"],
    ["unknown", "https://claude.ai/oauth"],
    ["hasOwnProperty", "https://claude.ai/oauth"],
    ["toString", "https://claude.ai/oauth"],
    ["claude", "not a url"],
    // The right host, but not the page the CLI opens: another app's consent, an open redirect, a login form.
    ["claude", "https://claude.com/login"],
    ["claude", "https://claude.ai/oauth/authorize/../../redirect?to=evil"],
    ["codex", "https://auth.openai.com/log-in"],
    ["agy", "https://accounts.google.com/ServiceLogin?continue=https://evil.example"],
    // The right page, sending the code to someone else's callback.
    [
      "agy",
      "https://accounts.google.com/o/oauth2/auth?redirect_uri=https%3A%2F%2Fevil.example%2Fcb",
    ],
    [
      "claude",
      "https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Fplatform.claude.com%2Fcb",
    ],
    [
      "codex",
      "https://auth.openai.com/oauth/authorize?redirect_uri=https%3A%2F%2Fevil.example%2Fcb",
    ],
    [
      "codex",
      "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455&redirect_uri=https%3A%2F%2Fevil.example",
    ],
  ];
  for (const [agent, url] of blocked) {
    expect(validateAgentAuthUrl(agent, url)).toEqual({ ok: false, reason: "untrusted_url" });
  }
});

test("selectAgentSignInMode filters out requiresLocalLoopback modes on remote locations", () => {
  const codexModes = [
    { mode: "browser" as const, requiresLocalLoopback: true },
    { mode: "device_code" as const, requiresLocalLoopback: false },
  ];
  expect(selectAgentSignInMode("local", codexModes)).toBe("browser");
  expect(selectAgentSignInMode("remote", codexModes)).toBe("device_code");

  const loopbackOnly = [{ mode: "browser" as const, requiresLocalLoopback: true }];
  expect(selectAgentSignInMode("local", loopbackOnly)).toBe("browser");
  expect(selectAgentSignInMode("remote", loopbackOnly)).toBeUndefined();

  const codeOnly = [{ mode: "code" as const, requiresLocalLoopback: false }];
  expect(selectAgentSignInMode("local", codeOnly)).toBe("code");
  expect(selectAgentSignInMode("remote", codeOnly)).toBe("code");
});

test("the bridge preserves known auth errors and drops arbitrary daemon values", () => {
  for (const reason of [...AgentAuthFailureReasonSchema.options, "flow_not_active"] as const) {
    expect(authProblemReasonOf({ data: { reason } })).toBe(reason);
  }
  for (const reason of ["private text", "__proto__", "constructor", 3, null]) {
    expect(authProblemReasonOf({ data: { reason } })).toBe("failed");
  }
});
