import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { agentSetupRead, agentSetupSetRuntime, CycleErrorCode, META } from "@cycle/protocol";
import { AGENT_SETTINGS_UNREADABLE, type AgentSettings } from "../src/agent-settings.ts";
import { claudeEffectiveRuntime, createClaudeSetupProvider } from "../src/agent-setup.ts";
import type { AgentDefinition } from "../src/agents.ts";
import { agyHarness } from "../src/agy-agent.ts";
import { claudeHarness } from "../src/claude-agent.ts";
import { ConfigSchema } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";
import { agentSettingsPath } from "../src/data-dir.ts";
import { agentsFor } from "../src/harnesses.ts";
import { processAgent } from "../src/process-agent.ts";
import { connectClient, until } from "./client.ts";
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

const makeClaudeRuntimeDaemon = async (
  options: {
    turnGate?: () => Promise<void>;
    corruptSettingsFile?: boolean;
    onNew?: () => Promise<void>;
  } = {},
) => {
  const bin = join(dir, "claude-stub");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(bin, 0o755);
  if (options.corruptSettingsFile) {
    writeFileSync(agentSettingsPath(dir), "{ broken json", "utf8");
  }
  const config = ConfigSchema.parse({ claude: { warmStart: true, maxWarm: 3 } }).claude;
  const setup = createClaudeSetupProvider({
    config,
    dataDir: dir,
    inherited: { PATH: "/usr/bin:/bin" },
    env: () => ({ CLAUDE_CONFIG_DIR: join(dir, "claude"), HOME: join(dir, "claude") }),
    locateBinary: () => ({ source: "builtin", path: bin }),
    runCommand: async (cmd) =>
      cmd[1] === "--version"
        ? { exitCode: 0, stdout: "2.1.327\n", stderr: "", timedOut: false }
        : {
            exitCode: 0,
            stdout: JSON.stringify({ loggedIn: true, authMethod: "claudeai" }),
            stderr: "",
            timedOut: false,
          },
  });

  const kills: string[] = [];
  let launchCount = 0;
  const fake = fakeAgent({
    onPrompt: async ({ say }) => {
      if (options.turnGate) await options.turnGate();
      await say({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "done" },
      });
    },
    ...(options.onNew !== undefined ? { onNew: options.onNew } : {}),
  });

  const daemon = await Daemon.start({
    dataDir: dir,
    agents: (agentSettings: AgentSettings) => [
      {
        ...fake.definition,
        id: "claude",
        name: "Claude",
        setup,
        maxAhead: () => {
          const r = claudeEffectiveRuntime(config, agentSettings).values;
          return r.warmStart ? r.maxWarm : 0;
        },
        launch: async () => {
          const idx = ++launchCount;
          const launched = await fake.definition.launch();
          return {
            ...launched,
            kill: () => {
              kills.push(`launch-${idx}`);
              launched.kill?.();
            },
          };
        },
      },
    ],
  });
  open.push(daemon);
  return { daemon, kills, launchCount: () => launchCount };
};

