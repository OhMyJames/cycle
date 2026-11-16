/**
 * Claude Code's modes and approvals, end to end: the real Claude Code, driven by the Claude Agent
 * SDK against a scripted model, beside the real `codex app-server`.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeHarness } from "@cycle/harness-claude";
import { CodexHarness } from "@cycle/harness-codex";
import type { Approval, ApprovalAnswer, Item, SessionEvent } from "@cycle/protocol";
import {
  type Daemon,
  Harnesses,
  type OpenProviders,
  diskFile,
  openProviders,
  startDaemon,
} from "../../src/index.ts";
import { type ClaudeReply, type MockClaude, startMockClaude } from "./mock-claude.ts";
import { type MockModel, startMockModel } from "./mock-model.ts";
import { type WireClient, connect } from "./wire-client.ts";

const SONNET = "claude-sonnet-5-5";

let daemon: Daemon;
let codexModel: MockModel;
let claude: MockClaude;
let providers: OpenProviders;
let root: string;
let project: string;
let client: WireClient;
let script: (prompt: string, results: number) => ClaudeReply;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "cycle-claude-modes-"));
  project = join(root, "project");
  mkdirSync(project);
  mkdirSync(join(root, "codex"));
  script = () => ({ text: ["ok"] });
  codexModel = startMockModel(() => ({ text: ["Hello from codex"] }));
  claude = startMockClaude(root, (prompt, results) => script(prompt, results));
  providers = await openProviders(
    diskFile(join(root, "home", "providers.json")),
    "gateway-token",
    join(root, "home", "provider-models.json"),
  );
  daemon = await startDaemon({
    providers: providers.store,
    harness: new Harnesses(
      new CodexHarness({
        config: codexModel.codexConfig,
        env: { CODEX_HOME: join(root, "codex") },
      }),
      [
        new ClaudeHarness({
          env: claude.env,
          ...(process.env["CYCLE_DEBUG"]
            ? { onLog: (line: string) => console.error(`[claude] ${line}`) }
            : {}),
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
const asked = (sessionId: string): Approval[] =>
  of(sessionId).flatMap((event) => (event.type === "approval.requested" ? [event.approval] : []));

async function start(mode: string) {
  const session = await client.call("session.create", { cwd: project, model: SONNET, mode });
  await client.call("session.open", { sessionId: session.id });
  return session;
}

/** Sends a prompt and answers the first thing it asks, as `answer` says. */
async function askedOnce(
  sessionId: string,
  text: string,
  answer: (approval: Approval) => ApprovalAnswer,
): Promise<Approval> {
  const before = asked(sessionId).length;
  const turns = ended(sessionId).length;
  await client.call("session.send", { sessionId, text });
  await client.until(() => asked(sessionId).length > before);
  const approval = asked(sessionId)[before] as Approval;
  await client.call("approval.respond", {
    sessionId,
    approvalId: approval.id,
    response: answer(approval),
  });
  await client.until(() => ended(sessionId).length > turns);
  return approval;
}

test("the modes on offer are each agent's own", async () => {
  const { modes } = await client.call("modes.list", {});
  const ids = (harness: string) =>
    modes.filter((mode) => mode.harness === harness).map((mode) => mode.id);
  expect(ids("claude")).toEqual([
    "default",
    "acceptEdits",
    "plan",
    "auto",
    "dontAsk",
    "bypassPermissions",
  ]);
  expect(ids("codex")).toEqual(["readOnly", "auto", "plan", "fullAccess"]);
  const settings = await client.call("settings.get", {});
  expect(settings.modes).toEqual({ codex: "auto", claude: "acceptEdits" });
  expect(
    client.call("session.create", { cwd: project, model: SONNET, mode: "fullAccess" }),
  ).rejects.toThrow("Claude has no mode named fullAccess");
});

