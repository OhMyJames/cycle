/**
 * Two harnesses in one daemon, end to end: the real Claude Code, driven by the Claude Agent SDK
 * against a scripted model, beside the real `codex app-server` against its own.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeHarness } from "@cycle/harness-claude";
import { CodexHarness } from "@cycle/harness-codex";
import type { Item, SessionEvent } from "@cycle/protocol";
import {
  type Daemon,
  Harnesses,
  type OpenProviders,
  TOOLS_KEY_ENV,
  TOOLS_SERVER,
  type ToolsServer,
  diskFile,
  openProviders,
  startDaemon,
  startTools,
} from "../../src/index.ts";
import { type ClaudeReply, type MockClaude, startMockClaude } from "./mock-claude.ts";
import { type MockModel, startMockModel } from "./mock-model.ts";
import { type WireClient, connect } from "./wire-client.ts";

const TOOLS_KEY = "claude-test-tools-key";
const SONNET = "claude-sonnet-5-5";

let daemon: Daemon;
let codexModel: MockModel;
let claude: MockClaude;
let tools: ToolsServer;
let providers: OpenProviders;
let root: string;
let project: string;
let client: WireClient;
let script: (prompt: string, results: number) => ClaudeReply;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "cycle-claude-"));
  project = join(root, "project");
  mkdirSync(project);
  mkdirSync(join(root, "codex"));
  writeFileSync(join(project, "hello.txt"), "hello\n");
  script = (prompt) => ({ text: ["You said: ", prompt] });
  codexModel = startMockModel(() => ({ text: ["Hello", " from codex"] }));
  claude = startMockClaude(root, (prompt, results) => script(prompt, results));
  tools = startTools(TOOLS_KEY);
  providers = await openProviders(
    diskFile(join(root, "home", "providers.json")),
    "gateway-token",
    join(root, "home", "provider-models.json"),
  );
  daemon = await startDaemon({
    tools,
    providers: providers.store,
    harness: new Harnesses(
      new CodexHarness({
        config: codexModel.codexConfig,
        env: { CODEX_HOME: join(root, "codex") },
        tools: { name: TOOLS_SERVER, url: tools.url, keyEnv: TOOLS_KEY_ENV, key: tools.key },
      }),
      [
        new ClaudeHarness({
          env: claude.env,
          ...(process.env["CYCLE_DEBUG"]
            ? { onLog: (line: string) => console.error(`[claude] ${line}`) }
            : {}),
          tools: { name: TOOLS_SERVER, url: tools.url, key: tools.key },
        }),
      ],
    ),
    home: join(root, "home"),
  });
  client = connect(daemon.url);
  await client.opened;
});

afterAll(async () => {
  client?.close();
  await daemon?.stop();
  tools?.stop();
  providers?.stop();
  codexModel?.stop();
  claude?.stop();
  rmSync(root, { recursive: true, force: true });
});

const of = (sessionId: string) => client.events().filter((event) => event.sessionId === sessionId);
const ended = (sessionId: string) =>
  of(sessionId).filter((event) => event.type === "turn.completed");
const items = (events: SessionEvent[]): Item[] =>
  events.flatMap((event) => (event.type === "item.completed" ? [event.item] : []));

async function start(mode: "default" | "acceptEdits" = "default") {
  const session = await client.call("session.create", { cwd: project, model: SONNET, mode });
  await client.call("session.open", { sessionId: session.id });
  return session;
}

/** Sends a prompt and waits for the turn it starts to end. With `accept`, says yes to what it asks. */
async function turn(sessionId: string, text: string, accept = false): Promise<SessionEvent[]> {
  const before = of(sessionId).length;
  const turns = ended(sessionId).length;
  const answered = new Set<string>();
  const asked = () =>
    of(sessionId).find(
      (event) => event.type === "approval.requested" && !answered.has(event.approval.id),
    );
  await client.call("session.send", { sessionId, text });
  for (;;) {
    await client.until(() => ended(sessionId).length > turns || (accept && asked() !== undefined));
    if (ended(sessionId).length > turns) break;
    const ask = asked();
    if (ask?.type !== "approval.requested") continue;
    answered.add(ask.approval.id);
    await client.call("approval.respond", {
      sessionId,
      approvalId: ask.approval.id,
      response: { decision: "accept" },
    });
  }
  return of(sessionId).slice(before);
}

