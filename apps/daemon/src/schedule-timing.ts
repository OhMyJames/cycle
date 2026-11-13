import type { ScheduleTiming } from "@cycle/protocol";

const MINUTE_MS = 60_000;
/** A week and a day, so that any `daily` timing has an occurrence in the days looked at. */
const DAYS_LOOKED_AT = 8;

type Daily = Extract<ScheduleTiming, { kind: "daily" }>;

/** The occurrence on the local calendar day `offset` days from `day`, if the timing has one then. */
function dailyOn(timing: Daily, day: Date, offset: number): number | null {
  const date = new Date(day.getFullYear(), day.getMonth(), day.getDate() + offset);
  if (timing.weekdays && !timing.weekdays.includes(date.getDay())) return null;
  const [hours = 0, minutes = 0] = timing.time.split(":").map(Number);
  // A time a clock change skips runs at the time the clock shows instead.
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes).getTime();
}

/** The first occurrence later than `after`, or null when there is none. */
export function nextOccurrence(timing: ScheduleTiming, after: number): number | null {
  if (timing.kind === "once") return timing.at > after ? timing.at : null;
  if (timing.kind === "every") {
    if (after < timing.from) return timing.from;
    const period = timing.minutes * MINUTE_MS;
    return timing.from + (Math.floor((after - timing.from) / period) + 1) * period;
  }
  const day = new Date(after);
  for (let offset = 0; offset < DAYS_LOOKED_AT; offset++) {
    const at = dailyOn(timing, day, offset);
    if (at !== null && at > after) return at;
  }
  return null;
}

/** The latest occurrence at or before `at`, if it is later than `floor`. */
export function latestOccurrence(timing: ScheduleTiming, floor: number, at: number): number | null {
  const latest = latestAtOrBefore(timing, at);
  return latest !== null && latest > floor ? latest : null;
}

function latestAtOrBefore(timing: ScheduleTiming, at: number): number | null {
  if (timing.kind === "once") return timing.at <= at ? timing.at : null;
  if (timing.kind === "every") {
    if (at < timing.from) return null;
    const period = timing.minutes * MINUTE_MS;
    return timing.from + Math.floor((at - timing.from) / period) * period;
  }
  const day = new Date(at);
  for (let offset = 0; offset < DAYS_LOOKED_AT; offset++) {
    const when = dailyOn(timing, day, -offset);
    if (when !== null && when <= at) return when;
  }
  return null;
}
