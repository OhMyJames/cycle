/**
 * A worktree Claude Code's agent enters, through the whole daemon: the real Claude Code on a
 * scripted model, the real `codex app-server` as the machine, real git in a scratch repository, and
 * the desk that serves the harness's callbacks from the hub. What the page would be told is read
 * from the wire, and what the daemon keeps from `sessions.json`.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeHarness } from "@cycle/harness-claude";
import { CodexHarness } from "@cycle/harness-codex";
import type { Item, Session, SessionEvent } from "@cycle/protocol";
import {
  type Daemon,
  Harnesses,
  type OpenProviders,
  TOOLS_KEY_ENV,
  TOOLS_SERVER,
  type ToolsServer,
  WorktreeDesk,
  diskFile,
  openProviders,
  startDaemon,
  startTools,
} from "../../src/index.ts";
import { enters, leaves, runs, toolResults } from "./claude-worktree-rig.ts";
import { installFakeSbx, openSandboxes } from "./fake-sbx.ts";
import { type ClaudeReply, type MockClaude, startMockClaude } from "./mock-claude.ts";
import { type MockModel, startMockModel } from "./mock-model.ts";
import { type WireClient, connect } from "./wire-client.ts";

const SONNET = "claude-sonnet-5-5";

let daemon: Daemon;
let codexModel: MockModel;
let claude: MockClaude;
let tools: ToolsServer;
let providers: OpenProviders;
let sandboxes: Awaited<ReturnType<typeof openSandboxes>>;
let root: string;
let project: string;
let client: WireClient;
let script: (prompt: string, results: number) => ClaudeReply;
let worktrees = new WorktreeDesk();

const git = (...args: string[]): string => {
  const result = Bun.spawnSync(["git", ...args], { cwd: project });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
};

/** The daemon over the folders of this test, as it starts again after being stopped. */
const start = () =>
  startDaemon({
    tools,
    worktrees,
    providers: providers.store,
    sandboxes,
    harness: new Harnesses(
      new CodexHarness({
        config: codexModel.codexConfig,
        env: { CODEX_HOME: join(root, "codex") },
        tools: { name: TOOLS_SERVER, url: tools.url, keyEnv: TOOLS_KEY_ENV, key: tools.key },
      }),
      [
        new ClaudeHarness({
          env: claude.env,
          worktrees,
          sandboxes: sandboxes.admin,
          tools: { name: TOOLS_SERVER, url: tools.url, key: tools.key },
        }),
      ],
    ),
    home: join(root, "home"),
  });

/** Stops the daemon, which writes what it keeps, and starts another over the same folders. */
async function restart(): Promise<void> {
  client.close();
  await daemon.stop();
  worktrees = new WorktreeDesk();
  daemon = await start();
  client = connect(daemon.url);
  await client.opened;
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cycle-worktree-daemon-")));
  project = join(root, "project");
  mkdirSync(project);
  mkdirSync(join(root, "codex"));
  writeFileSync(join(project, "hello.txt"), "hello\n");
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.name", "t"],
    ["config", "user.email", "t@example.com"],
    ["add", "-A"],
    ["commit", "-q", "-m", "first"],
  ]) {
    git(...args);
  }
  const sbx = installFakeSbx(root);
  script = () => ({ text: ["done"] });
  codexModel = startMockModel(() => ({ text: ["Hello"] }));
  claude = startMockClaude(root, (prompt, results) => script(prompt, results));
  tools = startTools("worktree-daemon-tools-key");
  providers = await openProviders(
    diskFile(join(root, "home", "providers.json")),
    "gateway-token",
    join(root, "home", "provider-models.json"),
  );
  sandboxes = await openSandboxes(root, { ...process.env, ...claude.env, ...sbx.env });
  daemon = await start();
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

async function begin(mode?: "default" | "acceptEdits"): Promise<Session> {
  const session = await client.call("session.create", {
    cwd: project,
    model: SONNET,
    ...(mode ? { mode } : {}),
  });
  await client.call("session.open", { sessionId: session.id });
  return session;
}

const listed = async (sessionId: string): Promise<Session | undefined> =>
  (await client.call("session.list", { archived: false })).sessions.find(
    (info) => info.id === sessionId,
  );

/** What the daemon wrote of sessions, which it does after a pause: read once it has stopped. */
const kept = (): Record<string, { worktree?: { origin: string; path: string } }> =>
  (
    JSON.parse(readFileSync(join(root, "home", "sessions.json"), "utf8")) as {
      sessions: Record<string, { worktree?: { origin: string; path: string } }>;
    }
  ).sessions;

const folder = (name: string) => join(project, ".agents", "worktree", `cycle-${name}`);

