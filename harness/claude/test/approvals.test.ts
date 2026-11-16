import { expect, test } from "bun:test";
import {
  AFTER_PLAN,
  PlanDraft,
  StreamReader,
  toApproval,
  toElicitation,
  toElicitationResult,
  toOwner,
  toPermission,
  toTurns,
} from "../src/index.ts";
import { assistant } from "./fake-sdk.ts";

const hint = { cwd: "/project" };
const rule = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "make:*" }] };
const suggestions = [
  { ...rule, behavior: "allow", destination: "localSettings" },
  { type: "addDirectories", directories: ["/other"], destination: "session" },
  { type: "setMode", mode: "bypassPermissions", destination: "session" },
  { type: "removeRules", rules: [], behavior: "deny", destination: "session" },
];

test("what Claude Code asks is asked of the owner in the shape of what it is", () => {
  expect(
    toApproval("i", "Bash", { command: "rm x", description: "remove" }, { ...hint, suggestions }),
  ).toEqual({
    id: "i",
    kind: "command",
    itemId: "i",
    command: "rm x",
    cwd: "/project",
    reason: "remove",
    // Never a rule that turns on a mode that does not ask, nor one that is no permission.
    rules: [
      { id: "0", label: "Bash(make:*)" },
      { id: "1", label: "Work in /other" },
    ],
    editable: true,
    notes: true,
  });
  expect(toApproval("i", "Write", {}, hint)).toMatchObject({
    kind: "fileChange",
    rules: [],
    notes: true,
  });
  expect(
    toApproval("i", "mcp__docs__search", { q: "x" }, { ...hint, title: "Search the docs" }),
  ).toEqual({
    id: "i",
    kind: "tool",
    itemId: "i",
    server: "docs",
    tool: "search",
    input: '{\n  "q": "x"\n}',
    title: "Search the docs",
    reason: null,
    rules: [],
  });
  const asked = { question: "Which?", header: "Pick", options: [{ label: "A", description: "a" }] };
  expect(toApproval("i", "AskUserQuestion", { questions: [asked] }, hint)).toMatchObject({
    kind: "question",
    questions: [{ id: "Which?", header: "Pick", options: [{ label: "A", description: "a" }] }],
  });
  expect(toApproval("i", "ExitPlanMode", {}, { ...hint, plan: "# Plan" })).toEqual({
    id: "i",
    kind: "plan",
    itemId: "i",
    plan: "# Plan",
    modes: ["default", "acceptEdits", "auto", "dontAsk"],
  });
});

test("the owner's answer keeps to the session, and never writes their settings", () => {
  const input = { command: "make" };
  expect(toPermission("Bash", input, suggestions, { decision: "accept" })).toEqual({
    behavior: "allow",
    updatedInput: input,
  });
  // A rule the owner picks is kept for the session, wherever Claude Code suggested keeping it.
  expect(
    toPermission("Bash", input, suggestions, { decision: "accept", rules: ["0", "2", "3"] }),
  ).toEqual({
    behavior: "allow",
    updatedInput: input,
    updatedPermissions: [{ ...rule, behavior: "allow", destination: "session" }],
  });
  expect(toPermission("Bash", input, suggestions, { decision: "acceptForSession" })).toEqual({
    behavior: "allow",
    updatedInput: input,
    updatedPermissions: [
      { ...rule, behavior: "allow", destination: "session" },
      { type: "addDirectories", directories: ["/other"], destination: "session" },
    ],
  });
  // With no rule proposed, the tool itself is allowed for the session.
  expect(toPermission("Edit", {}, [], { decision: "acceptForSession" })).toMatchObject({
    updatedPermissions: [
      { type: "addRules", rules: [{ toolName: "Edit" }], destination: "session" },
    ],
  });
  expect(toPermission("Bash", input, [], { decision: "cancel" })).toMatchObject({
    behavior: "deny",
    interrupt: true,
  });
  expect(
    toPermission("AskUserQuestion", { questions: [] }, [], { answers: { "Which?": ["A", "B"] } }),
  ).toEqual({
    behavior: "allow",
    updatedInput: { questions: [], answers: { "Which?": "A, B" } },
  });
});

