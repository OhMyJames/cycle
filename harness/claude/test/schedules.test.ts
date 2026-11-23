import { expect, test } from "bun:test";
import {
  cronsOf,
  fireTimeOf,
  KEEP_FOR_MS,
  nextFire,
  parseCron,
  Schedules,
} from "../src/schedules.ts";

/** A local time, as Claude Code reads a cron expression. */
const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0) =>
  new Date(y, mo - 1, d, h, mi, s).getTime();

test("the Stop hook's crons are read, and a hook that does not say leaves them unknown", () => {
  expect(
    cronsOf({
      hook_event_name: "Stop",
      session_crons: [
        { id: "343632c0", schedule: "50 2 * * *", recurring: false, prompt: "Reply WOKE" },
        { id: "cc4f1946", schedule: "*/30 * * * *", recurring: true, prompt: "TICK" },
        { id: "x", schedule: 7 },
      ],
    }),
  ).toEqual([
    { id: "343632c0", schedule: "50 2 * * *", recurring: false, prompt: "Reply WOKE" },
    { id: "cc4f1946", schedule: "*/30 * * * *", recurring: true, prompt: "TICK" },
  ]);
  expect(cronsOf({ hook_event_name: "Stop", session_crons: [] })).toEqual([]);
  expect(cronsOf({ hook_event_name: "Stop" })).toBeUndefined();
  expect(cronsOf(undefined)).toBeUndefined();
});

test("a wakeup's pinned minute fires at that minute, and not again within the hour", () => {
  // What ScheduleWakeup sets: a one-shot cron at the minute it is due.
  expect(nextFire("50 2 * * *", at(2026, 11, 23, 2, 48, 30), KEEP_FOR_MS)).toBe(
    at(2026, 11, 23, 2, 50),
  );
  // The minute it fired in is behind: tomorrow, which is not within the hour.
  expect(nextFire("50 2 * * *", at(2026, 11, 23, 2, 50, 5), KEEP_FOR_MS)).toBeUndefined();
  expect(nextFire("50 2 * * *", at(2026, 11, 23, 2, 50), KEEP_FOR_MS)).toBe(
    at(2026, 11, 23, 2, 50),
  );
});

test("steps, ranges, lists, names and macros are read as cron reads them", () => {
  const from = at(2026, 11, 23, 10, 7); // a Monday
  expect(nextFire("*/30 * * * *", from, KEEP_FOR_MS)).toBe(at(2026, 11, 23, 10, 30));
  expect(nextFire("5-10/2 * * * *", from, KEEP_FOR_MS)).toBe(at(2026, 11, 23, 10, 7));
  expect(nextFire("15,45 10 * * *", from, KEEP_FOR_MS)).toBe(at(2026, 11, 23, 10, 15));
  expect(nextFire("0 11 * nov mon", from, KEEP_FOR_MS)).toBe(at(2026, 11, 23, 11, 0));
  expect(nextFire("0 11 * * 7", from, KEEP_FOR_MS)).toBeUndefined(); // Sunday, also written 7
  expect(nextFire("@hourly", from, KEEP_FOR_MS)).toBe(at(2026, 11, 23, 11, 0));
  expect(nextFire("0 11 ? * mon", from, KEEP_FOR_MS)).toBe(at(2026, 11, 23, 11, 0));
  // Both day fields restricted: either one is enough.
  expect(nextFire("0 11 1 * mon", from, KEEP_FOR_MS)).toBe(at(2026, 11, 23, 11, 0));
  expect(nextFire("0 11 1 * *", from, KEEP_FOR_MS)).toBeUndefined();
  // A day field that begins with "*" does not restrict, so both must match (the 23rd is odd: */2 from 1 has it).
  expect(nextFire("0 11 */2 * tue", from, KEEP_FOR_MS)).toBeUndefined();
});

test("an expression that cannot be read is said so, not taken as never", () => {
  for (const bad of ["", "* * * *", "61 * * * *", "*/0 * * * *", "a b c d e", "5-1 * * * *"]) {
    expect(parseCron(bad)).toBeUndefined();
    expect(nextFire(bad, at(2026, 11, 23, 10, 0), KEEP_FOR_MS)).toBe("unreadable");
  }
});