test("warmStart true -> false immediately reclaims unprompted warm processes while keeping sessions stopped", async () => {
  const { daemon, kills } = await makeClaudeRuntimeDaemon();
  const c1 = await connectClient(daemon);
  const c2 = await connectClient(daemon);

  // Create 2 unprompted sessions (warm processes) and 1 prompted session.
  const w1 = await c1.agent.request(methods.agent.session.new, {
    cwd: dir,
    _meta: { [META.agent]: "claude" },
  });
  const w2 = await c1.agent.request(methods.agent.session.new, {
    cwd: dir,
    _meta: { [META.agent]: "claude" },
  });
  const p1 = await c1.agent.request(methods.agent.session.new, {
    cwd: dir,
    _meta: { [META.agent]: "claude" },
  });
  await c1.agent.request(methods.agent.session.resume, { sessionId: p1.sessionId, cwd: dir });
  await c1.agent.request(methods.agent.session.prompt, {
    sessionId: p1.sessionId,
    prompt: [{ type: "text", text: "hello" }],
  });
  await until(() => c1.ended() >= 1, "prompted turn finishes");
  expect(kills).toEqual([]);

  // Flip warmStart -> false: both unprompted warm processes are killed immediately, prompted session stays alive.
  const updated = await c1.agent.request(agentSetupSetRuntime.name, {
    agent: "claude",
    patch: { warmStart: false },
    expectedRevision: 0,
  });
  expect(updated).toEqual({
    values: { warmStart: false, maxWarm: 3, progressSummaries: true },
    overrides: ["warmStart"],
    revision: 1,
  });
  expect(kills).toEqual(["launch-1", "launch-2"]);

  // Both sessions remain listed and are now stopped; both clients received _cycle/agent_setup_changed.
  const listed = await c1.agent.request(methods.agent.session.list, {});
  const byId = new Map(
    listed.sessions.map((s) => [s.sessionId, s._meta as Record<string, unknown>]),
  );
  expect(byId.get(w1.sessionId)?.[META.state]).toBe("stopped");
  expect(byId.get(w2.sessionId)?.[META.state]).toBe("stopped");
  expect(byId.get(p1.sessionId)?.[META.state]).toBe("idle");
  await until(
    () => c1.setupChanged.length === 1 && c2.setupChanged.length === 1,
    "setupChanged broadcast",
  );
  expect(c2.setupChanged[0]).toEqual({ agent: "claude", revision: 1 });
});

test("lowering maxWarm immediately reclaims oldest excess unprompted warm processes FIFO", async () => {
  const { daemon, kills } = await makeClaudeRuntimeDaemon();
  const c = await connectClient(daemon);

  await c.agent.request(methods.agent.session.new, { cwd: dir, _meta: { [META.agent]: "claude" } });
  await c.agent.request(methods.agent.session.new, { cwd: dir, _meta: { [META.agent]: "claude" } });
  await c.agent.request(methods.agent.session.new, { cwd: dir, _meta: { [META.agent]: "claude" } });
  expect(kills).toEqual([]);

  // Lower maxWarm 3 -> 1: oldest two warm processes (launch-1, launch-2) are reclaimed FIFO; newest stays.
  await c.agent.request(agentSetupSetRuntime.name, {
    agent: "claude",
    patch: { maxWarm: 1 },
    expectedRevision: 0,
  });
  expect(kills).toEqual(["launch-1", "launch-2"]);
});

test("next_idle_restart recycles idle sessions immediately and busy sessions only after their turn ends", async () => {
  let releaseTurn: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  let firstPrompt = true;
  const { daemon, kills } = await makeClaudeRuntimeDaemon({
    turnGate: () => {
      if (firstPrompt) {
        firstPrompt = false;
        return gate;
      }
      return Promise.resolve();
    },
  });
  const c = await connectClient(daemon);

  // Session A: busy running a turn. Session B: idle.
  const busy = await c.agent.request(methods.agent.session.new, {
    cwd: dir,
    _meta: { [META.agent]: "claude" },
  });
  await c.agent.request(methods.agent.session.resume, { sessionId: busy.sessionId, cwd: dir });
  const idle = await c.agent.request(methods.agent.session.new, {
    cwd: dir,
    _meta: { [META.agent]: "claude" },
  });
  const promptReq = c.agent.request(methods.agent.session.prompt, {
    sessionId: busy.sessionId,
    prompt: [{ type: "text", text: "working" }],
  });
  await until(
    () => c.seen.some((s) => (s.update as { state?: string }).state === "running"),
    "busy turn starts",
  );

  // Toggle progressSummaries (applyScope: next_idle_restart).
  await c.agent.request(agentSetupSetRuntime.name, {
    agent: "claude",
    patch: { progressSummaries: false },
    expectedRevision: 0,
  });

  // Idle session B (launch-2) recycled immediately; busy session A (launch-1) NOT interrupted.
  expect(kills).toEqual(["launch-2"]);

  // Once busy session A's turn finishes, it is recycled automatically.
  releaseTurn?.();
  await promptReq;
  await until(() => kills.includes("launch-1"), "busy session recycled once idle");
  expect(kills).toEqual(["launch-2", "launch-1"]);
  expect(idle.sessionId).not.toBe(busy.sessionId);
});