test("a plan is shown, approved into the mode the owner picks, and kept in the conversation", async () => {
  const session = await start("plan");
  const plan = "# The plan\n\n1. Say done.";
  script = (_prompt, results) =>
    results ? { text: ["done"] } : { call: { name: "ExitPlanMode", input: { plan } } };
  const approval = await askedOnce(session.id, "plan something", () => ({
    decision: "accept",
    mode: "acceptEdits",
  }));
  // Never a mode that does not ask.
  expect(approval).toEqual({
    id: approval.id,
    kind: "plan",
    itemId: approval.id,
    plan,
    modes: ["default", "acceptEdits", "auto", "dontAsk"],
  });
  expect(items(of(session.id)).find((item) => item.kind === "plan")).toMatchObject({ text: plan });
  // Claude Code left plan mode for the one picked, and the session follows it.
  await client.until(() =>
    client.pushes.some(
      (push) =>
        push.type === "sessions.changed" &&
        push.sessions.some((info) => info.id === session.id && info.mode === "acceptEdits"),
    ),
  );
  expect(
    of(session.id).some(
      (event) => event.type === "notice" && event.message === "Claude moved to Accept edits.",
    ),
  ).toBe(true);
  expect(ended(session.id).at(-1)).toMatchObject({ status: "completed" });
});

test("a rule kept for the session lets the like through unasked, and is written nowhere", async () => {
  const session = await start("default");
  const command = "python3 -c \"open('kept.txt','w')\"";
  script = (_prompt, results) =>
    results ? { text: ["made"] } : { call: { name: "Bash", input: { command } } };
  const approval = await askedOnce(session.id, "make it", (asking) => ({
    decision: "accept",
    rules: asking.kind === "command" ? (asking.rules ?? []).map((rule) => rule.id) : [],
  }));
  expect(approval).toMatchObject({ kind: "command", editable: true, notes: true });
  expect(approval.kind === "command" ? approval.rules?.length : 0).toBeGreaterThan(0);
  expect(existsSync(join(project, "kept.txt"))).toBe(true);
  rmSync(join(project, "kept.txt"));

  const before = asked(session.id).length;
  const turns = ended(session.id).length;
  await client.call("session.send", { sessionId: session.id, text: "again" });
  await client.until(() => ended(session.id).length > turns);
  expect(asked(session.id)).toHaveLength(before);
  expect(existsSync(join(project, "kept.txt"))).toBe(true);
  // Kept for the session only: nothing went to the project's settings.
  expect(existsSync(join(project, ".claude", "settings.local.json"))).toBe(false);
  expect(existsSync(join(project, ".claude", "settings.json"))).toBe(false);
});

test("a refusal tells the agent why, and the call shows as declined", async () => {
  const session = await start("default");
  const command = "python3 -c \"open('refused.txt','w')\"";
  script = (_prompt, results) =>
    results ? { text: ["understood"] } : { call: { name: "Bash", input: { command } } };
  await askedOnce(session.id, "make another", () => ({
    decision: "decline",
    message: "write it under tmp instead",
  }));
  expect(existsSync(join(project, "refused.txt"))).toBe(false);
  expect(items(of(session.id)).find((item) => item.kind === "command")).toMatchObject({
    status: "declined",
  });
  expect(JSON.stringify(claude.requests.at(-1))).toContain("write it under tmp instead");
});

test("the owner's change of mode reaches a running Claude Code in place", async () => {
  const session = await start("default");
  script = () => ({ text: ["hi"] });
  const turns = ended(session.id).length;
  await client.call("session.send", { sessionId: session.id, text: "hello" });
  await client.until(() => ended(session.id).length > turns);
  await client.call("session.update", { sessionId: session.id, mode: "dontAsk" });
  // Don't ask refuses what no rule allows, without asking.
  const command = "python3 -c \"open('never.txt','w')\"";
  script = (_prompt, results) =>
    results ? { text: ["refused"] } : { call: { name: "Bash", input: { command } } };
  const before = asked(session.id).length;
  await client.call("session.send", { sessionId: session.id, text: "try it" });
  await client.until(() => ended(session.id).length > turns + 1);
  expect(asked(session.id)).toHaveLength(before);
  expect(existsSync(join(project, "never.txt"))).toBe(false);
  expect(
    items(of(session.id))
      .filter((item) => item.kind === "command")
      .at(-1),
  ).toMatchObject({
    status: "declined",
  });
});