test("what a finished call set: a wakeup's time, a session cron's next run, nothing for the rest", () => {
  expect(
    fireTimeOf({ scheduledFor: 1795431000000, clampedDelaySeconds: 60, wasClamped: false }),
  ).toBe(1795431000000);
  expect(
    fireTimeOf({ scheduledFor: 1795431000000, clampedDelaySeconds: 60, stopped: true }),
  ).toBeUndefined();
  expect(
    fireTimeOf({
      id: "d2122794",
      humanSchedule: "Every day at 2:49 AM",
      recurring: false,
      durable: false,
      nextFireAt: 1795430940000,
    }),
  ).toBe(1795430940000);
  expect(
    fireTimeOf({ id: "d", humanSchedule: "Daily", durable: true, nextFireAt: 1 }),
  ).toBeUndefined();
  expect(fireTimeOf({ jobs: [] })).toBeUndefined();
  expect(fireTimeOf({ id: "cc4f1946" })).toBeUndefined();
  expect(fireTimeOf("text")).toBeUndefined();
});

test("a session is kept for what fires within the hour, and not for what fires further off", () => {
  const now = at(2026, 11, 23, 10, 7);
  const kept = (schedule: string, recurring = false, toldAt = now) => {
    const s = new Schedules();
    s.told([{ id: "c", schedule, recurring, prompt: "p" }], toldAt);
    return s.dueWithin(now);
  };
  expect(kept("40 10 * * *")).toBe(true);
  expect(kept("6 11 * * *")).toBe(true);
  expect(kept("8 11 * * *")).toBe(false);
  expect(kept("0 9 * * *")).toBe(false);
  // A recurring job may fire up to 30 minutes after its minute: one whose minute just passed may still be to come.
  expect(kept("50 9 * * *", true)).toBe(true);
  expect(kept("30 9 * * *", true)).toBe(false);
  expect(kept("50 9 * * *", false)).toBe(false);
  // Its minute just went: it may be firing, its turn not yet begun.
  expect(kept("6 10 * * *", false)).toBe(true);
  expect(kept("4 10 * * *", false)).toBe(false);
  // One that cannot be read: kept while what was told is fresh, not for as long as the job lives.
  expect(kept("not a cron")).toBe(true);
  expect(kept("not a cron", false, now - 2 * KEEP_FOR_MS)).toBe(false);
  expect(new Schedules().dueWithin(now)).toBe(false);
});

test("what a call set counts until the Stop hook speaks, which has the last word", () => {
  const now = at(2026, 11, 23, 10, 7);
  const s = new Schedules();
  s.called("t1", { scheduledFor: now + 20 * 60_000, clampedDelaySeconds: 1200 });
  expect(s.dueWithin(now)).toBe(true);
  expect(s.dueWithin(now + 21 * 60_000)).toBe(true);
  // Long past: it fired, or it will not.
  expect(s.dueWithin(now + 30 * 60_000)).toBe(false);
  s.told([], now);
  expect(s.dueWithin(now)).toBe(false);
});

// ---- the list clients are told (CYCL-146) ----