test("an EnterWorktree makes the worktree under .agents, asks for no approval even in default mode, and the session says where it is", async () => {
  script = (_prompt, results) => (results ? { text: ["entered"] } : enters("first"));
  // `default` asks before most things (the `pwd` below is asked and accepted): the enter is not.
  const session = await begin("default");
  expect(session.mode).toBe("default");
  const events = await turn(session.id, "enter one");
  expect(events.some((event) => event.type === "approval.requested")).toBe(false);
  expect(events.at(-1)).toMatchObject({ type: "turn.completed", status: "completed" });
  expect(toolResults(claude.requests).join("\n")).toContain(folder("first"));
  const info = await listed(session.id);
  expect(info).toMatchObject({
    cwd: project,
    branch: "cycle/first",
    worktree: { repo: project, branch: "cycle/first", path: folder("first"), origin: "agent" },
  });
  // Cycle's, not Claude Code's: unlocked, on cycle/<name>, the project quiet, no `.claude` made.
  expect(git("worktree", "list", "--porcelain")).not.toContain("locked");
  expect(git("branch", "--list", "cycle/first")).toContain("cycle/first");
  expect(git("status", "--porcelain")).toBe("");
  expect(existsSync(join(project, ".claude"))).toBe(false);

  // The next prompt's `init` says the agent is in it: the record stays, and a command runs there.
  script = (_prompt, results) => (results ? { text: ["here"] } : runs("pwd"));
  const second = await turn(session.id, "where are you");
  const command = items(second).find((item) => item.kind === "command");
  expect(command?.kind === "command" ? command.output.trim() : "").toBe(folder("first"));
  expect((await listed(session.id))?.worktree?.path).toBe(folder("first"));
});

test("the record is written to sessions.json, and a new daemon's process starts in the worktree and keeps it", async () => {
  const [before] = (await client.call("session.list", { archived: false })).sessions;
  const id = before?.id ?? "";
  await restart();
  expect(kept()[id]?.worktree).toMatchObject({ origin: "agent", path: folder("first") });
  expect((await listed(id))?.worktree).toMatchObject({ origin: "agent", path: folder("first") });
  await client.call("session.open", { sessionId: id });
  script = (_prompt, results) => (results ? { text: ["here"] } : runs("pwd"));
  const events = await turn(id, "still there?");
  const command = items(events).find((item) => item.kind === "command");
  expect(command?.kind === "command" ? command.output.trim() : "").toBe(folder("first"));
  expect((await listed(id))?.worktree?.path).toBe(folder("first"));
});

test("a keep leaves the worktree on disk and, once the agent is seen in its own folder, off the session", async () => {
  const id = (await client.call("session.list", { archived: false })).sessions[0]?.id ?? "";
  script = (_prompt, results) => (results ? { text: ["left"] } : leaves("keep"));
  await turn(id, "leave it");
  await restart();
  await client.call("session.open", { sessionId: id });
  script = () => ({ text: ["back"] });
  await turn(id, "and now?");
  const info = await listed(id);
  expect(info?.worktree).toBeNull();
  await daemon.stop();
  expect(kept()[id]?.worktree).toBeUndefined();
  daemon = await start();
  client = connect(daemon.url);
  await client.opened;
  expect(existsSync(folder("first"))).toBe(true);
  expect(git("branch", "--list", "cycle/first")).toContain("cycle/first");
});

test("a remove asks Cycle for nothing to remove: the folder and branch stay, and the thread says so", async () => {
  script = (_prompt, results) => {
    if (results === 0) return enters("second");
    return results === 1 ? leaves("remove", true) : { text: ["removed"] };
  };
  const session = await begin();
  const events = await turn(session.id, "enter and remove");
  const notice = events.find((event) => event.type === "notice");
  expect(notice).toMatchObject({
    level: "info",
    message:
      "Claude Code asked to remove the worktree cycle/second. Cycle keeps it until you remove it.",
  });
  expect(existsSync(folder("second"))).toBe(true);
  expect(git("branch", "--list", "cycle/second")).toContain("cycle/second");
  expect((await listed(session.id))?.worktree).toBeNull();
});

test("deleting a session with its worktree removes the folder, as for any, and keeps the branch", async () => {
  script = (_prompt, results) => (results ? { text: ["entered"] } : enters("third"));
  const session = await begin();
  await turn(session.id, "enter three");
  expect(existsSync(folder("third"))).toBe(true);
  await client.call("session.delete", { sessionId: session.id, removeWorktree: true });
  expect(existsSync(folder("third"))).toBe(false);
  expect(git("branch", "--list", "cycle/third")).toContain("cycle/third");
});

test("a name the daemon refuses is a refusal the model reads, and nothing is made or recorded", async () => {
  script = (_prompt, results) => (results ? { text: ["refused"] } : enters("x.lock"));
  const session = await begin();
  const before = git("worktree", "list", "--porcelain");
  await turn(session.id, "enter a lock");
  expect(toolResults(claude.requests).join("\n")).toContain(
    "No part of a worktree's name ends with a dot or in .lock.",
  );
  expect(git("worktree", "list", "--porcelain")).toBe(before);
  expect((await listed(session.id))?.worktree).toBeNull();
});

/**
 * Whether Claude Code's latest request to the model names a tool anywhere: the two worktree tools
 * are deferred ones, which it lists in the conversation, not among the tools it sends.
 */
const offers = (tool: string) => JSON.stringify(claude.requests.at(-1)).includes(tool);

test("a session in a container is given neither tool, and one on this machine both", async () => {
  script = () => ({ text: ["hi"] });
  const local = await begin();
  await turn(local.id, "on this machine");
  expect(offers("EnterWorktree")).toBe(true);
  expect(offers("ExitWorktree")).toBe(true);
  const boxed = await client.call("session.create", {
    cwd: project,
    model: SONNET,
    environment: "standard",
  });
  await client.call("session.open", { sessionId: boxed.id });
  await turn(boxed.id, "in a container");
  expect(offers("EnterWorktree")).toBe(false);
  expect(offers("ExitWorktree")).toBe(false);
  expect(offers("Bash")).toBe(true);
});
