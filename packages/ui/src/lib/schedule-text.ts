import type {
  Schedule,
  ScheduleInput,
  ScheduleTiming,
  SessionInfo,
  PermissionMode,
} from "@cycle/protocol";

const LOCALE = "en-US";
const MINUTE_MS = 60_000;

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** A time of day, as `9:00 AM`. */
export const clock = (date: Date): string =>
  date.toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit" });

/** `HH:MM` on the clock, as `9:00 AM`. */
export const clockLabel = (time: string): string => {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  return clock(new Date(2000, 0, 1, hours, minutes));
};

const dayNumber = (date: Date): number =>
  Math.round(new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 86_400_000);

/** `Tomorrow at 9:00 AM` as it reads after another word: `tomorrow at 9:00 AM`. */
export const lowerFirst = (text: string): string => text.slice(0, 1).toLowerCase() + text.slice(1);

/** A day near now, as a group of runs is headed: `Today`, `Yesterday`, or the date. */
export function dayLabel(when: Date, now: Date): string {
  const days = dayNumber(when) - dayNumber(now);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  return when.toLocaleDateString(LOCALE, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(when.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** A moment near now, as people say it: `Today at 9:00 AM`, `Tomorrow at…`, or the date. */
export const whenLabel = (when: Date, now: Date): string =>
  `${dayLabel(when, now)} at ${clock(when)}`;

function daysLabel(weekdays: readonly number[] | null): string {
  const days = new Set(weekdays ?? []);
  if (days.size === 0 || days.size === 7) return "Every day";
  if (days.size === 5 && [1, 2, 3, 4, 5].every((day) => days.has(day))) return "Weekdays";
  if (days.size === 2 && days.has(0) && days.has(6)) return "Weekends";
  return [...days]
    .toSorted((a, b) => a - b)
    .map((day) => WEEKDAYS[day]?.slice(0, 3))
    .join(", ");
}

/** What a timing does, in a few words. */
export function describeTiming(timing: ScheduleTiming, now: Date): string {
  if (timing.kind === "daily") return `${daysLabel(timing.weekdays)} at ${clockLabel(timing.time)}`;
  if (timing.kind === "once") return `Once, ${lowerFirst(whenLabel(new Date(timing.at), now))}`;
  const { minutes } = timing;
  if (minutes % 60 === 0) return minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`;
  return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
}

/** What the form edits: every kind of timing at once, so switching kinds keeps what was typed. */
export interface ScheduleDraft {
  name: string;
  prompt: string;
  cwd: string;
  worktree: boolean;
  /** Not on the form: a new schedule is on, and the list's switch turns one off. */
  enabled: boolean;
  /** Null: what new sessions start with when the run starts. */
  model: string | null;
  effort: string | null;
  mode: PermissionMode | null;
  /** The agent `mode` is one of. */
  modeHarness: string | null;
  kind: ScheduleTiming["kind"];
  /** `HH:MM`, for `daily`. */
  time: string;
  /** For `daily`; none is every day. */
  weekdays: number[];
  every: number;
  unit: "minutes" | "hours";
  /** `YYYY-MM-DDTHH:MM` on the local clock, as a `datetime-local` field holds it, for `once`. */
  at: string;
}

const pad = (value: number): string => String(value).padStart(2, "0");

const localField = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** The form for a schedule, or for a new one in `cwd`: every day at 9, on, in place. */
export function draftOf(schedule: Schedule | null, cwd: string, now: Date): ScheduleDraft {
  const tomorrowAtNine = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9);
  const timing = schedule?.timing;
  const hours = timing?.kind === "every" && timing.minutes % 60 === 0;
  return {
    name: schedule?.name ?? "",
    prompt: schedule?.prompt ?? "",
    cwd: schedule?.cwd ?? cwd,
    worktree: schedule?.worktree ?? false,
    enabled: schedule?.enabled ?? true,
    model: schedule?.model ?? null,
    effort: schedule?.effort ?? null,
    mode: schedule?.mode ?? null,
    modeHarness: schedule?.modeHarness ?? null,
    kind: timing?.kind ?? "daily",
    time: timing?.kind === "daily" ? timing.time : "09:00",
    weekdays: timing?.kind === "daily" ? (timing.weekdays ?? []) : [],
    every: timing?.kind === "every" ? (hours ? timing.minutes / 60 : timing.minutes) : 1,
    unit: timing?.kind === "every" && !hours ? "minutes" : "hours",
    at: localField(timing?.kind === "once" ? new Date(timing.at) : tomorrowAtNine),
  };
}

function timingOf(draft: ScheduleDraft, existing: Schedule | null, now: Date): ScheduleTiming {
  if (draft.kind === "daily") {
    const some = draft.weekdays.length > 0 && draft.weekdays.length < 7;
    return {
      kind: "daily",
      time: draft.time,
      weekdays: some ? draft.weekdays.toSorted((a, b) => a - b) : null,
    };
  }
  if (draft.kind === "once") return { kind: "once", at: new Date(draft.at).getTime() };
  const minutes = draft.unit === "hours" ? draft.every * 60 : draft.every;
  const old = existing?.timing;
  if (old?.kind === "every" && old.minutes === minutes) return old;
  // A new interval starts one interval from now, so saving it does not run it at once.
  const minute = Math.ceil(now.getTime() / MINUTE_MS) * MINUTE_MS;
  return { kind: "every", minutes, from: minute + minutes * MINUTE_MS };
}

/** What the form says, for the daemon. */
export function inputOf(draft: ScheduleDraft, existing: Schedule | null, now: Date): ScheduleInput {
  const timing = timingOf(draft, existing, now);
  // A `once` that ran turned itself off: giving it a time still to come turns it on again.
  const rearmed =
    timing.kind === "once" &&
    timing.at > now.getTime() &&
    !(existing?.timing.kind === "once" && existing.timing.at === timing.at);
  return {
    ...(existing ? { id: existing.id } : {}),
    name: draft.name.trim(),
    enabled: draft.enabled || rearmed,
    prompt: draft.prompt.trim(),
    cwd: draft.cwd,
    worktree: draft.worktree,
    model: draft.model,
    effort: draft.effort,
    mode: draft.mode,
    modeHarness: draft.mode ? draft.modeHarness : null,
    timing,
  };
}

/** The schedule as it is, for a change of one field such as `enabled`. */
export function inputFromSchedule(schedule: Schedule): ScheduleInput {
  const { since: _since, runs: _runs, next: _next, ...input } = schedule;
  return input;
}

/** What the form must have before it can be saved, or null when it has all of it. */
export function draftProblem(draft: ScheduleDraft, now: Date): string | null {
  if (draft.name.trim() === "") return "Name it";
  if (draft.prompt.trim() === "") return "Say what to do";
  if (draft.cwd === "") return "Choose a folder";
  if (draft.kind === "every" && (!Number.isInteger(draft.every) || draft.every < 1)) {
    return "Run it at least every minute";
  }
  if (draft.kind === "once") {
    const at = new Date(draft.at).getTime();
    if (Number.isNaN(at)) return "Choose a time";
    if (draft.enabled && at <= now.getTime()) return "Choose a time that has not passed";
  }
  return null;
}

/** One run in the history: a session a schedule started, or a run that started none. */
export interface RunEntry {
  key: string;
  at: number;
  /** Null for a session whose schedule is gone. */
  schedule: Schedule | null;
  sessionId: string | null;
  /** The session's title, or with none yet the message it was sent. */
  title: string;
  /** Why a run started no session. */
  error: string | null;
}

/**
 * Every run there is a trace of, newest first: each session the list marks
 * as a schedule's, at the time its run started when the schedule still
 * records it, and each run that started no session.
 */
export function runEntries(
  sessions: readonly SessionInfo[],
  schedules: readonly Schedule[],
): RunEntry[] {
  const byId = new Map(schedules.map((schedule) => [schedule.id, schedule]));
  const started = new Map(
    schedules.flatMap((schedule) =>
      schedule.runs.flatMap((run) =>
        run.sessionId ? [[run.sessionId, run.startedAt] as const] : [],
      ),
    ),
  );
  const ran = sessions.flatMap((session): RunEntry[] => {
    if (!session.scheduleId) return [];
    const schedule = byId.get(session.scheduleId) ?? null;
    return [
      {
        key: session.id,
        at: started.get(session.id) ?? session.createdAt,
        schedule,
        sessionId: session.id,
        title: session.title || session.preview || schedule?.prompt || "Untitled session",
        error: null,
      },
    ];
  });
  const failed = schedules.flatMap((schedule) =>
    schedule.runs.flatMap((run): RunEntry[] =>
      run.error !== null && run.sessionId === null
        ? [
            {
              key: `${schedule.id}:${run.startedAt}`,
              at: run.startedAt,
              schedule,
              sessionId: null,
              title: schedule.prompt,
              error: run.error,
            },
          ]
        : [],
    ),
  );
  return [...ran, ...failed].toSorted((a, b) => b.at - a.at);
}

/** Runs under the day each started, in the order given. */
export function runsByDay(
  runs: readonly RunEntry[],
  now: Date,
): { day: string; runs: RunEntry[] }[] {
  const groups: { day: string; runs: RunEntry[] }[] = [];
  for (const run of runs) {
    const day = dayLabel(new Date(run.at), now);
    const last = groups.at(-1);
    if (last?.day === day) last.runs.push(run);
    else groups.push({ day, runs: [run] });
  }
  return groups;
}

/** What the chosen days come to: none chosen reads as every day, and seven look the same. */
export function daysSaid(weekdays: readonly number[]): string {
  if (weekdays.length === 0 || weekdays.length === 7) return "Every day";
  return `${weekdays.length} ${weekdays.length === 1 ? "day" : "days"} a week`;
}
