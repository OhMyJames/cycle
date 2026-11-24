// Letting go of what is idle (docs/daemon.md "空闲回收"、"空闲退出", CYCL-104): an agent with nothing to do and nobody
// attached ends after a while and is started again on the next prompt; the daemon says when it has been idle, and
// never while anything could be lost.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { Daemon } from "../src/index.ts";
import { connectClient, until } from "./client.ts";
import { fakeAgent } from "./fake-agent.ts";
import { tempDir } from "./support.ts";

const LIMIT = 10 * 60_000;

let dir: string;
let dispose: () => Promise<void>;
let open: Daemon[] = [];
let clock = 1_000_000;
beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
  clock = 1_000_000;
});
afterEach(async () => {
  for (const daemon of open) await daemon.close();
  open = [];
  await dispose();
});

const start = async (fake = fakeAgent(), attachedAgentIdleMs?: number) => {
  const daemon = await Daemon.start({
    dataDir: dir,
    agents: [fake.definition],
    agentIdleMs: LIMIT,
    ...(attachedAgentIdleMs !== undefined ? { attachedAgentIdleMs } : {}),
    now: () => clock,
  });
  open.push(daemon);
  return { daemon, fake };
};

const text = (value: string) => [{ type: "text" as const, text: value }];

const sub = (state: string, background: boolean) => ({
  sessionUpdate: "subagent_update",
  sessionId: "task-1",
  state: state === "idle" ? { state, stopReason: "end_turn" } : { state },
  _meta: { "cycle/subagent": { toolCallId: "task-1", background } },
});

/** A session with one finished turn, made by a client that then leaves. */
const finishedTurn = async (daemon: Daemon, prompt = "hi") => {
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text(prompt) });
  await until(() => c.ended() >= 1, "the turn to end");
  return { c, sessionId };
};

test("an idle agent nobody is attached to is let go after the limit, and the next prompt resumes it", async () => {
  const { daemon, fake } = await start();
  const { c, sessionId } = await finishedTurn(daemon);
  c.close();
  await c.closed;

  clock += LIMIT - 1;
  expect(daemon.reclaimIdleAgents()).toEqual([]);
  clock += 1;
  expect(daemon.reclaimIdleAgents()).toEqual([sessionId]);

  const again = await connectClient(daemon);
  // The session stays listed, its agent stopped.
  const listed = await again.agent.request(methods.agent.session.list, {});
  const row = listed.sessions.find((s) => s.sessionId === sessionId);
  expect(((row?._meta ?? {}) as Record<string, unknown>)["cycle/state"]).toBe("stopped");
  await again.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await again.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("again") });
  await until(() => fake.log.prompts.length === 2, "the second prompt to reach an agent");
  expect(fake.log.launches).toBe(2);
  expect(fake.log.resumes.map((r) => r.sessionId)).toEqual([sessionId]);
});

test("an agent is kept while a client is attached, however long", async () => {
  const { daemon } = await start();
  const { c } = await finishedTurn(daemon);
  clock += LIMIT * 10;
  expect(daemon.reclaimIdleAgents()).toEqual([]);
  // The idle time starts when the client leaves, not from the last thing written.
  c.close();
  await c.closed;
  expect(daemon.reclaimIdleAgents()).toEqual([]);
  clock += LIMIT;
  expect(daemon.reclaimIdleAgents()).toHaveLength(1);
});

test("with an attached limit, an agent a client stays attached to is let go after it, and the next prompt resumes it (CYC-297)", async () => {
  const { daemon, fake } = await start(fakeAgent(), LIMIT * 6);
  const { c, sessionId } = await finishedTurn(daemon);
  clock += LIMIT * 6 - 1;
  expect(daemon.reclaimIdleAgents()).toEqual([]);
  clock += 1;
  expect(daemon.reclaimIdleAgents()).toEqual([sessionId]);
  // Still attached; its next prompt starts the agent again.
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("again") });
  await until(() => fake.log.prompts.length === 2, "the second prompt to reach an agent");
  expect(fake.log.launches).toBe(2);
});

