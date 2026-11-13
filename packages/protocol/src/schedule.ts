import type { SessionMode } from "./model.ts";

/**
 * When a schedule runs, on the daemon machine's own clock. `once` runs at
 * `at`. `every` runs at `from` and every `minutes` after it. `daily` runs at
 * `time`, `HH:MM`, on the days of `weekdays` (0 is Sunday), or on every day
 * when that is null. Moments are milliseconds since the epoch.
 */
export type ScheduleTiming =
  | { kind: "once"; at: number }
  | { kind: "every"; minutes: number; from: number }
  | { kind: "daily"; time: string; weekdays: number[] | null };

/**
 * What the owner says about a schedule. Each run starts a new session with
 * `prompt` as its first message, as the composer would.
 */
export interface ScheduleInput {
  /** Absent: a new schedule, which the daemon names. */
  id?: string;
  name: string;
  enabled: boolean;
  prompt: string;
  /** Absolute. */
  cwd: string;
  /** Each run gets a worktree of its own. */
  worktree: boolean;
  /** Null: what new sessions start with when the run starts. */
  model: string | null;
  effort: string | null;
  mode: SessionMode | null;
  timing: ScheduleTiming;
}

/** One time a schedule ran, or tried to. */
export interface ScheduleRun {
  /** The occurrence it ran for. For a run the owner asked for, when they asked. */
  scheduledFor: number;
  startedAt: number;
  /** The owner asked for it, outside the timing. */
  manual: boolean;
  /** The session it started. */
  sessionId: string | null;
  /** Why it started no session, or stopped after starting one. */
  error: string | null;
}

/**
 * A schedule as the daemon keeps it. An occurrence counts only after `since`.
 * Of the occurrences missed while the daemon was not running or a run was
 * still at work, only the latest runs, and only before the one after it. A
 * `once` has none after it, so it runs late only within `ONCE_GRACE_MS`, and
 * is then disabled.
 */
export interface Schedule extends ScheduleInput {
  id: string;
  /** When it was made, enabled or given its timing. */
  since: number;
  /** Newest first. The first that is not `manual` is the occurrence it last ran for. */
  runs: ScheduleRun[];
  /** Its next occurrence. Null when it is disabled or has none. */
  next: number | null;
}

/** At most this many runs are kept for each schedule, the newest. */
export const SCHEDULE_RUNS_KEPT = 20;
/** How late a `once` schedule may still run. */
export const ONCE_GRACE_MS = 12 * 60 * 60 * 1000;
