// The fixed samples of CYCL-50, through the real path: a fake agent says them to a daemon, and the app's main process
// (ConnectionManager) builds the conversation from what the daemon sends. Each must come out the same live, replayed
// from the log, and after a dropped connection: no repeat, nothing missing.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Channel, connectUnix } from "@cycle/client";
import { Daemon, listenUnix } from "@cycle/daemon";
import {
  type AppEvent,
  applyUpdate,
  blocksOf,
  type Conversation,
  emptyConversation,
  toolFacts,
} from "@cycle/ui";
import {
  AFTER_ANSWERS,
  BEFORE_DROP,
  OLD_ENTRY,
  OLD_JSONL,
  OLD_SESSION_ID,
  OLD_UPDATES_SENT,
  PARALLEL,
  PARALLEL_PROMPT,
  RECONNECT_PROMPT,
  WHILE_AWAY,
} from "../../../packages/ui/test/samples.ts";
import { fakeAgent } from "../../daemon/test/fake-agent.ts";
import { ConnectionManager } from "../src/main/manager.ts";
import { fileSettings } from "../src/main/settings.ts";

let dir: string;
let cleanup: (() => void | Promise<void>)[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cv1-samples-"));
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

const of = <T extends AppEvent["type"]>(events: AppEvent[], type: T) =>
  events.filter((e): e is Extract<AppEvent, { type: T }> => e.type === type);

/** A daemon with a fake agent on a socket, and app main processes that reach it; each one's line can be cut alone. */
const setup = async (fake = fakeAgent()) => {
  const daemon = await Daemon.start({ dataDir: join(dir, "daemon"), agents: [fake.definition] });
  const socket = join(dir, "d.sock");
  const server = await listenUnix({
    path: socket,
    onConnection: ({ stream }) => void daemon.accept(stream),
  });
  cleanup.push(async () => {
    server.close();
    await daemon.close();
  });
  const channels = new Map<string, Channel[]>();
  const held = new Set<string>();
  const app = async (name: string) => {
    const events: AppEvent[] = [];
    const m = new ConnectionManager({
      settings: fileSettings(join(dir, `settings-${name}.json`)),
      channelFor: () => async () => {
        if (held.has(name)) throw new Error("the network is down");
        const channel = await connectUnix(socket);
        channels.set(name, [...(channels.get(name) ?? []), channel]);
        return channel;
      },
      emit: (event) => events.push(event),
      backoff: { first: 10, max: 40 },
    });
    await m.init();
    cleanup.push(() => m.close());
    await m.connect("local");
    return { m, events };
  };
  return {
    app,
    /** This app's line goes, and stays down until `back`. */
    away: (name: string) => {
      held.add(name);
      for (const channel of channels.get(name)?.splice(0) ?? []) channel.close();
    },
    back: (name: string) => held.delete(name),
  };
};

/** What a conversation shows: the parts the page draws, without what only says how it was arrived at. */
const shown = (c: Conversation) => ({
  items: c.items,
  turns: c.turns,
  stops: c.stops,
  status: c.status,
  usage: c.usage,
  queue: c.queue,
});

const snapshot = async (m: ConnectionManager, id: string) =>
  (await m.openSession("local", id)).conversation;

/** The conversation once its first turn has ended, as this app has it. */
const turnEnded = async (m: ConnectionManager, id: string, turns = 1): Promise<Conversation> => {
  const started = Date.now();
  for (;;) {
    const c = await snapshot(m, id);
    if (c.turns >= turns) return c;
    if (Date.now() - started > 3_000) throw new Error("timed out waiting for the turn to end");
    await Bun.sleep(10);
  }
};

/** A gate a fake agent waits at, opened by the test. */
const gate = () => {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open: () => open(), opened };
};