test("both agents' models are offered, and a session runs on the agent its model is of", async () => {
  const { models } = await client.call("models.list", {});
  const byHarness = (name: string) => models.filter((model) => model.harness === name);
  expect(byHarness("codex").length).toBeGreaterThan(0);
  expect(byHarness("claude").map((model) => model.id)).toContain(SONNET);
  // A session with no model chosen is the main agent's.
  expect(byHarness("claude").some((model) => model.isDefault)).toBe(false);

  const session = await start();
  expect(session).toMatchObject({
    harness: "claude",
    model: SONNET,
    status: "idle",
    activity: "idle",
  });
  const events = await turn(session.id, "hello there");
  expect(items(events).map((item) => [item.kind, "text" in item ? item.text : ""])).toEqual([
    ["userMessage", "hello there"],
    ["agentMessage", "You said: hello there"],
  ]);
  expect(events.at(-1)).toMatchObject({ type: "turn.completed", status: "completed" });
  expect(events.some((event) => event.type === "item.delta")).toBe(true);
  const usage = events.find((event) => event.type === "usage.updated");
  expect(usage).toMatchObject({ usage: { contextWindow: expect.any(Number) } });

  const other = await client.call("session.create", { cwd: project, mode: "fullAccess" });
  expect(other).toMatchObject({ harness: "codex", model: "mock-model" });
  await client.call("session.open", { sessionId: other.id });
  await client.call("session.send", { sessionId: other.id, text: "PROMPT:hello" });
  await client.until(() => ended(other.id).length === 1);
  expect(items(of(other.id)).at(-1)).toMatchObject({ text: "Hello from codex" });

  // Each stays with the agent it began on.
  expect(
    client.call("session.update", {
      sessionId: session.id,
      model: byHarness("codex")[0]?.id ?? "",
    }),
  ).rejects.toThrow("began on Claude");
  const { sessions } = await client.call("session.list", { archived: false });
  expect(sessions.map((info) => [info.id, info.harness]).toSorted()).toEqual(
    [
      [session.id, "claude"],
      [other.id, "codex"],
    ].toSorted(),
  );
});

test("Claude Code asks the owner before a command that changes something", async () => {
  const session = await start();
  script = (_prompt, results) =>
    results
      ? { text: ["done"] }
      : { call: { name: "Bash", input: { command: "python3 -c \"open('made.txt','w')\"" } } };
  await client.call("session.send", { sessionId: session.id, text: "make a file" });
  await client.until(() => of(session.id).some((event) => event.type === "approval.requested"));
  const asked = of(session.id).find((event) => event.type === "approval.requested");
  if (asked?.type !== "approval.requested") throw new Error("expected an approval");
  expect(asked.approval).toMatchObject({ kind: "command", cwd: project });
  expect(existsSync(join(project, "made.txt"))).toBe(false);
  const { sessions } = await client.call("session.list", { archived: false });
  expect(sessions.find((info) => info.id === session.id)?.activity).toBe("requires_action");

  await client.call("approval.respond", {
    sessionId: session.id,
    approvalId: asked.approval.id,
    response: { decision: "accept" },
  });
  await client.until(() => ended(session.id).length === 1);
  expect(existsSync(join(project, "made.txt"))).toBe(true);
  expect(items(of(session.id)).find((item) => item.kind === "command")).toMatchObject({
    status: "completed",
    exitCode: 0,
  });
});