test("the owner may change what runs, and say why they refused", () => {
  const input = { command: "make", description: "build" };
  expect(toPermission("Bash", input, [], { decision: "accept", edited: "make test" })).toEqual({
    behavior: "allow",
    updatedInput: { command: "make test", description: "build" },
  });
  const tool = { q: "x" };
  expect(
    toPermission("mcp__docs__search", tool, [], { decision: "accept", edited: '{"q":"y"}' }),
  ).toMatchObject({ updatedInput: { q: "y" } });
  // What is not an object of JSON leaves the input as it was.
  expect(
    toPermission("mcp__docs__search", tool, [], { decision: "accept", edited: "[1]" }),
  ).toMatchObject({ updatedInput: tool });
  expect(toPermission("Edit", { a: 1 }, [], { decision: "accept", edited: "{}" })).toMatchObject({
    updatedInput: { a: 1 },
  });
  expect(toPermission("Bash", input, [], { decision: "decline", message: " use npm " })).toEqual({
    behavior: "deny",
    message: "The owner declined this: use npm",
  });
  expect(toPermission("Bash", input, [], { decision: "decline" })).toMatchObject({
    behavior: "deny",
    message: expect.stringContaining("ask what to do instead"),
  });
});

const accept = (mode?: string) =>
  toPermission("ExitPlanMode", {}, [], { decision: "accept", ...(mode ? { mode } : {}) });

test("an approved plan goes on in the mode the owner picks, never one that does not ask", () => {
  expect(accept("acceptEdits")).toEqual({
    behavior: "allow",
    updatedInput: {},
    updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
  });
  expect(AFTER_PLAN).not.toContain("bypassPermissions");
  expect(accept("bypassPermissions")).toMatchObject({
    updatedPermissions: [{ mode: "default" }],
  });
  expect(accept()).toMatchObject({ updatedPermissions: [{ mode: "default" }] });
  expect(
    toPermission("ExitPlanMode", {}, [], { decision: "decline", message: "add tests" }),
  ).toEqual({ behavior: "deny", message: "The owner wants the plan changed: add tests" });
  expect(toPermission("ExitPlanMode", {}, [], { decision: "cancel" })).toMatchObject({
    interrupt: true,
  });
});

test("the plan is what the model wrote to its plan file, in the stream and in what was stored", () => {
  const reader = new StreamReader("s", "/project");
  const write = {
    type: "tool_use",
    id: "w",
    name: "Write",
    input: { file_path: "/home/me/.claude/plans/a.md", content: "# Plan\n\n1. one" },
  };
  const edit = {
    type: "tool_use",
    id: "e",
    name: "Edit",
    input: { file_path: "/home/me/.claude/plans/a.md", old_string: "one", new_string: "two" },
  };
  const exit = { type: "tool_use", id: "x", name: "ExitPlanMode", input: {} };
  const events = reader.read("t", { type: "assistant", message: { content: [write, edit, exit] } });
  expect(events.at(-1)).toMatchObject({
    type: "item.started",
    item: { id: "x", kind: "plan", text: "# Plan\n\n1. two" },
  });
  expect(reader.planFor("x")).toBe("# Plan\n\n1. two");
  expect(reader.planFor("w")).toBe("");
  const [turn] = toTurns([assistant("a1", [write, edit, exit])], "/project");
  expect(turn?.items.at(-1)).toEqual({ id: "x", kind: "plan", text: "# Plan\n\n1. two" });
  // A plan the request carries is taken as it is.
  const carried = { ...exit, id: "y", input: { plan: "mine" } };
  expect(reader.read("t", { type: "assistant", message: { content: [carried] } })).toMatchObject([
    { item: { kind: "plan", text: "mine" } },
  ]);
});

