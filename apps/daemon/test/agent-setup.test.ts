import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AgentApp, methods } from "@agentclientprotocol/sdk/experimental/v2";
import { codexAppServerArgs } from "@cycle/harness-codex";
import { AgentSetupSnapshotSchema, agentSetupRead, META } from "@cycle/protocol";
import {
  AGY_AUTH_URL_RE,
  type AgentSetupRunCommand,
  CLAUDE_AUTH_URL_RE,
  captureConfigMtime,
  createAgySetupProvider,
  createClaudeSetupProvider,
  createCodexSetupProvider,
  extractAuthUrl,
  loginCommandFor,
  probeBinaryVersion,
  readConfigFileStatus,
  runAgyAcpLogout,
  runCodexAppServerLogout,
  runCodexAppServerProbe,
  runIsolatedCommand,
  startCliCodeAuth,
  startCodexAppServerAuth,
  VERSION_FAILURE_TTL_MS,
} from "../src/agent-setup.ts";
import { ConfigSchema } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";
import { connectClient } from "./client.ts";
import { fakeAgent } from "./fake-agent.ts";
import { daemonHarness } from "./support.ts";

let dir: string;
const open = daemonHarness<Daemon>((made) => {
  dir = made;
});

const makeExecutableStub = (name: string, body = "#!/bin/sh\nexit 0\n"): string => {
  const path = join(dir, name);
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
  return path;
};

test("Claude setup provider parses auth status JSON, detects viaEnv without leaking values, and classifies failures", async () => {
  const bin = makeExecutableStub("claude-bin");
  const secretValue = "sk-ant-super-secret-value-never-leak";
  const config = ConfigSchema.parse({
    claude: {
      allowEnv: ["HTTPS_PROXY", "PATH"],
      env: { ANTHROPIC_API_KEY: secretValue, EXTRA_VAR: "other-secret" },
      warmStart: false,
      maxWarm: 5,
      progressSummaries: false,
    },
  }).claude;

  let nextStatus = {
    exitCode: 0 as number | null,
    stdout: JSON.stringify({
      loggedIn: true,
      authMethod: "claudeai",
      apiProvider: "firstParty",
      email: "dev@example.com",
      organization: "Cycle Org",
      subscriptionType: "max",
      loginExpiresAt: "2026-12-01T00:00:00.000Z",
    }),
    stderr: "",
    timedOut: false,
  };

  const seenEnvs: Record<string, string>[] = [];
  const runCommand: AgentSetupRunCommand = async (cmd, opts) => {
    seenEnvs.push(opts.env);
    if (cmd[1] === "--version") {
      return { exitCode: 0, stdout: "2.1.327 (Claude Code)\n", stderr: "", timedOut: false };
    }
    return nextStatus;
  };

  const provider = createClaudeSetupProvider({
    config,
    dataDir: dir,
    inherited: { PATH: "/usr/bin:/bin", HTTPS_PROXY: "http://proxy.local", UNRELATED: "nope" },
    env: () => ({
      CLAUDE_CONFIG_DIR: join(dir, "claude"),
      HOME: join(dir, "claude"),
      ANTHROPIC_API_KEY: secretValue,
    }),
    locateBinary: () => ({ source: "builtin", path: bin }),
    runCommand,
  });

  const binary = await provider.probeBinary();
  expect(binary).toEqual({ source: "builtin", path: bin, version: "2.1.327" });

  const signedIn = await provider.readAuth();
  expect(signedIn).toEqual({
    state: "signed_in",
    method: "subscription",
    viaEnv: "ANTHROPIC_API_KEY",
    account: {
      email: "dev@example.com",
      organization: "Cycle Org",
      plan: "max",
      expiresAt: Date.parse("2026-12-01T00:00:00.000Z"),
    },
  });
  // Isolated env: never inherits UNRELATED or host HOME.
  expect(seenEnvs[0]?.UNRELATED).toBeUndefined();
  expect(seenEnvs[0]?.HOME).toBe(join(dir, "claude"));

  const diag = provider.diagnostics();
  expect(diag).toEqual({
    dataDir: join(dir, "claude"),
    customDataDir: false,
    allowEnv: ["HTTPS_PROXY", "PATH"],
    envNames: ["ANTHROPIC_API_KEY", "EXTRA_VAR"],
  });
  expect(JSON.stringify({ signedIn, diag, runtime: provider.runtimeSnapshot() })).not.toContain(
    secretValue,
  );
  expect(JSON.stringify({ signedIn, diag })).not.toContain("other-secret");

  nextStatus = {
    exitCode: 0,
    stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }),
    stderr: "",
    timedOut: false,
  };
  expect(await provider.readAuth({ forceRefresh: true })).toEqual({
    state: "signed_out",
    method: "none",
    viaEnv: "ANTHROPIC_API_KEY",
  });

  nextStatus = { exitCode: null, stdout: "", stderr: "", timedOut: true };
  expect(await provider.readAuth({ forceRefresh: true })).toEqual({
    state: "auth_unknown",
    unknownReason: "timeout",
    method: "unknown",
    viaEnv: "ANTHROPIC_API_KEY",
  });

  nextStatus = { exitCode: 1, stdout: "not json", stderr: "crash", timedOut: false };
  expect(await provider.readAuth({ forceRefresh: true })).toEqual({
    state: "auth_unknown",
    unknownReason: "probe_failed",
    method: "unknown",
    viaEnv: "ANTHROPIC_API_KEY",
  });
});

