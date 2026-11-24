import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { CycleErrorCode, QUEUE_LIMIT, type QueueUpdate } from "@cycle/protocol";
import { blobsDir, indexPath, sessionsDir } from "../src/data-dir.ts";
import { Daemon } from "../src/index.ts";
import { connectClient, type Seen, until } from "./client.ts";
import { fakeAgent } from "./fake-agent.ts";
import { daemonHarness } from "./support.ts";

let dir: string;
const open = daemonHarness<Daemon>((made) => {
  dir = made;
});

const start = async (fake: ReturnType<typeof fakeAgent>) => {
  const daemon = await Daemon.start({ dataDir: dir, agents: [fake.definition] });
  open.push(daemon);
  return daemon;
};

const text = (value: string) => [{ type: "text" as const, text: value }];

/** Waits, for at most two seconds, for something that takes a promise to check. */
const waitFor = async (condition: () => Promise<boolean>, what: string): Promise<void> => {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > 2_000) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};

/** A gate a test opens when the agent should go on. */
const gate = () => {
  let open: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { closed, open };
};

const queueUpdates = (seen: Seen[]): { update: QueueUpdate; seq: number | undefined }[] =>
  seen
    .filter((s) => s.update.sessionUpdate === "_cycle/queue_update")
    .map((s) => ({ update: s.update as unknown as QueueUpdate, seq: s.seq }));

const handbacks = (seen: Seen[]) => queueUpdates(seen).filter((q) => q.update.returned?.length);

const queueTexts = (update: { entries: { prompt: unknown[] }[] }): string[] =>
  update.entries.map((e) => (e.prompt[0] as { text: string }).text);

/** A session with a client attached, whose first turn holds until `release`. */
const working = async (
  script?: Parameters<typeof fakeAgent>[0],
  options?: Parameters<typeof fakeAgent>[1],
) => {
  const slow = gate();
  const fake = fakeAgent(script ?? { onPrompt: () => slow.closed }, options);
  const daemon = await start(fake);
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("first") });
  return { fake, daemon, c, sessionId, release: slow.open };
};

test("a prompt while the agent works is queued, then sent in order when the turn ends well", async () => {
  const { fake, c, sessionId, release } = await working();
  const answer = await c.agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: text("second"),
  });
  expect(answer._meta).toMatchObject({ "cycle/queued": true });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("third") });
  await until(() => queueUpdates(c.seen).length === 2, "two snapshots");
  expect(queueTexts(queueUpdates(c.seen)[1]?.update ?? { entries: [] })).toEqual([
    "second",
    "third",
  ]);
  // The id of a queued prompt is the daemon's, and is in the queue under that name.
  expect(queueUpdates(c.seen)[0]?.update.entries[0]?.queueId).toBe(answer.messageId);
  expect(fake.log.prompts).toEqual(["first"]);
  release();
  await until(() => fake.log.prompts.length === 3, "both queued prompts to be sent");
  expect(fake.log.prompts).toEqual(["first", "second", "third"]);
  await until(() => c.ended() === 3, "three turns to end");
  const last = queueUpdates(c.seen).at(-1)?.update;
  expect(last?.entries).toEqual([]);
  expect(last?.returned).toBeUndefined();
  // History has each user message when it was sent, in the order things happened.
  const sent = c.seen
    .filter((s) => s.update.sessionUpdate === "user_message")
    .map(
      (s) => ((s.update as { content: { text: string }[] }).content[0] as { text: string }).text,
    );
  expect(sent).toEqual(["first", "second", "third"]);
});

test("a stop hands the queue back, and nothing is sent", async () => {
  const { fake, c, sessionId } = await working({
    onPrompt: ({ cancelled }) => cancelled,
  });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("second") });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("third") });
  await until(() => queueUpdates(c.seen).length === 2, "two snapshots");
  await c.agent.notify(methods.agent.session.cancel, { sessionId });
  await until(() => handbacks(c.seen).length === 1, "the queue to be handed back");
  const back = handbacks(c.seen)[0]?.update;
  expect(back?.entries).toEqual([]);
  expect(back?.reason).toBe("cancelled");
  expect(queueTexts({ entries: back?.returned ?? [] })).toEqual(["second", "third"]);
  await until(() => c.ended() === 1, "the cancelled turn to end");
  expect(fake.log.prompts).toEqual(["first"]);
});

test("a turn that ends any way but end_turn hands the queue back", async () => {
  const slow = gate();
  const { fake, c, sessionId, release } = await working({
    onPrompt: async ({ say }) => {
      await slow.closed;
      await say({ sessionUpdate: "state_update", state: "idle", stopReason: "error" });
      return "ended";
    },
  });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("second") });
  await until(() => queueUpdates(c.seen).length === 1, "a snapshot");
  slow.open();
  release();
  await until(() => handbacks(c.seen).length === 1, "the queue to be handed back");
  expect(handbacks(c.seen)[0]?.update).toMatchObject({ entries: [], reason: "error" });
  expect(fake.log.prompts).toEqual(["first"]);
});

