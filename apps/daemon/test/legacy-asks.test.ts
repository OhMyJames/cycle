import { expect, test } from "bun:test";
import type { Ask, Question } from "@cycle/protocol";
import { legacyAnswer, legacyApproval, legacyEvents } from "../src/legacy-asks.ts";

const ask: Ask = {
  id: "a",
  header: "Pick",
  question: "Which?",
  options: [{ label: "A", description: "the first" }],
  allowOther: true,
  secret: true,
};
const field = {
  name: "name",
  title: "Name",
  description: "",
  type: "string",
  options: null,
  required: true,
} as const;

test("a choice is the approval of kind question the page draws, with its asks as they are", () => {
  const question: Question = { id: "q", itemId: "i", kind: "choice", asks: [ask] };
  expect(legacyApproval(question)).toEqual({
    id: "q",
    kind: "question",
    itemId: "i",
    questions: [ask],
  });
});

test("a form is an elicitation with no address, and a link one with no form", () => {
  expect(
    legacyApproval({
      id: "f",
      itemId: "f",
      kind: "form",
      server: "docs",
      message: "Who?",
      fields: [field],
      schema: '{"type":"object"}',
    }),
  ).toEqual({
    id: "f",
    kind: "elicitation",
    itemId: "f",
    server: "docs",
    message: "Who?",
    url: null,
    fields: [field],
    schema: '{"type":"object"}',
  });
  expect(
    legacyApproval({
      id: "l",
      itemId: "l",
      kind: "link",
      server: "docs",
      message: "Sign in",
      url: "https://x.test",
    }),
  ).toEqual({
    id: "l",
    kind: "elicitation",
    itemId: "l",
    server: "docs",
    message: "Sign in",
    url: "https://x.test",
    fields: null,
    schema: null,
  });
});

test("the page's answers become answers of the question's own kind", () => {
  expect(legacyAnswer({ answers: { a: ["x"] } })).toEqual({ answers: { a: ["x"] } });
  expect(legacyAnswer({ decision: "accept", content: { name: "Ada" } })).toEqual({
    action: "accept",
    content: { name: "Ada" },
  });
  // There is no keeping a form for the session.
  expect(legacyAnswer({ decision: "acceptForSession" })).toEqual({ action: "accept" });
  expect(legacyAnswer({ decision: "decline" })).toEqual({ action: "decline" });
  expect(legacyAnswer({ decision: "cancel", content: { name: "Ada" } })).toEqual({
    action: "cancel",
    content: { name: "Ada" },
  });
  // What an approval's answer carries besides is not an answer's.
  expect(
    legacyAnswer({ decision: "accept", rules: ["0"], edited: "x", message: "m", mode: "plan" }),
  ).toEqual({ action: "accept" });
});

test("a question's two events are told again as the approval's two", () => {
  const question: Question = { id: "q", itemId: "i", kind: "choice", asks: [ask] };
  expect(
    legacyEvents({ type: "question.requested", sessionId: "s", turnId: null, question }),
  ).toEqual([
    {
      type: "approval.requested",
      sessionId: "s",
      turnId: null,
      approval: legacyApproval(question),
    },
  ]);
  expect(legacyEvents({ type: "question.resolved", sessionId: "s", questionId: "q" })).toEqual([
    { type: "approval.resolved", sessionId: "s", approvalId: "q" },
  ]);
  expect(legacyEvents({ type: "approval.resolved", sessionId: "s", approvalId: "q" })).toEqual([]);
  expect(legacyEvents({ type: "notice", sessionId: "s", level: "info", message: "m" })).toEqual([]);
});