test("Codex setup provider queries account/read and account/rateLimits/read through app-server", async () => {
  // Real mock executable speaking newline-delimited JSON-RPC over stdio like `codex app-server`.
  const mockCodex = makeExecutableStub(
    "mock-codex",
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex-cli 0.171.0");
  process.exit(0);
}
const decoder = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  let idx;
  while ((idx = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { serverInfo: { name: "codex" } } }));
    } else if (msg.method === "account/read") {
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          account: {
            type: "chatgpt",
            email: "codex@example.com",
            planType: "pro",
            workspaceName: "Personal",
          },
        },
      }));
    } else if (msg.method === "account/rateLimits/read") {
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1795500000 },
            secondary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: 1796000000 },
          },
        },
      }));
    }
  }
}
`,
  );

  const codexHome = join(dir, "codex");
  const probed = await runCodexAppServerProbe({
    executable: mockCodex,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", CODEX_HOME: codexHome, HOME: codexHome },
    refreshUsage: true,
    timeoutMs: 5000,
  });
  expect(probed.error).toBeUndefined();
  expect(probed.account).toEqual({
    type: "chatgpt",
    email: "codex@example.com",
    planType: "pro",
    workspaceName: "Personal",
  });

  const provider = createCodexSetupProvider({
    config: ConfigSchema.parse({}).codex,
    dataDir: dir,
    inherited: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    env: () => ({ CODEX_HOME: codexHome, HOME: codexHome }),
    locateBinary: () => ({ source: "builtin", path: mockCodex }),
    now: () => 1_795_480_000_000,
  });

  const binary = await provider.probeBinary();
  expect(binary).toEqual({ source: "builtin", path: mockCodex, version: "0.171.0" });

  const auth = await provider.readAuth({ refreshUsage: true });
  expect(auth.state).toBe("signed_in");
  expect(auth.method).toBe("subscription");
  expect(auth.account).toEqual({
    email: "codex@example.com",
    plan: "pro",
    organization: "Personal",
  });
  expect(auth.planUsage).toEqual({
    windows: [
      { kind: "five_hour", utilization: 0.42, resetsAt: 1_795_500_000_000, status: "allowed" },
      { kind: "seven_day", utilization: 0.18, resetsAt: 1_796_000_000_000, status: "allowed" },
    ],
    at: 1_795_480_000_000,
  });
});

test("Agy setup provider enforces minVersion, classifies auth states, and caches with forceRefresh bypass", async () => {
  const bin = makeExecutableStub("agy-bin");
  let nowMs = 1_000_000;
  let modelsCalls = 0;
  let modelsOutcome = {
    exitCode: 0 as number | null,
    stdout: "gemini-3\n",
    stderr: "",
    timedOut: false,
  };

  const runCommand: AgentSetupRunCommand = async (cmd) => {
    if (cmd[1] === "--version") {
      return { exitCode: 0, stdout: "1.5.15\n", stderr: "", timedOut: false };
    }
    modelsCalls += 1;
    return modelsOutcome;
  };

  const provider = createAgySetupProvider({
    config: ConfigSchema.parse({ agy: { sandbox: true, telemetry: false } }).agy,
    dataDir: dir,
    inherited: { PATH: "/usr/bin:/bin" },
    env: () => ({ HOME: join(dir, "agy") }),
    locateBinary: () => ({ source: "path", path: bin }),
    runCommand,
    cacheTtlMs: 45_000,
    now: () => nowMs,
  });

  expect(await provider.probeBinary()).toEqual({
    source: "path",
    path: bin,
    version: "1.5.15",
    minVersion: "1.5.10",
  });

  // Signed in & cached for 45s.
  expect(await provider.readAuth()).toEqual({ state: "signed_in", method: "subscription" });
  expect(modelsCalls).toBe(1);
  nowMs += 10_000;
  expect(await provider.readAuth()).toEqual({ state: "signed_in", method: "subscription" });
  expect(modelsCalls).toBe(1);

  // forceRefresh bypasses cache.
  modelsOutcome = {
    exitCode: 1,
    stdout: "",
    stderr: "Error: Please sign in to view available models.\n",
    timedOut: false,
  };
  expect(await provider.readAuth({ forceRefresh: true })).toEqual({
    state: "signed_out",
    method: "none",
  });
  expect(modelsCalls).toBe(2);

  // After TTL expires, network error becomes auth_unknown (not cached).
  nowMs += 50_000;
  modelsOutcome = { exitCode: 1, stdout: "", stderr: "ECONNREFUSED upstream", timedOut: false };
  expect(await provider.readAuth()).toEqual({
    state: "auth_unknown",
    unknownReason: "network_error",
    method: "unknown",
  });
  expect(modelsCalls).toBe(3);

  // Generic failure becomes probe_failed; timeout becomes timeout.
  modelsOutcome = { exitCode: 2, stdout: "", stderr: "unexpected crash", timedOut: false };
  expect(await provider.readAuth()).toEqual({
    state: "auth_unknown",
    unknownReason: "probe_failed",
    method: "unknown",
  });
  modelsOutcome = { exitCode: null, stdout: "", stderr: "", timedOut: true };
  expect(await provider.readAuth()).toEqual({
    state: "auth_unknown",
    unknownReason: "timeout",
    method: "unknown",
  });

  // Version below AGY_MIN_VERSION reports binary_unavailable.
  const oldBin = makeExecutableStub("agy-old-bin");
  const oldProvider = createAgySetupProvider({
    config: ConfigSchema.parse({}).agy,
    dataDir: dir,
    inherited: { PATH: "/usr/bin:/bin" },
    env: () => ({ HOME: join(dir, "agy") }),
    locateBinary: () => ({ source: "configured", path: oldBin }),
    runCommand: async () => ({ exitCode: 0, stdout: "1.5.8\n", stderr: "", timedOut: false }),
  });
  expect(await oldProvider.probeBinary()).toEqual({
    source: "configured",
    path: oldBin,
    version: "1.5.8",
    minVersion: "1.5.10",
    problem: "version_too_old",
  });
  expect(await oldProvider.readAuth()).toEqual({
    state: "binary_unavailable",
    method: "none",
  });
});

test("readConfigFileStatus tracks startup mtime staleness and current parse errors", () => {
  const configPath = join(dir, "config.json");
  expect(readConfigFileStatus({ path: configPath })).toEqual({
    path: configPath,
    exists: false,
    stale: false,
  });

  writeFileSync(configPath, JSON.stringify({ claude: { warmStart: true } }), "utf8");
  const loadedMtimeMs = captureConfigMtime(configPath);
  expect(readConfigFileStatus({ path: configPath, loadedMtimeMs })).toEqual({
    path: configPath,
    exists: true,
    stale: false,
  });

  // Modify config.json with broken JSON and an earlier/later mtime.
  writeFileSync(configPath, "{ broken json", "utf8");
  const status = readConfigFileStatus({
    path: configPath,
    loadedMtimeMs: (loadedMtimeMs ?? 0) - 5000,
  });
  expect(status.exists).toBe(true);
  expect(status.stale).toBe(true);
  expect(status.error).toBeDefined();
});

test("Daemon advertises agentSetup capability, serves _cycle/agent_setup/read, merges observed tier and Codex usage, and rejects unknown agents", async () => {
  const agyBin = makeExecutableStub("agy-live-bin");
  const nowMs = 1_795_480_123_000;
  const agyApp = new AgentApp({ name: "agy-fake" })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: 2,
      info: { name: "agy-fake", version: "1.5.15" },
      capabilities: { session: {} },
    }))
    .onRequest(
      methods.agent.session.new,
      () =>
        ({
          sessionId: "agy-s1",
          configOptions: [],
          _meta: { antigravity: { tier: "pro" } },
        }) as never,
    );

  const codexBin = makeExecutableStub("codex-live-bin");
  const codexProvider = createCodexSetupProvider({
    config: ConfigSchema.parse({}).codex,
    dataDir: dir,
    inherited: { PATH: "/usr/bin:/bin" },
    env: () => ({ CODEX_HOME: join(dir, "codex"), HOME: join(dir, "codex") }),
    locateBinary: () => ({ source: "builtin", path: codexBin }),
    runCommand: async () => ({ exitCode: 0, stdout: "0.171.0\n", stderr: "", timedOut: false }),
    probeAppServer: async ({ refreshUsage }) => ({
      account: { type: "chatgpt", email: "user@example.com", planType: "plus" },
      ...(refreshUsage
        ? {
            rateLimits: {
              limitId: "codex",
              limitName: null,
              primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1795500000 },
              secondary: null,
              credits: null,
              planType: "plus",
              normalModelSlug: null,
              individualLimit: null,
              spendControlReached: null,
              rateLimitReachedType: null,
            },
          }
        : {}),
    }),
    now: () => nowMs,
  });

  const agyProvider = createAgySetupProvider({
    config: ConfigSchema.parse({}).agy,
    dataDir: dir,
    inherited: { PATH: "/usr/bin:/bin" },
    env: () => ({ HOME: join(dir, "agy") }),
    locateBinary: () => ({ source: "path", path: agyBin }),
    runCommand: async (cmd) =>
      cmd[1] === "--version"
        ? { exitCode: 0, stdout: "1.5.15\n", stderr: "", timedOut: false }
        : { exitCode: 0, stdout: "gemini-3\n", stderr: "", timedOut: false },
    now: () => nowMs,
  });

  const daemon = await Daemon.start({
    dataDir: dir,
    now: () => nowMs,
    agents: [
      {
        id: "agy",
        name: "Antigravity",
        configSchema: { type: "object", properties: {} },
        setup: agyProvider,
        launch: async () => ({ target: agyApp }),
      },
      {
        ...fakeAgent().definition,
        id: "codex",
        name: "Codex",
        setup: codexProvider,
      },
    ],
  });
  open.push(daemon);

  const c = await connectClient(daemon);

  // Capability advertised.
  const caps = (c.init._meta as Record<string, unknown>)[META.capabilities] as Record<
    string,
    unknown
  >;
  expect(caps.agentSetup).toBe(true);

  // Create an agy session so daemon observes `_meta.antigravity.tier`.
  await c.agent.request(methods.agent.session.new, {
    cwd: dir,
    _meta: { [META.agent]: "agy" },
  });

  const agySnapshot = AgentSetupSnapshotSchema.parse(
    await c.agent.request(agentSetupRead.name, { agent: "agy" }),
  );
  expect(agySnapshot.auth.state).toBe("signed_in");
  expect(agySnapshot.auth.account).toEqual({
    plan: "pro",
    tierObservedAt: nowMs,
  });

  // Codex refreshUsage updates planUsage and broadcasts PLAN_USAGE_CHANGED.
  const codexSnapshot = AgentSetupSnapshotSchema.parse(
    await c.agent.request(agentSetupRead.name, { agent: "codex", refreshUsage: true }),
  );
  expect(codexSnapshot.canRefreshUsage).toBe(true);
  expect(codexSnapshot.planUsage?.windows).toHaveLength(1);
  expect(codexSnapshot.planUsage?.windows[0]?.utilization).toBe(0.25);
  expect(c.planUsage).toHaveLength(1);

  // Unknown agent rejected with -32602 and fixed data.reason: "unknown_agent".
  try {
    await c.agent.request(agentSetupRead.name, { agent: "nonexistent" });
    throw new Error("Expected unknown_agent error");
  } catch (error) {
    const rpc = error as { code?: number; data?: { reason?: string } };
    expect(rpc.code).toBe(-32602);
    expect(rpc.data?.reason).toBe("unknown_agent");
  }
});

test("Codex auth driver drives browser login, device_code login/cancel, and logout over app-server stdio without leaking secrets", async () => {
  const logFile = join(dir, "codex-rpc.log");
  const fakeCodex = join(dir, "fake-codex");
  const script = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const logPath = ${JSON.stringify(logFile)};
appendFileSync(logPath, "argv " + process.argv.slice(2).join(" ") + "\\n");
const decoder = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  for (let nl = buf.indexOf("\\n"); nl !== -1; nl = buf.indexOf("\\n")) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    appendFileSync(logPath, msg.method + "\\n");
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { serverInfo: { name: "fake-codex" } } }) + "\\n");
    } else if (msg.method === "account/login/start") {
      if (msg.params?.type === "chatgpt") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { type: "chatgpt", loginId: "login-browser-1", authUrl: "https://auth.openai.com/oauth/authorize?state=1" } }) + "\\n");
        setTimeout(() => {
          process.stdout.write(JSON.stringify({ method: "account/login/completed", params: { loginId: "login-browser-1", success: true, error: null } }) + "\\n");
        }, 30);
      } else if (msg.params?.type === "chatgptDeviceCode") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { type: "chatgptDeviceCode", loginId: "login-dev-2", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" } }) + "\\n");
      }
    } else if (msg.method === "account/login/cancel") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { status: "canceled" } }) + "\\n");
      process.stdout.write(JSON.stringify({ method: "account/login/completed", params: { loginId: msg.params?.loginId, success: false, error: "canceled" } }) + "\\n");
    } else if (msg.method === "account/logout") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
    }
  }
}
`;
  writeFileSync(fakeCodex, script, { mode: 0o755 });
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", CODEX_HOME: join(dir, "codex-home") };

  // 1. Browser mode (chatgpt)
  const browserHandle = await startCodexAppServerAuth({
    executable: fakeCodex,
    env,
    mode: "browser",
  });
  expect(browserHandle.authorizationUrl).toBe("https://auth.openai.com/oauth/authorize?state=1");
  expect(await browserHandle.completed).toEqual({ ok: true });

  // 2. Device code mode (chatgptDeviceCode) + cancel
  const deviceHandle = await startCodexAppServerAuth({
    executable: fakeCodex,
    env,
    mode: "device_code",
  });
  expect(deviceHandle.verificationUrl).toBe("https://auth.openai.com/codex/device");
  expect(deviceHandle.userCode).toBe("ABCD-1234");
  await deviceHandle.cancel();
  expect(await deviceHandle.completed).toEqual({ ok: false, reason: "cancelled" });

  // 3. Logout
  await runCodexAppServerLogout({ executable: fakeCodex, env });

  // Every app-server Cycle starts gets the session's own arguments (codexAppServerArgs).
  const argvLines = readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("argv "));
  expect(argvLines).toHaveLength(3);
  for (const line of argvLines) {
    expect(line).toBe(`argv ${codexAppServerArgs().join(" ")}`);
  }
  expect(codexAppServerArgs()).toContain("check_for_update_on_startup=false");

  // 4. Provider advertises both modes (browser loopback + device_code remote) and canSignOut.
  const provider = createCodexSetupProvider({
    config: ConfigSchema.parse({}).codex,
    dataDir: dir,
    inherited: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    env: () => ({ CODEX_HOME: join(dir, "codex-home") }),
    locateBinary: () => ({ source: "path", path: fakeCodex }),
  });
  expect(provider.signInModes()).toEqual([
    { mode: "browser", requiresLocalLoopback: true },
    { mode: "device_code", requiresLocalLoopback: false },
  ]);
  expect(provider.canSignOut()).toBe(true);
});