test("a prompt that cannot reach the agent hands back what was queued behind it", async () => {
  const fake = fakeAgent();
  const start_ = gate();
  let broken = false;
  const definition = {
    ...fake.definition,
    launch: async (...args: Parameters<typeof fake.definition.launch>) => {
      if (!broken) return fake.definition.launch(...args);
      await start_.closed;
      throw new Error("the agent did not start");
    },
  };
  const daemon = await Daemon.start({ dataDir: dir, agents: [definition] });
  open.push(daemon);
  const c = await connectClient(daemon);
  // Another window: a request is not held up by one from the first.
  const other = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("first") });
  await until(() => c.ended() === 1, "the first turn to end");
  // The agent is gone, and the next prompt has to start it, which takes a while and then fails.
  fake.crash();
  await Bun.sleep(100);
  broken = true;
  const lost = c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("lost") });
  const refused = lost.then(
    () => undefined,
    (error: unknown) => error,
  );
  await other.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("behind") });
  await until(() => queueUpdates(c.seen).length === 1, "the snapshot of the queue");
  start_.open();
  expect(await refused).toBeInstanceOf(Error);
  await until(() => handbacks(c.seen).length === 1, "the queue to be handed back");
  const back = handbacks(c.seen)[0]?.update;
  expect(back).toMatchObject({ entries: [], reason: "error" });
  expect(queueTexts({ entries: back?.returned ?? [] })).toEqual(["behind"]);
});

test("a queued prompt whose turn is cut short by the agent exiting is a turn that ended in error, on record", async () => {
  const first = gate();
  const second = gate();
  let turns = 0;
  const fake = fakeAgent({ onPrompt: () => (++turns === 1 ? first.closed : second.closed) });
  const daemon = await start(fake);
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("first") });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("second") });
  await until(() => queueUpdates(c.seen).length === 1, "the snapshot of the queue");
  first.open();
  // The first turn ended well, so the second goes: it is the turn that is running when the agent dies.
  await until(() => queueUpdates(c.seen).length === 2, "the second prompt to be sent");
  await until(() => turns === 2, "the agent to have the second prompt");
  fake.crash();
  const failed = () =>
    c.seen.filter((s) => (s.update as { stopReason?: string }).stopReason === "error");
  await until(() => failed().length === 1, "the end of the second turn to be on record");
  expect(failed()[0]?.update).toMatchObject({ state: "idle" });
});

test("a queue that is full refuses the next prompt", async () => {
  const { c, sessionId } = await working();
  for (let i = 0; i < QUEUE_LIMIT; i++) {
    await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text(`p${i}`) });
  }
  await expect(
    c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("one too many") }),
  ).rejects.toMatchObject({ code: CycleErrorCode.SessionBusy });
});

test("a prompt that cannot be sent is refused when it is queued too, not later", async () => {
  const { c, sessionId } = await working();
  await expect(
    c.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
    }),
  ).rejects.toMatchObject({ code: -32602 });
  expect(queueUpdates(c.seen)).toEqual([]);
});

test("a queued prompt is taken back with dequeue, once", async () => {
  const { c, sessionId } = await working();
  const { messageId } = await c.agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: text("second"),
  });
  const request = (queueId: string) =>
    c.agent.request("_cycle/prompt/dequeue" as never, { sessionId, queueId } as never) as Promise<{
      prompt: unknown[];
    }>;
  expect((await request(messageId)).prompt).toEqual(text("second"));
  await until(() => queueUpdates(c.seen).length === 2, "a snapshot of the empty queue");
  expect(queueUpdates(c.seen)[1]?.update.entries).toEqual([]);
  await expect(request(messageId)).rejects.toMatchObject({ code: CycleErrorCode.NotQueued });
});

test("an image in a queued prompt is stored once, beside the log, and not in it", async () => {
  const { daemon, c, sessionId } = await working(undefined, { promptCapabilities: { image: {} } });
  const data = Buffer.alloc(40 * 1024, 7).toString("base64");
  await c.agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "image", mimeType: "image/png", data }],
  });
  // A second snapshot holds the same image again.
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("more") });
  await until(() => queueUpdates(c.seen).length === 2, "two snapshots");
  await daemon.close();
  open.length = 0;
  const log = await readFile(join(sessionsDir(dir), `${sessionId}.jsonl`), "utf8");
  expect(log).not.toContain(data);
  expect(log).toContain("cycle/blob");
  expect(await readdir(join(blobsDir(dir), sessionId))).toHaveLength(1);
});