test("an agent is kept while its turn runs, and while a background task works", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { daemon } = await start(
    fakeAgent({
      onPrompt: async ({ prompt, say }) => {
        if (prompt === "long") await held;
        if (prompt === "background") await say(sub("running", true));
        if (prompt === "done") await say(sub("idle", false));
      },
    }),
  );
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  // A turn in progress, with its client gone.
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("long") });
  await until(() => daemon.activity().length === 1, "the turn to start");
  const watcher = await connectClient(daemon);
  c.close();
  await c.closed;
  clock += LIMIT * 2;
  expect(daemon.reclaimIdleAgents()).toEqual([]);
  expect(daemon.idleSince()).toBeUndefined();
  release();
  await until(() => daemon.activity().length === 0, "the turn to end");

  // A background task outlives its turn: the agent stays for it.
  const d = await connectClient(daemon);
  await d.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  const before = d.ended();
  await d.agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: text("background"),
  });
  await until(() => d.ended() > before, "the background turn to end");
  d.close();
  await d.closed;
  watcher.close();
  await watcher.closed;
  clock += LIMIT * 2;
  expect(daemon.activity()[0]?.background).toBe(1);
  expect(daemon.reclaimIdleAgents()).toEqual([]);
  expect(daemon.idleSince()).toBeUndefined();
});

test("the daemon is idle only with no client and nothing working, counted from the last of them", async () => {
  const { daemon } = await start();
  const started = clock;
  expect(daemon.idleSince()).toBe(started);
  const { c } = await finishedTurn(daemon);
  expect(daemon.idleSince()).toBeUndefined();
  clock += 5_000;
  c.close();
  await c.closed;
  expect(daemon.idleSince()).toBe(started + 5_000);
  // Letting an agent go is the daemon's own doing: the idle time still counts from the client leaving.
  clock += LIMIT;
  expect(daemon.reclaimIdleAgents()).toHaveLength(1);
  await Bun.sleep(20);
  expect(daemon.idleSince()).toBe(started + 5_000);
});

test("without a limit no agent is let go", async () => {
  const fake = fakeAgent();
  const daemon = await Daemon.start({
    dataDir: dir,
    agents: [fake.definition],
    now: () => clock,
  });
  open.push(daemon);
  const { c } = await finishedTurn(daemon);
  c.close();
  await c.closed;
  clock += LIMIT * 100;
  expect(daemon.reclaimIdleAgents()).toEqual([]);
});

test("a background task whose end is unknown does not hold the agent on its own", async () => {
  const { daemon } = await start(
    fakeAgent({
      onPrompt: async ({ say }) => {
        await say(sub("running", true));
        // The agent's list no longer has it: gone from the background, why unknown (docs/protocol.md §8).
        await say({
          sessionUpdate: "subagent_update",
          sessionId: "task-1",
          state: { state: "running" },
          _meta: { "cycle/subagent": { toolCallId: "task-1", status: "unknown" } },
        });
      },
    }),
  );
  const { c, sessionId } = await finishedTurn(daemon);
  c.close();
  await c.closed;
  clock += LIMIT;
  expect(daemon.reclaimIdleAgents()).toEqual([sessionId]);
});

test("a prompt right after an agent is let go starts a new one, not the one going away", async () => {
  const { daemon, fake } = await start();
  const { c, sessionId } = await finishedTurn(daemon);
  c.close();
  await c.closed;
  clock += LIMIT;
  const again = await connectClient(daemon);
  expect(daemon.reclaimIdleAgents()).toEqual([sessionId]);
  // Asked again at once: nothing more to let go, the agent is already gone as far as the daemon is concerned.
  expect(daemon.reclaimIdleAgents()).toEqual([]);
  await again.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await again.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("again") });
  await until(() => again.ended() >= 1, "the turn after the reclaim to end");
  expect(fake.log.launches).toBe(2);
  const stops = again.seen.map((s) => (s.update as { stopReason?: string }).stopReason);
  expect(stops.filter((reason) => reason !== undefined)).toEqual(["end_turn"]);
});