test("set_runtime enforces revision_conflict (-32602), validation errors (-32014), and corrupt-file protection", async () => {
  const { daemon } = await makeClaudeRuntimeDaemon();
  const c = await connectClient(daemon);

  await c.agent.request(agentSetupSetRuntime.name, {
    agent: "claude",
    patch: { warmStart: false },
    expectedRevision: 0,
  });

  // Stale expectedRevision -> -32602 + revision_conflict.
  try {
    await c.agent.request(agentSetupSetRuntime.name, {
      agent: "claude",
      patch: { maxWarm: 2 },
      expectedRevision: 0,
    });
    throw new Error("Expected revision_conflict");
  } catch (error) {
    const rpc = error as { code?: number; data?: { reason?: string; currentRevision?: number } };
    expect(rpc.code).toBe(-32602);
    expect(rpc.data?.reason).toBe("revision_conflict");
    expect(rpc.data?.currentRevision).toBe(1);
  }

  // Out-of-range integer -> -32014 invalid_config.
  try {
    await c.agent.request(agentSetupSetRuntime.name, {
      agent: "claude",
      patch: { maxWarm: 99 },
      expectedRevision: 1,
    });
    throw new Error("Expected invalid_config");
  } catch (error) {
    const rpc = error as { code?: number; data?: { field?: string; reason?: string } };
    expect(rpc.code).toBe(CycleErrorCode.InvalidConfig);
    expect(rpc.data?.field).toBe("maxWarm");
    expect(rpc.data?.reason).toBe("out_of_range");
  }

  // Corrupt agent-settings.json surfaces fileError in snapshot and refuses set_runtime with -32014.
  await daemon.close();
  open = [];
  const { daemon: corruptDaemon } = await makeClaudeRuntimeDaemon({ corruptSettingsFile: true });
  const c2 = await connectClient(corruptDaemon);
  const snap = (await c2.agent.request(agentSetupRead.name, { agent: "claude" })) as {
    runtime: { fileError?: string };
  };
  expect(snap.runtime.fileError).toBeDefined();
  try {
    await c2.agent.request(agentSetupSetRuntime.name, {
      agent: "claude",
      patch: { warmStart: false },
      expectedRevision: 0,
    });
    throw new Error("Expected corrupt file refusal");
  } catch (error) {
    const rpc = error as { code?: number; data?: { reason?: string } };
    expect(rpc.code).toBe(CycleErrorCode.InvalidConfig);
    expect(rpc.data?.reason).toBe("file_corrupt");
  }
});

test("processAgent evaluates dynamic env function on every launch", async () => {
  const outFile = join(dir, "env-seen.txt");
  const script = join(dir, "echo-env.sh");
  writeFileSync(script, `#!/bin/sh\necho "$TEST_FLAG" >> "${outFile}"\n`, "utf8");
  chmodSync(script, 0o755);

  let currentFlag = "first";
  const def = processAgent({
    id: "dyn",
    name: "Dyn",
    command: [script],
    env: () => ({ PATH: "/usr/bin:/bin", TEST_FLAG: currentFlag }),
  });

  const first = await def.launch();
  await until(
    () => existsSync(outFile) && readFileSync(outFile, "utf8").includes("first"),
    "first env written",
  );
  first.kill?.();

  currentFlag = "second";
  const second = await def.launch();
  await until(
    () => existsSync(outFile) && readFileSync(outFile, "utf8").includes("second"),
    "second env written",
  );
  second.kill?.();

  const lines = readFileSync(outFile, "utf8").trim().split("\n");
  expect(lines).toEqual(["first", "second"]);
});

