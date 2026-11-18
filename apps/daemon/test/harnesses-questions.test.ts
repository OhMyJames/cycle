import { expect, test } from "bun:test";
import type { Question } from "@cycle/protocol";
import { Harnesses } from "../src/index.ts";
import { FakeHarness } from "./fake-harness.ts";

const question: Question = { id: "q1", itemId: "i1", kind: "choice", asks: [] };

function setup() {
  const main = new FakeHarness("main");
  const other = new FakeHarness("other");
  const all = new Harnesses(main, [other]);
  return { main, other, all };
}

test("an answer to a question goes to the agent that asked, and the main one when none did", () => {
  const { main, other, all } = setup();
  other.emit({ type: "question.requested", sessionId: "o1", turnId: "t1", question });
  all.answerQuestion("q1", { answers: { a: ["x"] } });
  expect(other.calls).toEqual(["answer q1"]);
  expect(other.answers).toEqual([{ questionId: "q1", answer: { answers: { a: ["x"] } } }]);
  expect(main.calls).toEqual([]);
  all.answerQuestion("unknown", { action: "decline" });
  expect(main.calls).toEqual(["answer unknown"]);
});

test("a question that was resolved is no longer the agent's to be asked", () => {
  const { main, other, all } = setup();
  other.emit({ type: "question.requested", sessionId: "o1", turnId: null, question });
  other.emit({ type: "question.resolved", sessionId: "o1", questionId: "q1" });
  all.answerQuestion("q1", { action: "cancel" });
  expect(other.calls).toEqual([]);
  expect(main.calls).toEqual(["answer q1"]);
});

test("a question's id is not an approval's: each is routed by its own list", () => {
  const { main, other, all } = setup();
  other.emit({ type: "question.requested", sessionId: "o1", turnId: "t1", question });
  all.respondApproval("q1", { decision: "accept" });
  expect(other.calls).toEqual([]);
  expect(main.calls).toEqual(["approve q1"]);
});
