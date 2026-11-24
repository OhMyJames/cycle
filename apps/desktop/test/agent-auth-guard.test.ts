import { expect, test } from "bun:test";
import { selectAgentSignInMode, validateAgentAuthUrl } from "../src/main/agent-auth-guard.ts";

test("hardcoded per-agent auth domain allowlist permits exact official HTTPS hosts and blocks phishing / scheme / port / credential tricks", () => {
  // Permitted exact official HTTPS hosts
  expect(validateAgentAuthUrl("claude", "https://claude.ai/oauth/authorize?state=1")).toEqual({
    ok: true,
    url: "https://claude.ai/oauth/authorize?state=1",
    host: "claude.ai",
  });
  expect(validateAgentAuthUrl("claude", "https://claude.com/login")).toMatchObject({
    ok: true,
    host: "claude.com",
  });
  expect(validateAgentAuthUrl("claude", "https://platform.claude.com/oauth")).toMatchObject({
    ok: true,
    host: "platform.claude.com",
  });
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
  ];
  for (const [agent, url] of blocked) {
    expect(validateAgentAuthUrl(agent, url)).toEqual({ ok: false, reason: "untrusted_url" });
  }
});

test("selectAgentSignInMode filters out requiresLocalLoopback modes on remote environments", () => {
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
