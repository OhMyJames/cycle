import { expect, test } from "bun:test";
import { itemUpdate, MAX_OUTPUT, outputHead, outputTail } from "../src/items.ts";
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
  expect(text.startsWith("rrr")).toBe(true);
  expect(text.endsWith(`\n… ${MAX_OUTPUT} more characters not shown`)).toBe(true);
});

const mcpItem = (extra: object): ThreadItem =>
  ({
    type: "mcpToolCall",
    id: "m3",
    server: "linear",
    tool: "create_issue",
    status: "completed",
    arguments: {},
    result: null,
    error: null,
    ...extra,
  }) as unknown as ThreadItem;

test("an MCP call is titled `server · tool` and its text blocks are text, not JSON", () => {
  const update = itemUpdate(
    mcpItem({
      result: {
        content: [
          { type: "text", text: 'a "quoted"\nline' },
          { type: "text", text: "second" },
        ],
      },
    }),
    true,
    false,
  );
  expect(update).toMatchObject({
    name: "linear/create_issue",
    title: "linear · create_issue",
    content: [{ type: "content", content: { type: "text", text: 'a "quoted"\nline\nsecond' } }],
  });
});

test("an MCP call's error is told as its message text", () => {
  const update = itemUpdate(
    mcpItem({ status: "failed", error: { message: "no such team" } }),
    true,
    false,
  );
  expect(update).toMatchObject({
    status: "failed",
    content: [{ type: "content", content: { type: "text", text: "no such team" } }],
  });
});

test("an MCP call's image is kept as an image and other blocks as their JSON", () => {
  const update = itemUpdate(
    mcpItem({
      result: {
        content: [
          { type: "image", data: "AAAA", mimeType: "image/png" },
          { type: "resource_link", uri: "file:///a" },
        ],
      },
    }),
    true,
    false,
  );
  expect(update).toMatchObject({
    content: [
      {
        type: "content",
        content: { type: "text", text: '{"type":"resource_link","uri":"file:///a"}' },
      },
      { type: "content", content: { type: "image", data: "AAAA", mimeType: "image/png" } },
    ],
  });
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

const edited = (changes: object[]) =>
  itemUpdate(
    { type: "fileChange", id: "f", status: "completed", changes } as unknown as ThreadItem,
    true,
    false,
  ) as unknown as {
    content: { type: string; changes: { operation: string; path: string }[]; patch: unknown }[];
    _meta: { "cycle/toolResult": { edit: { additions: number; deletions: number } } };
  };

test("a file change is a diff block a file, with the counts summed", () => {
  const out = edited([change("/a.ts", "@@ -1 +1 @@\n-a\n+b"), change("/b.ts", "x\ny", "add")]);
  expect(out.content.map((c) => c.type)).toEqual(["diff", "diff"]);
  expect(out.content[0]?.changes).toEqual([{ operation: "modify", path: "/a.ts" }]);
  expect(out.content[1]?.changes).toEqual([{ operation: "add", path: "/b.ts" }]);
  expect(out.content[0]?.patch).toEqual({
    format: "git_patch",
    text: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
  });
  expect(out._meta["cycle/toolResult"]).toEqual({ edit: { additions: 3, deletions: 1 } });
});

test("a header Codex gave is not doubled, and an empty diff is 0/0", () => {
  const text = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
  const out = edited([change("/a.ts", text), change("/e.ts", "")]);
  expect(out.content[0]?.patch).toEqual({ format: "git_patch", text });
  expect(out.content[1]?.patch).toBeNull();
  expect(out._meta["cycle/toolResult"].edit).toEqual({ additions: 1, deletions: 1 });
});

test("a file whose diff is too long has no patch, and the small one beside it keeps its", () => {
  const out = edited([
    change("/big.json", "+".repeat(MAX_OUTPUT + 1), "add"),
    change("/foo.ts", "@@ -1 +1 @@\n-old\n+new"),
  ]);
  expect(out.content[0]?.patch).toBeNull();
  expect(out.content[1]?.patch).not.toBeNull();
  expect(out._meta["cycle/toolResult"].edit.deletions).toBe(1);
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
    title: "plan · get_issue",
    rawInput: { projectKey: "CYC", sequenceNumber: 308 },
    content: [{ type: "content", content: { type: "text", text: "ok" } }],
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

test("a completed command's native durationMs goes into toolResult.run, and is left out when missing or invalid", () => {
  const run = (extra: object) =>
    (
      itemUpdate(
        { ...(command("x") as object), ...extra } as ThreadItem,
        true,
        false,
      ) as unknown as {
        _meta: { "cycle/toolResult": { run: unknown } };
      }
    )._meta["cycle/toolResult"].run;
  expect(run({ durationMs: 12500 })).toEqual({ durationMs: 12500 });
  expect(run({ durationMs: 0 })).toEqual({ durationMs: 0 });
  expect(run({ durationMs: 3000, status: "failed", exitCode: 2 })).toEqual({
    exitCode: 2,
    durationMs: 3000,
  });
  expect(run({ durationMs: null })).toEqual({});
  expect(run({ durationMs: undefined })).toEqual({});
  expect(run({ durationMs: -5 })).toEqual({});
  expect(run({ durationMs: "9" })).toEqual({});
  expect(run({ durationMs: 1.5 })).toEqual({});
});
