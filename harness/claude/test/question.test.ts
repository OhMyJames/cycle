import { expect, test } from "bun:test";
import type { HarnessEvent, Question } from "@cycle/protocol";
import {
  ClaudeHarness,
  toApproval,
  toElicitationQuestion,
  toElicitationResult,
  toPermission,
  toQuestion,
  toQuestionPermission,
} from "../src/index.ts";
import { FakeSdk, settle } from "./fake-sdk.ts";

const SONNET = "claude-sonnet-5-5";
const hint = { cwd: "/project" };
const picked = { question: "Which?", header: "Pick", options: [{ label: "A", description: "a" }] };
const FORM = { serverName: "docs", message: "Name?", requestedSchema: { properties: {} } };

async function begun() {
  const sdk = new FakeSdk();
  let ids = 0;
  const harness = new ClaudeHarness({
    sdk,
    env: { CLAUDE_CONFIG_DIR: "/home/me/.claude" },
    schedule: () => () => {},
    now: () => 1000,
    newId: () => `id${++ids}`,
  });
  const events: HarnessEvent[] = [];
  harness.onEvent((event) => events.push(event));
  const session = await harness.createSession({ cwd: "/project", model: SONNET });
  await harness.send(session.id, { text: "hello", images: [] }, { mode: "default", model: SONNET });
  await settle();
  return { harness, events, session, query: sdk.last };
}

const ofType = <T extends HarnessEvent["type"]>(events: HarnessEvent[], type: T) =>
  events.filter((event): event is Extract<HarnessEvent, { type: T }> => event.type === type);

test("a choice Claude Code asks is a question of asks, and is no approval", () => {
  expect(toQuestion("i", "AskUserQuestion", { questions: [picked] })).toEqual({
    id: "i",
    itemId: "i",
    kind: "choice",
    asks: [
      {
        // Claude Code takes its answers by the question's own text.
        id: "Which?",
        header: "Pick",
        question: "Which?",
        options: [{ label: "A", description: "a" }],
        allowOther: true,
        secret: false,
      },
    ],
  });
  expect(toQuestion("i", "AskUserQuestion", {})).toMatchObject({ kind: "choice", asks: [] });
  expect(toQuestion("i", "Bash", { command: "ls" })).toBeNull();
  expect(toApproval("i", "AskUserQuestion", { questions: [picked] }, hint)).toMatchObject({
    kind: "tool",
  });
});

test("a choice is answered by the text of each ask, and refused as any tool is", () => {
  const input = { questions: [] };
  expect(toQuestionPermission(input, { answers: { "Which?": ["A", "B"] } })).toEqual({
    behavior: "allow",
    updatedInput: { questions: [], answers: { "Which?": "A, B" } },
  });
  expect(toQuestionPermission(input, { action: "accept" })).toEqual({
    behavior: "allow",
    updatedInput: input,
  });
  expect(toQuestionPermission(input, { action: "decline" })).toMatchObject({ behavior: "deny" });
  expect(toQuestionPermission(input, { action: "cancel" })).toEqual({
    behavior: "deny",
    message: "The owner stopped the turn.",
    interrupt: true,
  });
  // What an approval's answer carrying choices does is what a choice's answer does.
  expect(toPermission("AskUserQuestion", input, [], { answers: { "Which?": ["A"] } })).toEqual(
    toQuestionPermission(input, { answers: { "Which?": ["A"] } }),
  );
});