test("Claude code auth driver extracts ANSI-wrapped URL, submits one-time code via stdin, classifies invalid_code/parse_failed, and cleans up on cancel/logout", async () => {
  expect(
    extractAuthUrl(
      `\x1b[32mVisit: https://claude.com/cai/oauth/authorize?code=true&state=abc\x1b[0m\nPaste code > `,
      CLAUDE_AUTH_URL_RE,
    ),
  ).toBe("https://claude.com/cai/oauth/authorize?code=true&state=abc");
  // As CLI 2.1.331 prints it: on claude.ai, its query one opaque token.
  expect(
    extractAuthUrl(
      "Opening browser to sign in…\nIf the browser didn't open, visit:\nhttps://claude.ai/oauth/authorize?z-C99cQ9yANBwHEfuh4CUA5V7TSH3\nPaste code here if prompted > ",
      CLAUDE_AUTH_URL_RE,
    ),
  ).toBe("https://claude.ai/oauth/authorize?z-C99cQ9yANBwHEfuh4CUA5V7TSH3");

  const fakeClaude = join(dir, "fake-claude");
  const script = `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "logout") {
  process.stdout.write("Successfully logged out\\n");
  process.exit(0);
}
if (process.env.FAKE_MODE === "no_url") {
  process.stdout.write("Something unexpected\\n");
  process.exit(1);
}
if (process.env.FAKE_MODE === "silent") {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
process.stdout.write("Opening browser to sign in...\\n");
process.stdout.write("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=xyz\\n");
process.stdout.write("Paste code here if prompted > ");
const decoder = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  if (buf.includes("\\n")) {
    const code = buf.trim();
    if (code === "VALID-CODE-123") {
      process.stdout.write("Login successful\\n");
      process.exit(0);
    }
    process.stderr.write("Error: invalid_grant (expired code)\\n");
    process.exit(1);
  }
}
`;
  writeFileSync(fakeClaude, script, { mode: 0o755 });

  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", CLAUDE_CONFIG_DIR: join(dir, "claude") };

  // 1. Valid code succeeds.
  const okFlow = await startCliCodeAuth({
    command: [fakeClaude, "auth", "login", "--claudeai"],
    env,
    urlPattern: CLAUDE_AUTH_URL_RE,
  });
  expect(okFlow.authorizationUrl).toBe(
    "https://claude.com/cai/oauth/authorize?code=true&state=xyz",
  );
  expect(await okFlow.submit?.("VALID-CODE-123")).toEqual({ ok: true });
  expect(await okFlow.completed).toEqual({ ok: true });

  // 2. Invalid code returns invalid_code.
  const badFlow = await startCliCodeAuth({
    command: [fakeClaude, "auth", "login", "--claudeai"],
    env,
    urlPattern: CLAUDE_AUTH_URL_RE,
  });
  expect(await badFlow.submit?.("WRONG-CODE")).toEqual({ ok: false, reason: "invalid_code" });

  // 3. Cancel terminates process cleanly.
  const cancelFlow = await startCliCodeAuth({
    command: [fakeClaude, "auth", "login", "--claudeai"],
    env,
    urlPattern: CLAUDE_AUTH_URL_RE,
  });
  await cancelFlow.cancel();
  expect(await cancelFlow.completed).toEqual({ ok: false, reason: "cancelled" });

  // 4. Missing URL returns parse_failed.
  await expect(
    startCliCodeAuth({
      command: [fakeClaude, "auth", "login", "--claudeai"],
      env: { ...env, FAKE_MODE: "no_url" },
      urlPattern: CLAUDE_AUTH_URL_RE,
    }),
  ).rejects.toMatchObject({ reason: "parse_failed" });

  // 4b. Aborted while still waiting for its URL (a disconnect, the daemon closing): the child dies at once, not when
  // the URL wait would have ended.
  const abort = new AbortController();
  const startedAt = Date.now();
  const silent = startCliCodeAuth({
    command: [fakeClaude, "auth", "login", "--claudeai"],
    env: { ...env, FAKE_MODE: "silent" },
    urlPattern: CLAUDE_AUTH_URL_RE,
    startTimeoutMs: 10_000,
    signal: abort.signal,
  });
  await Bun.sleep(300);
  abort.abort();
  await expect(silent).rejects.toMatchObject({ reason: "cancelled" });
  expect(Date.now() - startedAt).toBeLessThan(3_000);

  // 5. Provider advertises code mode + canSignOut and runs logout cleanly.
  const provider = createClaudeSetupProvider({
    config: ConfigSchema.parse({}).claude,
    dataDir: dir,
    inherited: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    env: () => ({ CLAUDE_CONFIG_DIR: join(dir, "claude") }),
    locateBinary: () => ({ source: "path", path: fakeClaude }),
  });
  expect(provider.signInModes()).toEqual([{ mode: "code", requiresLocalLoopback: false }]);
  expect(provider.canSignOut()).toBe(true);
  await provider.authDriver?.logout?.();
});

