import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, listenUnix } from "@cycle/daemon";
import { CycleErrorCode } from "@cycle/protocol";
// The fake agent is the daemon's own test double; there is no package export for it, so this test reaches into
// apps/daemon/test by path (and `@cycle/daemon` is a devDependency for the same reason).
import { fakeAgent } from "../../../apps/daemon/test/fake-agent.ts";
import { DaemonSessions } from "../src/sessions.ts";

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

const setup = async (fake: ReturnType<typeof fakeAgent>) => {
  let daemon = await Daemon.start({ dataDir: dir, agents: [fake.definition] });
  let daemonOpen = true;
  const socket = join(dir, "d.sock");
  const listen = () =>
    listenUnix({ path: socket, onConnection: ({ stream }) => void daemon.accept(stream) });
  let server = await listen();
  const sessions = new DaemonSessions(socket, () => {});
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

const context = { role: "dev" as const, worktree: "/tmp", timeoutMs: 5_000 };

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
