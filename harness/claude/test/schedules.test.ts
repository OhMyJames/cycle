import { expect, test } from "bun:test";
import { cronsOf, dueWithin, KEEP_FOR_MS, nextFire, parseCron } from "../src/schedules.ts";

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
        { id: 7, schedule: "* * * * *" },
      ],
    }),
  ).toEqual([
    { id: "343632c0", schedule: "50 2 * * *", recurring: false },
    { id: "cc4f1946", schedule: "*/30 * * * *", recurring: true },
  ]);
  expect(cronsOf({ hook_event_name: "Stop", session_crons: [] })).toEqual([]);
  expect(cronsOf({ hook_event_name: "Stop" })).toBeUndefined();
  expect(cronsOf(undefined)).toBeUndefined();
});

test("a wakeup's pinned minute fires at that minute, today or not within the hour", () => {
  // What ScheduleWakeup sets: a one-shot cron at the minute it is due.
  expect(nextFire("50 2 * * *", at(2026, 11, 23, 2, 48, 30), KEEP_FOR_MS)).toBe(
    at(2026, 11, 23, 2, 50),
  );
  // Already past today: tomorrow, which is not within the hour.
  expect(nextFire("50 2 * * *", at(2026, 11, 23, 2, 51), KEEP_FOR_MS)).toBeUndefined();
});

test("steps, ranges, lists and names are read as cron reads them", () => {
  const from = at(2026, 11, 23, 10, 7); // a Monday
  expect(nextFire("*/30 * * * *", from, KEEP_FOR_MS)).toBe(at(2026, 11, 23, 10, 30));
  expect(nextFire("5-10/2 * * * *", from, KEEP_FOR_MS)).toBe(at(2026, 11, 23, 10, 7));
  expect(nextFire("15,45 10 * * *", from, KEEP_FOR_MS)).toBe(at(2026, 11, 23, 10, 15));
  expect(nextFire("0 11 * nov mon", from, KEEP_FOR_MS)).toBe(at(2026, 11, 23, 11, 0));
  expect(nextFire("0 11 * * 7", from, KEEP_FOR_MS)).toBeUndefined(); // Sunday, also written 7
  // Both day fields restricted: either one is enough.
  expect(nextFire("0 11 1 * mon", from, KEEP_FOR_MS)).toBe(at(2026, 11, 23, 11, 0));
  expect(nextFire("0 11 1 * *", from, KEEP_FOR_MS)).toBeUndefined();
});

test("an expression that cannot be read is said so, not taken as never", () => {
  for (const bad of ["", "* * * *", "61 * * * *", "*/0 * * * *", "a b c d e", "5-1 * * * *"]) {
    expect(parseCron(bad)).toBeUndefined();
    expect(nextFire(bad, at(2026, 11, 23, 10, 0), KEEP_FOR_MS)).toBe("unreadable");
  }
});

test("a session is kept for a cron due within the hour, or one that cannot be read, and not for one further off", () => {
  const now = at(2026, 11, 23, 10, 7);
  const cron = (schedule: string) => [{ id: "x", schedule, recurring: false }];
  expect(dueWithin(cron("40 10 * * *"), now)).toBe(true);
  expect(dueWithin(cron("6 11 * * *"), now)).toBe(true);
  expect(dueWithin(cron("8 11 * * *"), now)).toBe(false);
  expect(dueWithin(cron("0 9 * * *"), now)).toBe(false);
  expect(dueWithin(cron("not a cron"), now)).toBe(true);
  expect(dueWithin([], now)).toBe(false);
  expect(dueWithin(undefined, now)).toBe(false);
});
