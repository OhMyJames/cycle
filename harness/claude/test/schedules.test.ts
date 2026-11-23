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
    { schedule: "50 2 * * *", recurring: false },
    { schedule: "*/30 * * * *", recurring: true },
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
    s.told([{ schedule, recurring }], toldAt);
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
  s.called({ scheduledFor: now + 20 * 60_000, clampedDelaySeconds: 1200 });
  expect(s.dueWithin(now)).toBe(true);
  expect(s.dueWithin(now + 21 * 60_000)).toBe(true);
  // Long past: it fired, or it will not.
  expect(s.dueWithin(now + 30 * 60_000)).toBe(false);
  s.told([], now);
  expect(s.dueWithin(now)).toBe(false);
});
