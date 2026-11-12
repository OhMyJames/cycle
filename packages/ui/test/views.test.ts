import { expect, test } from "bun:test";
import type { Item, SessionInfo } from "@cycle/protocol";
import { triggerAt } from "../src/components/composer.tsx";
import { plainCommand } from "../src/components/items.tsx";
import { groupSessions } from "../src/components/sidebar.tsx";
import { activityLabel, segmentsOf, summarize } from "../src/components/thread.tsx";

const command = (
  id: string,
  action?: "read" | "search" | "list",
  status: "running" | "completed" = "completed",
): Item => ({
  id,
  kind: "command",
  command: "/bin/bash -lc 'npm test'",
  cwd: "/p",
  output: "",
  exitCode: 0,
  durationMs: null,
  actions:
    action === "read"
      ? [{ type: "read", path: "/p/a.ts" }]
      : action === "search"
        ? [{ type: "search", query: "x", path: null }]
        : action === "list"
          ? [{ type: "list", path: null }]
          : [],
  status,
});
const message = (id: string): Item => ({ id, kind: "agentMessage", text: "hi" });
const edit: Item = {
  id: "e",
  kind: "fileChange",
  status: "completed",
  changes: [
    { path: "a.ts", change: "update", diff: "" },
    { path: "b.ts", change: "add", diff: "" },
  ],
};

test("a turn is split into what was said and the stretches of work between", () => {
  const items = [
    { id: "u", kind: "userMessage", text: "go", images: [] } satisfies Item,
    command("1", "read"),
    command("2"),
    message("m1"),
    edit,
    message("m2"),
  ];
  expect(
    segmentsOf(items).map((segment) =>
      segment.type === "work" ? segment.items.length : segment.item.id,
    ),
  ).toEqual(["u", 2, "m1", 1, "m2"]);
});

test("a stretch of work is summed up in one line", () => {
  expect(summarize([command("1", "read"), command("2", "read"), command("3"), edit])).toBe(
    "Read 2 files, ran 1 command, edited 2 files",
  );
  expect(summarize([command("1", "list"), command("2", "search")])).toBe(
    "Listed files, searched 1 time",
  );
  expect(summarize([{ id: "r", kind: "reasoning", text: "hm" }])).toBe("Thought it through");
});

const turn = (items: Item[]) => ({
  id: "t",
  status: "running" as const,
  error: null,
  startedAt: null,
  durationMs: null,
  items,
  diff: null,
});

test("the status line says what the last item is doing", () => {
  expect(activityLabel(turn([]))).toBe("Starting");
  expect(activityLabel(turn([message("m")]))).toBe("Writing");
  expect(activityLabel(turn([command("c", undefined, "running")]))).toBe("Running npm test");
  expect(activityLabel(turn([command("c")]))).toBe("Thinking");
});

test.each([
  ["/bin/bash -lc 'echo hi'", "echo hi"],
  ["bash -lc 'it'\\''s'", "it's"],
  ['/bin/zsh -lc "echo \\"q\\" && ls"', 'echo "q" && ls'],
  ["git status", "git status"],
])("the command %p is shown as %p", (wrapped, plain) => {
  expect(plainCommand(wrapped)).toBe(plain);
});

test.each([
  ["look at @src/ap", 15, { kind: "@", query: "src/ap", start: 8 }],
  ["@", 1, { kind: "@", query: "", start: 0 }],
  ["mail me@example", 15, null],
  ["/comp", 5, { kind: "/", query: "comp", start: 0 }],
  ["run /comp", 9, null],
  ["a @b c", 6, null],
])("typing %p with the caret at %p", (text, caret, expected) => {
  expect(triggerAt(text, caret)).toEqual(expected as ReturnType<typeof triggerAt>);
});

test("the list puts what needs the owner first, then what runs, then by day", () => {
  const now = new Date(2026, 5, 10, 15).getTime();
  const info = (id: string, patch: Partial<SessionInfo>): SessionInfo => ({
    id,
    harness: "codex",
    title: id,
    preview: "",
    cwd: "/p",
    model: "m",
    effort: null,
    mode: "auto",
    status: "idle",
    branch: null,
    worktree: null,
    createdAt: 0,
    updatedAt: now - 1000,
    archived: false,
    pinned: false,
    unread: false,
    forkedFrom: null,
    ...patch,
  });
  const groups = groupSessions(
    [
      info("old", { updatedAt: now - 40 * 86_400_000 }),
      info("today-early", { updatedAt: now - 7_200_000 }),
      info("today-late", {}),
      info("pinned", { pinned: true, updatedAt: now - 9 * 86_400_000 }),
      info("running", { status: "running" }),
      info("waiting", { status: "waiting", updatedAt: now - 5 * 86_400_000 }),
    ],
    now,
  );
  expect(groups.map((group) => [group.label, group.sessions.map((session) => session.id)])).toEqual(
    [
      ["Needs you", ["waiting"]],
      ["Running", ["running"]],
      ["Pinned", ["pinned"]],
      ["Today", ["today-late", "today-early"]],
      ["Earlier", ["old"]],
    ],
  );
});
