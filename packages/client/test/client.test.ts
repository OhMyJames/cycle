import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { Daemon, listenUnix } from "@cycle/daemon";
import type { DaemonUpdateState } from "@cycle/protocol";
import { fakeAgent } from "../../../apps/daemon/test/fake-agent.ts";
import {
  type Channel,
  CycleClient,
  commandChannel,
  connectUnix,
  type ElicitationAnswer,
  type PermissionAnswer,
  ProtocolMismatchError,
} from "../src/index.ts";
import { connectorsDaemon } from "./fake-connectors-daemon.ts";

let dir: string;
let cleanup: (() => void | Promise<void>)[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cv1-"));
});
afterEach(async () => {
  for (const clean of cleanup.reverse()) await clean();
  cleanup = [];
  await rm(dir, { recursive: true, force: true });
});

const until = async (condition: () => boolean, what: string, ms = 3_000) => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};

const text = (value: string) => [{ type: "text" as const, text: value }];

/** A daemon on a unix socket, and a way to make clients that can be cut off. */
const setup = async (fake = fakeAgent(), extra: { updateState?: () => DaemonUpdateState } = {}) => {
  let daemon = await Daemon.start({ dataDir: dir, agents: [fake.definition], ...extra });
  const socket = join(dir, "d.sock");
  const server = await listenUnix({
    path: socket,
    onConnection: ({ stream }) => void daemon.accept(stream),
  });
  cleanup.push(async () => {
    server.close();
    await daemon.close();
  });
  const channels: Channel[] = [];
  let down = false;
  const connect = async () => {
    if (down) throw new Error("the network is down");
    const channel = await connectUnix(socket);
    channels.push(channel);
    return channel;
  };
  const make = (
    events: ConstructorParameters<typeof CycleClient>[0]["events"] = {},
    more: { promptWaitMs?: number } = {},
  ) => {
    const client = new CycleClient({ connect, events, backoff: { first: 10, max: 50 }, ...more });
    cleanup.push(() => client.close());
    return client;
  };
  return {
    fake,
    make,
    announce: () => daemon.announceUpdate(),
    /** Cuts every connection, as a network drop would. */
    drop: () => {
      for (const channel of channels.splice(0)) channel.close();
    },
    network: (up: boolean) => {
      down = !up;
    },
    /** Stops the daemon and starts another on the same data, which reads every history afresh. */
    restart: async () => {
      await daemon.close();
      daemon = await Daemon.start({ dataDir: dir, agents: [fake.definition] });
    },
  };
};

/** The seq of each record seen. replay_complete marks a place and is not a record. */
const seqs = (seen: { update: SessionUpdate; seq: number | undefined }[]) =>
  seen
    .filter((s) => s.seq !== undefined && s.update.sessionUpdate !== "replay_complete")
    .map((s) => s.seq);

test("starts, makes a session, and shows a turn as it happens", async () => {
  const { make } = await setup();
  const seen: { update: SessionUpdate; seq: number | undefined }[] = [];
  const client = make({ update: (_id, update, seq) => seen.push({ update, seq }) });
  await client.start();
  expect(client.state).toBe("connected");
  expect(client.capabilities).toMatchObject({ agents: ["fake"] });
  const sessionId = await client.newSession({ cwd: "/tmp" });
  await client.watch(sessionId, "/tmp");
  await client.prompt(sessionId, text("hi"));
  await until(
    () => seen.some((s) => (s.update as { stopReason?: string }).stopReason === "end_turn"),
    "the turn",
  );
  expect(seqs(seen)).toEqual([2, 3, 4, 5]);
  expect((await client.listSessions()).map((s) => s.sessionId)).toEqual([sessionId]);
});

test("an older daemon supplies its complete list once and unsupported filters are explicit", async () => {
  const old = await connectorsDaemon(dir, { capable: false });
  const client = new CycleClient({ connect: () => connectUnix(old.socket) });
  cleanup.push(
    () => old.close(),
    () => client.close(),
  );
  await client.start();
  const pages = [];
  for await (const page of client.sessionPages()) pages.push(page);
  expect(pages).toEqual([{ sessions: [], hasMore: false }]);
  await expect(client.sessionPages({ agent: "claude" }).next()).rejects.toThrow(
    "does not support session list filters",
  );
});

