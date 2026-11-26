import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CycleClient, connectUnix } from "@cycle/client";
import { Daemon, listenUnix } from "@cycle/daemon";
import { CycleErrorCode } from "@cycle/protocol";
// The fake agent is the daemon's own test double; there is no package export for it, so this test reaches into
// apps/daemon/test by path (and `@cycle/daemon` is a devDependency for the same reason).
import { fakeAgent } from "../../../apps/daemon/test/fake-agent.ts";
import { DaemonSessions, type RecordEvent } from "../src/sessions.ts";

let dir: string;
let cleanup: (() => void | Promise<void>)[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "al-sessions-"));
});
afterEach(async () => {
  for (const clean of cleanup.reverse()) await clean();
  cleanup = [];
  await rm(dir, { recursive: true, force: true });
});

const setup = async (fake: ReturnType<typeof fakeAgent>, record?: RecordEvent) => {
  let daemon = await Daemon.start({ dataDir: dir, agents: [fake.definition] });
  let daemonOpen = true;
  const socket = join(dir, "d.sock");
  const listen = () =>
    listenUnix({ path: socket, onConnection: ({ stream }) => void daemon.accept(stream) });
  let server = await listen();
  const sessions = new DaemonSessions(socket, () => {}, record);
  await sessions.start();
  cleanup.push(async () => {
    await sessions.close();
    server.close();
    if (daemonOpen) await daemon.close();
  });
  const { sessionId } = await sessions.create({
    role: "dev",
    agent: "fake",
    title: "t",
    cwd: "/tmp",
  });
  return {
    sessions,
    sessionId,
    socket,
    restartDaemon: async () => {
      daemon = await Daemon.start({ dataDir: dir, agents: [fake.definition] });
      daemonOpen = true;
      server = await listen();
    },
    stopDaemon: async () => {
      daemonOpen = false;
      // No socket while the daemon is down, as when Cycle is being updated.
      server.close();
      await daemon.close();
    },
  };
};

const context = { run: "CYC-1", role: "dev" as const, worktree: "/tmp", timeoutMs: 5_000 };

test("a turn the daemon's stop ended is marked interrupted", async () => {
  let started!: () => void;
  const running = new Promise<void>((r) => {
    started = r;
  });
  const { sessions, sessionId, stopDaemon, restartDaemon } = await setup(
    fakeAgent({
      onPrompt: async () => {
        started();
        return new Promise(() => {});
      },
    }),
  );
  const turn = sessions.turn(sessionId, "work", context);
  await running;
  await stopDaemon();
  await restartDaemon();
  const result = await turn;
  expect(result.stopReason).toBe("error");
  expect(result.interrupted).toBe(true);
}, 15_000);

test("an error that is not the daemon's stop is not marked", async () => {
  const { sessions, sessionId } = await setup(
    fakeAgent({
      onPrompt: async ({ say }) => {
        await say({
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: "error",
          error: { code: CycleErrorCode.AgentExited, message: "boom" },
        });
        return "ended";
      },
    }),
  );
  const result = await sessions.turn(sessionId, "work", context);
  expect(result.stopReason).toBe("error");
  expect(result.interrupted).toBeUndefined();
}, 15_000);

test("after the daemon stops and comes back, the same session takes the turn again", async () => {
  let prompts = 0;
  let started!: () => void;
  const running = new Promise<void>((r) => {
    started = r;
  });
  const { sessions, sessionId, stopDaemon, restartDaemon } = await setup(
    fakeAgent({
      onPrompt: async ({ say }) => {
        prompts++;
        if (prompts === 1) {
          started();
          return new Promise(() => {});
        }
        await say({
          sessionUpdate: "agent_message_chunk",
          messageId: "a1",
          content: { type: "text", text: "again" },
        });
        return undefined;
      },
    }),
  );
  const first = sessions.turn(sessionId, "work", context);
  await running;
  await stopDaemon();
  await restartDaemon();
  expect((await first).interrupted).toBe(true);
  const second = await sessions.turn(sessionId, "work", context);
  expect(second.stopReason).toBe("end_turn");
  expect(second.text).toContain("again");
}, 20_000);