test("what the calls set is listed at once, named, and the Stop hook's list then has the last word", () => {
  const now = at(2026, 11, 23, 2, 48);
  const s = new Schedules();
  s.asked("t1", "CronCreate", {
    cron: "*/30 * * * *",
    prompt: "Reply with the word TICK",
    recurring: true,
  });
  s.called("t1", {
    id: "cc4f1946",
    humanSchedule: "Every 30 minutes",
    recurring: true,
    durable: false,
    nextFireAt: at(2026, 11, 23, 3, 11, 58),
  });
  s.asked("t2", "ScheduleWakeup", { delaySeconds: 60, prompt: "Reply with the word WOKE" });
  s.called("t2", { scheduledFor: at(2026, 11, 23, 2, 50), clampedDelaySeconds: 60 });
  s.asked("t3", "Read", { file_path: "/x" });
  s.called("t3", { file: {} });
  expect(s.update(now)).toEqual({
    sessionUpdate: "_cycle/schedule_update",
    jobs: [
      {
        id: "cc4f1946",
        kind: "cron",
        schedule: "*/30 * * * *",
        humanSchedule: "Every 30 minutes",
        recurring: true,
        durable: false,
        prompt: "Reply with the word TICK",
        nextFireAt: at(2026, 11, 23, 3, 11, 58),
        toolCallId: "t1",
      },
      {
        id: "wakeup:t2",
        kind: "wakeup",
        schedule: "50 2 23 11 *",
        recurring: false,
        durable: false,
        prompt: "Reply with the word WOKE",
        nextFireAt: at(2026, 11, 23, 2, 50),
        toolCallId: "t2",
      },
    ],
  });
  // Nothing new: nothing to tell.
  expect(s.update(now)).toBeUndefined();
  // The hook names the wakeup by its own id, and keeps what the call said of the cron.
  s.told(
    [
      {
        id: "cc4f1946",
        schedule: "*/30 * * * *",
        recurring: true,
        prompt: "Reply with the word TICK",
      },
      {
        id: "343632c0",
        schedule: "50 2 * * *",
        recurring: false,
        prompt: "Reply with the word WOKE",
      },
    ],
    now,
  );
  const told = s.update(now) as { jobs: Record<string, unknown>[] };
  expect(told.jobs.map((j) => [j.id, j.kind, j.toolCallId])).toEqual([
    ["cc4f1946", "cron", "t1"],
    ["343632c0", "wakeup", "t2"],
  ]);
  // Fired and gone: the hook's next list does not have it.
  s.told(
    [
      {
        id: "cc4f1946",
        schedule: "*/30 * * * *",
        recurring: true,
        prompt: "Reply with the word TICK",
      },
    ],
    now + 3 * 60_000,
  );
  const after = s.update(now + 3 * 60_000) as { jobs: Record<string, unknown>[] };
  expect(after.jobs.map((j) => j.id)).toEqual(["cc4f1946"]);
});

test("a cron's next run is worked out from its schedule once the time a call gave has gone", () => {
  const s = new Schedules();
  s.told([{ id: "c", schedule: "*/30 * * * *", recurring: true, prompt: "TICK" }], 0);
  expect(s.list(at(2026, 11, 23, 10, 7))[0]?.nextFireAt).toBe(at(2026, 11, 23, 10, 30));
  // Further off than a week: said only in its schedule.
  s.told([{ id: "y", schedule: "0 0 1 1 *", recurring: true, prompt: "Happy new year" }], 0);
  expect(s.list(at(2026, 11, 23, 10, 7))[0]?.nextFireAt).toBeUndefined();
});

test("a deleted cron leaves the list, a stopped loop takes its wakeups, and CronList has the durable ones", () => {
  const now = at(2026, 11, 23, 10, 0);
  const s = new Schedules();
  s.asked("a", "CronCreate", { cron: "0 9 * * *", prompt: "Morning check", durable: true });
  s.called("a", { id: "d1", humanSchedule: "Every day at 9 AM", recurring: true, durable: true });
  s.asked("b", "ScheduleWakeup", { delaySeconds: 600, prompt: "loop" });
  s.called("b", { scheduledFor: now + 600_000, clampedDelaySeconds: 600 });
  expect(s.list(now).map((j) => [j.id, j.durable])).toEqual([
    ["wakeup:b", false],
    ["d1", true],
  ]);
  s.asked("c", "ScheduleWakeup", { stop: true });
  s.called("c", { scheduledFor: 0, clampedDelaySeconds: 0, stopped: true, cancelledWakeups: 1 });
  expect(s.list(now).map((j) => j.id)).toEqual(["d1"]);
  s.asked("d", "CronDelete", { id: "d1" });
  s.called("d", { id: "d1" });
  expect(s.list(now)).toEqual([]);
  s.asked("e", "CronList", {});
  s.called("e", {
    jobs: [
      {
        id: "d2",
        cron: "0 18 * * 5",
        humanSchedule: "Fridays at 6 PM",
        prompt: "Weekly notes",
        recurring: true,
        durable: true,
      },
      { id: "s1", cron: "*/10 * * * *", prompt: "Poll", recurring: true, durable: false },
    ],
  });
  expect(s.list(now).map((j) => [j.id, j.durable])).toEqual([
    ["s1", false],
    ["d2", true],
  ]);
});

