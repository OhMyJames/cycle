import { expect, test } from "bun:test";
import type { Schedule, ScheduleInput, ScheduleTiming } from "@cycle/protocol";
import {
  JsonStore,
  LaunchError,
  Scheduler,
  type SchedulesFile,
  latestOccurrence,
  nextOccurrence,
} from "../src/index.ts";
import { manualSchedule } from "./fake-harness.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A local time, so the daily cases hold in any zone the tests run in. */
const at = (day: number, hour = 0, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();

test.each<[string, ScheduleTiming, number, number | null]>([
  ["once, before it", { kind: "once", at: at(2) }, at(1), at(2)],
  ["once, after it", { kind: "once", at: at(2) }, at(2), null],
  ["every, before it starts", { kind: "every", minutes: 30, from: at(2) }, at(1), at(2)],
  ["every, on a beat", { kind: "every", minutes: 30, from: at(2) }, at(2, 1), at(2, 1, 30)],
  ["every, between beats", { kind: "every", minutes: 30, from: at(2) }, at(2, 1, 10), at(2, 1, 30)],
  ["daily, later today", { kind: "daily", time: "09:00", weekdays: null }, at(2, 8), at(2, 9)],
  ["daily, tomorrow", { kind: "daily", time: "09:00", weekdays: null }, at(2, 9), at(3, 9)],
  // 2026-11-02 is a Monday.
  ["daily, next chosen day", { kind: "daily", time: "09:00", weekdays: [3] }, at(2, 10), at(4, 9)],
  ["daily, a week on", { kind: "daily", time: "09:00", weekdays: [1] }, at(2, 9), at(9, 9)],
])("the next occurrence of %s", (_name, timing, after, next) => {
  expect(nextOccurrence(timing, after)).toBe(next);
});

test.each<[string, ScheduleTiming, number, number, number | null]>([
  ["once, due", { kind: "once", at: at(2) }, at(1), at(3), at(2)],
  ["once, already counted", { kind: "once", at: at(2) }, at(2), at(3), null],
  [
    "every, the latest beat",
    { kind: "every", minutes: 60, from: at(2) },
    at(2),
    at(2, 5, 20),
    at(2, 5),
  ],
  ["every, not yet", { kind: "every", minutes: 60, from: at(2) }, at(1), at(1, 12), null],
  ["daily, today's", { kind: "daily", time: "09:00", weekdays: null }, at(1), at(2, 10), at(2, 9)],
  [
    "daily, yesterday's",
    { kind: "daily", time: "09:00", weekdays: null },
    at(1),
    at(3, 8),
    at(2, 9),
  ],
  [
    "daily, ran already",
    { kind: "daily", time: "09:00", weekdays: null },
    at(2, 9),
    at(2, 10),
    null,
  ],
])("the latest occurrence of %s", (_name, timing, floor, now, latest) => {
  expect(latestOccurrence(timing, floor, now)).toBe(latest);
});

const input = (over: Partial<ScheduleInput> = {}): ScheduleInput => ({
  name: "Morning check",
  enabled: true,
  prompt: "Check the build",
  cwd: "/repo",
  worktree: false,
  model: null,
  effort: null,
  mode: null,
  timing: { kind: "every", minutes: 60, from: at(2) },
  ...over,
});

async function setup(stored: SchedulesFile = { schedules: [] }) {
  let now = at(2);
  let ids = 0;
  const written: string[] = [];
  const delay = manualSchedule();
  const file = await JsonStore.open<SchedulesFile>(
    {
      read: async () => JSON.stringify(stored),
      write: async (text) => {
        written.push(text);
      },
    },
    { schedules: [] },
    delay.schedule,
  );
  const launched: string[] = [];
  const working = new Set<string>();
  const changes: Schedule[][] = [];
  let launch = async (id: string): Promise<{ sessionId: string }> => ({
    sessionId: `s${launched.push(id)}`,
  });
  const scheduler = new Scheduler({
    file,
    launch: (schedule) => launch(schedule.id),
    isWorking: (sessionId) => working.has(sessionId),
    now: () => now,
    newId: () => `id${++ids}`,
    onChange: (schedules) => changes.push(schedules),
    modes: () => ["readOnly", "auto", "plan"],
  });
  return {
    scheduler,
    launched,
    working,
    changes,
    written,
    file,
    go: (ms: number) => {
      now += ms;
    },
    failWith: (error: Error) => {
      launch = async () => {
        throw error;
      };
    },
    /** Lets a launch that was started settle. */
    settle: () => new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve))),
  };
}

test("a schedule runs when it is due, once for each occurrence", async () => {
  const t = await setup();
  const made = t.scheduler.put(input());
  expect(made.next).toBe(at(2, 1));
  t.scheduler.tick();
  expect(t.launched).toEqual([]);

  t.go(HOUR);
  t.scheduler.tick();
  t.scheduler.tick();
  await t.settle();
  expect(t.launched).toEqual(["id1"]);
  expect(t.scheduler.list()[0]?.runs).toEqual([
    { scheduledFor: at(2, 1), startedAt: at(2, 1), manual: false, sessionId: "s1", error: null },
  ]);
  expect(t.changes.at(-1)?.[0]?.runs[0]?.sessionId).toBe("s1");
});

test("of the occurrences missed while away, only the latest runs", async () => {
  const t = await setup();
  t.scheduler.put(input());
  t.go(5 * HOUR + 10 * MINUTE);
  t.scheduler.tick();
  await t.settle();
  expect(t.scheduler.list()[0]?.runs.map((run) => run.scheduledFor)).toEqual([at(2, 5)]);
});