test("an edit shows what changed, and a stored conversation reads back the same turns", async () => {
  const session = await start("acceptEdits");
  const edit = {
    file_path: join(project, "hello.txt"),
    old_string: "hello",
    new_string: "goodbye",
  };
  script = (_prompt, results) =>
    results ? { text: ["edited"] } : { call: { name: "Edit", input: edit } };
  // Inside the folder, `auto` edits unasked.
  const events = await turn(session.id, "change the greeting");
  expect(events.some((event) => event.type === "approval.requested")).toBe(false);
  expect(items(events).find((item) => item.kind === "fileChange")).toMatchObject({
    status: "completed",
    changes: [
      { path: edit.file_path, change: "update", diff: "@@ -1,1 +1,1 @@\n-hello\n+goodbye" },
    ],
  });
  script = (prompt) => ({ text: ["You said: ", prompt] });
  await turn(session.id, "and again");

  // Another daemon over the same homes knows the session only as Claude Code stored it.
  const reader = new ClaudeHarness({ env: claude.env });
  const stored = await reader.loadSession(session.id, {});
  await reader.dispose();
  expect(stored.session).toMatchObject({
    cwd: project,
    model: SONNET,
    preview: "change the greeting",
  });
  const live = await client.call("session.open", { sessionId: session.id });
  if (!("state" in live)) throw new Error("expected a snapshot");
  expect(stored.turns.map((each) => each.id)).toEqual(live.state.turns.map((each) => each.id));
  expect(stored.turns.map((each) => each.items.map((item) => item.kind))).toEqual([
    ["userMessage", "fileChange", "agentMessage"],
    ["userMessage", "agentMessage"],
  ]);

  // Going back takes the turn out of what the model is sent next.
  const [, second] = live.state.turns;
  await client.call("session.rewind", { sessionId: session.id, turnId: second?.id ?? "" });
  await turn(session.id, "a third thing");
  const sent = JSON.stringify(claude.requests.at(-1));
  expect(sent).toContain("change the greeting");
  expect(sent).not.toContain("and again");
});

test("an agent of Claude Code reads another session through Cycle's tools, unasked and with the key kept from its commands", async () => {
  const first = await start();
  script = () => ({ text: ["The answer is forty-two."] });
  await turn(first.id, "what is the answer");

  const second = await start();
  const read = { name: `mcp__${TOOLS_SERVER}__read_session`, input: { session_id: first.id } };
  script = (_prompt, results) => (results ? { text: ["read it"] } : { call: read });
  const events = await turn(second.id, "read the other one");
  expect(events.some((event) => event.type === "approval.requested")).toBe(false);
  const call = items(events).find((item) => item.kind === "toolCall");
  expect(call).toMatchObject({ server: TOOLS_SERVER, tool: "read_session", status: "completed" });
  expect(call?.kind === "toolCall" ? call.result : "").toContain("The answer is forty-two.");

  // What a command of the agent's can see of the process that runs it: its arguments and its
  // environment. The key is in neither.
  const seen = { name: "Bash", input: { command: "ps -eo args | grep -e --session-id; env" } };
  script = (_prompt, results) => (results ? { text: ["looked"] } : { call: seen });
  const looked = await turn(second.id, "look around", true);
  const output = items(looked).find((item) => item.kind === "command");
  expect(output).toMatchObject({ status: "completed" });
  expect(output?.kind === "command" ? output.output : "").toContain(`--session-id=${second.id}`);
  expect(output?.kind === "command" ? output.output : TOOLS_KEY).not.toContain(TOOLS_KEY);
});

test("a turn can be stopped, and steered while it works", async () => {
  const session = await start();
  script = () => ({ text: Array.from({ length: 40 }, (_, index) => `w${index} `), delayMs: 100 });
  await client.call("session.send", { sessionId: session.id, text: "talk slowly" });
  await client.until(() => of(session.id).some((event) => event.type === "item.delta"));
  await client.call("session.interrupt", { sessionId: session.id });
  await client.until(() => ended(session.id).length === 1);
  expect(ended(session.id)[0]).toMatchObject({ status: "interrupted", error: null });

  let rounds = 0;
  const nap = { name: "Bash", input: { command: "sleep 0.5; echo round" } };
  script = () => (rounds++ < 3 ? { call: nap } : { text: ["finished"] });
  await client.call("session.send", { sessionId: session.id, text: "work a while" });
  await client.until(() => of(session.id).some((event) => event.type === "item.started"));
  await client.call("session.send", {
    sessionId: session.id,
    text: "and mind this",
    delivery: "steer",
  });
  await client.until(() => ended(session.id).length === 2);
  // The model was sent the prompt inside the turn, between two of its tool calls.
  expect(JSON.stringify(claude.requests.at(-1))).toContain("and mind this");
  expect(ended(session.id)).toHaveLength(2);
});