test("the list says when the process is gone, only while it holds something that is not durable", () => {
  const now = at(2026, 11, 23, 10, 0);
  const s = new Schedules();
  // The first word is told even with nothing in it: this agent tells its list.
  expect(s.update(now)).toEqual({ sessionUpdate: "_cycle/schedule_update", jobs: [] });
  s.sleeping(true);
  expect(s.update(now)).toBeUndefined();
  s.told([{ id: "c", schedule: "0 9 * * *", recurring: true, prompt: "Daily" }], now);
  expect(s.update(now)).toMatchObject({ dormant: true });
  s.sleeping(false);
  expect(s.update(now)).not.toHaveProperty("dormant");
});

test("a long prompt is cut short", () => {
  const s = new Schedules();
  s.told([{ id: "c", schedule: "0 9 * * *", recurring: true, prompt: "x".repeat(1_000) }], 0);
  expect(s.list(0)[0]?.prompt).toHaveLength(301);
});

test("review: a one-shot's time once gone is not made into another, and is dropped on waking", () => {
  const now = at(2026, 11, 23, 10, 0);
  const s = new Schedules();
  s.asked("w", "ScheduleWakeup", { prompt: "Look again" });
  s.called("w", { scheduledFor: now + 70 * 60_000, clampedDelaySeconds: 3600 });
  s.told([{ id: "c", schedule: "10 11 * * *", recurring: false, prompt: "Look again" }], now);
  const later = now + 3 * 60 * 60_000;
  expect(s.list(later)[0]?.nextFireAt).toBeUndefined();
  s.sleeping(true, later);
  s.sleeping(false, later);
  expect(s.list(later)).toEqual([]);
});

test("review: a CronCreate result that does not say whether it recurs takes the call's word, recurring by default", () => {
  const s = new Schedules();
  s.asked("a", "CronCreate", { cron: "*/30 * * * *", prompt: "Poll" });
  s.called("a", { id: "x", humanSchedule: "Every 30 minutes" });
  s.asked("b", "CronCreate", { cron: "0 9 * * *", prompt: "Once", recurring: false });
  s.called("b", { id: "y", humanSchedule: "At 9 AM" });
  expect(s.list(0).map((j) => [j.id, j.recurring])).toEqual([
    ["x", true],
    ["y", false],
  ]);
});

test("review: CronList knows a wakeup, a hook cron without an id still keeps its process, same words go by their minute", () => {
  const now = at(2026, 11, 23, 10, 0);
  const s = new Schedules();
  s.asked("w1", "ScheduleWakeup", { prompt: "Check" });
  s.called("w1", { scheduledFor: at(2026, 11, 23, 10, 10), clampedDelaySeconds: 600 });
  s.asked("w2", "ScheduleWakeup", { prompt: "Check" });
  s.called("w2", { scheduledFor: at(2026, 11, 23, 10, 50), clampedDelaySeconds: 3000 });
  s.asked("l", "CronList", {});
  s.called("l", {
    jobs: [
      { id: "a", cron: "10 10 * * *", prompt: "Check", durable: false },
      { id: "b", cron: "50 10 * * *", prompt: "Check", durable: false },
    ],
  });
  expect(s.list(now).map((j) => [j.id, j.kind, j.toolCallId, j.nextFireAt])).toEqual([
    ["a", "wakeup", "w1", at(2026, 11, 23, 10, 10)],
    ["b", "wakeup", "w2", at(2026, 11, 23, 10, 50)],
  ]);
  const crons = cronsOf({ session_crons: [{ schedule: "20 10 * * *", recurring: false }] });
  expect(crons).toEqual([{ id: "cron:0", schedule: "20 10 * * *", recurring: false, prompt: "" }]);
  s.told(crons ?? [], now);
  expect(s.dueWithin(now)).toBe(true);
});