test("Agy auth driver runs agy acp --login (accounts.google.com) and native agy acp logout RPC, invalidating 45s cache", async () => {
  const fakeAgy = join(dir, "fake-agy");
  const script = `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("1.5.15\\n");
  process.exit(0);
}
if (args[0] === "acp" && args[1] === "--login") {
  process.stdout.write("Open this link in a browser to log in with Google:\\n\\n  https://accounts.google.com/o/oauth2/auth?response_type=code&state=agy123\\n\\nThen paste the authorization code:\\n");
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += dec.decode(chunk, { stream: true });
    if (buf.includes("\\n")) {
      process.exit(buf.trim() === "AGY-CODE-OK" ? 0 : 1);
    }
  }
}
if (args[0] === "acp") {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += dec.decode(chunk, { stream: true });
    for (let nl = buf.indexOf("\\n"); nl !== -1; nl = buf.indexOf("\\n")) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.method === "initialize") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }) + "\\n");
      } else if (msg.method === "logout") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
      }
    }
  }
}
`;
  writeFileSync(fakeAgy, script, { mode: 0o755 });
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(dir, "agy-home") };

  // 1. Login flow extracts accounts.google.com URL and delivers code via stdin.
  const flow = await startCliCodeAuth({
    command: [fakeAgy, "acp", "--login"],
    env,
    urlPattern: AGY_AUTH_URL_RE,
  });
  expect(flow.authorizationUrl).toBe(
    "https://accounts.google.com/o/oauth2/auth?response_type=code&state=agy123",
  );
  expect(await flow.submit?.("AGY-CODE-OK")).toEqual({ ok: true });
  expect(await flow.completed).toEqual({ ok: true });

  // 2. Native agy acp logout RPC succeeds cleanly.
  await runAgyAcpLogout({ executable: fakeAgy, env });

  // 3. Provider advertises code mode, canSignOut, and invalidates 45s cache on logout/invalidateCache.
  let modelsProbes = 0;
  const provider = createAgySetupProvider({
    config: ConfigSchema.parse({}).agy,
    dataDir: dir,
    inherited: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    env: () => ({ HOME: join(dir, "agy-home") }),
    locateBinary: () => ({ source: "path", path: fakeAgy }),
    runCommand: async (cmd) => {
      if (cmd[1] === "--version") {
        return { exitCode: 0, stdout: "1.5.15\n", stderr: "", timedOut: false };
      }
      modelsProbes++;
      return { exitCode: 0, stdout: "gemini-3\n", stderr: "", timedOut: false };
    },
  });
  expect(provider.signInModes()).toEqual([{ mode: "code", requiresLocalLoopback: false }]);
  expect(provider.canSignOut()).toBe(true);
  await provider.readAuth();
  await provider.readAuth();
  expect(modelsProbes).toBe(1);
  await provider.authDriver?.logout?.();
  await provider.readAuth();
  expect(modelsProbes).toBe(2);

  // Malformed JSON error must be sanitized so secret values near a syntax error never leak over L1.
  const secretPath = join(dir, "secret-broken.json");
  writeFileSync(
    secretPath,
    '{ "claude": { "env": { "ANTHROPIC_API_KEY": sk-ant-TOPSECRET-999 } } }',
  );
  const broken = readConfigFileStatus({ path: secretPath });
  expect(broken.error).toBe("Invalid JSON syntax in config.json");
  expect(broken.error).not.toContain("TOPSECRET");
});

