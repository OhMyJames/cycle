import { afterEach, beforeEach, expect, test } from "bun:test";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { META } from "@cycle/protocol";
import { BINARY_SOURCES } from "../scripts/binaries.ts";
import { ConfigSchema } from "../src/config.ts";
import { agentsFor, HARNESSES } from "../src/harnesses.ts";
import { Daemon } from "../src/index.ts";
import { connectClient, until } from "./client.ts";
import { fakeAgent } from "./fake-agent.ts";
import { ECHO_MAIN, echoHarness } from "./fixtures/echo-harness.ts";
import { tempDir } from "./support.ts";

let dir: string;
let dispose: () => Promise<void>;
let open: Daemon[] = [];
beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
});
afterEach(async () => {
  for (const daemon of open) await daemon.close();
  open = [];
  await dispose();
});

const text = (value: string) => [{ type: "text" as const, text: value }];

test("every harness has what the daemon reads by its id: a section in config.json, and where its binary is built from", () => {
  const config = ConfigSchema.parse({});
  const ids = HARNESSES.map((h) => h.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const harness of HARNESSES) {
    if (harness.definition) expect(Object.keys(config)).toContain(harness.id);
    if (harness.binary !== undefined) expect(Object.keys(BINARY_SOURCES)).toContain(harness.id);
  }
  // The agents are made in the registry's order: the first is what a session with none named gets.
  expect(agentsFor(config, dir, { PATH: "/bin" }).map((a) => a.id)).toEqual(
    HARNESSES.filter((h) => h.definition).map((h) => h.id),
  );
});

test("a second agent goes the whole way: listed, a session made with it, a prompt answered by its own adapter process, and resumed by the next daemon (CYCL-155)", async () => {
  // A harness that is not Claude, beside a first agent: nothing but its entry says how it runs.
  const first = fakeAgent();
  const agents = () => [
    first.definition,
    ...agentsFor(
      ConfigSchema.parse({}),
      dir,
      { PATH: process.env.PATH },
      undefined,
      [echoHarness],
      [process.execPath, ECHO_MAIN],
    ),
  ];
  const daemon = await Daemon.start({ dataDir: dir, agents: agents() });
  open.push(daemon);
  const c = await connectClient(daemon);

  const listed = (await c.agent.request("_cycle/agents/list", {})) as {
    agents: { id: string; name: string; available: boolean }[];
  };
  expect(listed.agents.map((a) => [a.id, a.name, a.available])).toEqual([
    ["fake", "Fake", true],
    ["echo", "Echo", true],
  ]);

  const { sessionId } = await c.agent.request(methods.agent.session.new, {
    cwd: "/tmp",
    _meta: { [META.agent]: "echo" },
  });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("one") });
  const said = (client: typeof c) =>
    client.seen
      .map((s) => s.update as { sessionUpdate: string; content?: { text?: string } })
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => u.content?.text);
  await until(() => c.ended() >= 1, "the first turn to end", 10_000);
  // Its adapter got its configuration, and it was this agent that answered, not the first.
  expect(said(c)).toEqual(["echo new: one"]);
  expect(first.log.prompts).toEqual([]);
  const rows = await c.agent.request(methods.agent.session.list, {});
  expect(((rows.sessions[0]?._meta ?? {}) as Record<string, unknown>)[META.agent]).toBe("echo");

  // Another daemon on the same data: the session is still this agent's, and its next prompt resumes it there.
  await daemon.close();
  open = [];
  const again = await Daemon.start({ dataDir: dir, agents: agents() });
  open.push(again);
  const d = await connectClient(again);
  await d.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await d.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("two") });
  await until(() => d.ended() >= 1, "the second turn to end", 10_000);
  expect(said(d).at(-1)).toBe("echo resumed: two");
  expect(first.log.resumes).toEqual([]);
}, 30_000);

test("an agent's own limit on processes waiting for a first prompt counts its sessions, not another agent's", async () => {
  const warm = fakeAgent();
  const other = fakeAgent();
  const daemon = await Daemon.start({
    dataDir: dir,
    agents: [
      { ...warm.definition, id: "warm", maxAhead: 1 },
      { ...other.definition, id: "other" },
    ],
  });
  open.push(daemon);
  const c = await connectClient(daemon);
  const make = async (agent: string) =>
    (
      await c.agent.request(methods.agent.session.new, {
        cwd: "/tmp",
        _meta: { [META.agent]: agent },
      })
    ).sessionId;
  const warmIds = [
    await make("warm"),
    await make("other"),
    await make("other"),
    await make("warm"),
  ];
  await until(
    () => warm.log.launches === 2 && other.log.launches === 2,
    "each session's agent to start",
  );
  await Bun.sleep(50);
  for (const sessionId of warmIds) {
    await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
    await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("hi") });
  }
  await until(
    () => warm.log.prompts.length === 2 && other.log.prompts.length === 2,
    "every prompt to reach its agent",
  );
  // The limited agent let go of its older one, which was started again; the other's two were never counted.
  expect(warm.log.resumes.map((r) => r.sessionId)).toEqual([warmIds[0]]);
  expect(other.log.resumes).toEqual([]);
});
