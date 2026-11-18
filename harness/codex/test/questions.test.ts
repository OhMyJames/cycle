import { expect, test } from "bun:test";
import { questionResult, toQuestion } from "../src/index.ts";

const INPUT = "item/tool/requestUserInput";
const ELICIT = "mcpServer/elicitation/request";

const asked = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  header: "Pick",
  question: `Which ${id}?`,
  isOther: false,
  isSecret: false,
  options: [{ label: "A", description: "the first" }],
  ...extra,
});

test("what codex asks before it acts is not a question", () => {
  expect(toQuestion("t:1", "item/commandExecution/requestApproval", { itemId: "i" })).toBeNull();
  expect(toQuestion("t:2", "item/unknown/request", {})).toBeNull();
});

test("a request for a choice offers its options, and free text when it lists none or allows it", () => {
  const question = toQuestion("t:5", INPUT, {
    itemId: "i",
    questions: [
      asked("pick"),
      asked("other", { isOther: true }),
      asked("free", { options: null }),
      asked("none", { options: [] }),
      asked("key", { isSecret: true, options: null }),
    ],
  });
  expect(question).toMatchObject({ id: "t:5", kind: "choice", itemId: "i" });
  const asks = question?.kind === "choice" ? question.asks : [];
  expect(asks.map(({ id, allowOther, secret }) => [id, allowOther, secret])).toEqual([
    ["pick", false, false],
    ["other", true, false],
    ["free", true, false],
    ["none", true, false],
    ["key", true, true],
  ]);
  expect(asks[0]).toEqual({
    id: "pick",
    header: "Pick",
    question: "Which pick?",
    options: [{ label: "A", description: "the first" }],
    allowOther: false,
    secret: false,
  });
  expect(asks[2]?.options).toEqual([]);
});

test("an MCP server's form is drawn as fields when it is MCP's own, else shown as its schema", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string", title: "Name" } },
    required: ["name"],
  };
  const form = toQuestion("t:6", ELICIT, {
    serverName: "docs",
    message: "Who?",
    mode: "form",
    requestedSchema: schema,
  });
  expect(form).toEqual({
    id: "t:6",
    kind: "form",
    itemId: "t:6",
    server: "docs",
    message: "Who?",
    fields: [
      {
        name: "name",
        title: "Name",
        description: "",
        type: "string",
        options: null,
        required: true,
      },
    ],
    schema: JSON.stringify(schema, null, 2),
  });
  const odd = { type: "object", properties: { deep: { type: "object" } } };
  expect(
    toQuestion("t:7", ELICIT, {
      serverName: "docs",
      message: "?",
      mode: "form",
      requestedSchema: odd,
    }),
  ).toMatchObject({ kind: "form", fields: null, schema: JSON.stringify(odd, null, 2) });
  // A request that names no mode is OpenAI's: its schema is shown, not drawn.
  expect(
    toQuestion("t:8", ELICIT, { serverName: "docs", message: "?", requestedSchema: schema }),
  ).toMatchObject({ kind: "form", fields: null, schema: JSON.stringify(schema, null, 2) });
});

test("an MCP server's page is a link, with no form beside it", () => {
  expect(
    toQuestion("t:9", ELICIT, {
      serverName: "docs",
      message: "Sign in",
      mode: "url",
      url: "https://x.test/auth",
      requestedSchema: { type: "object" },
    }),
  ).toEqual({
    id: "t:9",
    kind: "link",
    itemId: "t:9",
    server: "docs",
    message: "Sign in",
    url: "https://x.test/auth",
  });
  // An address in a request that is not in url mode is not a page to open.
  expect(
    toQuestion("t:9b", ELICIT, {
      serverName: "d",
      message: "?",
      mode: "form",
      url: "https://x.test",
    }),
  ).toMatchObject({ kind: "form" });
  // A url mode with no address has no page to open, and reads as a form with no schema.
  expect(
    toQuestion("t:10", ELICIT, { serverName: "docs", message: "?", mode: "url" }),
  ).toMatchObject({ kind: "form", fields: null, schema: null });
});

test("the owner's answers go back by ask id, and any action on a choice is no answer", () => {
  expect(questionResult(INPUT, { answers: { pick: ["A", "B"], free: ["x"] } })).toEqual({
    answers: { pick: { answers: ["A", "B"] }, free: { answers: ["x"] } },
  });
  for (const action of ["accept", "decline", "cancel"] as const) {
    expect(questionResult(INPUT, { action })).toEqual({ answers: {} });
  }
});

test("an MCP server's request is answered with accept, decline or cancel, and content only on accept", () => {
  const content = { name: "Ada" };
  expect(questionResult(ELICIT, { action: "accept", content })).toEqual({
    action: "accept",
    content,
    _meta: null,
  });
  expect(questionResult(ELICIT, { action: "accept" })).toEqual({
    action: "accept",
    content: null,
    _meta: null,
  });
  for (const action of ["decline", "cancel"] as const) {
    expect(questionResult(ELICIT, { action, content })).toEqual({
      action,
      content: null,
      _meta: null,
    });
  }
  // Choices are not what it asked: it reads as cancelled.
  expect(questionResult(ELICIT, { answers: { a: ["b"] } })).toEqual({
    action: "cancel",
    content: null,
    _meta: null,
  });
});