test("the real Claude and agy harnesses read the daemon's own AgentSettings: maxAhead and env follow set_runtime", async () => {
  // agentsFor hands the daemon a factory; the daemon calls it with the instance set_runtime writes. The daemon's
  // sessions run on a fake agent; maxAhead is the harness's own closure, and the env each start gets is read by
  // launching the harness's own definition, whose command (`self`) only writes down what it was given.
  const configs = join(dir, "adapter-configs.txt");
  const self = join(dir, "self.sh");
  writeFileSync(
    self,
    `#!/bin/sh\nprintf '%s\\n' "$CYCLE_ADAPTER_CONFIG" >> "${configs}"\n`,
    "utf8",
  );
  chmodSync(self, 0o755);
  const fake = fakeAgent();
  const kills: string[] = [];
  let launches = 0;
  const made: AgentDefinition[] = [];
  const real = new Map<string, AgentDefinition>();
  const daemon = await Daemon.start({
    dataDir: dir,
    agents: (settings) =>
      agentsFor(
        ConfigSchema.parse({}),
        dir,
        { PATH: "/usr/bin:/bin" },
        undefined,
        [claudeHarness, agyHarness],
        [self],
      )(settings).map((definition) => {
        real.set(definition.id, definition);
        const wrapped: AgentDefinition = {
          ...definition,
          launch: async () => {
            const index = ++launches;
            const launched = await fake.definition.launch();
            return {
              ...launched,
              kill: () => {
                kills.push(`launch-${index}`);
                launched.kill?.();
              },
            };
          },
        };
        made.push(wrapped);
        return wrapped;
      }),
  });
  open.push(daemon);
  const claude = made.find((d) => d.id === "claude") as AgentDefinition;
  const maxAhead = () =>
    typeof claude.maxAhead === "function" ? claude.maxAhead() : claude.maxAhead;
  const adapterConfig = async (id: string) => {
    const before = existsSync(configs) ? readFileSync(configs, "utf8").split("\n").length : 1;
    const launched = await (real.get(id) as AgentDefinition).launch();
    await until(
      () => existsSync(configs) && readFileSync(configs, "utf8").split("\n").length > before,
      `${id} adapter config written`,
    );
    launched.kill?.();
    const lines = readFileSync(configs, "utf8").trim().split("\n");
    return JSON.parse(lines.at(-1) as string) as Record<string, unknown>;
  };
  expect(maxAhead()).toBe(3);
  expect(await adapterConfig("claude")).toMatchObject({ warmStart: true, progressSummaries: true });
  expect(await adapterConfig("agy")).toMatchObject({ sandbox: false, telemetry: true });

  const c = await connectClient(daemon);
  await c.agent.request(methods.agent.session.new, { cwd: dir, _meta: { [META.agent]: "claude" } });
  await c.agent.request(methods.agent.session.new, { cwd: dir, _meta: { [META.agent]: "claude" } });
  expect(kills).toEqual([]);

  // Lowering maxWarm through L1 is seen by the real maxAhead closure, and reclaims the oldest warm process.
  await c.agent.request(agentSetupSetRuntime.name, {
    agent: "claude",
    patch: { maxWarm: 1 },
    expectedRevision: 0,
  });
  expect(maxAhead()).toBe(1);
  expect(kills).toEqual(["launch-1"]);

  await c.agent.request(agentSetupSetRuntime.name, {
    agent: "claude",
    patch: { warmStart: false },
    expectedRevision: 1,
  });
  expect(maxAhead()).toBe(0);
  expect(kills).toEqual(["launch-1", "launch-2"]);

  // A next_idle_restart setting reaches the env of the next start.
  await c.agent.request(agentSetupSetRuntime.name, {
    agent: "claude",
    patch: { progressSummaries: false },
    expectedRevision: 2,
  });
  expect(await adapterConfig("claude")).toMatchObject({
    warmStart: false,
    progressSummaries: false,
  });

  await c.agent.request(agentSetupSetRuntime.name, {
    agent: "agy",
    patch: { sandbox: true, telemetry: false },
    expectedRevision: 0,
  });
  expect(await adapterConfig("agy")).toMatchObject({ sandbox: true, telemetry: false });
});

