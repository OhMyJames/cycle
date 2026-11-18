import { expect, test } from "bun:test";
import type { Item, Session } from "@cycle/protocol";
import { triggerAt } from "../src/components/composer.tsx";
import { groupSessions } from "../src/components/sidebar.tsx";
import { currentStep } from "../src/components/thread.tsx";

const running = (items: Item[]) => ({
  id: "t",
  status: "running" as const,
  error: null,
  startedAt: null,
  durationMs: null,
  items,
  diff: null,
});
const command = (status: "running" | "completed"): Item => ({
  id: "c",
  kind: "command",
  command: "/bin/bash -lc 'npm test'",
  cwd: "/p",
  output: "",
  exitCode: null,
  durationMs: null,
  actions: [],
  status,
});

test.each<[string, Item[], string]>([
  ["nothing yet", [], "Working"],
  ["a thought", [{ id: "r", kind: "reasoning", text: "hm" }], "Thinking"],
  ["a reply", [{ id: "m", kind: "agentMessage", text: "hi" }], "Writing"],
  ["a command at work", [command("running")], "Running npm test"],
  ["a command that ended", [command("completed")], "Working"],
  [
    "another agent at work",
    [{ id: "a", kind: "agentCall", tool: "wait", prompt: null, receivers: [], status: "running" }],
    "Waiting for a subagent",
  ],
])("the status line after %s", (_name, items, step) => {
  expect(currentStep(running(items))).toBe(step);
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
  const info = (id: string, patch: Partial<Session>): Session => ({
    id,
    harness: "codex",
    title: id,
    preview: "",
    cwd: "/p",
    model: "m",
    effort: null,
    mode: "auto",
    status: "idle",
    activity: "idle",
    loaded: true,
    failed: false,
    branch: null,
    worktree: null,
    sandbox: null,
    sandboxCwd: null,
    directories: [],
    createdAt: 0,
    updatedAt: now - 1000,
    archived: false,
    pinned: false,
    unread: false,
    forkedFrom: null,
    scheduleId: null,
    ...patch,
  });
  const groups = groupSessions(
    [
      info("old", { updatedAt: now - 40 * 86_400_000 }),
      info("today-early", { updatedAt: now - 7_200_000 }),
      info("today-late", {}),
      info("pinned", { pinned: true, updatedAt: now - 9 * 86_400_000 }),
      info("running", { status: "running", activity: "running" }),
      info("waiting", {
        status: "waiting",
        activity: "requires_action",
        updatedAt: now - 5 * 86_400_000,
      }),
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