test("an MCP server's form is drawn as fields when it can be, and its page is a link", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string", title: "Name" },
      size: { type: "string", enum: ["s", "m"], description: "How big" },
      ok: { type: "boolean" },
    },
    required: ["name"],
  };
  const form = toElicitationQuestion("e", {
    serverName: "docs",
    message: "Who?",
    requestedSchema: schema,
  });
  expect(form).toMatchObject({
    id: "e",
    itemId: "e",
    kind: "form",
    server: "docs",
    message: "Who?",
    fields: [
      { name: "name", title: "Name", type: "string", options: null, required: true },
      { name: "size", title: "size", description: "How big", options: ["s", "m"] },
      { name: "ok", type: "boolean", required: false },
    ],
  });
  const nested = { properties: { where: { type: "object" } } };
  expect(
    toElicitationQuestion("e", { serverName: "d", message: "", requestedSchema: nested }),
  ).toMatchObject({ kind: "form", fields: null, schema: JSON.stringify(nested, null, 2) });
  expect(
    toElicitationQuestion("e", {
      serverName: "d",
      message: "Sign in",
      mode: "url",
      url: "https://x",
    }),
  ).toEqual({
    id: "e",
    itemId: "e",
    kind: "link",
    server: "d",
    message: "Sign in",
    url: "https://x",
  });
  // A url mode with no address has no page to open: it reads as a form.
  expect(toElicitationQuestion("e", { serverName: "d", message: "?", mode: "url" })).toMatchObject({
    kind: "form",
  });
  // An address of a request that is not in url mode is not a page to open.
  expect(
    toElicitationQuestion("e", { serverName: "d", message: "?", mode: "form", url: "https://x" }),
  ).toMatchObject({ kind: "form" });
});

test("an MCP server's request is answered with accept, decline or cancel, and content only on accept", () => {
  expect(toElicitationResult({ action: "accept", content: { name: "me" } })).toEqual({
    action: "accept",
    content: { name: "me" },
  });
  expect(toElicitationResult({ action: "accept" })).toEqual({ action: "accept" });
  expect(toElicitationResult({ action: "decline", content: { name: "me" } })).toEqual({
    action: "decline",
  });
  expect(toElicitationResult({ action: "cancel" })).toEqual({ action: "cancel" });
  // Choices are no answer to a form: it is declined.
  expect(toElicitationResult({ answers: { a: ["b"] } })).toEqual({ action: "decline" });
});

test("a choice is asked as a question, answered, and no word of the answer is in an event", async () => {
  const { harness, events, session, query } = await begun();
  const input = { questions: [picked] };
  const signal = new AbortController().signal;
  const secret = "hunter2-the-secret";
  const asked = query.options.canUseTool?.("AskUserQuestion", input, {
    signal,
    toolUseID: "toolu_q",
  });
  await settle();
  expect(ofType(events, "approval.requested")).toEqual([]);
  const [requested] = ofType(events, "question.requested");
  expect(requested).toMatchObject({
    sessionId: session.id,
    turnId: expect.any(String),
    question: { id: "toolu_q", kind: "choice" },
  });
  harness.answerQuestion("toolu_q", { answers: { "Which?": [secret] } });
  expect(await asked).toEqual({
    behavior: "allow",
    updatedInput: { ...input, answers: { "Which?": secret } },
  });
  expect(ofType(events, "question.resolved")).toEqual([
    { type: "question.resolved", sessionId: session.id, questionId: "toolu_q" },
  ]);
  expect(ofType(events, "approval.resolved")).toEqual([]);
  expect(JSON.stringify(events)).not.toContain(secret);
});

test("a choice declined or cancelled is refused, and cancelling stops the turn", async () => {
  const { harness, query } = await begun();
  const signal = new AbortController().signal;
  const input = { questions: [picked] };
  const first = query.options.canUseTool?.("AskUserQuestion", input, { signal, toolUseID: "q1" });
  harness.answerQuestion("q1", { action: "decline" });
  expect(await first).toMatchObject({ behavior: "deny" });
  const second = query.options.canUseTool?.("AskUserQuestion", input, { signal, toolUseID: "q2" });
  harness.answerQuestion("q2", { action: "cancel" });
  expect(await second).toMatchObject({ behavior: "deny", interrupt: true });
});

