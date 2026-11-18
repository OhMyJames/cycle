import { expect, test } from "bun:test";
import { approvalResult, toApproval } from "../src/index.ts";

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

test("what codex asks for content is not an approval", () => {
  expect(toApproval("t:5", "item/tool/requestUserInput", { questions: [] })).toBeNull();
  expect(toApproval("t:6", "mcpServer/elicitation/request", { message: "?" })).toBeNull();
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
