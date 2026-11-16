/**
 * Claude Code's helper agents and background tasks, end to end: the real Claude Code against a
 * scripted model, through the daemon to a client.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeHarness } from "@cycle/harness-claude";
import { CodexHarness } from "@cycle/harness-codex";
import type { Item, SessionEvent, SessionState } from "@cycle/protocol";
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

/** Whether the latest thing Claude Code sent the model is a task's news. */
function news(body: unknown): boolean {
  const messages = (body as { messages?: { role: string; content: unknown }[] }).messages ?? [];
  const last = messages.at(-1);
  return last?.role === "user" && JSON.stringify(last.content).includes("<task-notification>");
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "cycle-claude-tasks-"));
  project = join(root, "project");
  mkdirSync(project);
  mkdirSync(join(root, "codex"));
  script = (prompt) => ({ text: ["You said: ", prompt] });
  codexModel = startMockModel(() => ({ text: ["Hello from codex"] }));
  claude = startMockClaude(root, (prompt, results, body) =>
    news(body) ? { text: ["The task is done."] } : script(prompt, results),
  );
  tools = startTools("claude-tasks-tools-key");
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
      [new ClaudeHarness({ env: claude.env })],
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
const listed = (sessionId: string) =>
  of(sessionId).flatMap((event) => (event.type === "tasks.updated" ? [event.tasks] : []));

async function start() {
  // `fullAccess` keeps the commands from asking: what is tested here is the tasks.
  const session = await client.call("session.create", {
    cwd: project,
    model: SONNET,
    mode: "bypassPermissions",
  });
  await client.call("session.open", { sessionId: session.id });
  return session;
}

async function state(sessionId: string): Promise<SessionState> {
  const opened = await client.call("session.open", { sessionId });
  if (!("state" in opened)) throw new Error("expected a snapshot");
  return opened.state;
}

const brief = (items: Item[]) =>
  items.map((item) => {
    const status = "status" in item ? ` ${item.status}` : "";
    return `${item.kind}${status}${item.parentId ? " nested" : ""}`;
  });

test("a helper agent in the foreground is a task, with what it did inside it", async () => {
  const session = await start();
  const agent = {
    description: "Look around",
    prompt: "helper: look",
    subagent_type: "general-purpose",
    run_in_background: false,
  };
  script = (prompt, results) => {
    if (prompt === "helper: look") {
      return results
        ? { text: ["helper found a.txt"] }
        : { call: { name: "Bash", input: { command: "echo a.txt" } } };
    }
    return results ? { text: ["main done"] } : { call: { name: "Agent", input: agent } };
  };
  await client.call("session.send", { sessionId: session.id, text: "delegate" });
  await client.until(() => ended(session.id).length === 1);
  const [turn] = (await state(session.id)).turns;
  expect(turn?.origin).toBeUndefined();
  expect(brief(turn?.items ?? [])).toEqual([
    "userMessage",
    "task completed",
    "command completed nested",
    "agentMessage nested",
    "agentMessage",
  ]);
  const task = turn?.items[1];
  expect(task).toMatchObject({
    kind: "task",
    task: "agent",
    agent: "general-purpose",
    background: false,
  });
  expect(turn?.items[2]).toMatchObject({ parentId: task?.id, output: "a.txt" });
  expect(turn?.items[3]).toMatchObject({ text: "helper found a.txt" });
  // Its news came inside the turn: no turn of the agent's own follows.
  expect((await state(session.id)).turns).toHaveLength(1);
});

test("a command in the background ends after its turn, and the agent takes up its news in a turn of its own", async () => {
  const session = await start();
  const slow = { command: "sleep 1; echo built", description: "Build", run_in_background: true };
  script = (_prompt, results) =>
    results ? { text: ["started the build"] } : { call: { name: "Bash", input: slow } };
  await client.call("session.send", { sessionId: session.id, text: "build it" });
  await client.until(() => ended(session.id).length === 2);
  const [first, second] = (await state(session.id)).turns;
  const task = first?.items.find((item) => item.kind === "task");
  expect(task).toMatchObject({ task: "command", background: true, status: "completed" });
  // Claude Code lists a task before it tells of it: the list names its item once it is told.
  const lists = listed(session.id);
  expect(lists.findLast((tasks) => tasks.length > 0)?.map((each) => each.itemId)).toEqual([
    task?.id ?? "",
  ]);
  expect(lists.at(-1)).toEqual([]);
  expect(second?.origin).toEqual({
    kind: "task",
    taskId: task?.kind === "task" ? task.taskId : "",
  });
  expect(brief(second?.items ?? [])).toEqual(["agentMessage"]);
  // The owner's next prompt is a turn of its own, after the agent's.
  script = (prompt) => ({ text: ["You said: ", prompt] });
  await client.call("session.send", { sessionId: session.id, text: "thanks" });
  await client.until(() => ended(session.id).length === 3);
  const live = await state(session.id);
  expect(live.turns.at(-1)?.origin).toBeUndefined();

  // Read back from what Claude Code stored, the turns are the same ones, under the same ids.
  const reader = new ClaudeHarness({ env: claude.env });
  const stored = await reader.loadSession(session.id, {});
  await reader.dispose();
  const shape = (turns: typeof live.turns) =>
    turns.map((turn) => [turn.id, turn.origin?.kind ?? "owner", turn.status]);
  expect(shape(stored.turns)).toEqual(shape(live.turns));
  // And the agent's turn can be gone back to by the id it had while it ran.
  await client.call("session.rewind", { sessionId: session.id, turnId: second?.id ?? "" });
  expect((await state(session.id)).turns.map((turn) => turn.id)).toEqual([first?.id ?? ""]);
});

test("one task in the background is stopped by itself, and its turn's end does not stop it", async () => {
  const session = await start();
  const forever = { command: "sleep 30", description: "Wait", run_in_background: true };
  script = (_prompt, results) =>
    results ? { text: ["waiting"] } : { call: { name: "Bash", input: forever } };
  await client.call("session.send", { sessionId: session.id, text: "wait" });
  await client.until(() => ended(session.id).length === 1);
  const running = (await state(session.id)).tasks;
  expect(running).toHaveLength(1);
  await client.call("session.stopTask", { sessionId: session.id, taskId: running[0]?.id ?? "" });
  await client.until(() => listed(session.id).at(-1)?.length === 0);
  const after = await state(session.id);
  const task = after.turns[0]?.items.find((item) => item.kind === "task");
  expect(task).toMatchObject({ status: "stopped" });
  expect(after.turns[0]?.status).toBe("completed");
  expect(of(session.id).some((event: SessionEvent) => event.type === "notice")).toBe(false);
});
