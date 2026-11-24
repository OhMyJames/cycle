import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import {
  type AgentAuthMode,
  agentAuthCancel,
  agentAuthLogout,
  agentAuthStart,
  agentAuthSubmit,
  agentSetupRead,
  CycleErrorCode,
} from "@cycle/protocol";
import type {
  AgentAuthFlowHandle,
  AgentAuthFlowOutcome,
  AgentSetupProvider,
} from "../src/agent-setup.ts";
import { Daemon } from "../src/daemon.ts";
import type { Logger } from "../src/logger.ts";
import { connectClient, until } from "./client.ts";
import { fakeAgent } from "./fake-agent.ts";

let dir: string;
let cleanup: (() => Promise<void>)[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cv1-auth-"));
});

afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
  await rm(dir, { recursive: true, force: true });
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const recordingLog = () => {
  const entries: unknown[] = [];
  const log: Logger = {
    debug: (event, data) => entries.push({ level: "debug", event, data }),
    info: (event, data) => entries.push({ level: "info", event, data }),
    warn: (event, data) => entries.push({ level: "warn", event, data }),
    error: (event, data) => entries.push({ level: "error", event, data }),
  };
  return { log, entries };
};

const makeProvider = (opts: {
  signInModes?: { mode: AgentAuthMode; requiresLocalLoopback: boolean }[];
  canSignOut?: boolean;
  onStart?: (mode: AgentAuthMode) => Promise<AgentAuthFlowHandle>;
  onLogout?: () => Promise<void>;
  onInvalidate?: () => void;
}): AgentSetupProvider => ({
  probeBinary: () => ({ source: "path", path: "/usr/bin/agent", version: "2.0.0" }),
  readAuth: async () => ({ state: "signed_out", method: "none" }),
  signInModes: () => opts.signInModes ?? [{ mode: "code", requiresLocalLoopback: false }],
  canSignOut: () => opts.canSignOut ?? true,
  canRefreshUsage: false,
  loginCommand: "cycle login claude",
  diagnostics: () => ({
    dataDir: join(dir, "agent"),
    customDataDir: false,
    allowEnv: [],
    envNames: [],
  }),
  runtimeSnapshot: () => ({
    schemaVersion: 1,
    schema: { type: "object", properties: {} },
    values: {},
    overrides: [],
    revision: 0,
  }),
  authDriver: {
    start:
      opts.onStart ??
      (async () => ({ completed: deferred<AgentAuthFlowOutcome>().promise, cancel: () => {} })),
    ...(opts.onLogout !== undefined ? { logout: opts.onLogout } : {}),
    ...(opts.onInvalidate !== undefined ? { invalidateCache: opts.onInvalidate } : {}),
  },
});