test("after a drop it reconnects and shows what it missed once, in order", async () => {
  const { make, drop } = await setup();
  const states: string[] = [];
  const seen: { update: SessionUpdate; seq: number | undefined }[] = [];
  const watcher = make({
    update: (_id, update, seq) => seen.push({ update, seq }),
    connection: (state) => states.push(state),
  });
  await watcher.start();
  const sessionId = await watcher.newSession({ cwd: "/tmp" });
  await watcher.watch(sessionId, "/tmp");
  await watcher.prompt(sessionId, text("one"));
  await until(() => seqs(seen).length === 4, "the first turn");

  // Everyone's connection is cut; another client carries on while this one is away.
  const other = make();
  await other.start();
  drop();
  await until(() => states.includes("reconnecting"), "the loss to be noticed");
  await until(() => watcher.state === "connected", "the reconnect");
  await other.start().catch(() => undefined);
  await until(() => other.state === "connected", "the other client to be back");
  await other.watch(sessionId, "/tmp");
  await other.prompt(sessionId, text("two"));
  await until(() => seqs(seen).length === 8, "the second turn");

  // Each record once, in order, with no gap and no repeat.
  expect(seqs(seen)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  expect(states).toEqual(["connecting", "connected", "reconnecting", "connected"]);
});

test("what happened while it was away is delivered when it comes back", async () => {
  const { make, drop, network } = await setup();
  const seen: { update: SessionUpdate; seq: number | undefined }[] = [];
  const watcher = make({ update: (_id, update, seq) => seen.push({ update, seq }) });
  await watcher.start();
  const sessionId = await watcher.newSession({ cwd: "/tmp" });
  await watcher.watch(sessionId, "/tmp");

  const other = make();
  await other.start();
  await other.watch(sessionId, "/tmp");
  network(false);
  drop();
  await until(() => watcher.state === "reconnecting", "the loss");
  // The other client was cut too; wait for it, then let only it back.
  network(true);
  await until(() => other.state === "connected", "the other client");
  await other.prompt(sessionId, text("while you were out"));
  await until(
    () => seqs(seen).length === 4,
    "the turn to be shown to the one that was away",
    5_000,
  );
  expect(seqs(seen)).toEqual([2, 3, 4, 5]);
});

test("a permission request is answered by the handler", async () => {
  const outcomes: unknown[] = [];
  const fake = fakeAgent({
    onPrompt: async ({ ask }) => {
      outcomes.push(await ask());
    },
  });
  const { make } = await setup(fake);
  const asked: string[] = [];
  const client = make({
    permission: async (sessionId): Promise<PermissionAnswer> => {
      asked.push(sessionId);
      return { outcome: "selected", optionId: "allow" };
    },
  });
  await client.start();
  const sessionId = await client.newSession({ cwd: "/tmp" });
  await client.watch(sessionId, "/tmp");
  await client.prompt(sessionId, text("ask"));
  await until(() => outcomes.length === 1, "the answer");
  expect(asked).toEqual([sessionId]);
  expect(outcomes[0]).toMatchObject({ outcome: { outcome: "selected", optionId: "allow" } });
});

test("a request left open by a dropped connection is asked again after the reconnect", async () => {
  const outcomes: unknown[] = [];
  const fake = fakeAgent({
    onPrompt: async ({ ask }) => {
      outcomes.push(await ask());
    },
  });
  const { make, drop } = await setup(fake);
  let asked = 0;
  const client = make({
    permission: async (): Promise<PermissionAnswer> => {
      asked++;
      // The first time the user is slow, and the connection goes before they answer.
      if (asked === 1) return new Promise<PermissionAnswer>(() => {});
      return { outcome: "selected", optionId: "allow" };
    },
  });
  await client.start();
  const sessionId = await client.newSession({ cwd: "/tmp" });
  await client.watch(sessionId, "/tmp");
  await client.prompt(sessionId, text("ask"));
  await until(() => asked === 1, "the first ask");
  drop();
  await until(() => asked === 2, "the second ask, after the reconnect", 5_000);
  await until(() => outcomes.length === 1, "the agent to be answered");
  expect(outcomes[0]).toMatchObject({ outcome: { outcome: "selected", optionId: "allow" } });
});

test("start fails if the daemon cannot be reached, and close stops retrying", async () => {
  const { make, network } = await setup();
  network(false);
  const client = make();
  await expect(client.start()).rejects.toThrow("the network is down");
  expect(client.state).toBe("closed");

  network(true);
  const second = make();
  await second.start();
  network(false);
  const states: string[] = [];
  const third = make({ connection: (s) => states.push(s) });
  network(true);
  await third.start();
  network(false);
  await third.close();
  expect(third.state).toBe("closed");
});

test("reads and sets an agent's defaults, and hears of a change made by someone else", async () => {
  const { make } = await setup();
  const heard: string[] = [];
  const a = make({ defaultsChanged: (agent) => heard.push(agent) });
  const b = make();
  await a.start();
  await b.start();
  expect(await a.agentDefaults("fake")).toEqual({});
  await b.setAgentDefaults("fake", { mode: "plan" });
  expect(await a.agentDefaults("fake")).toEqual({ mode: "plan" });
  await until(() => heard.length === 1, "the change");
  expect(heard).toEqual(["fake"]);
});

test("a command that cannot run fails with what it said, not only that the connection ended", async () => {
  const client = new CycleClient({
    connect: async () =>
      commandChannel({
        command: [
          "/bin/sh",
          "-c",
          "echo 'sh: /home/u/.local/bin/cycle-daemon: No such file or directory' >&2; exit 127",
        ],
      }),
  });
  await expect(client.start()).rejects.toThrow(/cycle-daemon: No such file or directory/);
});

test("a client with a form handler is asked forms; one without is not, and the agent is told", async () => {
  const answers: unknown[] = [];
  const fake = fakeAgent({
    onPrompt: async ({ elicit }) => {
      answers.push(await elicit());
    },
  });
  const { make } = await setup(fake);

  // Without the handler the client does not claim the capability: nobody is asked, nobody waits.
  const plain = make();
  await plain.start();
  const sessionId = await plain.newSession({ cwd: "/tmp" });
  await plain.watch(sessionId, "/tmp");
  await plain.prompt(sessionId, text("ask"));
  await until(() => answers.length === 1, "the agent to be answered");
  expect(answers[0]).toEqual({ action: "cancel", _meta: { "cycle/noClient": true } });
  await plain.close();

  const asked: Record<string, unknown>[] = [];
  const client = make({
    elicitation: async (_id, request): Promise<ElicitationAnswer> => {
      asked.push(request);
      return { action: "accept", content: { pick: "b" } };
    },
  });
  await client.start();
  await client.watch(sessionId, "/tmp");
  await Bun.sleep(30); // the first turn is over
  await client.prompt(sessionId, text("ask again"));
  await until(() => answers.length === 2, "the agent to be answered again");
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({ mode: "form", message: "Which one?" });
  expect(answers[1]).toEqual({ action: "accept", content: { pick: "b" } });
});

test("marks a session read, and clears its unread mark in the list", async () => {
  const { make } = await setup();
  const seen: { update: SessionUpdate; seq: number | undefined }[] = [];
  const client = make({ update: (_id, update, seq) => seen.push({ update, seq }) });
  await client.start();
  const sessionId = await client.newSession({ cwd: "/tmp" });
  await client.watch(sessionId, "/tmp");
  await client.prompt(sessionId, text("hi"));
  await until(
    () => seen.some((s) => (s.update as { stopReason?: string }).stopReason === "end_turn"),
    "the turn",
  );
  const unread = async () => {
    const row = (await client.listSessions()).find((s) => s.sessionId === sessionId);
    return row?._meta?.["cycle/unread"];
  };
  expect(await unread()).toBe(true);
  const last = seqs(seen).at(-1);
  if (last === undefined) throw new Error("no record seen");
  await client.markRead(sessionId, last);
  expect(await unread()).toBe(false);
});

test("a watched session deleted by another client while this one was away does not keep the host from reconnecting", async () => {
  const { make, drop, network } = await setup();
  const states: string[] = [];
  const gone: string[] = [];
  const seen: { update: SessionUpdate; seq: number | undefined }[] = [];
  const a = make({
    connection: (s) => states.push(s),
    gone: (id) => gone.push(id),
    update: (id, update, seq) => {
      if (id === healthy) seen.push({ update, seq });
    },
  });
  await a.start();
  const healthy = await a.newSession({ cwd: "/tmp" });
  const doomed = await a.newSession({ cwd: "/tmp" });
  await a.watch(healthy, "/tmp");
  await a.watch(doomed, "/tmp");
  // Another client has its own way in, so it can act while this one's network is down.
  const other = new CycleClient({
    connect: () => connectUnix(join(dir, "d.sock")),
    backoff: { first: 10, max: 50 },
  });
  cleanup.push(() => other.close());
  await other.start();
  network(false);
  drop();
  await until(() => states.includes("reconnecting"), "the loss to be noticed");
  await other.delete(doomed);
  network(true);
  await until(() => a.state === "connected", "the reconnect");

  // It says so once, and is connected only now: not once per attempt, and not before it is done.
  expect(gone).toEqual([doomed]);
  expect(states.at(-1)).toBe("connected");
  expect(states.filter((s) => s === "connected")).toHaveLength(2);
  // The healthy session is attached again and carries on.
  await other.watch(healthy, "/tmp");
  await other.prompt(healthy, text("still there"));
  await until(
    () => seen.some((s) => (s.update as { stopReason?: string }).stopReason === "end_turn"),
    "the healthy session to go on",
  );
  // And the next drop does not ask for the deleted one again.
  drop();
  await until(() => states.filter((s) => s === "connected").length === 3, "the next reconnect");
  expect(gone).toEqual([doomed]);
});

test("watching a session that is not there fails, and it is not kept for the next reconnect", async () => {
  const { make, drop } = await setup();
  const states: string[] = [];
  const gone: string[] = [];
  const a = make({ connection: (s) => states.push(s), gone: (id) => gone.push(id) });
  await a.start();
  await expect(a.watch("00000000-0000-4000-8000-000000000000", "/tmp")).rejects.toMatchObject({
    code: -32002,
  });
  drop();
  await until(() => states.filter((s) => s === "connected").length === 2, "the reconnect");
  expect(gone).toEqual([]);
});

test("a watched session whose history cannot be read does not keep the host from reconnecting", async () => {
  const { make, drop, network, restart } = await setup();
  const states: string[] = [];
  const unreadable: string[] = [];
  const seen: { update: SessionUpdate; seq: number | undefined }[] = [];
  const a = make({
    connection: (s) => states.push(s),
    unreadable: (id) => unreadable.push(id),
    update: (id, update, seq) => {
      if (id === healthy) seen.push({ update, seq });
    },
  });
  await a.start();
  const healthy = await a.newSession({ cwd: "/tmp" });
  const damaged = await a.newSession({ cwd: "/tmp" });
  await a.watch(healthy, "/tmp");
  await a.watch(damaged, "/tmp");
  // The line is whole and not JSON: not the half line a crash leaves, which is cut off and forgiven.
  network(false);
  drop();
  await until(() => states.includes("reconnecting"), "the loss to be noticed");
  await restart();
  await appendFile(join(dir, "sessions", `${damaged}.jsonl`), "this is not a record\n");
  network(true);
  await until(() => a.state === "connected", "the reconnect");

  expect(unreadable).toEqual([damaged]);
  expect(states.filter((s) => s === "connected")).toHaveLength(2);
  // The healthy one is attached again and carries on.
  const other = new CycleClient({
    connect: () => connectUnix(join(dir, "d.sock")),
    backoff: { first: 10, max: 50 },
  });
  cleanup.push(() => other.close());
  await other.start();
  await other.watch(healthy, "/tmp");
  await other.prompt(healthy, text("still there"));
  await until(
    () => seen.some((s) => (s.update as { stopReason?: string }).stopReason === "end_turn"),
    "the healthy session to go on",
  );
  // It is not asked for again at the next drop, and the list says what is wrong with it.
  drop();
  await until(() => states.filter((s) => s === "connected").length === 3, "the next reconnect");
  expect(unreadable).toEqual([damaged]);
  const row = (await a.listSessions()).find((s) => s.sessionId === damaged);
  expect(row?._meta?.["cycle/historyFailed"]).toBe(true);
});

test("a delete the daemon refuses leaves the session watched, so a reconnect still brings what comes next", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { make, drop } = await setup(fakeAgent({ onPrompt: () => held }));
  const states: string[] = [];
  const seen: { update: SessionUpdate; seq: number | undefined }[] = [];
  const a = make({
    connection: (s) => states.push(s),
    update: (_id, update, seq) => seen.push({ update, seq }),
  });
  await a.start();
  const sessionId = await a.newSession({ cwd: "/tmp" });
  await a.watch(sessionId, "/tmp");
  await a.prompt(sessionId, text("slow"));
  await until(
    () => seen.some((s) => (s.update as { state?: string }).state === "running"),
    "the turn to be running",
  );
  await expect(a.delete(sessionId)).rejects.toMatchObject({ code: -32010 });
  drop();
  await until(() => states.filter((s) => s === "connected").length === 2, "the reconnect");
  release();
  await until(
    () => seen.some((s) => (s.update as { stopReason?: string }).stopReason === "end_turn"),
    "the turn to end, as seen after the reconnect",
  );
});

