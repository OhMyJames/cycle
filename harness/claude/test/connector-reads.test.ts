import { expect, test } from "bun:test";
import type { HarnessEvent, Usage } from "@cycle/protocol";
import { ClaudeHarness, toMcpServers } from "../src/index.ts";
import type { WireMessage } from "../src/wire.ts";
import { FakeSdk, settle } from "./fake-sdk.ts";

const commandNamed = (name: string) => ({ name, description: "", argumentHint: "" });

/** A harness whose short waits run at once, and whose clock a test moves. */
function setup() {
  const sdk = new FakeSdk();
  let ids = 0;
  const clock = { now: 1000 };
  // The owner's files, by when each was last written: a test writes one with `touch`.
  const written = new Map<string, number>();
  const touch = (path: string) => written.set(path, ++clock.now);
  const harness = new ClaudeHarness({
    stamp: async (paths) => paths.map((path) => written.get(path) ?? 0).join("|"),
    sdk,
    env: { CLAUDE_CONFIG_DIR: "/home/me/.claude" },
    // A process's idle close never comes; a poll's short wait comes at once.
    schedule: (run, ms) => {
      if (ms < 1000) queueMicrotask(run);
      return () => {};
    },
    now: () => clock.now,
    newId: () => `id${++ids}`,
  });
  const events: HarnessEvent[] = [];
  harness.onEvent((event) => events.push(event));
  return { sdk, harness, events, clock, touch };
}

const options = { mode: "readOnly" as const, model: "claude-sonnet-5-5" };
const result = (cost: number): WireMessage => ({
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 1,
  total_cost_usd: cost,
});

test("each folder has its own commands: a project's are not offered in another", async () => {
  const { sdk, harness } = setup();
  sdk.commandsAt = {
    "/a": [{ name: "only-in-a", description: "", argumentHint: "" }],
    "/b": [{ name: "only-in-b", description: "", argumentHint: "" }],
  };
  const names = async (cwd: string) =>
    (await harness.listCommands({ cwd })).map((command) => command.name);
  expect(await names("/a")).toEqual(["only-in-a"]);
  expect(await names("/b")).toEqual(["only-in-b"]);
  const started = sdk.queries.length;
  // Asked again, a folder's list is kept, with no process started for it.
  expect(await names("/a")).toEqual(["only-in-a"]);
  expect(sdk.queries).toHaveLength(started);
  expect((await harness.listSkills("/b")).map((skill) => skill.name)).toEqual(["only-in-b"]);

  // A session with no process has its folder's.
  const session = await harness.createSession({ cwd: "/b", model: options.model });
  expect((await harness.listCommands({ sessionId: session.id }))[0]?.name).toBe("only-in-b");
});

test("MCP servers are read once they have connected, and kept a while without a process", async () => {
  const { sdk, harness, clock } = setup();
  await harness.start();
  const pending = { name: "srv", status: "pending" as const };
  const ready = { name: "srv", status: "connected" as const, tools: [{ name: "look" }] };
  sdk.serverReads = [[pending], [pending], [ready]];
  const before = sdk.queries.length;
  const servers = await harness.listMcpServers();
  expect(servers).toMatchObject([{ name: "srv", status: "connected", tools: [{ name: "look" }] }]);
  expect(sdk.queries.length).toBe(before + 1);
  expect(sdk.queries.at(-1)?.closed).toBe(true);

  // Within a few minutes, no process is started again for the same answer.
  sdk.servers = [];
  expect(await harness.listMcpServers()).toEqual(servers);
  expect(sdk.queries.length).toBe(before + 1);
  clock.now += 6 * 60_000;
  expect(await harness.listMcpServers()).toEqual([]);
  expect(sdk.queries.length).toBe(before + 2);
});

test("a server that never finishes connecting is read as it is, after a while", async () => {
  const { sdk, harness } = setup();
  sdk.servers = [{ name: "slow", status: "pending" }];
  expect((await harness.listMcpServers())[0]).toMatchObject({ name: "slow", status: "unknown" });
});

test("a process that started before the owner's files changed is not what lists the servers", async () => {
  const { sdk, harness, touch } = setup();
  await harness.start();
  const session = await harness.createSession({ cwd: "/p", model: options.model });
  // A turn that waits on an approval keeps its process for as long as the owner takes.
  await harness.send(session.id, { text: "go", images: [] }, options);
  await settle();
  const old = sdk.last;
  sdk.servers = [{ name: "first", status: "connected" }];
  expect((await harness.listMcpServers()).map((server) => server.name)).toEqual(["first"]);
  expect(sdk.last).toBe(old);

  // The owner adds a server: the next look at once says so, with the old process left running.
  sdk.servers = [
    { name: "first", status: "connected" },
    { name: "second", status: "connected" },
  ];
  touch("/home/me/.claude/.claude.json");
  const names = (await harness.listMcpServers()).map((server) => server.name);
  expect(names).toEqual(["first", "second"]);
  expect(sdk.last).not.toBe(old);
});

test("a command added in the owner's files or a folder shows at once, and only where it belongs", async () => {
  const { sdk, harness, touch } = setup();
  sdk.commandsAt = { "/a": [commandNamed("old")] };
  const names = async (cwd: string) =>
    (await harness.listCommands({ cwd })).map((each) => each.name);
  expect(await names("/a")).toEqual(["old"]);
  const started = () => sdk.queries.length;
  const before = started();

  // Nothing changed: the list is kept.
  expect(await names("/a")).toEqual(["old"]);
  expect(started()).toBe(before);

  // The folder gets a command of its own: asked again, once.
  sdk.commandsAt = { "/a": [commandNamed("old"), commandNamed("added")] };
  touch("/a/.claude/commands");
  expect(await names("/a")).toEqual(["old", "added"]);
  expect(await names("/a")).toEqual(["old", "added"]);
  expect(started()).toBe(before + 1);

  // Another folder's change is not this one's.
  touch("/b/.claude/skills");
  expect(await names("/a")).toEqual(["old", "added"]);
  expect(started()).toBe(before + 1);

  // The owner's own reach every folder.
  sdk.commandsAt = { "/a": [commandNamed("everywhere")] };
  touch("/home/me/.claude/skills");
  expect(await names("/a")).toEqual(["everywhere"]);
});

test("a plugin's server is marked as no plugin id, which the SDK does not give", () => {
  const [server] = toMcpServers(
    [{ name: "plugin:formatter:fmt", status: "connected", source: "plugin" }],
    null,
  );
  expect(server?.pluginId).toBeNull();
});

test("what a session cost adds up over its processes, whether or not a process carried it on", async () => {
  const { sdk, harness, events } = setup();
  const costs = () =>
    events.flatMap((event) =>
      event.type === "usage.updated" ? [(event.usage as Usage).costUsd] : [],
    );
  const session = await harness.createSession({ cwd: "/p", model: options.model });
  const turn = async (cost: number, mode?: string) => {
    await harness.send(
      session.id,
      { text: "go", images: [] },
      { ...options, ...(mode ? { mode } : {}) },
    );
    await settle();
    sdk.last.say(result(cost));
    await settle();
  };
  await turn(0.5);
  await turn(0.75);
  // A mode only a start can give is another process. This one began at nothing.
  await turn(0.1, "bypassPermissions");
  await turn(0.3, "bypassPermissions");
  // And this one carried on from what the conversation had cost.
  await turn(1.25, "acceptEdits");
  expect(costs()).toEqual([0.5, 0.75, 0.85, 1.05, 1.25]);
});