test("auth flow enforces per-agent mutex, connection binding, initiating-only completion, atomic single-use submit, and zero code logging", async () => {
  const { log, entries } = recordingLog();
  const submittedCodes: string[] = [];
  let cancelCount = 0;
  const flowDone = deferred<AgentAuthFlowOutcome>();
  const submitGate = deferred<{ ok: true }>();

  const fake = fakeAgent();
  const daemon = await Daemon.start({
    dataDir: join(dir, "daemon"),
    log,
    agents: [
      {
        ...fake.definition,
        id: "claude",
        name: "Claude",
        setup: makeProvider({
          onStart: async () => ({
            authorizationUrl: "https://claude.ai/oauth/authorize?state=abc",
            completed: flowDone.promise,
            submit: async (code) => {
              submittedCodes.push(code);
              return submitGate.promise;
            },
            cancel: () => {
              cancelCount++;
            },
          }),
        }),
      },
    ],
  });
  cleanup.push(() => daemon.close());

  const clientA = await connectClient(daemon);
  const clientB = await connectClient(daemon);

  const started = (await clientA.agent.request(agentAuthStart.name, {
    agent: "claude",
    mode: "code",
  } as never)) as { flowId: string; mode: string; authorizationUrl?: string; expiresAt: number };
  expect(started.mode).toBe("code");
  expect(started.authorizationUrl).toBe("https://claude.ai/oauth/authorize?state=abc");

  // Live snapshot reports signing_in while flow is active.
  const midSnap = (await clientB.agent.request(agentSetupRead.name, {
    agent: "claude",
  } as never)) as { auth: { state: string } };
  expect(midSnap.auth.state).toBe("signing_in");

  // Concurrent start for the same agent is rejected with auth_in_progress.
  await expect(
    clientB.agent.request(agentAuthStart.name, { agent: "claude", mode: "code" } as never),
  ).rejects.toMatchObject({
    code: CycleErrorCode.AgentAuthFailed,
    data: { reason: "auth_in_progress" },
  });

  // Other connection cannot submit or cancel clientA's flowId.
  await expect(
    clientB.agent.request(agentAuthSubmit.name, {
      flowId: started.flowId,
      code: "hijack-code",
    } as never),
  ).rejects.toMatchObject({ code: -32602, data: { reason: "flow_forbidden" } });
  await expect(
    clientB.agent.request(agentAuthCancel.name, { flowId: started.flowId } as never),
  ).rejects.toMatchObject({ code: -32602, data: { reason: "flow_forbidden" } });

  // Atomic single-use submit: second submit returns flow_consumed and concurrent cancel returns flow_not_active.
  const secretCode = "ONE-TIME-SECRET-CODE-9999";
  const firstSubmit = clientA.agent.request(agentAuthSubmit.name, {
    flowId: started.flowId,
    code: secretCode,
  } as never);
  await expect(
    clientA.agent.request(agentAuthSubmit.name, {
      flowId: started.flowId,
      code: "SECOND-CODE",
    } as never),
  ).rejects.toMatchObject({ code: -32602, data: { reason: "flow_consumed" } });
  await expect(
    clientA.agent.request(agentAuthCancel.name, { flowId: started.flowId } as never),
  ).rejects.toMatchObject({ code: -32602, data: { reason: "flow_not_active" } });

  submitGate.resolve({ ok: true });
  expect(await firstSubmit).toEqual({ ok: true });
  expect(submittedCodes).toEqual([secretCode]);

  // Resolve flow: `_cycle/agent_auth_completed` goes ONLY to clientA; `_cycle/agent_setup_changed` goes to both.
  flowDone.resolve({ ok: true });
  await until(() => clientA.authCompleted.length === 1, "clientA authCompleted");
  await until(
    () => clientB.setupChanged.length >= 2,
    "clientB setupChanged broadcast on start and completion",
  );
  expect(clientA.authCompleted).toEqual([{ flowId: started.flowId, agent: "claude", ok: true }]);
  expect(clientB.authCompleted).toEqual([]);
  expect(cancelCount).toBe(0);

  // Zero secret code in daemon logs!
  expect(JSON.stringify(entries)).not.toContain(secretCode);
  expect(JSON.stringify(entries)).not.toContain("ONE-TIME-SECRET");
});

test("auth flow cleans up subprocess on TTL expiry, client disconnect, and daemon.close()", async () => {
  let cancels = 0;
  const fake = fakeAgent();
  const daemon = await Daemon.start({
    dataDir: join(dir, "daemon"),
    authFlowTtlMs: 40,
    agents: [
      {
        ...fake.definition,
        id: "claude",
        name: "Claude",
        setup: makeProvider({
          onStart: async () => ({
            authorizationUrl: "https://claude.ai/oauth/authorize",
            completed: deferred<AgentAuthFlowOutcome>().promise,
            cancel: () => {
              cancels++;
            },
          }),
        }),
      },
    ],
  });
  cleanup.push(() => daemon.close());

  // 1. TTL expiry cancels subprocess and notifies initiating client.
  const c1 = await connectClient(daemon);
  const f1 = (await c1.agent.request(agentAuthStart.name, { agent: "claude" } as never)) as {
    flowId: string;
  };
  await until(() => c1.authCompleted.length === 1, "TTL expiry notification");
  expect(c1.authCompleted[0]).toEqual({
    flowId: f1.flowId,
    agent: "claude",
    ok: false,
    reason: "expired",
  });
  expect(cancels).toBe(1);

  // 2. Client disconnect cancels subprocess immediately.
  const c2 = await connectClient(daemon);
  await c2.agent.request(agentAuthStart.name, { agent: "claude" } as never);
  c2.close();
  await until(() => cancels === 2, "disconnect cleanup");

  // 3. daemon.close() cancels active subprocesses without leaving orphans.
  const daemon2 = await Daemon.start({
    dataDir: join(dir, "daemon2"),
    authFlowTtlMs: 60_000,
    agents: [
      {
        ...fake.definition,
        id: "claude",
        name: "Claude",
        setup: makeProvider({
          onStart: async () => ({
            authorizationUrl: "https://claude.ai/oauth/authorize",
            completed: deferred<AgentAuthFlowOutcome>().promise,
            cancel: () => {
              cancels++;
            },
          }),
        }),
      },
    ],
  });
  const c3 = await connectClient(daemon2);
  await c3.agent.request(agentAuthStart.name, { agent: "claude" } as never);
  await daemon2.close();
  expect(cancels).toBe(3);
});