test("a call refused without asking is declined, with why where the item cannot say it", () => {
  const reader = new StreamReader("s", "/project");
  const calls = [
    { type: "tool_use", id: "b", name: "Bash", input: { command: "rm x" } },
    { type: "tool_use", id: "w", name: "Write", input: { file_path: "/project/a", content: "" } },
  ];
  reader.read("t", { type: "assistant", message: { content: calls } });
  for (const id of ["b", "w"]) {
    reader.read("t", {
      type: "system",
      subtype: "permission_denied",
      tool_use_id: id,
      message: "denied in don't ask mode" as never,
    });
  }
  const results = ["b", "w"].map((id) => ({
    type: "tool_result",
    tool_use_id: id,
    content: "denied in don't ask mode",
    is_error: true,
  }));
  const events = reader.read("t", { type: "user", message: { content: results } });
  expect(events).toMatchObject([
    { type: "item.completed", item: { kind: "command", status: "declined", exitCode: null } },
    { type: "item.completed", item: { kind: "fileChange", status: "declined" } },
    { type: "notice", level: "warning", message: "denied in don't ask mode" },
  ]);
});

test("an MCP server's form is drawn as fields when it can be, and answered as the owner did", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string", title: "Name" },
      size: { type: "string", enum: ["s", "m"], description: "How big" },
      ok: { type: "boolean" },
    },
    required: ["name"],
  };
  const form = toElicitation("e", { serverName: "docs", message: "Who?", requestedSchema: schema });
  expect(form).toMatchObject({
    kind: "elicitation",
    server: "docs",
    message: "Who?",
    url: null,
    fields: [
      { name: "name", title: "Name", type: "string", options: null, required: true },
      { name: "size", title: "size", description: "How big", options: ["s", "m"] },
      { name: "ok", type: "boolean", required: false },
    ],
  });
  const nested = { properties: { where: { type: "object" } } };
  expect(
    toElicitation("e", { serverName: "d", message: "", requestedSchema: nested }),
  ).toMatchObject({ fields: null, schema: JSON.stringify(nested, null, 2) });
  expect(
    toElicitation("e", { serverName: "d", message: "Sign in", mode: "url", url: "https://x" }),
  ).toMatchObject({ url: "https://x", fields: null, schema: null });
  expect(toElicitationResult({ decision: "accept", content: { name: "me" } })).toEqual({
    action: "accept",
    content: { name: "me" },
  });
  expect(toElicitationResult({ decision: "decline" })).toEqual({ action: "decline" });
  expect(toElicitationResult({ decision: "cancel" })).toEqual({ action: "cancel" });
});

test("the plan file is followed as edited, `$` and every match alike", () => {
  const draft = new PlanDraft();
  const file_path = "/home/me/.claude/plans/a.md";
  draft.see("Write", { file_path, content: "cost: X, then X" });
  draft.see("Edit", { file_path, old_string: "X", new_string: "$& and $1" });
  expect(draft.fill("ExitPlanMode", {})).toEqual({ plan: "cost: $& and $1, then X" });
  draft.see("Edit", { file_path, old_string: "X", new_string: "Y", replace_all: true });
  expect(draft.fill("ExitPlanMode", {})).toEqual({ plan: "cost: $& and $1, then Y" });
  // A file elsewhere is no plan.
  draft.see("Write", { file_path: "/project/plans.md", content: "no" });
  expect(draft.fill("ExitPlanMode", {})).toEqual({ plan: "cost: $& and $1, then Y" });
});

test("a refusal is shown to the owner in words of the app's, not Claude Code's advice to the model", () => {
  const model = `Permission to use Bash has been denied because Claude Code is running in don't ask mode. IMPORTANT: You *may* attempt another way. STOP and explain to the user what you need.`;
  const reader = new StreamReader("s", "/project");
  reader.read("t", {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "b", name: "Bash", input: { command: "rm x" } }] },
  });
  // As live, it was told of no refusal beforehand: the result alone says so, as stored ones do.
  const [done] = reader.read("t", {
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "b", content: model, is_error: true }],
    },
  });
  expect(done).toMatchObject({ item: { kind: "command", status: "declined", exitCode: null } });
  const output =
    done?.type === "item.completed" && done.item.kind === "command" ? done.item.output : "";
  expect(output).toBe("Not run: Don't ask mode refuses what is not already allowed.");
  expect(toOwner("Permission to use Edit has been denied by a rule. IMPORTANT: STOP.")).toBe(
    "Permission to use Edit has been denied by a rule.",
  );
  expect(toOwner("Exit code 1")).toBe("Exit code 1");
});
