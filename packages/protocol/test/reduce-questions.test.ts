import { expect, test } from "bun:test";
import {
  type Question,
  type Session,
  type SessionEvent,
  initialSessionState,
  reduceSession,
} from "../src/index.ts";

const info = { id: "s", harness: "fake" } as Session;
const fold = (events: SessionEvent[]) => events.reduce(reduceSession, initialSessionState(info));

const choice: Question = {
  id: "q",
  itemId: "i",
  kind: "choice",
  asks: [
    {
      id: "a",
      header: "Pick",
      question: "Which?",
      options: [],
      allowOther: true,
      secret: false,
    },
  ],
};
const link: Question = {
  id: "l",
  itemId: "l",
  kind: "link",
  server: "docs",
  message: "Sign in",
  url: "https://x.test",
};
const ask = (question: Question, turnId: string | null = "t1"): SessionEvent => ({
  type: "question.requested",
  sessionId: "s",
  turnId,
  question,
});
const resolved = (questionId: string): SessionEvent => ({
  type: "question.resolved",
  sessionId: "s",
  questionId,
});
const approve: SessionEvent = {
  type: "approval.requested",
  sessionId: "s",
  turnId: "t1",
  approval: { id: "a1", kind: "fileChange", itemId: "i", reason: null },
};
const started: SessionEvent = { type: "turn.started", sessionId: "s", turnId: "t1", startedAt: 0 };
const done = (turnId: string): SessionEvent => ({
  type: "turn.completed",
  sessionId: "s",
  turnId,
  status: "interrupted",
  error: null,
  durationMs: 1,
});

test("a session starts with no question", () => {
  expect(initialSessionState(info).questions).toEqual([]);
});

test("a question is kept in the order it was asked, and resolved by its id", () => {
  const open = fold([ask(choice), ask(link)]);
  expect(open.questions).toEqual([choice, link]);
  expect(fold([ask(choice), ask(link), resolved("q")]).questions).toEqual([link]);
  expect(fold([ask(choice), resolved("nobody")]).questions).toEqual([choice]);
});

test("a question asked again by its id replaces the one before, at the end", () => {
  const again: Question = { ...choice, itemId: "other" };
  expect(fold([ask(choice), ask(link), ask(again)]).questions).toEqual([link, again]);
});

test("a question and an approval are two lists, and neither touches the other", () => {
  const both = fold([ask(choice), approve]);
  expect(both.questions).toEqual([choice]);
  expect(both.approvals).toHaveLength(1);
  const answered = fold([ask(choice), approve, resolved("q")]);
  expect(answered.questions).toEqual([]);
  expect(answered.approvals).toHaveLength(1);
  const approved = fold([
    ask(choice),
    approve,
    { type: "approval.resolved", sessionId: "s", approvalId: "a1" },
  ]);
  expect(approved.questions).toEqual([choice]);
  expect(approved.approvals).toEqual([]);
});

test("a question that no event asked is not in the state, and one asked outside a turn is kept", () => {
  expect(fold([started]).questions).toEqual([]);
  expect(fold([ask(choice, null)]).questions).toEqual([choice]);
});

test("ending a turn empties the questions, whichever turn's id it names", () => {
  expect(fold([started, ask(choice), done("t1")]).questions).toEqual([]);
  expect(fold([started, ask(choice), approve, done("t1")]).approvals).toEqual([]);
  // A crash or a stop ends the turn the state knew: no question outlives it.
  expect(fold([ask(choice), done("t9")]).questions).toEqual([]);
});
