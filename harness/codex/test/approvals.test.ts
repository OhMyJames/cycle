import { expect, test } from "bun:test";
import { approvalResult, toApproval } from "../src/index.ts";

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

test("what codex asks before it acts is an approval of the kind it is", () => {
  expect(
    toApproval("t:1", "item/commandExecution/requestApproval", {
      itemId: "i",
      command: "ls",
      cwd: "/p",
      reason: "list",
    }),
  ).toEqual({ id: "t:1", kind: "command", itemId: "i", command: "ls", cwd: "/p", reason: "list" });
  expect(toApproval("t:2", "item/fileChange/requestApproval", { itemId: "i" })).toEqual({
    id: "t:2",
    kind: "fileChange",
    itemId: "i",
    reason: null,
  });
  expect(
    toApproval("t:3", "item/permissions/requestApproval", {
      itemId: "i",
      permissions: { network: true },
    }),
  ).toMatchObject({ kind: "permissions", summary: '{\n  "network": true\n}' });
  expect(toApproval("t:4", "item/unknown/request", {})).toBeNull();
});

test("a request for a choice offers its options, and free text when it lists none or allows it", () => {
  const approval = toApproval("t:5", INPUT, {
    itemId: "i",
    questions: [
      asked("pick"),
      asked("other", { isOther: true }),
      asked("free", { options: null }),
      asked("none", { options: [] }),
      asked("key", { isSecret: true, options: null }),
    ],
  });
  expect(approval).toMatchObject({ id: "t:5", kind: "question", itemId: "i" });
  const questions = approval?.kind === "question" ? approval.questions : [];
  expect(questions.map(({ id, allowOther, secret }) => [id, allowOther, secret])).toEqual([
    ["pick", false, false],
    ["other", true, false],
    ["free", true, false],
    ["none", true, false],
    ["key", true, true],
  ]);
  expect(questions[0]).toEqual({
    id: "pick",
    header: "Pick",
    question: "Which pick?",
    options: [{ label: "A", description: "the first" }],
    allowOther: false,
    secret: false,
  });
  expect(questions[2]?.options).toEqual([]);
});

test("an MCP server's form is drawn as fields when it is MCP's own, else shown as its schema", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string", title: "Name" } },
    required: ["name"],
  };
  const form = toApproval("t:6", ELICIT, {
    serverName: "docs",
    message: "Who?",
    mode: "form",
    requestedSchema: schema,
  });
  expect(form).toEqual({
    id: "t:6",
    kind: "elicitation",
    itemId: "t:6",
    server: "docs",
    message: "Who?",
    url: null,
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
    toApproval("t:7", ELICIT, {
      serverName: "docs",
      message: "?",
      mode: "form",
      requestedSchema: odd,
    }),
  ).toMatchObject({ fields: null, schema: JSON.stringify(odd, null, 2) });
  // A request that names no mode is OpenAI's: its schema is shown, not drawn.
  expect(
    toApproval("t:8", ELICIT, { serverName: "docs", message: "?", requestedSchema: schema }),
  ).toMatchObject({ fields: null, schema: JSON.stringify(schema, null, 2) });
});

test("an MCP server's page is a url, with no form beside it", () => {
  expect(
    toApproval("t:9", ELICIT, {
      serverName: "docs",
      message: "Sign in",
      mode: "url",
      url: "https://x.test/auth",
      requestedSchema: { type: "object" },
    }),
  ).toMatchObject({ kind: "elicitation", url: "https://x.test/auth", fields: null, schema: null });
  // An address in a request that is not in url mode is not a page to open.
  expect(
    toApproval("t:9b", ELICIT, {
      serverName: "d",
      message: "?",
      mode: "form",
      url: "https://x.test",
    }),
  ).toMatchObject({ url: null });
  // A url mode with no address has no page to open, and reads as a form with no schema.
  expect(
    toApproval("t:10", ELICIT, { serverName: "docs", message: "?", mode: "url" }),
  ).toMatchObject({ url: null, fields: null, schema: null });
});

test("the owner's answers go back by question id, and any decision on a choice is no answer", () => {
  expect(approvalResult(INPUT, {}, { answers: { pick: ["A", "B"], free: ["x"] } })).toEqual({
    answers: { pick: { answers: ["A", "B"] }, free: { answers: ["x"] } },
  });
  for (const decision of ["accept", "acceptForSession", "decline", "cancel"] as const) {
    expect(approvalResult(INPUT, {}, { decision })).toEqual({ answers: {} });
  }
});

test("an MCP server's request is answered with accept, decline or cancel, and content only on accept", () => {
  const content = { name: "Ada" };
  expect(approvalResult(ELICIT, {}, { decision: "accept", content })).toEqual({
    action: "accept",
    content,
    _meta: null,
  });
  expect(approvalResult(ELICIT, {}, { decision: "acceptForSession", content })).toEqual({
    action: "accept",
    content,
    _meta: null,
  });
  expect(approvalResult(ELICIT, {}, { decision: "accept" })).toEqual({
    action: "accept",
    content: null,
    _meta: null,
  });
  for (const decision of ["decline", "cancel"] as const) {
    expect(approvalResult(ELICIT, {}, { decision, content })).toEqual({
      action: decision,
      content: null,
      _meta: null,
    });
  }
  // Choices are not what it asked: it reads as cancelled.
  expect(approvalResult(ELICIT, {}, { answers: { a: ["b"] } })).toEqual({
    action: "cancel",
    content: null,
    _meta: null,
  });
});

test("the other requests are answered by decision, and a permission is granted as asked", () => {
  const permissions = { network: true };
  expect(
    approvalResult("item/commandExecution/requestApproval", {}, { decision: "accept" }),
  ).toEqual({ decision: "accept" });
  expect(
    approvalResult("item/permissions/requestApproval", { permissions }, { decision: "accept" }),
  ).toEqual({ permissions, scope: "turn" });
  expect(
    approvalResult(
      "item/permissions/requestApproval",
      { permissions },
      { decision: "acceptForSession" },
    ),
  ).toEqual({ permissions, scope: "session" });
  expect(
    approvalResult("item/permissions/requestApproval", { permissions }, { decision: "decline" }),
  ).toEqual({ permissions: {}, scope: "turn" });
});