test("a queue left by a restart is handed back to the client that attaches, live, and not again", async () => {
  const slow = gate();
  const first = await start(fakeAgent({ onPrompt: () => slow.closed }));
  const c = await connectClient(first);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("first") });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("second") });
  await until(() => queueUpdates(c.seen).length === 1, "a snapshot");
  // The index says there is a queue before the daemon stops: that is how a restart knows to look.
  await waitFor(
    async () => /"queued":\s*true/.test(await readFile(indexPath(dir), "utf8")),
    "the index",
  );
  await first.close();
  open.length = 0;

  const second = await start(fakeAgent());
  const d = await connectClient(second);
  await d.agent.request(methods.agent.session.resume, {
    sessionId,
    cwd: "/tmp",
    replayFrom: { type: "start" },
  });
  await until(() => handbacks(d.seen).length === 1, "the queue to be handed back");
  const kinds = d.kinds();
  const complete = kinds.indexOf("replay_complete");
  const [replayed] = queueUpdates(d.seen);
  const [live] = handbacks(d.seen);
  // The replay holds the snapshot with the prompt in it; the hand-back came after it, outside the log.
  expect(replayed?.update.entries).toHaveLength(1);
  expect(replayed?.update.returned).toBeUndefined();
  expect(live?.update).toMatchObject({ entries: [], reason: "interrupted" });
  expect(queueTexts({ entries: live?.update.returned ?? [] })).toEqual(["second"]);
  expect(
    d.seen.findIndex((s) => s === d.seen.find((x) => x.update === live?.update)),
  ).toBeGreaterThan(complete);
  expect(live?.seq).toBeUndefined();

  // A third client that replays everything finds an empty queue, and nothing to hand back live.
  const e = await connectClient(second);
  await e.agent.request(methods.agent.session.resume, {
    sessionId,
    cwd: "/tmp",
    replayFrom: { type: "start" },
  });
  expect(queueUpdates(e.seen).at(-1)?.update.entries).toEqual([]);
  await Bun.sleep(30);
  expect(queueUpdates(e.seen).length).toBe(2);
});

test("with nobody attached the queue is held, and handed back when a client comes", async () => {
  const fail = gate();
  const { daemon, c, sessionId, fake } = await working({
    onPrompt: async ({ say }) => {
      await fail.closed;
      await say({ sessionUpdate: "state_update", state: "idle", stopReason: "error" });
      return "ended";
    },
  });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("second") });
  await c.close();
  await c.closed;
  // Let the daemon notice the client is gone before the turn ends.
  await Bun.sleep(50);
  fail.open();
  await Bun.sleep(100);
  const again = await connectClient(daemon);
  await again.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await until(() => handbacks(again.seen).length === 1, "the queue to be handed back");
  expect(handbacks(again.seen)[0]?.update).toMatchObject({ entries: [], reason: "error" });
  expect(queueTexts({ entries: handbacks(again.seen)[0]?.update.returned ?? [] })).toEqual([
    "second",
  ]);
  expect(fake.log.prompts).toEqual(["first"]);
});

// ---- steer: into the running turn (docs/protocol.md §8) ----

const steerPrompt = (sessionId: string, value: string) => ({
  sessionId,
  prompt: text(value),
  _meta: { "cycle/steer": true },
});

test("a steered prompt goes into the running turn, not the queue, where the agent takes it", async () => {
  const { fake, c, sessionId, release } = await working(undefined, { steer: "take" });
  const answer = await c.agent.request(
    methods.agent.session.prompt,
    steerPrompt(sessionId, "mind this"),
  );
  expect(answer._meta).toMatchObject({ "cycle/steered": true });
  expect(answer._meta).not.toHaveProperty("cycle/queued");
  expect(fake.log.steers).toEqual(["mind this"]);
  expect(fake.log.prompts).toEqual(["first"]);
  await until(
    () => c.seen.some((s) => (s.update as { messageId?: string }).messageId === answer.messageId),
    "the steered user message",
  );
  expect(queueUpdates(c.seen)).toEqual([]);
  release();
  await until(() => c.ended() === 1, "the one turn to end");
  expect(fake.log.prompts).toEqual(["first"]);
});

for (const steer of [undefined, "refuse"] as const) {
  test(`a steered prompt is queued when the agent ${steer === undefined ? "cannot steer" : "refuses it"}`, async () => {
    const { fake, c, sessionId, release } = await working(
      undefined,
      steer === undefined ? {} : { steer },
    );
    const answer = await c.agent.request(
      methods.agent.session.prompt,
      steerPrompt(sessionId, "later"),
    );
    expect(answer._meta).toMatchObject({ "cycle/queued": true });
    expect(fake.log.steers).toEqual([]);
    release();
    await until(() => fake.log.prompts.length === 2, "the queued prompt to be sent");
    expect(fake.log.prompts).toEqual(["first", "later"]);
  });
}

