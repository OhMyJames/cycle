/**
 * A session whose agent runs in a sandbox, end to end, with a stand-in for Docker's `sbx`
 * (`fake-sbx.sh`): the real Claude Code is started through `sbx exec`, with a home of its own, and
 * what is said there is read back from this side.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeHarness, projectFolder, sandboxName, sbxSandboxes } from "@cycle/harness-claude";
import { CodexHarness } from "@cycle/harness-codex";
import type { Item, SessionEvent } from "@cycle/protocol";
import {
  type Daemon,
  Harnesses,
  type OpenProviders,
  type ToolsServer,
  diskFile,
  openProviders,
  startDaemon,
  startTools,
} from "../../src/index.ts";
import { installFakeSbx } from "./fake-sbx.ts";
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
let state: string;
let client: WireClient;
let script: (prompt: string, results: number) => ClaudeReply;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "cycle-sbx-"));
  project = join(root, "project");
  mkdirSync(project);
  mkdirSync(join(root, "codex"));
  const sbx = installFakeSbx(root);
  state = sbx.state;

  script = (prompt) => ({ text: ["You said: ", prompt] });
  codexModel = startMockModel(() => ({ text: ["Hello", " from codex"] }));
  claude = startMockClaude(root, (prompt, results) => script(prompt, results));
  tools = startTools("sandbox-test-tools-key");
  providers = await openProviders(
    diskFile(join(root, "home", "providers.json")),
    "gateway-token",
    join(root, "home", "provider-models.json"),
  );
  const env = { ...process.env, ...claude.env, ...sbx.env };
  daemon = await startDaemon({
    tools,
    providers: providers.store,
    harness: new Harnesses(
      new CodexHarness({
        config: codexModel.codexConfig,
        env: { CODEX_HOME: join(root, "codex") },
      }),
      [
        new ClaudeHarness({
          env: claude.env,
          sandboxes: sbxSandboxes(env),
          tools: { name: "cycle", url: tools.url, key: tools.key },
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

/** Sends a prompt and waits for the turn it starts to end, saying yes to what it asks meanwhile. */
async function turn(sessionId: string, text: string): Promise<SessionEvent[]> {
  const before = of(sessionId).length;
  const turns = ended(sessionId).length;
  const answered = new Set<string>();
  const asked = () =>
    of(sessionId).find(
      (event) => event.type === "approval.requested" && !answered.has(event.approval.id),
    );
  await client.call("session.send", { sessionId, text });
  for (;;) {
    await client.until(() => ended(sessionId).length > turns || asked() !== undefined);
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

test("a session's agent runs in the folder's sandbox, and its conversation is kept on this side", async () => {
  const { models } = await client.call("models.list", {});
  expect(models.filter((model) => model.sandbox).map((model) => model.harness)).toContain("claude");
  expect(models.some((model) => model.harness === "codex" && model.sandbox)).toBe(false);

  const name = sandboxName(project);
  const session = await client.call("session.create", {
    cwd: project,
    model: SONNET,
    mode: "auto",
    sandbox: true,
  });
  expect(session).toMatchObject({ harness: "claude", sandbox: name });
  expect(readFileSync(join(state, "names"), "utf8")).toBe(`${name}\n`);
  await client.call("session.open", { sessionId: session.id });

  const events = await turn(session.id, "hello from outside");
  expect(events.at(-1)).toMatchObject({ type: "turn.completed", status: "completed" });
  expect(items(events).at(-1)).toMatchObject({ text: "You said: hello from outside" });
  // It was the sandbox's own Claude Code that ran, in the folder.
  expect(readFileSync(join(state, "execs"), "utf8")).toBe(`${name} ${project} claude\n`);

  // A command of the agent's runs inside: its home is the sandbox's, and it holds no key of ours.
  const look = { name: "Bash", input: { command: "echo home=$HOME; env" } };
  script = (_prompt, results) => (results ? { text: ["looked"] } : { call: look });
  const looked = items(await turn(session.id, "look around")).find(
    (item) => item.kind === "command",
  );
  const output = looked?.kind === "command" ? looked.output : "";
  expect(output).toContain(`home=${join(state, name, "home")}`);
  expect(output).not.toContain("sandbox-test-tools-key");
  expect(output).not.toContain("CODEX_HOME");

  // The conversation is where this machine's Claude Code keeps the folder's, and nowhere else of
  // its home went into the sandbox.
  const kept = join(root, "claude", "projects", projectFolder(project));
  expect(readdirSync(kept)).toContain(`${session.id}.jsonl`);
  expect(readdirSync(join(state, name, "home", ".claude", "projects"))).toEqual([
    projectFolder(project),
  ]);
  const reader = new ClaudeHarness({ env: claude.env });
  const stored = await reader.loadSession(session.id, {});
  await reader.dispose();
  expect(stored.turns.map((each) => each.items.map((item) => item.kind))).toEqual([
    ["userMessage", "agentMessage"],
    ["userMessage", "command", "agentMessage"],
  ]);
  const { sessions } = await client.call("session.list", { archived: false });
  expect(sessions.find((info) => info.id === session.id)).toMatchObject({ sandbox: name });
});

test("a second session in the folder shares its sandbox, and one outside a sandbox runs here", async () => {
  script = (prompt) => ({ text: ["You said: ", prompt] });
  const second = await client.call("session.create", {
    cwd: project,
    model: SONNET,
    sandbox: true,
  });
  await client.call("session.open", { sessionId: second.id });
  await turn(second.id, "another");
  expect(readFileSync(join(state, "names"), "utf8").trim().split("\n")).toHaveLength(1);

  const execs = readFileSync(join(state, "execs"), "utf8");
  const local = await client.call("session.create", { cwd: project, model: SONNET });
  expect(local.sandbox).toBeNull();
  await client.call("session.open", { sessionId: local.id });
  await turn(local.id, "on this machine");
  expect(readFileSync(join(state, "execs"), "utf8")).toBe(execs);

  // Codex has no sandbox to run in yet, and a worktree's history would be left outside one.
  expect(client.call("session.create", { cwd: project, sandbox: true })).rejects.toThrow(
    "Codex sessions do not run in a sandbox yet.",
  );
  expect(existsSync(join(state, "names"))).toBe(true);
});
