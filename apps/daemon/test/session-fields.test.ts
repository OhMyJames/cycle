import { expect, test } from "bun:test";
import type { AgentSession, Session, Settings, WorktreeInfo } from "@cycle/protocol";
import { Git, JsonStore, type MetaFile, SessionHub, UsageLedger } from "../src/index.ts";
import { FakeHarness, manualSchedule } from "./fake-harness.ts";

type SessionMeta = MetaFile["sessions"][string];

/**
 * Which side wins each field of a session the daemon joins from its agent's record and from its own
 * `sessions.json` (`remember()`): pinned here so that moving a field changes a known thing.
 */

const memory = () => ({ read: async () => null, write: async () => {} });

async function setup(
  options: { meta?: Record<string, SessionMeta>; modes?: Settings["modes"] } = {},
) {
  const harness = new FakeHarness();
  const timers = manualSchedule();
  const settings: Settings = {
    model: null,
    effort: null,
    modes: options.modes ?? {},
    worktree: false,
    projects: [],
  };
  const meta = await JsonStore.open<MetaFile>(
    memory(),
    { sessions: options.meta ?? {} },
    timers.schedule,
  );
  const hub = new SessionHub({
    harness: harness.asAgents(),
    meta,
    settings: () => settings,
    usage: new UsageLedger(await JsonStore.open(memory(), { days: {} }, timers.schedule), () => 0),
    git: new Git((argv, execOptions) => harness.exec(argv, execOptions)),
    worktreeParent: "/home/worktrees",
    schedule: timers.schedule,
    now: () => 1000,
    log: () => {},
    viewers: () => 0,
    publish: { frame: () => {}, sessions: () => {}, removed: () => {}, usage: () => {} },
  });
  /** Lists the agent's records, and returns the one of the session `s1`. */
  const listed = async (...records: AgentSession[]) => {
    harness.stored = records;
    const list = await hub.list(false);
    return list.find((info) => info.id === "s1") as Session;
  };
  /** Opens the session `s1` as the agent loads it from a record. */
  const opened = async (record: AgentSession) => {
    harness.loadSession = async () => ({ session: record, turns: [], usage: null });
    const result = await hub.open(record.id, undefined);
    if (!("state" in result)) throw new Error("a first open gives the state");
    return result.state.info;
  };
  return { harness, hub, meta, listed, opened };
}

const worktree: WorktreeInfo = { repo: "/repo", base: "abc", branch: "cycle/meta" };

/** What the agent keeps of a session, each field set so that a winner can be told from a loser. */
const agentRecord = (harness: FakeHarness, patch: Partial<AgentSession> = {}) =>
  harness.session("s1", {
    title: "agent title",
    preview: "agent preview",
    cwd: "/agent/cwd",
    model: "agent-model",
    effort: "low",
    branch: "agent-branch",
    sandbox: "agent-sandbox",
    sandboxCwd: "/home/agent/workspace/x",
    createdAt: 10,
    updatedAt: 20,
    forkedFrom: "parent",
    tag: "agent-tag",
    ...patch,
  });

/** What Cycle keeps of the same session, each field set differently from the agent's. */
const cycleMeta: SessionMeta = {
  title: "meta title",
  model: "meta-model",
  effort: "high",
  agentMode: "readOnly",
  worktree,
  sandbox: "meta-sandbox",
  directories: ["/extra"],
  pinned: true,
  unread: true,
  scheduleId: "sched",
};

test("with both sides set, Cycle wins title, model, effort, branch and sandbox", async () => {
  const { harness, listed } = await setup({ meta: { s1: cycleMeta } });
  const info = await listed(agentRecord(harness));
  expect(info).toMatchObject({
    title: "meta title",
    model: "meta-model",
    effort: "high",
    branch: "cycle/meta",
    sandbox: "meta-sandbox",
  });
});

test("Cycle alone keeps mode, worktree, directories, pinned, unread and scheduleId", async () => {
  const { harness, listed } = await setup({ meta: { s1: cycleMeta }, modes: { fake: "plan" } });
  const info = await listed(agentRecord(harness));
  expect(info).toMatchObject({
    mode: "readOnly",
    worktree,
    directories: ["/extra"],
    pinned: true,
    unread: true,
    scheduleId: "sched",
  });
});

test("the agent alone says cwd, harness, sandboxCwd, createdAt, forkedFrom and tag", async () => {
  const { harness, listed } = await setup({ meta: { s1: cycleMeta } });
  const info = await listed(agentRecord(harness));
  expect(info).toMatchObject({
    id: "s1",
    harness: "fake",
    cwd: "/agent/cwd",
    sandboxCwd: "/home/agent/workspace/x",
    createdAt: 10,
    forkedFrom: "parent",
    tag: "agent-tag",
  });
});