test("runIsolatedCommand returns promptly when a grandchild keeps the output pipes open, and kills its process group", async () => {
  const pidFile = join(dir, "grandchild.pid");
  // Exits at once, leaving a background child (like agy's language server) holding stdout and stderr.
  const leaves = makeExecutableStub(
    "leaves-grandchild",
    `#!/bin/sh\nsleep 30 &\necho $! > ${JSON.stringify(pidFile)}\necho "1.2.3"\nexit 0\n`,
  );
  const started = Date.now();
  const result = await runIsolatedCommand([leaves], {
    env: { PATH: "/usr/bin:/bin" },
    timeoutMs: 5_000,
  });
  expect(Date.now() - started).toBeLessThan(3_000);
  expect(result).toMatchObject({ exitCode: 0, timedOut: false });
  expect(result.stdout).toContain("1.2.3");
  const grandchild = Number(readFileSync(pidFile, "utf8").trim());
  await Bun.sleep(50);
  expect(() => process.kill(grandchild, 0)).toThrow();

  // The command itself hangs too: the timeout bounds the whole call.
  const hangs = makeExecutableStub("hangs", "#!/bin/sh\nsleep 30 &\nsleep 30\n");
  const hungStart = Date.now();
  const hung = await runIsolatedCommand([hangs], {
    env: { PATH: "/usr/bin:/bin" },
    timeoutMs: 300,
  });
  expect(hung.timedOut).toBe(true);
  expect(Date.now() - hungStart).toBeLessThan(3_000);
}, 10_000);