test("a session still inside session/new when a next_idle_restart setting changes is recycled once it is published", async () => {
  let releaseNew: (() => void) | undefined;
  let holdNext = true;
  const { daemon, kills, launchCount } = await makeClaudeRuntimeDaemon({
    onNew: () => {
      if (!holdNext) return Promise.resolve();
      holdNext = false;
      return new Promise<void>((resolve) => {
        releaseNew = resolve;
      });
    },
  });
  const c = await connectClient(daemon);
  const creating = c.agent.request(methods.agent.session.new, {
    cwd: dir,
    _meta: { [META.agent]: "claude" },
  });
  await until(() => releaseNew !== undefined, "session/new reached the agent");
  await c.agent.request(agentSetupSetRuntime.name, {
    agent: "claude",
    patch: { progressSummaries: false },
    expectedRevision: 0,
  });
  // Not yet listed, so the change could not reach it directly.
  expect(kills).toEqual([]);
  releaseNew?.();
  const created = await creating;
  // Started with the old setting: let go as soon as it is published (it is idle and unprompted).
  expect(kills).toEqual(["launch-1"]);
  await c.agent.request(methods.agent.session.prompt, {
    sessionId: created.sessionId,
    prompt: [{ type: "text", text: "after the change" }],
  });
  expect(launchCount()).toBe(2);
});

test("an unreadable agent-settings.json is reported with a fixed message, and recovers once fixed or removed", async () => {
  const { daemon } = await makeClaudeRuntimeDaemon({ corruptSettingsFile: true });
  const c = await connectClient(daemon);
  const read = async () =>
    (await c.agent.request(agentSetupRead.name, { agent: "claude" })) as {
      runtime: { fileError?: string; values: Record<string, unknown>; revision: number };
    };
  const snap = await read();
  // Neither the path nor the parser's message leaves the daemon.
  expect(snap.runtime.fileError).toBe(AGENT_SETTINGS_UNREADABLE);
  try {
    await c.agent.request(agentSetupSetRuntime.name, {
      agent: "claude",
      patch: { warmStart: false },
      expectedRevision: 0,
    });
    throw new Error("Expected corrupt file refusal");
  } catch (error) {
    const rpc = error as { code?: number; message?: string; data?: { reason?: string } };
    expect(rpc.code).toBe(CycleErrorCode.InvalidConfig);
    expect(rpc.data?.reason).toBe("file_corrupt");
    expect(rpc.message).toBe(AGENT_SETTINGS_UNREADABLE);
    expect(JSON.stringify(error)).not.toContain(dir);
  }

  // Fixed on disk: the next read and write see it, with no restart.
  writeFileSync(
    agentSettingsPath(dir),
    JSON.stringify({ version: 1, agents: { claude: { revision: 4, values: { maxWarm: 2 } } } }),
    "utf8",
  );
  const fixed = await read();
  expect(fixed.runtime.fileError).toBeUndefined();
  expect(fixed.runtime.values.maxWarm).toBe(2);
  expect(fixed.runtime.revision).toBe(4);
  const written = (await c.agent.request(agentSetupSetRuntime.name, {
    agent: "claude",
    patch: { warmStart: false },
    expectedRevision: 4,
  })) as { revision: number };
  expect(written.revision).toBe(5);
});

test("values in agent-settings.json outside the agent's schema are dropped on load, not used", async () => {
  writeFileSync(
    agentSettingsPath(dir),
    JSON.stringify({
      version: 1,
      agents: {
        claude: {
          revision: 2,
          values: { maxWarm: 1000, warmStart: "yes", progressSummaries: false, bogus: true },
        },
      },
    }),
    "utf8",
  );
  const { daemon } = await makeClaudeRuntimeDaemon();
  const c = await connectClient(daemon);
  const snap = (await c.agent.request(agentSetupRead.name, { agent: "claude" })) as {
    runtime: { values: Record<string, unknown>; overrides: string[]; fileError?: string };
  };
  expect(snap.runtime.fileError).toBeUndefined();
  expect(snap.runtime.values).toEqual({ warmStart: true, maxWarm: 3, progressSummaries: false });
  expect(snap.runtime.overrides).toEqual(["progressSummaries"]);
});
