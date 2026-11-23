import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { Daemon, isListening, listenUnix } from "../src/index.ts";
import {
  askWorking,
  BUSY_EXIT,
  type StopChoice,
  type StopDeps,
  stopDaemon,
  workingOf,
} from "../src/stop.ts";
import { connectClient, until } from "./client.ts";
import { fakeAgent } from "./fake-agent.ts";
import { tempDir } from "./support.ts";

let dir: string;
let dispose: () => Promise<void>;
let cleanup: (() => Promise<void> | void)[] = [];
beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
});
afterEach(async () => {
  for (const clean of cleanup.reverse()) await clean();
  cleanup = [];
  await dispose();
});

const text = (value: string) => [{ type: "text" as const, text: value }];

/** A daemon on a socket, as `serve` runs one, with a fake agent; `stop` is what SIGTERM does to it. */
const serving = async (fake: ReturnType<typeof fakeAgent>) => {
  const daemon = await Daemon.start({ dataDir: dir, agents: [fake.definition] });
  const socket = join(dir, "daemon.sock");
  const server = await listenUnix({
    path: socket,
    onConnection: ({ stream }) => daemon.accept(stream),
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    server.close();
    await daemon.close();
  };
  cleanup.push(stop);
  return { daemon, socket, stop };
};

/** A session whose turn runs until `finish`. */
const busy = async (daemon: Daemon) => {
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("go") });
  return { c, sessionId, finish: () => finish(), done };
};

const deps = (
  socket: string,
  stop: () => Promise<void>,
  over: Partial<StopDeps> = {},
): StopDeps & { said: string[]; signals: () => number } => {
  const said: string[] = [];
  let signals = 0;
  return {
    force: false,
    wait: false,
    interactive: false,
    isRunning: () => isListening(socket),
    working: () => askWorking(socket, 2_000),
    choose: async () => "cancel" as StopChoice,
    signal: () => {
      signals += 1;
      void stop();
    },
    say: (line) => said.push(line),
    pollMs: 20,
    stopWithinMs: 2_000,
    ...over,
    said,
    signals: () => signals,
  };
};

test("the session list says which sessions are working: a turn, a request, background tasks", () => {
  const rows = [
    { sessionId: "a", cwd: "/", _meta: { "cycle/state": "running", title: "Fix the build" } },
    { sessionId: "b", cwd: "/", _meta: { "cycle/state": "requires_action" } },
    { sessionId: "c", cwd: "/", _meta: { "cycle/state": "idle", "cycle/background": 2 } },
    { sessionId: "d", cwd: "/", _meta: { "cycle/state": "stopped" } },
    { sessionId: "e", cwd: "/", _meta: { "cycle/state": "idle" } },
  ];
  expect(workingOf(rows)).toEqual([
    { sessionId: "a", title: "Fix the build", state: "running", background: 0 },
    { sessionId: "b", state: "requires_action", background: 0 },
    { sessionId: "c", state: "idle", background: 2 },
  ]);
});

test("with nothing working, stop stops", async () => {
  const { socket, stop } = await serving(fakeAgent());
  const d = deps(socket, stop);
  expect(await stopDaemon(d)).toBe(0);
  expect(d.signals()).toBe(1);
  expect(await isListening(socket)).toBe(false);
});

test("with a turn running and no terminal, stop lists it and does not stop", async () => {
  const { daemon, socket, stop } = await serving(
    fakeAgent({ onPrompt: () => new Promise(() => {}) }),
  );
  const { sessionId } = await busy(daemon);
  const d = deps(socket, stop);
  expect(await stopDaemon(d)).toBe(BUSY_EXIT);
  expect(d.signals()).toBe(0);
  expect(d.said.join("\n")).toContain(`${sessionId}: a turn is running`);
  expect(d.said.join("\n")).toContain("--force");
  expect(await isListening(socket)).toBe(true);
});

test("--force stops over a running turn and says what is lost", async () => {
  const { daemon, socket, stop } = await serving(
    fakeAgent({ onPrompt: () => new Promise(() => {}) }),
  );
  await busy(daemon);
  const d = deps(socket, stop, { force: true });
  expect(await stopDaemon(d)).toBe(0);
  expect(d.said.join("\n")).toContain("the history marks it as interrupted");
  expect(d.said.join("\n")).toContain("queue are kept");
});

test("--wait stops once the turn has ended, and not before", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { daemon, socket, stop } = await serving(fakeAgent({ onPrompt: () => held }));
  const { c } = await busy(daemon);
  const d = deps(socket, stop, { wait: true });
  const stopping = stopDaemon(d);
  await until(() => d.said.some((l) => l.startsWith("Waiting")), "it to wait");
  await Bun.sleep(100);
  expect(d.signals()).toBe(0);
  release();
  await until(() => c.ended() === 1, "the turn to end");
  expect(await stopping).toBe(0);
  expect(d.signals()).toBe(1);
  // It ended by itself: nothing was interrupted.
  expect(d.said.join("\n")).not.toContain("interrupts");
});

test("at a terminal the person chooses; cancel leaves the daemon running", async () => {
  const { daemon, socket, stop } = await serving(
    fakeAgent({ onPrompt: () => new Promise(() => {}) }),
  );
  await busy(daemon);
  const asked: string[] = [];
  const d = deps(socket, stop, {
    interactive: true,
    choose: async (question) => {
      asked.push(question);
      return "cancel";
    },
  });
  expect(await stopDaemon(d)).toBe(BUSY_EXIT);
  expect(asked[0]).toContain("[w]ait");
  expect(d.signals()).toBe(0);
});

test("a daemon that cannot be asked is not stopped without --force", async () => {
  const d = deps(join(dir, "nothing.sock"), async () => {}, {
    isRunning: async () => true,
    working: async () => {
      throw new Error("no answer");
    },
  });
  expect(await stopDaemon(d)).toBe(BUSY_EXIT);
  expect(d.said[0]).toContain("no answer");
  expect(d.signals()).toBe(0);
});

test("the look that ends the wait is the answer: a later one that disagrees does not undo the stop", async () => {
  // There, gone, there again: once a look has found it gone, no second look is taken that could say otherwise.
  const looks = [true, false, true];
  const d = deps(join(dir, "nothing.sock"), async () => {}, {
    isRunning: async () => looks.shift() ?? true,
    working: async () => [],
  });
  expect(await stopDaemon(d)).toBe(0);
  expect(d.said.at(-1)).toBe("stopped");
  expect(looks).toEqual([true]);
});
