import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentApp, methods } from "@agentclientprotocol/sdk/experimental/v2";
import { AgentSetupSnapshotSchema, agentSetupRead, META } from "@cycle/protocol";
import {
  type AgentSetupRunCommand,
  captureConfigMtime,
  createAgySetupProvider,
  createClaudeSetupProvider,
  createCodexSetupProvider,
  readConfigFileStatus,
  runCodexAppServerLogout,
  runCodexAppServerProbe,
  startCodexAppServerAuth,
} from "../src/agent-setup.ts";
import { ConfigSchema } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";
import { connectClient } from "./client.ts";
import { fakeAgent } from "./fake-agent.ts";
import { tempDir } from "./support.ts";

let dir: string;
let dispose: () => Promise<void>;
let open: Daemon[] = [];

beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
});

afterEach(async () => {
  for (const daemon of open) await daemon.close();
  open = [];
  await dispose();
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
  expect(await provider.readAuth()).toEqual({
    state: "signed_out",
    method: "none",
    viaEnv: "ANTHROPIC_API_KEY",
  });

  nextStatus = { exitCode: null, stdout: "", stderr: "", timedOut: true };
  expect(await provider.readAuth()).toEqual({
    state: "auth_unknown",
    unknownReason: "timeout",
    method: "unknown",
    viaEnv: "ANTHROPIC_API_KEY",
  });

  nextStatus = { exitCode: 1, stdout: "not json", stderr: "crash", timedOut: false };
  expect(await provider.readAuth()).toEqual({
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