/** A client whose dials wait for the test to let them through. */
const gated = async () => {
  await setup();
  const socket = join(dir, "d.sock");
  const gates: (() => void)[] = [];
  let hold = false;
  const channels: Channel[] = [];
  const states: string[] = [];
  const client = new CycleClient({
    connect: async () => {
      if (hold) await new Promise<void>((resolve) => gates.push(resolve));
      const channel = await connectUnix(socket);
      channels.push(channel);
      return channel;
    },
    events: { connection: (s) => states.push(s) },
    backoff: { first: 10, max: 50 },
  });
  cleanup.push(() => client.close());
  return {
    client,
    states,
    hold: (on: boolean) => {
      hold = on;
    },
    release: () => {
      for (const open of gates.splice(0)) open();
    },
    dialling: () => gates.length,
    /** Cuts the line the client is on. */
    cut: () => channels.at(-1)?.close(),
  };
};

test("closing a client that is still dialling leaves it closed", async () => {
  const g = await gated();
  g.hold(true);
  const starting = g.client.start();
  starting.catch(() => undefined);
  await until(() => g.dialling() === 1, "the dial to be waiting");
  await g.client.close();
  g.release();
  await expect(starting).rejects.toThrow();
  await Bun.sleep(50);
  expect(g.client.state).toBe("closed");
  expect(g.states).not.toContain("connected");
  await expect(g.client.listSessions()).rejects.toThrow("Not connected");
});