type Recorded = { run: string; kind: string; data: Record<string, string | number | boolean> };
const recorder = () => {
  const events: Recorded[] = [];
  return {
    events,
    record: ((run, kind, data) => void events.push({ run, kind, data })) as RecordEvent,
  };
};
const call = (command: string) => ({
  subject: {
    type: "tool_call",
    toolCall: { toolCallId: "t1", kind: "execute", rawInput: { command } },
  },
});

test("a request the policy refuses is recorded with its command prefix only", async () => {
  const { events, record } = recorder();
  let answer: unknown;
  const { sessions, sessionId } = await setup(
    fakeAgent({
      onPrompt: async ({ ask }) => {
        answer = await ask(call("git mv secret-token-file other-file"));
        return undefined;
      },
    }),
    record,
  );
  await sessions.turn(sessionId, "work", { ...context, role: "qa" });
  expect(events).toHaveLength(1);
  expect(events[0]).toEqual({
    run: "CYC-1",
    kind: "permission_requested",
    data: {
      role: "qa",
      tool: "execute",
      command: "git mv",
      decision: "deny",
      reason: "a command outside the allowlist",
    },
  });
  expect(JSON.stringify(events)).not.toContain("secret-token-file");
  expect(answer).toBeDefined();
}, 15_000);

test("a request left for a person is recorded, and so is what the person answered", async () => {
  const { events, record } = recorder();
  const { sessions, sessionId, socket } = await setup(
    fakeAgent({
      onPrompt: async ({ ask }) => {
        await ask(call("curl https://example.com/?token=abc"));
        return undefined;
      },
    }),
    record,
  );
  const person = new CycleClient({
    name: "person",
    connect: () => connectUnix(socket),
    events: {
      permission: async (_id, request) => {
        const options = request.options as { optionId: string; kind: string }[];
        const allow = options.find((o) => o.kind === "allow_once");
        return { outcome: "selected", optionId: allow?.optionId ?? "" };
      },
    },
  });
  await person.start();
  cleanup.push(() => person.close());
  await person.watch(sessionId, "/tmp");
  await sessions.turn(sessionId, "work", context);
  const until = Date.now() + 10_000;
  while (events.length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  expect(events.map((e) => e.kind)).toEqual(["permission_requested", "permission_answered"]);
  expect(events[0]?.data).toMatchObject({ decision: "ask", tool: "execute", command: "curl" });
  expect(events[1]?.data).toEqual({
    role: "dev",
    tool: "execute",
    command: "curl",
    answer: "allow",
  });
  expect(JSON.stringify(events)).not.toContain("token");
}, 15_000);

test("a request the policy allows writes no event, and a compound command is filed under the part that was refused", async () => {
  const { events, record } = recorder();
  const { sessions, sessionId } = await setup(
    fakeAgent({
      onPrompt: async ({ ask }) => {
        await ask(call("git status"));
        await ask(call("git status && curl secrets.txt"));
        return undefined;
      },
    }),
    record,
  );
  await sessions.turn(sessionId, "work", { ...context, role: "qa" });
  await new Promise((r) => setTimeout(r, 50));
  expect(events).toHaveLength(1);
  expect(events[0]?.data).toMatchObject({ command: "curl", decision: "deny" });
  expect(JSON.stringify(events)).not.toContain("secrets");
}, 15_000);

test("create sets model and effort on the new session, and sets nothing when they are not given", async () => {
  const fake = fakeAgent({}, { configOptions: [] });
  const { sessions } = await setup(fake);
  expect(fake.log.configs).toEqual([]);
  await sessions.create({
    role: "dev",
    agent: "fake",
    model: "opus",
    effort: "high",
    title: "t",
    cwd: "/tmp",
  });
  expect(fake.log.configs.map((c) => [c.configId, c.value])).toEqual([
    ["model", "opus"],
    ["effort", "high"],
  ]);
});