test("calls made together with results out of order: one card in call order, counts only where whose they are is known", async () => {
  const { app } = await setup(
    fakeAgent({
      onPrompt: async ({ say }) => {
        for (const update of PARALLEL) await say(update);
      },
    }),
  );
  const live = await app("live");
  const id = await live.m.createSession("local", { cwd: "/tmp" });
  await live.m.openSession("local", id);
  await live.m.prompt("local", id, PARALLEL_PROMPT);
  const liveConversation = await turnEnded(live.m, id);

  // Replayed from the log by an app that was not there.
  const late = await app("late");
  const replayed = await snapshot(late.m, id);
  expect(shown(replayed)).toEqual(shown(liveConversation));

  const blocks = blocksOf(liveConversation);
  const work = blocks.find((b) => b.kind === "work");
  // One card for the three, in the order they were called, not the order they came back.
  expect(work?.kind === "work" ? work.tools.map((t) => t.id) : []).toEqual(["a", "b", "c"]);
  const tools = work?.kind === "work" ? work.tools : [];
  expect(tools.map((t) => t.status)).toEqual(["completed", "completed", "completed"]);
  // a and b came back together: no counts for either. c came back alone: its own (the lines it read).
  expect(toolFacts(tools[0] as never).read).toBeUndefined();
  expect(toolFacts(tools[1] as never).search).toBeUndefined();
  expect(toolFacts(tools[2] as never).read).toMatchObject({ start: 262, total: 640 });
});

test("a turn the app was away from: back, it shows what it missed once, and the open requests once", async () => {
  const dropped = gate();
  const reconnected = gate();
  const answered: unknown[] = [];
  const { app, away, back } = await setup(
    fakeAgent({
      onPrompt: async ({ say, ask, elicit }) => {
        for (const update of BEFORE_DROP) await say(update);
        const permission = ask({ toolCall: { toolCallId: "t1", name: "Bash" } });
        await dropped.opened;
        for (const update of WHILE_AWAY) await say(update);
        const form = elicit();
        await reconnected.opened;
        answered.push(await permission, await form);
        for (const update of AFTER_ANSWERS) await say(update);
      },
    }),
  );
  const stayed = await app("stayed");
  const left = await app("left");
  const id = await stayed.m.createSession("local", { cwd: "/tmp" });
  await stayed.m.openSession("local", id);
  await stayed.m.prompt("local", id, RECONNECT_PROMPT);
  // The other app sees the session once its first message is on record (docs/protocol.md §6), and opens it.
  const started = Date.now();
  while (!(await left.m.sessions("local")).some((s) => s.sessionId === id)) {
    if (Date.now() - started > 3_000)
      throw new Error("timed out waiting for the session to be listed");
    await Bun.sleep(10);
  }
  await left.m.openSession("local", id);
  await until(() => of(left.events, "permission").length === 1, "the request, before the drop");

  away("left");
  await until(
    () => of(left.events, "location-status").some((e) => e.state === "reconnecting"),
    "the drop to be noticed",
  );
  dropped.open();
  await until(() => of(stayed.events, "permission").length === 2, "the form, while it was away");
  back("left");
  await until(
    () => of(left.events, "location-status").at(-1)?.state === "connected",
    "the reconnect",
  );
  await until(() => of(left.events, "permission").length >= 2, "the form, after the reconnect");
  await Bun.sleep(100);

  // The same conversation as the one that never left: the command's end, the sub-agent's progress, the edit going.
  const a = await left.m.openSession("local", id);
  const b = await stayed.m.openSession("local", id);
  expect(shown(a.conversation)).toEqual(shown(b.conversation));
  // Waiting on the person, for both: the one that stayed was told as the one that came back was.
  expect(b.conversation.status).toBe("requires_action");
  const t1 = a.conversation.items.find((i) => i.kind === "tool" && i.id === "t1");
  expect(t1?.kind === "tool" ? t1.status : undefined).toBe("failed");
  const t2 = a.conversation.items.find((i) => i.kind === "tool" && i.id === "t2");
  expect(t2?.kind === "tool" ? t2.subagent?.usage?.toolUses : undefined).toBe(3);
  expect(a.conversation.items.filter((i) => i.kind === "tool").map((i) => i.id)).toEqual([
    "t1",
    "t2",
    "t3",
  ]);
  // Each request once: the permission asked before the drop and the form asked while away.
  expect(a.permissions.map((p) => p.key).sort()).toEqual(b.permissions.map((p) => p.key).sort());
  expect(a.permissions).toHaveLength(2);
  expect(new Set(of(left.events, "permission").map((e) => e.request.key)).size).toBe(2);

  // Answered from either side, and the turn ends the same for both.
  const permission = a.permissions.find((p) => p.form === undefined);
  const form = a.permissions.find((p) => p.form !== undefined);
  if (permission === undefined || form === undefined)
    throw new Error("both requests should be open");
  await left.m.answerPermission(permission.key, "allow");
  await stayed.m.answerForm(form.key, { pick: "queue.test.ts" });
  // Nothing waits on the person any more: neither shows it does, though the agent has said nothing yet.
  for (const x of [left, stayed]) {
    const started = Date.now();
    while ((await snapshot(x.m, id)).status === "requires_action") {
      if (Date.now() - started > 3_000) throw new Error("timed out waiting for the wait to end");
      await Bun.sleep(10);
    }
    expect((await snapshot(x.m, id)).status).toBe("running");
  }
  reconnected.open();
  const endA = await turnEnded(left.m, id);
  const endB = await turnEnded(stayed.m, id);
  expect(shown(endA)).toEqual(shown(endB));
  expect(answered).toHaveLength(2);
  // And the same again replayed by an app that saw none of it.
  const late = await app("late");
  expect(shown(await snapshot(late.m, id))).toEqual(shown(endA));
  expect((await late.m.openSession("local", id)).permissions).toEqual([]);
}, 15_000);

