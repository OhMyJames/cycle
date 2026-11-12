import { expect, test } from "bun:test";
import { modePolicy, toItem, toTurn } from "../src/index.ts";

test.each([
  [
    {
      type: "userMessage",
      id: "u",
      content: [
        { type: "text", text: "hi " },
        { type: "image", url: "data:x" },
      ],
    },
    { id: "u", kind: "userMessage", text: "hi ", images: ["data:x"] },
  ],
  [
    { type: "reasoning", id: "r", summary: ["a", "b"], content: ["raw"] },
    { id: "r", kind: "reasoning", text: "a\n\nb" },
  ],
  [
    {
      type: "commandExecution",
      id: "c",
      command: "cat x",
      cwd: "/p",
      status: "completed",
      commandActions: [{ type: "read", command: "cat x", name: "x", path: "/p/x" }],
      aggregatedOutput: "body",
      exitCode: 0,
      durationMs: 12,
    },
    {
      id: "c",
      kind: "command",
      command: "cat x",
      cwd: "/p",
      output: "body",
      exitCode: 0,
      durationMs: 12,
      actions: [{ type: "read", path: "/p/x" }],
      status: "completed",
    },
  ],
  [
    {
      type: "fileChange",
      id: "f",
      status: "inProgress",
      changes: [{ path: "a.ts", kind: { type: "update", move_path: "b.ts" }, diff: "@@" }],
    },
    {
      id: "f",
      kind: "fileChange",
      status: "running",
      changes: [{ path: "a.ts", change: "update", movePath: "b.ts", diff: "@@" }],
    },
  ],
  [
    {
      type: "mcpToolCall",
      id: "m",
      server: "docs",
      tool: "search",
      status: "failed",
      arguments: { q: "x" },
      result: null,
      error: { message: "nope" },
      durationMs: null,
    },
    {
      id: "m",
      kind: "toolCall",
      server: "docs",
      tool: "search",
      args: '{\n  "q": "x"\n}',
      result: null,
      error: "nope",
      durationMs: null,
      status: "failed",
    },
  ],
  [
    { type: "somethingNew", id: "n" },
    { id: "n", kind: "other", type: "somethingNew" },
  ],
])("an item is translated: %#", (raw, expected) => {
  expect(toItem(raw as Parameters<typeof toItem>[0])).toEqual(
    expected as ReturnType<typeof toItem>,
  );
});

test("a turn keeps its timing in milliseconds", () => {
  const turn = toTurn({
    id: "t",
    items: [],
    status: "inProgress",
    error: null,
    startedAt: 10,
    durationMs: null,
  });
  expect(turn).toMatchObject({ status: "running", startedAt: 10_000 });
});

test("only full access goes without asking or a sandbox", () => {
  expect(modePolicy("readOnly")).toMatchObject({
    approvalPolicy: "on-request",
    sandbox: "read-only",
  });
  expect(modePolicy("auto")).toMatchObject({
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });
  expect(modePolicy("fullAccess")).toMatchObject({
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });
});