test("sign out preserves active turns, kills unprompted warm processes, recycles idle prompted sessions, clears caches, and broadcasts setup changed", async () => {
  const turnGate = deferred<void>();
  let promptCalls = 0;
  let logoutCalls = 0;
  let invalidateCalls = 0;

  const fake = fakeAgent({
    onPrompt: async ({ say }) => {
      promptCalls++;
      if (promptCalls === 2) {
        await say({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "working..." },
        });
        await turnGate.promise;
      }
      await say({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "done" },
      });
    },
  });

  const daemon = await Daemon.start({
    dataDir: join(dir, "daemon"),
    agents: [
      {
        ...fake.definition,
        id: "claude",
        name: "Claude",
        maxAhead: 3,
        setup: makeProvider({
          onLogout: async () => {
            logoutCalls++;
          },
          onInvalidate: () => {
            invalidateCalls++;
          },
        }),
      },
    ],
  });
  cleanup.push(() => daemon.close());

  const c = await connectClient(daemon);
  // 1. Prompted idle session (should be recycled immediately on sign out).
  const idleSess = (await c.agent.request(methods.agent.session.new, {
    cwd: dir,
    _meta: { "cycle/agent": "claude" },
  } as never)) as { sessionId: string };
  await c.agent.request(methods.agent.session.resume, {
    sessionId: idleSess.sessionId,
    cwd: dir,
  } as never);
  await c.agent.request(methods.agent.session.prompt, {
    sessionId: idleSess.sessionId,
    prompt: [{ type: "text", text: "hi" }],
  } as never);

  // 2. Active running session (must NOT be interrupted during sign out; recycles after turn completes).
  const busySess = (await c.agent.request(methods.agent.session.new, {
    cwd: dir,
    _meta: { "cycle/agent": "claude" },
  } as never)) as { sessionId: string };
  await c.agent.request(methods.agent.session.resume, {
    sessionId: busySess.sessionId,
    cwd: dir,
  } as never);
  const busyPrompt = c.agent.request(methods.agent.session.prompt, {
    sessionId: busySess.sessionId,
    prompt: [{ type: "text", text: "long task" }],
  } as never);
  await until(() => promptCalls === 2, "busy turn started");

  // 3. Unprompted warm session (should be killed immediately on sign out).
  await c.agent.request(methods.agent.session.new, {
    cwd: dir,
    _meta: { "cycle/agent": "claude" },
  } as never);

  const launchesBeforeLogout = fake.log.launches;
  expect(launchesBeforeLogout).toBe(3);

  // Execute Sign out while busySess is running!
  await c.agent.request(agentAuthLogout.name, { agent: "claude" } as never);
  expect(logoutCalls).toBe(1);
  expect(invalidateCalls).toBe(1);
  await until(
    () => c.setupChanged.some((e) => e.agent === "claude"),
    "setupChanged broadcast after logout",
  );

  // Busy turn MUST finish cleanly without interruption!
  turnGate.resolve();
  await busyPrompt;

  // Next prompt on idleSess and busySess both spawn fresh agent processes because both were recycled!
  await c.agent.request(methods.agent.session.prompt, {
    sessionId: idleSess.sessionId,
    prompt: [{ type: "text", text: "after signout idle" }],
  } as never);
  await c.agent.request(methods.agent.session.prompt, {
    sessionId: busySess.sessionId,
    prompt: [{ type: "text", text: "after signout busy" }],
  } as never);
  expect(fake.log.launches).toBe(launchesBeforeLogout + 2);
});

test("failed code submit after completed settles emits _cycle/agent_auth_completed exactly once", async () => {
  const flowDone = deferred<AgentAuthFlowOutcome>();
  const fake = fakeAgent();
  const daemon = await Daemon.start({
    dataDir: join(dir, "daemon-once"),
    agents: [
      {
        ...fake.definition,
        id: "claude",
        name: "Claude",
        setup: makeProvider({
          onStart: async () => ({
            authorizationUrl: "https://claude.ai/oauth/authorize",
            completed: flowDone.promise,
            submit: async () => {
              // Mirrors startCliCodeAuth where `completed` settles right before `submit` returns `{ ok: false }`.
              flowDone.resolve({ ok: false, reason: "invalid_code" });
              return flowDone.promise;
            },
            cancel: () => {},
          }),
        }),
      },
    ],
  });
  cleanup.push(() => daemon.close());

  const c = await connectClient(daemon);
  const started = (await c.agent.request(agentAuthStart.name, {
    agent: "claude",
    mode: "code",
  } as never)) as { flowId: string };
  await expect(
    c.agent.request(agentAuthSubmit.name, {
      flowId: started.flowId,
      code: "BAD-CODE",
    } as never),
  ).rejects.toMatchObject({
    code: CycleErrorCode.AgentAuthFailed,
    data: { reason: "invalid_code" },
  });
  await Bun.sleep(30);
  expect(c.authCompleted).toEqual([
    { flowId: started.flowId, agent: "claude", ok: false, reason: "invalid_code" },
  ]);
});