test("with nothing kept by Cycle, the agent's values stand and Cycle's fields take defaults", async () => {
  const { harness, listed } = await setup();
  const info = await listed(agentRecord(harness));
  expect(info).toEqual({
    id: "s1",
    harness: "fake",
    title: "agent title",
    preview: "agent preview",
    cwd: "/agent/cwd",
    model: "agent-model",
    effort: "low",
    mode: "auto",
    status: "stored",
    branch: "agent-branch",
    worktree: null,
    sandbox: "agent-sandbox",
    sandboxCwd: "/home/agent/workspace/x",
    directories: [],
    createdAt: 10,
    updatedAt: 20,
    archived: false,
    pinned: false,
    unread: false,
    forkedFrom: "parent",
    tag: "agent-tag",
    scheduleId: null,
  });
});

test("a session without a tag has no tag key", async () => {
  const { harness, listed } = await setup();
  const { tag: _tag, ...record } = agentRecord(harness);
  const info = await listed(record);
  expect("tag" in info).toBe(false);
});

test("the preview and model the agent says stand, and those known before fill in what it omits", async () => {
  const { harness, listed } = await setup();
  expect((await listed(agentRecord(harness))).preview).toBe("agent preview");
  const info = await listed(agentRecord(harness, { preview: "", model: "" }));
  expect(info).toMatchObject({ preview: "agent preview", model: "agent-model" });
});

test("the effort the agent says stands, and a null one gives way to the one known before", async () => {
  const { harness, listed } = await setup();
  await listed(agentRecord(harness, { effort: "low" }));
  expect((await listed(agentRecord(harness, { effort: "medium" }))).effort).toBe("medium");
  expect((await listed(agentRecord(harness, { effort: null }))).effort).toBe("medium");
});

test("an effort Cycle kept as null wins over the agent's", async () => {
  const { harness, listed } = await setup({ meta: { s1: { effort: null } } });
  expect((await listed(agentRecord(harness))).effort).toBeNull();
});

test("an empty title kept by Cycle gives way to the agent's", async () => {
  const { harness, listed } = await setup({ meta: { s1: { title: "" } } });
  expect((await listed(agentRecord(harness))).title).toBe("agent title");
});

test("updatedAt is the greater of the agent's and the one known before", async () => {
  const { harness, listed } = await setup();
  await listed(agentRecord(harness, { updatedAt: 50 }));
  expect((await listed(agentRecord(harness, { updatedAt: 30 }))).updatedAt).toBe(50);
  expect((await listed(agentRecord(harness, { updatedAt: 70 }))).updatedAt).toBe(70);
});

test("the branch is the agent's without a worktree, and the worktree's with one", async () => {
  const none = await setup();
  expect((await none.listed(agentRecord(none.harness))).branch).toBe("agent-branch");
  const kept = await setup({ meta: { s1: { worktree } } });
  expect((await kept.listed(agentRecord(kept.harness))).branch).toBe("cycle/meta");
});

test("the mode is Cycle's: the one kept, else the settings' for the agent, never the agent's", async () => {
  const kept = await setup({ meta: { s1: { agentMode: "readOnly" } }, modes: { fake: "plan" } });
  expect((await kept.listed(agentRecord(kept.harness))).mode).toBe("readOnly");
  const settings = await setup({ modes: { fake: "plan" } });
  expect((await settings.listed(agentRecord(settings.harness))).mode).toBe("plan");
  const neither = await setup();
  expect((await neither.listed(agentRecord(neither.harness))).mode).toBe("auto");
});

test("listing archived sessions marks them archived", async () => {
  const { harness, hub } = await setup();
  harness.stored = [agentRecord(harness)];
  const [info] = await hub.list(true);
  expect(info?.archived).toBe(true);
});

test("opening a session joins the same winners as listing it, and is no longer stored", async () => {
  const { harness, listed, opened } = await setup({ meta: { s1: cycleMeta } });
  const record = agentRecord(harness);
  const fromList = await listed(record);
  const fromOpen = await opened(record);
  expect(fromOpen).toEqual({ ...fromList, status: "idle" });
});

test("opening a session the list did not show joins the same winners", async () => {
  const { harness, opened } = await setup({ meta: { s1: cycleMeta } });
  const info = await opened(agentRecord(harness));
  expect(info).toMatchObject({
    title: "meta title",
    model: "meta-model",
    effort: "high",
    mode: "readOnly",
    branch: "cycle/meta",
    worktree,
    sandbox: "meta-sandbox",
    sandboxCwd: "/home/agent/workspace/x",
    directories: ["/extra"],
    createdAt: 10,
    updatedAt: 20,
    pinned: true,
    unread: true,
    forkedFrom: "parent",
    tag: "agent-tag",
    scheduleId: "sched",
  });
});