test("probeBinaryVersion shares one probe, caches good answers, retries failures after a short TTL or on forceRefresh", async () => {
  const bin = makeExecutableStub("versioned-bin");
  let calls = 0;
  let answer = { exitCode: 1 as number | null, stdout: "", stderr: "boom", timedOut: false };
  const run: AgentSetupRunCommand = async () => {
    calls += 1;
    await Bun.sleep(5);
    return answer;
  };
  let nowMs = 1_000;
  const now = () => nowMs;

  // Concurrent callers share the single in-flight probe.
  const [a, b] = await Promise.all([
    probeBinaryVersion(bin, {}, { run, now }),
    probeBinaryVersion(bin, {}, { run, now }),
  ]);
  expect([a, b, calls]).toEqual([undefined, undefined, 1]);

  // A failure is remembered only briefly...
  answer = { exitCode: 0, stdout: "tool 2.0.1\n", stderr: "", timedOut: false };
  expect(await probeBinaryVersion(bin, {}, { run, now })).toBeUndefined();
  expect(calls).toBe(1);
  // ...and forceRefresh skips it.
  expect(await probeBinaryVersion(bin, {}, { run, now, forceRefresh: true })).toBe("2.0.1");
  expect(calls).toBe(2);

  // A good answer stays cached; a failure after the TTL is probed again.
  nowMs += VERSION_FAILURE_TTL_MS * 10;
  expect(await probeBinaryVersion(bin, {}, { run, now })).toBe("2.0.1");
  expect(calls).toBe(2);

  const flaky = makeExecutableStub("flaky-bin");
  answer = { exitCode: null, stdout: "", stderr: "", timedOut: true };
  expect(await probeBinaryVersion(flaky, {}, { run, now })).toBeUndefined();
  answer = { exitCode: 0, stdout: "3.1.4\n", stderr: "", timedOut: false };
  nowMs += VERSION_FAILURE_TTL_MS;
  expect(await probeBinaryVersion(flaky, {}, { run, now })).toBe("3.1.4");
});

