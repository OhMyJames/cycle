// Draining for an update, in this process (docs/daemon.md "自动更新", CYC-547): prompts sent meanwhile wait, are marked
// `hold: "update"`, and are sent by the daemon that starts after the switch (or by this one, if the switch is called off),
// with no client attached. What was queued before draining is handed back as interrupted, as always.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import type { QueueUpdate } from "@cycle/protocol";
import { indexPath } from "../src/data-dir.ts";
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

const gate = () => {
  let release: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { closed, release };
};

const snapshots = (seen: Seen[]) =>
  seen
    .filter((s) => s.update.sessionUpdate === "_cycle/queue_update")
    .map((s) => s.update as unknown as QueueUpdate);

const texts = (entries: { prompt: unknown[] }[]) =>
  entries.map((e) => (e.prompt[0] as { text: string }).text);

const queuedOnDisk = async () => /"queued":\s*true/.test(await readFile(indexPath(dir), "utf8"));
const untilAsync = async (check: () => Promise<boolean>, what: string) => {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > 3_000) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};

/** A session with a first turn that holds until released, then draining begins, and two prompts are sent. */
const draining = async () => {
  const slow = gate();
  const first = fakeAgent({ onPrompt: () => slow.closed });
  const daemon = await start(first);
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("running") });
  // Queued before draining: not held.
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("before") });
  daemon.setDraining(true);
  const answer = await c.agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: text("during"),
  });
  expect(answer._meta).toMatchObject({ "cycle/queued": true });
  return { first, daemon, c, sessionId, slow };
};

test("draining: a prompt is queued with hold, and the turn that ends does not take the next one", async () => {
  const { first, c, slow } = await draining();
  const last = snapshots(c.seen).at(-1);
  expect(texts(last?.entries ?? [])).toEqual(["before", "during"]);
  expect(last?.hold).toBe("update");
  expect(last?.entries.map((e) => e.hold)).toEqual([undefined, "update"]);
  slow.release();
  await Bun.sleep(80);
  expect(first.log.prompts).toEqual(["running"]);
});

test("draining: an idle session's prompt is queued too, and a new session's first prompt", async () => {
  const fake = fakeAgent();
  const daemon = await start(fake);
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  daemon.setDraining(true);
  const answer = await c.agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: text("held"),
  });
  expect(answer._meta).toMatchObject({ "cycle/queued": true });
  expect(snapshots(c.seen).at(-1)?.hold).toBe("update");
  await Bun.sleep(50);
  expect(fake.log.prompts).toEqual([]);
});

test("after the switch the new daemon sends the held prompts with no client; what came before is handed back", async () => {
  const { daemon, sessionId } = await draining();
  await untilAsync(queuedOnDisk, "the index");
  await daemon.close();
  open.length = 0;

  const second = fakeAgent();
  await start(second);
  await until(() => second.log.prompts.length === 1, "the held prompt to be sent");
  expect(second.log.prompts).toEqual(["during"]);
  expect(second.log.resumes).toHaveLength(1);

  // A client that comes back sees the turn's result and the earlier prompt handed back.
  const d = await connectClient(open[0] as Daemon);
  await d.agent.request(methods.agent.session.resume, {
    sessionId,
    cwd: "/tmp",
    replayFrom: { type: "start" },
  });
  await until(
    () => snapshots(d.seen).some((s) => s.returned?.length),
    "the earlier prompt to be handed back",
  );
  const back = snapshots(d.seen).find((s) => s.returned?.length);
  expect(back?.reason).toBe("interrupted");
  expect(texts(back?.returned ?? [])).toEqual(["before"]);
});

test("held prompts go one after the other", async () => {
  const fake = fakeAgent();
  const daemon = await start(fake);
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  daemon.setDraining(true);
  for (const word of ["one", "two", "three"])
    await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text(word) });
  await untilAsync(queuedOnDisk, "the index");
  await daemon.close();
  open.length = 0;
  const next = fakeAgent();
  await start(next);
  await until(() => next.log.prompts.length === 3, "three prompts");
  expect(next.log.prompts).toEqual(["one", "two", "three"]);
});

test("a switch called off: this daemon sends the held prompts", async () => {
  const fake = fakeAgent();
  const daemon = await start(fake);
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  daemon.setDraining(true);
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("held") });
  daemon.setDraining(false);
  await until(() => fake.log.prompts.length === 1, "the held prompt");
  expect(fake.log.prompts).toEqual(["held"]);
});