test("closing a client that is reconnecting leaves it closed", async () => {
  const g = await gated();
  await g.client.start();
  g.hold(true);
  g.cut();
  await until(() => g.dialling() === 1, "the reconnect to be dialling");
  await g.client.close();
  g.release();
  await Bun.sleep(100);
  expect(g.client.state).toBe("closed");
  expect(g.states.at(-1)).toBe("closed");
  expect(g.states.filter((s) => s === "connected")).toHaveLength(1);
  await expect(g.client.listSessions()).rejects.toThrow("Not connected");
});

test("a daemon that speaks another major version of the protocol is refused with what it speaks, and a client that is connected stays reconnecting and says so", async () => {
  await setup();
  const socket = join(dir, "d.sock");
  // A client from the future: it asks for protocol 1.0 of a daemon that speaks 0.x.
  const future = new CycleClient({
    connect: () => connectUnix(socket),
    protocolVersion: "1.0",
    backoff: { first: 10, max: 50 },
  });
  cleanup.push(() => future.close());
  const failure = await future.start().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(ProtocolMismatchError);
  expect(failure).toMatchObject({ code: -32022, supported: ["0.2"], requested: "1.0" });
  expect(future.state).toBe("closed");

  // One that was connected and meets it on reconnecting (the daemon was replaced by another build): the connection event
  // carries the same error, once per attempt, and it keeps trying, so the next daemon is found.
  const errors: unknown[] = [];
  const channels: Channel[] = [];
  const options: ConstructorParameters<typeof CycleClient>[0] = {
    connect: async () => {
      const channel = await connectUnix(socket);
      channels.push(channel);
      return channel;
    },
    events: { connection: (_state, error) => error !== undefined && errors.push(error) },
    backoff: { first: 10, max: 50 },
  };
  const a = new CycleClient(options);
  cleanup.push(() => a.close());
  await a.start();
  options.protocolVersion = "1.0";
  for (const channel of channels) channel.close();
  await until(
    () => errors.some((e) => e instanceof ProtocolMismatchError),
    "the mismatch to be said",
  );
  expect(a.state).toBe("reconnecting");
  delete options.protocolVersion;
  await until(() => a.state === "connected", "the right protocol to be found again");
});