test("setup providers share in-flight probes, cache definitive answers briefly, and invalidate on sign-in/out", async () => {
  const bin = makeExecutableStub("claude-dedupe-bin");
  let versionCalls = 0;
  let statusCalls = 0;
  let nowMs = 5_000;
  const runCommand: AgentSetupRunCommand = async (cmd) => {
    await Bun.sleep(5);
    if (cmd[1] === "--version") {
      versionCalls += 1;
      return { exitCode: 0, stdout: "2.1.327\n", stderr: "", timedOut: false };
    }
    statusCalls += 1;
    return {
      exitCode: 0,
      stdout: JSON.stringify({ loggedIn: true, authMethod: "claudeai" }),
      stderr: "",
      timedOut: false,
    };
  };
  const provider = createClaudeSetupProvider({
    config: ConfigSchema.parse({}).claude,
    dataDir: dir,
    inherited: { PATH: "/usr/bin:/bin" },
    env: () => ({ CLAUDE_CONFIG_DIR: join(dir, "claude") }),
    locateBinary: () => ({ source: "builtin", path: bin }),
    runCommand,
    now: () => nowMs,
  });

  // What the daemon does for one read (and every client after `_cycle/agent_setup_changed`).
  await Promise.all([
    provider.probeBinary(),
    provider.readAuth(),
    provider.probeBinary(),
    provider.readAuth(),
  ]);
  expect(versionCalls).toBe(1);
  expect(statusCalls).toBe(1);

  await provider.readAuth();
  expect(statusCalls).toBe(1);
  await provider.readAuth({ forceRefresh: true });
  expect(statusCalls).toBe(2);
  provider.authDriver?.invalidateCache?.();
  await provider.readAuth();
  expect(statusCalls).toBe(3);
  nowMs += 60_000;
  await provider.readAuth();
  expect(statusCalls).toBe(4);

  // Codex: refreshUsage always probes (and gets usage); a cached answer never repeats old usage.
  let codexProbes = 0;
  const codex = createCodexSetupProvider({
    config: ConfigSchema.parse({}).codex,
    dataDir: dir,
    inherited: { PATH: "/usr/bin:/bin" },
    env: () => ({ CODEX_HOME: join(dir, "codex") }),
    locateBinary: () => ({ source: "builtin", path: bin }),
    runCommand,
    probeAppServer: async ({ refreshUsage }) => {
      codexProbes += 1;
      return {
        account: { type: "chatgpt" },
        ...(refreshUsage
          ? {
              rateLimits: {
                limitId: "codex",
                primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1795500000 },
              } as never,
            }
          : {}),
      };
    },
    now: () => nowMs,
  });
  expect((await codex.readAuth({ refreshUsage: true })).planUsage).toBeDefined();
  expect((await codex.readAuth()).planUsage).toBeUndefined();
  expect(codexProbes).toBe(1);
  await codex.readAuth({ refreshUsage: true });
  expect(codexProbes).toBe(2);
});

test("Codex with no account but no OpenAI sign-in needed is signed in through a third party; agy with an API key reports api_key", async () => {
  const bin = makeExecutableStub("codex-provider-bin");
  const runCommand: AgentSetupRunCommand = async () => ({
    exitCode: 0,
    stdout: "1.5.15\n",
    stderr: "",
    timedOut: false,
  });
  let requiresOpenaiAuth = false;
  const codex = createCodexSetupProvider({
    config: ConfigSchema.parse({}).codex,
    dataDir: dir,
    inherited: { PATH: "/usr/bin:/bin" },
    env: () => ({ CODEX_HOME: join(dir, "codex") }),
    locateBinary: () => ({ source: "builtin", path: bin }),
    runCommand,
    probeAppServer: async () => ({ account: null, requiresOpenaiAuth }),
  });
  expect(await codex.readAuth()).toEqual({ state: "signed_in", method: "third_party" });
  requiresOpenaiAuth = true;
  expect(await codex.readAuth({ forceRefresh: true })).toEqual({
    state: "signed_out",
    method: "none",
  });

  const agy = createAgySetupProvider({
    config: ConfigSchema.parse({ agy: { env: { GEMINI_API_KEY: "never-shown" } } }).agy,
    dataDir: dir,
    inherited: { PATH: "/usr/bin:/bin" },
    env: () => ({ HOME: join(dir, "agy"), GEMINI_API_KEY: "never-shown" }),
    locateBinary: () => ({ source: "path", path: bin }),
    runCommand,
  });
  const auth = await agy.readAuth();
  expect(auth).toEqual({ state: "signed_in", method: "api_key", viaEnv: "GEMINI_API_KEY" });
  expect(JSON.stringify(auth)).not.toContain("never-shown");
});

