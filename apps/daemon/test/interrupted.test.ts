import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { CycleErrorCode, type QueueUpdate } from "@cycle/protocol";
import { indexPath, sessionsDir } from "../src/data-dir.ts";
import { Daemon } from "../src/index.ts";
import { connectClient, type Seen, until } from "./client.ts";
import { fakeAgent } from "./fake-agent.ts";
import { tempDir } from "./support.ts";

// docs/protocol.md §8 "daemon 停止时进行中的 turn": a turn the daemon stops in the middle of ends on record.

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

const start = async (fake: ReturnType<typeof fakeAgent>) => {
  const daemon = await Daemon.start({ dataDir: dir, agents: [fake.definition] });
  open.push(daemon);
  return daemon;
};

/** Takes a daemon out of the ones the test closes for itself. */
const stop = async (daemon: Daemon) => {
  open = open.filter((d) => d !== daemon);
  await daemon.close();
};

const text = (value: string) => [{ type: "text" as const, text: value }];
const never = () => new Promise<never>(() => {});

type Ended = { state?: string; stopReason?: string; error?: { code?: number; message?: string } };
const interruptions = (seen: Seen[]) =>
  seen.filter((s) => (s.update as Ended).error?.code === CycleErrorCode.DaemonStopped);

const logLines = async (sessionId: string) =>
  (await readFile(join(sessionsDir(dir), `${sessionId}.jsonl`), "utf8"))
    .trim()
    .split("\n")
    .map(
      (line) => JSON.parse(line) as { seq: number; kind: string; data: Record<string, unknown> },
    );

/** Waits, for at most two seconds, for the index on disk to say something. */
const indexSays = async (pattern: RegExp) => {
  const started = Date.now();
  while (!pattern.test(await readFile(indexPath(dir), "utf8").catch(() => ""))) {
    if (Date.now() - started > 2_000)
      throw new Error(`timed out waiting for the index: ${pattern}`);
    await Bun.sleep(5);
  }
};

test("a turn running when the daemon stops ends on record as interrupted, and the queue is kept for the next start", async () => {
  const first = await start(fakeAgent({ onPrompt: never }));
  const c = await connectClient(first);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("first") });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("second") });
  await until(() => c.kinds().includes("_cycle/queue_update"), "the prompt to be queued");
  expect(first.activity()).toEqual([
    { sessionId, title: "first", turn: true, pending: 0, background: 0, queued: 1 },
  ]);

  await stop(first);
  // The client still attached is told, live, before the daemon goes.
  const live = interruptions(c.seen);
  expect(live).toHaveLength(1);
  expect(live[0]?.update).toMatchObject({ state: "idle", stopReason: "error" });
  expect(typeof live[0]?.seq).toBe("number");
  // Nothing the agent said after it is on record: the end is the last update.
  const lines = await logLines(sessionId);
  const last = lines.filter((l) => l.kind === "update").at(-1);
  expect((last?.data as Ended | undefined)?.error?.code).toBe(CycleErrorCode.DaemonStopped);

  const second = await start(fakeAgent());
  const d = await connectClient(second);
  const [row] = (
    (await d.agent.request(methods.agent.session.list, {})) as {
      sessions: { _meta: Record<string, unknown> }[];
    }
  ).sessions;
  // Not working, and worth a look: the turn ended while nobody may have been watching.
  expect(row?._meta["cycle/state"]).toBe("stopped");
  expect(row?._meta["cycle/unread"]).toBe(true);
  await d.agent.request(methods.agent.session.resume, {
    sessionId,
    cwd: "/tmp",
    replayFrom: { type: "start" },
  });
  // The replay ends the turn once, and no second end was written at load.
  expect(interruptions(d.seen)).toHaveLength(1);
  expect(d.ended()).toBe(1);
  // What was queued comes back to the input box, as after any restart.
  await until(
    () =>
      d.seen.some(
        (s) =>
          s.update.sessionUpdate === "_cycle/queue_update" &&
          (s.update as unknown as QueueUpdate).reason === "interrupted",
      ),
    "the queue to be handed back",
  );
  const back = d.seen
    .map((s) => s.update as unknown as QueueUpdate)
    .find((u) => u.reason === "interrupted");
  expect(back?.returned?.map((e) => (e.prompt[0] as { text: string }).text)).toEqual(["second"]);
  expect(second.activity()).toEqual([]);
});

test("a request waiting on the owner when the daemon stops is aborted, and the agent is told no", async () => {
  let answer: unknown;
  const first = await start(
    fakeAgent({
      onPrompt: async ({ ask }) => {
        answer = await ask();
        return never();
      },
    }),
  );
  const c = await connectClient(first, { onPermission: () => "never" });
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("go") });
  await until(() => c.permissions.length === 1, "the request");
  expect(first.activity()[0]).toMatchObject({ turn: true, pending: 1 });
  await stop(first);
  expect(answer).toEqual({ outcome: { outcome: "cancelled" } });
  const kinds = (await logLines(sessionId)).map((l) => l.kind);
  expect(kinds.lastIndexOf("aborted")).toBeGreaterThan(kinds.lastIndexOf("request"));
  expect(interruptions(c.seen)).toHaveLength(1);
});

