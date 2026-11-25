import { expect, test } from "bun:test";
import { diffOf, itemUpdate, MAX_OUTPUT, outputHead, outputTail } from "../src/items.ts";
import type { ThreadItem } from "../src/wire.generated.ts";

const textOf = (item: ThreadItem): string | undefined => {
  const update = itemUpdate(item, true, false) as { content?: { content: { text: string } }[] };
  return update.content?.[0]?.content.text;
};

const command = (aggregatedOutput: string): ThreadItem =>
  ({
    type: "commandExecution",
    id: "c1",
    command: "make",
    cwd: "/",
    processId: null,
    source: "agent",
    status: "completed",
    commandActions: [],
    aggregatedOutput,
    exitCode: 0,
    durationMs: 1,
  }) as unknown as ThreadItem;

test("a command's output up to the limit is told whole", () => {
  const output = "x".repeat(MAX_OUTPUT);
  expect(textOf(command(output))).toBe(output);
});

test("a longer one is told by its end, saying how much was left out", () => {
  const output = `${"a".repeat(MAX_OUTPUT)}${"b".repeat(10)}`;
  const text = textOf(command(output)) ?? "";
  expect(text).toBe(
    `… 10 earlier characters not shown\n${"a".repeat(MAX_OUTPUT - 10)}${"b".repeat(10)}`,
  );
});

test("the end is not cut inside a character told in two halves", () => {
  // Three more code units than the limit: the cut falls between the halves of the second emoji.
  const output = `${"😀".repeat(MAX_OUTPUT / 2 + 1)}z`;
  const text = outputTail(output);
  const kept = text.slice(text.indexOf("\n") + 1);
  // Two emoji left out, counted as a person counts them.
  expect(text.startsWith("… 2 earlier characters not shown\n")).toBe(true);
  expect(kept.length).toBe(MAX_OUTPUT - 1);
  expect(kept.codePointAt(0)).toBe(0x1f600);
});

test("an MCP call's long result is told by its start, where it says what it is", () => {
  const item = {
    type: "mcpToolCall",
    id: "m1",
    server: "s",
    tool: "t",
    status: "completed",
    arguments: {},
    result: { content: [{ type: "text", text: "r".repeat(MAX_OUTPUT * 2) }] },
    error: null,
  } as unknown as ThreadItem;
  const text = textOf(item) ?? "";
  expect(text.startsWith('[{"type":"text","text":"rrr')).toBe(true);
  expect(text.endsWith(`\n… ${MAX_OUTPUT + 27} more characters not shown`)).toBe(true);
});

test("a command's long title is cut at its end", () => {
  const update = itemUpdate(
    { ...(command("") as object), command: "x".repeat(MAX_OUTPUT + 5) } as ThreadItem,
    false,
    false,
  ) as { title?: string };
  expect(update.title).toBe(outputHead("x".repeat(MAX_OUTPUT + 5)));
  expect(update.title?.endsWith("\n… 5 more characters not shown")).toBe(true);
});

const change = (path: string, diff: string, type: "add" | "delete" | "update" = "update") => ({
  path,
  kind: type === "update" ? { type, move_path: null } : { type },
  diff,
});

test("a diff up to the limit is told whole", () => {
  const changes = [change("/a.ts", "+a", "add"), change("/b.ts", "-b", "delete")];
  expect(diffOf(changes)).toBe("+a\n-b");
});

test("a file whose diff is too long is named, and the small edits beside it are still shown", () => {
  const changes = [
    change("/big.json", "+".repeat(MAX_OUTPUT + 1), "add"),
    change("/foo.ts", "-old\n+new"),
  ];
  expect(diffOf(changes)).toBe("added /big.json (its diff is too long to show)\n-old\n+new");
});

test("past the limit, the rest of the files are counted", () => {
  const changes = [
    change("/a.ts", "+".repeat(MAX_OUTPUT - 10)),
    change("/b.ts", "+".repeat(50)),
    change("/c.ts", "+c"),
    change("/d.ts", "+d"),
  ];
  // b's diff does not fit and neither does its name: b, c and d are counted. c would fit, but is not told after b.
  expect(diffOf(changes)).toBe(`${"+".repeat(MAX_OUTPUT - 10)}\n… and 3 more files`);
});

test("command, MCP, fileChange and webSearch items carry structured rawInput, locations and exitCode", () => {
  const ok = itemUpdate(command("done"), true, false);
  expect(ok).toMatchObject({
    sessionUpdate: "tool_call_update",
    name: "exec_command",
    title: "make",
    kind: "execute",
    status: "completed",
    rawInput: { command: "make", cwd: "/" },
    _meta: { "cycle/toolResult": { run: {} } },
  });

  const failed = itemUpdate(
    { ...(command("boom") as object), status: "failed", exitCode: 2 } as ThreadItem,
    true,
    false,
  );
  expect(failed).toMatchObject({
    status: "failed",
    rawInput: { command: "make", cwd: "/" },
    _meta: { "cycle/toolResult": { run: { exitCode: 2 } } },
  });

  const mcp = itemUpdate(
    {
      type: "mcpToolCall",
      id: "m2",
      server: "plan",
      tool: "get_issue",
      status: "completed",
      arguments: { projectKey: "CYC", sequenceNumber: 308 },
      result: { content: [{ type: "text", text: "ok" }] },
      error: null,
    } as unknown as ThreadItem,
    true,
    false,
  );
  expect(mcp).toMatchObject({
    name: "plan/get_issue",
    rawInput: { projectKey: "CYC", sequenceNumber: 308 },
  });

  const edited = itemUpdate(
    {
      type: "fileChange",
      id: "f1",
      status: "completed",
      changes: [change("/src/a.ts", "-a\n+b"), change("/src/b.ts", "+c", "add")],
    } as unknown as ThreadItem,
    true,
    false,
  );
  expect(edited).toMatchObject({
    kind: "edit",
    locations: [{ path: "/src/a.ts" }, { path: "/src/b.ts" }],
  });

  const searched = itemUpdate(
    { type: "webSearch", id: "w1", query: "cycle protocol" } as unknown as ThreadItem,
    true,
    false,
  );
  expect(searched).toMatchObject({
    kind: "search",
    title: "cycle protocol",
    rawInput: { query: "cycle protocol" },
  });
});
