/**
 * A choice Claude Code asks the owner (`AskUserQuestion`), end to end: the real Claude Code, driven
 * by the Claude Agent SDK against a scripted model, through the daemon's wire. No MCP server of the
 * mock raises an elicitation, so that is covered by `harness/claude/test` only.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeHarness } from "@cycle/harness-claude";
import { CodexHarness } from "@cycle/harness-codex";
import type { Approval, Question, SessionEvent } from "@cycle/protocol";
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
const QUESTIONS = [
  {
    question: "Which color?",
    header: "Color",
    multiSelect: false,
    options: [
      { label: "Red", description: "warm" },
      { label: "Blue", description: "cool" },
    ],
  },
];

let daemon: Daemon;
let codexModel: MockModel;
let claude: MockClaude;
let providers: OpenProviders;
let root: string;
let client: WireClient;
let script: (prompt: string, results: number) => ClaudeReply;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "cycle-claude-question-"));
  const project = join(root, "project");
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

const of = (sessionId: string): SessionEvent[] =>
  client.events().filter((event) => event.sessionId === sessionId);
const turnsEnded = (sessionId: string) =>
  of(sessionId).filter((event) => event.type === "turn.completed");
const asked = (sessionId: string): Approval[] =>
  of(sessionId).flatMap((event) => (event.type === "approval.requested" ? [event.approval] : []));
const resolved = (sessionId: string) =>
  of(sessionId).filter((event) => event.type === "approval.resolved");

const questions = (sessionId: string): Question[] =>
  of(sessionId).flatMap((event) => (event.type === "question.requested" ? [event.question] : []));

async function ask(sessionId: string): Promise<Approval> {
  const before = asked(sessionId).length;
  await client.call("session.send", { sessionId, text: "ask me" });
  await client.until(() => asked(sessionId).length > before);
  return asked(sessionId)[before] as Approval;
}

async function start() {
  const session = await client.call("session.create", {
    cwd: join(root, "project"),
    model: SONNET,
    mode: "default",
  });
  await client.call("session.open", { sessionId: session.id });
  return session;
}

test("a choice is asked, answered by the owner, and the agent reads the answers", async () => {
  const session = await start();
  script = (_prompt, results) =>
    results
      ? { text: ["noted"] }
      : { call: { name: "AskUserQuestion", input: { questions: QUESTIONS } } };
  const asking = await ask(session.id);
  expect(asking).toMatchObject({
    kind: "question",
    questions: [
      {
        id: "Which color?",
        header: "Color",
        options: [
          { label: "Red", description: "warm" },
          { label: "Blue", description: "cool" },
        ],
        allowOther: true,
        secret: false,
      },
    ],
  });
  // While the page draws approvals, the daemon sends the question also as the one it knows, in
  // the same frame.
  const [question] = questions(session.id);
  expect(question).toMatchObject({ id: asking.id, itemId: asking.id, kind: "choice" });
  const frame = client.frames.find((each) =>
    each.events.some((event) => event.type === "question.requested"),
  );
  expect(frame?.events.map((event) => event.type)).toEqual([
    "question.requested",
    "approval.requested",
  ]);
  await client.call("approval.respond", {
    sessionId: session.id,
    approvalId: asking.id,
    response: { answers: { "Which color?": ["Purple"] } },
  });
  await client.until(() => turnsEnded(session.id).length > 0);
  expect(resolved(session.id)).toEqual([
    { type: "approval.resolved", sessionId: session.id, approvalId: asking.id },
  ]);
  expect(turnsEnded(session.id).at(-1)).toMatchObject({ status: "completed" });
  // A free-text answer, which is no option, is in what the agent was told: the tool's result.
  expect(JSON.stringify(claude.requests.at(-1))).toContain("Which color?");
  expect(JSON.stringify(claude.requests.at(-1))).toContain("Purple");
});

test("a choice cancelled ends the turn as stopped", async () => {
  const session = await start();
  script = (_prompt, results) =>
    results
      ? { text: ["noted"] }
      : { call: { name: "AskUserQuestion", input: { questions: QUESTIONS } } };
  const asking = await ask(session.id);
  await client.call("approval.respond", {
    sessionId: session.id,
    approvalId: asking.id,
    response: { decision: "cancel" },
  });
  await client.until(() => turnsEnded(session.id).length > 0);
  expect(resolved(session.id)).toHaveLength(1);
  expect(turnsEnded(session.id).at(-1)).toMatchObject({ status: "interrupted" });
});

test("a choice answered as a question reaches the agent, and no question event holds the answer", async () => {
  const session = await start();
  script = (_prompt, results) =>
    results
      ? { text: ["noted"] }
      : { call: { name: "AskUserQuestion", input: { questions: QUESTIONS } } };
  await client.call("session.send", { sessionId: session.id, text: "ask me" });
  await client.until(() => questions(session.id).length > 0);
  const [question] = questions(session.id);
  expect(question).toMatchObject({ kind: "choice", asks: [{ id: "Which color?", secret: false }] });
  const secret = "swordfish-in-the-answer";
  await client.call("question.answer", {
    sessionId: session.id,
    questionId: question?.id ?? "",
    answer: { answers: { "Which color?": [secret] } },
  });
  await client.until(() => turnsEnded(session.id).length > 0);
  const gone = of(session.id).filter((event) => event.type === "question.resolved");
  expect(gone).toEqual([
    { type: "question.resolved", sessionId: session.id, questionId: question?.id ?? "" },
  ]);
  expect(turnsEnded(session.id).at(-1)).toMatchObject({ status: "completed" });
  // The agent was told it. No event of the question or the approval holds it, nor does a push.
  // Claude Code's own tool result, which it echoes the answer into, is the agent's item and not
  // the question's: its answers are never secret (`secret` is always false), so it is not looked
  // in here.
  expect(JSON.stringify(claude.requests.at(-1))).toContain(secret);
  const asking = of(session.id).filter((event) => /^(question|approval)\./.test(event.type));
  expect(asking.length).toBeGreaterThan(0);
  expect(JSON.stringify(asking)).not.toContain(secret);
  expect(JSON.stringify(client.pushes)).not.toContain(secret);
});
