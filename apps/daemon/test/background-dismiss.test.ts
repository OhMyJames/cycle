// Marking a background task that is not a sub-agent (`_cycle/task_update`) as ended when the agent let it go without
// saying how it ended (docs/protocol.md §6 and §9, CYC-118).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { Daemon } from "../src/index.ts";
import { connectClient, until } from "./client.ts";
import { fakeAgent } from "./fake-agent.ts";
import { tempDir } from "./support.ts";

let dir: string;
let dispose: () => Promise<void>;
const open: Daemon[] = [];
beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
});
afterEach(async () => {
  for (const daemon of open.splice(0)) await daemon.close();
  await dispose();
});

const text = (value: string) => [{ type: "text" as const, text: value }];
const kindOf = (u: unknown) => (u as { sessionUpdate?: string }).sessionUpdate;
const task = (taskId: string, state: string) => ({
  sessionUpdate: "_cycle/task_update",
  taskId,
  kind: "shell",
  title: taskId,
  state,
});

const run = async () => {
  const fake = fakeAgent({
    onPrompt: async ({ say }) => {
      await say(task("gone", "running"));
      await say(task("gone", "unknown"));
      await say(task("busy", "running"));
      await say(task("done", "running"));
      await say(task("done", "completed"));
    },
  });
  const daemon = await Daemon.start({ dataDir: dir, agents: [fake.definition] });
  open.push(daemon);
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("go") });
  await until(() => c.ended() >= 1, "the turn to end");
  const dismiss = (taskIds: string[]) =>
    c.agent.request(
      "_cycle/session/dismiss_background" as never,
      {
        sessionId,
        taskIds,
      } as never,
    ) as Promise<{ dismissed: number }>;
  const meta = async (of: Daemon = daemon) => {
    const list = await (await connectClient(of)).agent.request(methods.agent.session.list, {});
    const row = list.sessions.find((s) => s.sessionId === sessionId);
    return (row?._meta ?? {}) as Record<string, unknown>;
  };
  return { daemon, c, sessionId, dismiss, meta, agents: [fake.definition] };
};

test("an unknown task is marked ended: written, pushed, and still ended after a restart", async () => {
  const { daemon, c, sessionId, dismiss, meta, agents } = await run();
  expect((await meta())["cycle/backgroundUnknown"]).toEqual(["gone"]);
  expect((await meta())["cycle/background"]).toBe(1);

  expect(await dismiss(["gone"])).toEqual({ dismissed: 1 });
  const ends = c.seen
    .map((s) => s.update as unknown as Record<string, unknown>)
    .filter((u) => kindOf(u) === "_cycle/task_update" && u.taskId === "gone");
  expect(ends.at(-1)?.state).toBe("stopped");
  const after = await meta();
  expect(after["cycle/backgroundUnknown"]).toBeUndefined();
  // Only what ran counts in the background, as before.
  expect(after["cycle/background"]).toBe(1);
  // Once is enough.
  expect(await dismiss(["gone"])).toEqual({ dismissed: 0 });

  await daemon.close();
  open.length = 0;
  const again = await Daemon.start({ dataDir: dir, agents });
  open.push(again);
  const later = await connectClient(again);
  await later.agent.request(methods.agent.session.resume, {
    sessionId,
    cwd: "/tmp",
    replayFrom: { type: "start" },
  } as never);
  await until(
    () => later.seen.some((s) => kindOf(s.update) === "replay_complete"),
    "the replay to complete",
  );
  const last = (id: string) =>
    later.seen
      .map((s) => s.update as unknown as Record<string, unknown>)
      .filter((u) => kindOf(u) === "_cycle/task_update" && u.taskId === id)
      .at(-1);
  expect(last("gone")?.state).toBe("stopped");
  expect((await meta(again))["cycle/backgroundUnknown"]).toBeUndefined();
});

test("a task that runs, or has ended, is not touched", async () => {
  const { c, dismiss, meta } = await run();
  const before = c.seen.length;
  expect(await dismiss(["busy", "done", "nothing"])).toEqual({ dismissed: 0 });
  expect(c.seen.length).toBe(before);
  expect((await meta())["cycle/background"]).toBe(1);
  expect((await meta())["cycle/backgroundUnknown"]).toEqual(["gone"]);
});

test("an unknown task that runs again is no longer unknown", async () => {
  const fake = fakeAgent({
    onPrompt: async ({ say }) => {
      await say(task("t", "unknown"));
      await say(task("t", "running"));
    },
  });
  const daemon = await Daemon.start({ dataDir: dir, agents: [fake.definition] });
  open.push(daemon);
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("go") });
  await until(() => c.ended() >= 1, "the turn to end");
  const reply = (await c.agent.request(
    "_cycle/session/dismiss_background" as never,
    {
      sessionId,
      taskIds: ["t"],
    } as never,
  )) as { dismissed: number };
  expect(reply.dismissed).toBe(0);
});