test("an idle daemon stops without writing anything, and has nothing to say it is doing", async () => {
  const first = await start(fakeAgent());
  const c = await connectClient(first);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("hi") });
  await until(() => c.ended() === 1, "the turn to end");
  expect(first.activity()).toEqual([]);
  await indexSays(/"turnOpen":\s*false/);
  const before = (await logLines(sessionId)).length;
  await stop(first);
  expect(await logLines(sessionId)).toHaveLength(before);
});

test("background sub-agents count as work a stop would cut short, with no turn", async () => {
  const first = await start(
    fakeAgent({
      onPrompt: async ({ say }) => {
        await say({
          sessionUpdate: "subagent_update",
          sessionId: "sub-1",
          state: { state: "running" },
          _meta: { "cycle/subagent": { toolCallId: "sub-1", background: true } },
        });
        return "done";
      },
    }),
  );
  const c = await connectClient(first);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("hi") });
  await until(() => c.ended() === 1, "the turn to end");
  expect(first.activity()).toEqual([
    { sessionId, title: "hi", turn: false, pending: 0, background: 1, queued: 0 },
  ]);
  // No turn to end: the history is not given a false one.
  await stop(first);
  expect(interruptions(c.seen)).toHaveLength(0);
});

/** A session as a daemon that stopped without a word (a crash, or one older than the rule) leaves it. */
const leftBehind = async (
  records: Record<string, unknown>[],
  entry: Record<string, unknown> = {},
) => {
  const sessionId = "6f1c1f1e-0000-4000-8000-000000000001";
  await mkdir(sessionsDir(dir), { recursive: true });
  const ts = "2026-11-20T00:00:00.000Z";
  const lines = [
    { seq: 1, ts, kind: "meta", data: { event: "created", agent: "fake", cwd: "/tmp" } },
    ...records.map((data, i) => ({ seq: i + 2, ts, kind: "update", data })),
  ];
  await writeFile(
    join(sessionsDir(dir), `${sessionId}.jsonl`),
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
  await writeFile(
    indexPath(dir),
    JSON.stringify({
      version: 1,
      sessions: {
        [sessionId]: {
          agent: "fake",
          agentSessionId: sessionId,
          cwd: "/tmp",
          prompted: true,
          createdAt: ts,
          ...entry,
        },
      },
    }),
  );
  return sessionId;
};

const userMessage = { sessionUpdate: "user_message", messageId: "m1", content: text("hi") };

test("a turn a crashed or older daemon left open is ended on record when the session is next loaded, once", async () => {
  const sessionId = await leftBehind([
    userMessage,
    { sessionUpdate: "state_update", state: "running" },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "work" } },
  ]);
  const fake = fakeAgent();
  const first = await start(fake);
  const c = await connectClient(first);
  // The list loads the session: that is when the end is written, so the row is already unread.
  const listed = (await c.agent.request(methods.agent.session.list, {})) as {
    sessions: { _meta: Record<string, unknown> }[];
  };
  expect(listed.sessions[0]?._meta["cycle/unread"]).toBe(true);
  const lines = await logLines(sessionId);
  expect(lines).toHaveLength(5);
  expect((lines[4]?.data as Ended | undefined)?.error?.code).toBe(CycleErrorCode.DaemonStopped);
  await indexSays(/"turnOpen":\s*false/);
  await stop(first);

  const second = await start(fake);
  const d = await connectClient(second);
  await d.agent.request(methods.agent.session.resume, {
    sessionId,
    cwd: "/tmp",
    replayFrom: { type: "start" },
  });
  expect(interruptions(d.seen)).toHaveLength(1);
  expect(await logLines(sessionId)).toHaveLength(5);
});

test("a log whose last turn ended is left as it is, and the index learns so", async () => {
  const sessionId = await leftBehind([
    userMessage,
    { sessionUpdate: "state_update", state: "running" },
    { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
  ]);
  const first = await start(fakeAgent());
  const c = await connectClient(first);
  await c.agent.request(methods.agent.session.list, {});
  await indexSays(/"turnOpen":\s*false/);
  expect(await logLines(sessionId)).toHaveLength(4);
});

test("a session the index says has no turn open is not read for one", async () => {
  // The log says otherwise, but the index is what is trusted: it is how a restart avoids reading every log.
  const sessionId = await leftBehind(
    [userMessage, { sessionUpdate: "state_update", state: "running" }],
    { turnOpen: false },
  );
  const first = await start(fakeAgent());
  const c = await connectClient(first);
  await c.agent.request(methods.agent.session.list, {});
  expect(await logLines(sessionId)).toHaveLength(3);
});