test("a choice still open when its turn is stopped is settled, and a late answer goes nowhere", async () => {
  const { harness, events, session, query } = await begun();
  const stop = new AbortController();
  const asked = query.options.canUseTool?.(
    "AskUserQuestion",
    { questions: [picked] },
    { signal: stop.signal, toolUseID: "toolu_q" },
  );
  stop.abort();
  expect(await asked).toEqual({ behavior: "deny", message: "The turn was stopped." });
  expect(ofType(events, "question.resolved")).toEqual([
    { type: "question.resolved", sessionId: session.id, questionId: "toolu_q" },
  ]);
  harness.answerQuestion("toolu_q", { answers: { "Which?": ["A"] } });
  expect(ofType(events, "question.resolved")).toHaveLength(1);
});

test("a question and an approval still open when the process ends are each resolved as their kind", async () => {
  const { harness, events, session, query } = await begun();
  const signal = new AbortController().signal;
  void query.options.canUseTool?.(
    "AskUserQuestion",
    { questions: [picked] },
    { signal, toolUseID: "q" },
  );
  void query.options.canUseTool?.("Write", { file_path: "a" }, { signal, toolUseID: "w" });
  void query.options.onElicitation?.(FORM, { signal });
  await settle();
  events.length = 0;
  query.exit(new Error("exited with code 1"));
  await settle();
  expect(ofType(events, "question.resolved").map((event) => event.sessionId)).toEqual([
    session.id,
    session.id,
  ]);
  expect(ofType(events, "question.resolved").map((event) => event.questionId)).toContain("q");
  expect(ofType(events, "approval.resolved")).toEqual([
    { type: "approval.resolved", sessionId: session.id, approvalId: "w" },
  ]);
  // They are gone with it: an answer that comes after resolves nothing again.
  const told = events.length;
  harness.answerQuestion("q", { action: "decline" });
  harness.respondApproval("w", { decision: "decline" });
  expect(events).toHaveLength(told);
});

test("an answer of the wrong kind is an error, and an answer to what is gone is not", async () => {
  const { harness, query } = await begun();
  const signal = new AbortController().signal;
  void query.options.canUseTool?.(
    "AskUserQuestion",
    { questions: [picked] },
    { signal, toolUseID: "q" },
  );
  void query.options.canUseTool?.("Write", { file_path: "a" }, { signal, toolUseID: "w" });
  await settle();
  expect(() => harness.respondApproval("q", { decision: "accept" })).toThrow("unknown approval: q");
  expect(() => harness.answerQuestion("w", { action: "accept" })).toThrow("unknown question: w");
  // Neither was answered by the wrong call: each still waits for its own.
  harness.answerQuestion("q", { action: "decline" });
  harness.respondApproval("w", { decision: "decline" });
  expect(() => harness.answerQuestion("q", { action: "decline" })).not.toThrow();
  expect(() => harness.respondApproval("never-asked", { decision: "accept" })).not.toThrow();
});

test("an MCP server's request is the owner's to answer, and is called off with its turn", async () => {
  const { harness, events, session, query } = await begun();
  const stop = new AbortController();
  const first = query.options.onElicitation?.(FORM, { signal: new AbortController().signal });
  const second = query.options.onElicitation?.(FORM, { signal: stop.signal });
  await settle();
  expect(ofType(events, "approval.requested")).toEqual([]);
  const asked: Question[] = ofType(events, "question.requested").map((event) => event.question);
  expect(asked).toMatchObject([
    { kind: "form", server: "docs", message: "Name?", fields: [] },
    { kind: "form" },
  ]);
  harness.answerQuestion(asked[0]?.id ?? "", { action: "accept", content: { name: "me" } });
  expect(await first).toEqual({ action: "accept", content: { name: "me" } });
  stop.abort();
  expect(await second).toEqual({ action: "cancel" });
  expect(ofType(events, "question.resolved")).toEqual([
    { type: "question.resolved", sessionId: session.id, questionId: asked[0]?.id ?? "" },
    { type: "question.resolved", sessionId: session.id, questionId: asked[1]?.id ?? "" },
  ]);
});