test("a run waits while the session of the one before is still at work", async () => {
  const t = await setup();
  t.scheduler.put(input());
  t.go(HOUR);
  t.scheduler.tick();
  await t.settle();
  t.working.add("s1");
  t.go(HOUR);
  t.scheduler.tick();
  await t.settle();
  expect(t.launched).toHaveLength(1);

  t.working.delete("s1");
  t.scheduler.tick();
  await t.settle();
  expect(t.launched).toHaveLength(2);
});

test("a once runs a single time and is then off, and a stale one never runs", async () => {
  const t = await setup();
  t.scheduler.put(input({ timing: { kind: "once", at: at(2, 1) } }));
  expect(() => t.scheduler.put(input({ timing: { kind: "once", at: at(1) } }))).toThrow(
    "That time has passed.",
  );
  t.go(HOUR + MINUTE);
  t.scheduler.tick();
  await t.settle();
  expect(t.launched).toEqual(["id1"]);
  expect(t.scheduler.list()[0]).toMatchObject({ enabled: false, next: null });

  const late = await setup({
    schedules: [
      { ...input({ timing: { kind: "once", at: at(2, 1) } }), id: "old", since: at(1), runs: [] },
    ],
  });
  late.go(14 * HOUR);
  late.scheduler.tick();
  expect(late.launched).toEqual([]);
  expect(late.scheduler.list()[0]).toMatchObject({
    enabled: false,
    runs: [{ error: "Missed by more than 12 hours.", sessionId: null }],
  });
});

test("a run by hand does not move the occurrences, and a failure is recorded", async () => {
  const t = await setup();
  const made = t.scheduler.put(input({ enabled: false }));
  const run = await t.scheduler.run(made.id);
  expect(run).toMatchObject({ manual: true, sessionId: "s1", error: null });
  expect(t.scheduler.list()[0]?.next).toBeNull();

  t.failWith(new LaunchError("The agent refused the prompt.", "s9"));
  expect(await t.scheduler.run(made.id)).toMatchObject({
    sessionId: "s9",
    error: "The agent refused the prompt.",
  });
  await expect(t.scheduler.run("nope")).rejects.toThrow("no longer exists");
});

test("an edit keeps the runs, and a new timing counts from now", async () => {
  const t = await setup();
  const made = t.scheduler.put(input());
  t.go(HOUR);
  t.scheduler.tick();
  await t.settle();
  t.go(10 * MINUTE);
  const renamed = t.scheduler.put({ ...input({ name: "Hourly" }), id: made.id });
  expect(renamed).toMatchObject({ name: "Hourly", since: at(2) });
  expect(renamed.runs).toHaveLength(1);

  const retimed = t.scheduler.put({
    ...input({ timing: { kind: "every", minutes: 5, from: at(2) } }),
    id: made.id,
  });
  expect(retimed.since).toBe(at(2, 1, 10));
  t.scheduler.tick();
  await t.settle();
  expect(t.launched).toHaveLength(1);

  t.scheduler.remove(made.id);
  expect(t.scheduler.list()).toEqual([]);
  await t.file.flush();
  expect(JSON.parse(t.written.at(-1) ?? "")).toEqual({ schedules: [] });
});

test.each<[string, Partial<ScheduleInput>, string]>([
  ["no name", { name: "  " }, "needs a name"],
  ["no prompt", { prompt: "" }, "needs a prompt"],
  ["a relative folder", { cwd: "repo" }, "absolute path"],
  ["an unknown mode", { mode: "root" as never }, "Unknown mode"],
  ["a bad time", { timing: { kind: "daily", time: "25:00", weekdays: null } }, "not a timing"],
  ["no days", { timing: { kind: "daily", time: "09:00", weekdays: [] } }, "not a timing"],
  ["a zero interval", { timing: { kind: "every", minutes: 0, from: 1 } }, "not a timing"],
])("a schedule with %s is refused", async (_name, over, message) => {
  const t = await setup();
  expect(() => t.scheduler.put(input(over))).toThrow(message);
});

test("a run whose news cannot be told still ends, and its schedule can run again", async () => {
  const delay = manualSchedule();
  const file = await JsonStore.open<SchedulesFile>(
    { read: async () => null, write: async () => {} },
    { schedules: [] },
    delay.schedule,
  );
  let deaf = false;
  const scheduler = new Scheduler({
    file,
    launch: async () => ({ sessionId: "s1" }),
    isWorking: () => false,
    now: () => at(2),
    newId: () => "id1",
    onChange: () => {
      if (deaf) throw new Error("nobody to tell");
    },
    modes: () => [],
  });
  const { id } = scheduler.put(input());
  deaf = true;
  expect(await scheduler.run(id)).toMatchObject({ sessionId: "s1", error: null });
  expect(await scheduler.run(id)).toMatchObject({ sessionId: "s1", error: null });
});

test("a mode from before each agent named its own reads as it was meant, and stays for older daemons", async () => {
  const kept = { ...input({ mode: "auto" }), id: "kept", since: at(1), runs: [] };
  const t = await setup({ schedules: [kept] });
  expect(t.scheduler.list()[0]?.mode).toBe("legacy:auto");
  expect(t.scheduler.put({ ...input({ mode: "plan" }), id: "kept" }).mode).toBe("plan");
  expect(t.file.value.schedules[0]).toMatchObject({ mode: "auto", agentMode: "plan" });
  const back = t.scheduler.put({ ...input({ mode: "legacy:auto" }), id: "kept" });
  expect(back.mode).toBe("legacy:auto");
  expect(() => t.scheduler.put(input({ mode: "legacy:root" }))).toThrow("Unknown mode");
});