test('a worktree is asked for with the session, its branches are listed, and a refusal says why (docs/protocol.md §6 "Worktree")', async () => {
  const { make } = await setup();
  const client = make();
  await client.start();
  expect(client.capabilities).toMatchObject({ worktrees: true });
  // /tmp is no repository: the daemon says so, in a reason the page has a sentence for.
  await expect(client.gitBranches("/tmp")).rejects.toMatchObject({
    data: { reason: "not_a_repository" },
  });
  await expect(client.newSession({ cwd: "/tmp", worktree: {} })).rejects.toMatchObject({
    data: { reason: "not_a_repository" },
  });
});

test("a prompt sent while the connection is being re-made is sent once it is back", async () => {
  const { make, drop, network } = await setup();
  const seen: { update: SessionUpdate }[] = [];
  const states: string[] = [];
  const client = make({
    update: (_id, update) => seen.push({ update }),
    connection: (state) => states.push(state),
  });
  await client.start();
  const sessionId = await client.newSession({ cwd: "/tmp" });
  await client.watch(sessionId, "/tmp");
  network(false);
  drop();
  await until(() => client.state === "reconnecting", "the loss");
  const sent = client.prompt(sessionId, text("hi"));
  await Bun.sleep(60);
  network(true);
  expect(typeof (await sent)).toBe("string");
  expect(client.state).toBe("connected");
  await until(
    () => seen.some((s) => (s.update as { stopReason?: string }).stopReason === "end_turn"),
    "the turn",
  );
});

