import { expect, test } from "bun:test";
import type { Schedule, ScheduleTiming, SessionInfo } from "@cycle/protocol";
import {
  describeTiming,
  draftOf,
  draftProblem,
  inputFromSchedule,
  inputOf,
  runEntries,
  runsByDay,
  whenLabel,
} from "../src/lib/schedule-text.ts";

const now = new Date(2026, 10, 2, 10, 0);
const at = (day: number, hour = 0, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();

test.each<[ScheduleTiming, string]>([
  [{ kind: "daily", time: "09:00", weekdays: null }, "Every day at 9:00 AM"],
  [{ kind: "daily", time: "18:30", weekdays: [1, 2, 3, 4, 5] }, "Weekdays at 6:30 PM"],
  [{ kind: "daily", time: "08:00", weekdays: [0, 6] }, "Weekends at 8:00 AM"],
  [{ kind: "daily", time: "08:00", weekdays: [1, 3] }, "Mon, Wed at 8:00 AM"],
  [{ kind: "every", minutes: 60, from: 1 }, "Every hour"],
  [{ kind: "every", minutes: 180, from: 1 }, "Every 3 hours"],
  [{ kind: "every", minutes: 45, from: 1 }, "Every 45 minutes"],
  [{ kind: "once", at: at(3, 9) }, "Once, tomorrow at 9:00 AM"],
])("timing %j reads %p", (timing, text) => {
  expect(describeTiming(timing, now)).toBe(text);
});

test("a moment near now is said as people say it", () => {
  expect(whenLabel(new Date(at(2, 15)), now)).toBe("Today at 3:00 PM");
  expect(whenLabel(new Date(at(1, 15)), now)).toBe("Yesterday at 3:00 PM");
  expect(whenLabel(new Date(at(9, 15)), now)).toBe("Mon, Nov 9 at 3:00 PM");
});

const schedule = (over: Partial<Schedule> = {}): Schedule => ({
  id: "a",
  name: "Nightly",
  enabled: true,
  prompt: "Check the build",
  cwd: "/repo",
  worktree: false,
  model: null,
  effort: null,
  mode: null,
  timing: { kind: "every", minutes: 120, from: at(1) },
  since: at(1),
  runs: [],
  next: null,
  ...over,
});

test("a new schedule's form is every day at nine, and says what it lacks", () => {
  const draft = draftOf(null, "/repo", now);
  expect(draft).toMatchObject({ kind: "daily", time: "09:00", enabled: true, cwd: "/repo" });
  expect(draftProblem(draft, now)).toBe("Name it");
  expect(draftProblem({ ...draft, name: "n" }, now)).toBe("Say what to do");
  const full = { ...draft, name: " n ", prompt: " p " };
  expect(draftProblem(full, now)).toBeNull();
  expect(inputOf(full, null, now)).toMatchObject({
    name: "n",
    prompt: "p",
    timing: { kind: "daily", time: "09:00", weekdays: null },
  });
  expect(draftProblem({ ...full, kind: "once", at: "2026-11-01T09:00" }, now)).toBe(
    "Choose a time that has not passed",
  );
  expect(draftProblem({ ...full, kind: "every", every: 0 }, now)).toBe(
    "Run it at least every minute",
  );
});

test("an interval keeps its start unless it changed, and a new one starts an interval on", () => {
  const existing = schedule();
  const draft = draftOf(existing, "", now);
  expect(draft).toMatchObject({ kind: "every", every: 2, unit: "hours" });
  expect(inputOf(draft, existing, now).timing).toEqual(existing.timing);
  expect(inputOf({ ...draft, every: 30, unit: "minutes" }, existing, now).timing).toEqual({
    kind: "every",
    minutes: 30,
    from: at(2, 10, 30),
  });
  expect(inputFromSchedule(existing)).not.toHaveProperty("runs");
});

const session = (id: string, scheduleId: string | null, createdAt: number) =>
  ({ id, scheduleId, createdAt, title: null, preview: `prompt ${id}` }) as SessionInfo;

test("the history is each session a schedule started and each run that started none", () => {
  const kept = schedule({
    runs: [
      {
        scheduledFor: at(2, 8),
        startedAt: at(2, 8),
        manual: false,
        sessionId: null,
        error: "No folder",
      },
      {
        scheduledFor: at(1, 8),
        startedAt: at(1, 8, 1),
        manual: false,
        sessionId: "s1",
        error: null,
      },
    ],
  });
  const entries = runEntries(
    [session("s1", "a", at(1, 7)), session("s2", "gone", at(1, 9)), session("s3", null, at(2))],
    [kept],
  );
  expect(entries.map((entry) => [entry.key, entry.title, entry.error])).toEqual([
    [`a:${at(2, 8)}`, "Check the build", "No folder"],
    ["s2", "prompt s2", null],
    ["s1", "prompt s1", null],
  ]);
  expect(entries[1]?.schedule).toBeNull();
  expect(entries[2]?.at).toBe(at(1, 8, 1));
  expect(runsByDay(entries, now).map((group) => [group.day, group.runs.length])).toEqual([
    ["Today", 1],
    ["Yesterday", 2],
  ]);
});