test("a steer to a session that is not working is sent as any prompt", async () => {
  const fake = fakeAgent({}, { steer: "take" });
  const daemon = await start(fake);
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, steerPrompt(sessionId, "hello"));
  await until(() => c.ended() === 1, "the turn to end");
  expect(fake.log.prompts).toEqual(["hello"]);
  expect(fake.log.steers).toEqual([]);
});

test("two prompts queued together are announced one entry at a time, each snapshot as it was", async () => {
  const { c, sessionId, release } = await working();
  await Promise.all([
    c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("A") }),
    c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("B") }),
  ]);
  await until(() => queueUpdates(c.seen).length === 2, "two snapshots");
  const snapshots = queueUpdates(c.seen).map((s) => queueTexts(s.update));
  expect(snapshots).toEqual([["A"], ["A", "B"]]);
  release();
});

test("a queue left by a restart, with a prompt sent before anyone attaches, is handed back live to the first client that attaches, once", async () => {
  const slow = gate();
  const first = await start(fakeAgent({ onPrompt: () => slow.closed }));
  const c = await connectClient(first);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("first") });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("second") });
  await until(() => queueUpdates(c.seen).length === 1, "a snapshot");
  await waitFor(
    async () => /"queued":\s*true/.test(await readFile(indexPath(dir), "utf8")),
    "the index",
  );
  await first.close();
  open.length = 0;

  const fake = fakeAgent();
  const second = await start(fake);
  const sender = await connectClient(second);
  // Nobody has attached: this client sends at once, without resuming.
  await sender.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("new") });
  await until(() => fake.log.prompts.includes("new"), "the new prompt to reach the agent");
  // The old queued prompt was not sent on behind it.
  await Bun.sleep(50);
  expect(fake.log.prompts).toEqual(["new"]);

  const live = async (d: Awaited<ReturnType<typeof connectClient>>) => {
    const complete = d.kinds().indexOf("replay_complete");
    return d.seen
      .slice(complete + 1)
      .filter((s) => s.update.sessionUpdate === "_cycle/queue_update")
      .flatMap((s) => (s.update as unknown as QueueUpdate).returned ?? []);
  };
  const d = await connectClient(second);
  await d.agent.request(methods.agent.session.resume, {
    sessionId,
    cwd: "/tmp",
    replayFrom: { type: "start" },
  });
  await waitFor(async () => (await live(d)).length > 0, "the queue to be handed back");
  await Bun.sleep(30);
  expect(queueTexts({ entries: await live(d) })).toEqual(["second"]);

  // Handed back once: the next client to attach is not given it again.
  const e = await connectClient(second);
  await e.agent.request(methods.agent.session.resume, {
    sessionId,
    cwd: "/tmp",
    replayFrom: { type: "start" },
  });
  await Bun.sleep(50);
  expect(await live(e)).toEqual([]);
});

test("a return without a receipt survives restarting the daemon; another connection cannot acknowledge it", async () => {
  const daemon = await start(fakeAgent({ onPrompt: ({ cancelled }) => cancelled }));
  const a = await connectClient(daemon, { ackReturns: true });
  const { sessionId } = await a.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  const watch = { sessionId, cwd: "/tmp", replayFrom: { type: "start" as const } };
  await a.agent.request(methods.agent.session.resume, watch);
  const b = await connectClient(daemon, { ackReturns: true });
  await b.agent.request(methods.agent.session.resume, watch);
  await a.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("working") });
  await b.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("unsent") });
  await b.agent.notify(methods.agent.session.cancel, { sessionId });
  await until(() => handbacks(a.seen).length === 1, "the single recipient");
  const returnId = handbacks(a.seen)[0]?.update.returnId;
  expect(handbacks(b.seen)).toHaveLength(0);
  await b.agent.request("_cycle/prompt/ack_return" as never, { sessionId, returnId } as never);
  await daemon.close();
  open.length = 0;
  const restarted = await start(fakeAgent());
  const c = await connectClient(restarted, { ackReturns: true });
  await c.agent.request(methods.agent.session.resume, watch);
  await until(() => handbacks(c.seen).length === 1, "the unacknowledged batch");
  expect(handbacks(c.seen)[0]?.update).toMatchObject({
    returnId,
    returned: [{ prompt: text("unsent") }],
  });
  await c.agent.request("_cycle/prompt/ack_return" as never, { sessionId, returnId } as never);
  await restarted.close();
  open.length = 0;
  const d = await connectClient(await start(fakeAgent()));
  await d.agent.request(methods.agent.session.resume, watch);
  expect(handbacks(d.seen)).toHaveLength(0);
});