test("a prompt sent while the connection stays down fails after the wait", async () => {
  const { make, drop, network } = await setup();
  const client = make({}, { promptWaitMs: 80 });
  await client.start();
  const sessionId = await client.newSession({ cwd: "/tmp" });
  network(false);
  drop();
  await until(() => client.state === "reconnecting", "the loss");
  const started = Date.now();
  await expect(client.prompt(sessionId, text("hi"))).rejects.toThrow("Not connected");
  expect(Date.now() - started).toBeGreaterThanOrEqual(70);
});

test("the update state is read, and its notification reaches a client that has a handler", async () => {
  let state: DaemonUpdateState = { version: "1.2.3", updates: "on" };
  const { make, announce } = await setup(fakeAgent(), { updateState: () => state });
  const told: DaemonUpdateState[] = [];
  const listening = make({ daemonUpdate: (s) => told.push(s) });
  const deaf = make();
  await listening.start();
  await deaf.start();
  expect(listening.capabilities).toMatchObject({ selfUpdateDrain: true });
  state = {
    version: "1.2.3",
    updates: "on",
    pending: {
      version: "1.3.0",
      state: "draining",
      since: "2026-11-28T00:00:00Z",
      forceAt: "2026-11-28T00:15:00Z",
    },
  };
  expect(await deaf.readDaemonUpdate()).toEqual(state);
  announce();
  await until(() => told.length === 1, "the notification");
  expect(told[0]).toEqual(state);
});