test("diagnostics report the data directory the agent's environment really uses, and the login fallback names a custom --data-dir", () => {
  const bin = makeExecutableStub("diag-bin");
  const overridden = join(dir, "elsewhere");
  const claude = createClaudeSetupProvider({
    config: ConfigSchema.parse({ claude: { env: { CLAUDE_CONFIG_DIR: overridden } } }).claude,
    dataDir: dir,
    inherited: {},
    env: () => ({ CLAUDE_CONFIG_DIR: overridden }),
    locateBinary: () => ({ source: "builtin", path: bin }),
  });
  expect(claude.diagnostics()).toMatchObject({ dataDir: overridden, customDataDir: true });
  const agy = createAgySetupProvider({
    config: ConfigSchema.parse({ agy: { env: { HOME: overridden } } }).agy,
    dataDir: dir,
    inherited: {},
    env: () => ({ HOME: overridden }),
    locateBinary: () => ({ source: "path", path: bin }),
  });
  expect(agy.diagnostics()).toMatchObject({ dataDir: overridden, customDataDir: true });
  const codex = createCodexSetupProvider({
    config: ConfigSchema.parse({}).codex,
    dataDir: dir,
    inherited: {},
    env: () => ({ CODEX_HOME: join(dir, "codex") }),
    locateBinary: () => ({ source: "builtin", path: bin }),
  });
  expect(codex.diagnostics()).toMatchObject({ dataDir: join(dir, "codex"), customDataDir: false });

  // A temporary data directory is not the default one: the fallback must point `cycle` at it.
  expect(claude.loginCommand).toBe(`cycle --data-dir ${dir} login claude`);
  expect(loginCommandFor("agy", join(homedir(), ".cycle"))).toBe("cycle login agy");
  expect(loginCommandFor("codex", "/tmp/my data/it's")).toBe(
    `cycle --data-dir '/tmp/my data/it'\\''s' login codex`,
  );
});

test("agy sign-in and sign-out honour the telemetry opt-out the sessions get", async () => {
  const bin = makeExecutableStub("agy-flags-bin");
  const commands: string[][] = [];
  const logoutArgs: (readonly string[] | undefined)[] = [];
  const make = (telemetry: boolean) =>
    createAgySetupProvider({
      config: ConfigSchema.parse({ agy: { telemetry } }).agy,
      dataDir: dir,
      inherited: { PATH: "/usr/bin:/bin" },
      env: () => ({ HOME: join(dir, "agy") }),
      locateBinary: () => ({ source: "path", path: bin }),
      runCommand: async () => ({ exitCode: 0, stdout: "1.5.15\n", stderr: "", timedOut: false }),
      startCodeAuth: async ({ command }) => {
        commands.push(command);
        return {
          authorizationUrl: "https://accounts.google.com/x",
          completed: new Promise(() => {}),
          cancel: () => {},
        };
      },
      logoutAcp: async ({ args }) => {
        logoutArgs.push(args);
      },
    });
  const off = make(false);
  await off.authDriver?.start("code");
  await off.authDriver?.logout?.();
  expect(commands[0]).toEqual([bin, "acp", "--login", "--disable-telemetry"]);
  expect(logoutArgs[0]).toEqual(["--disable-telemetry"]);

  const on = make(true);
  await on.authDriver?.start("code");
  await on.authDriver?.logout?.();
  expect(commands[1]).toEqual([bin, "acp", "--login"]);
  expect(logoutArgs[1]).toEqual([]);
});

test("CLI code sign-in refuses a code with a newline or control character, and judges a wrong code only by output after it", async () => {
  const seen = join(dir, "stdin-seen.txt");
  const fake = makeExecutableStub(
    "fake-login",
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
// Text before the code is asked for that looks like a rejection must not decide the outcome.
process.stdout.write("Tip: an invalid code or expired code means starting over\\n");
process.stdout.write("Visit https://claude.com/cai/oauth/authorize?state=1\\n");
const decoder = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  appendFileSync(${JSON.stringify(seen)}, decoder.decode(chunk));
  if (buf.includes("\\n")) {
    process.stderr.write("network unreachable\\n");
    process.exit(1);
  }
}
`,
  );
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

  const flow = await startCliCodeAuth({ command: [fake], env, urlPattern: CLAUDE_AUTH_URL_RE });
  expect(await flow.submit?.("abc\nsecond-line")).toEqual({ ok: false, reason: "invalid_code" });
  expect(await flow.submit?.("abc\u0007")).toEqual({ ok: false, reason: "invalid_code" });
  expect(existsSync(seen)).toBe(false);
  await flow.cancel();

  const failing = await startCliCodeAuth({ command: [fake], env, urlPattern: CLAUDE_AUTH_URL_RE });
  expect(await failing.submit?.("  GOOD-SHAPE-CODE  ")).toEqual({
    ok: false,
    reason: "process_failed",
  });
  expect(readFileSync(seen, "utf8")).toBe("GOOD-SHAPE-CODE\n");
}, 10_000);