test("a history written before 0.3.5 is replayed as it was written, and draws in the plain style", async () => {
  // The data directory as daemon 0.3.4 left it.
  const data = join(dir, "daemon");
  await mkdir(join(data, "sessions"), { recursive: true });
  await writeFile(join(data, "sessions", `${OLD_SESSION_ID}.jsonl`), OLD_JSONL);
  await writeFile(
    join(data, "index.json"),
    JSON.stringify({ version: 1, sessions: { [OLD_SESSION_ID]: OLD_ENTRY } }),
  );
  const { app } = await setup();
  const { m } = await app("app");
  const replayed = await snapshot(m, OLD_SESSION_ID);
  // What the daemon sends is the log's updates as they are: the same conversation as reading the file.
  // Each with its record's time (`cycle/ts` is the log line's `ts`).
  const times = OLD_JSONL.trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { kind: string; ts: string })
    .filter((r) => r.kind === "update")
    .map((r) => Date.parse(r.ts));
  const direct = OLD_UPDATES_SENT.reduce(
    (c, u, i) => applyUpdate(c, u, { at: times[i] }),
    emptyConversation(),
  );
  expect(shown(replayed)).toEqual(shown(direct));
  expect(replayed.ignored).toBe(0);
  expect(replayed.turns).toBe(2);
  expect(replayed.stops.map((s) => s.stopReason)).toEqual(["end_turn", "error"]);
  // No counts, no diff: an edit and a read are plain rows, with what they returned as text.
  const tools = replayed.items.filter((i) => i.kind === "tool");
  for (const tool of tools) expect(tool.kind === "tool" && tool.result).toBeFalsy();
  // Laid out without trouble; the TaskCreate of then (kind `other`) is a row, as it was then (see docs/conversation-content.md).
  const blocks = blocksOf(replayed);
  expect(blocks.map((b) => b.kind)).toContain("end");
  const rows = blocks.flatMap((b) =>
    b.kind === "work" ? b.tools : b.kind === "failed" ? [b.tool] : [],
  );
  expect(rows.map((t) => t.name)).toEqual(["TaskCreate", "Read", "Edit", "Bash", "Bash"]);
});
