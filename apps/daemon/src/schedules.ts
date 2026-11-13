import {
  ONCE_GRACE_MS,
  SCHEDULE_RUNS_KEPT,
  type Schedule,
  type ScheduleInput,
  type ScheduleRun,
  type ScheduleTiming,
  type SessionMode,
} from "@cycle/protocol";
import { latestOccurrence, nextOccurrence } from "./schedule-timing.ts";
import type { JsonStore } from "./store.ts";

/** Why a run stopped after its session existed, such as a prompt the agent refused. */
export class LaunchError extends Error {
  readonly sessionId: string | null;

  constructor(reason: string, sessionId: string | null) {
    super(reason);
    this.sessionId = sessionId;
  }
}

/** A schedule as it is stored: without what only the wire carries. */
export type StoredSchedule = Omit<Schedule, "next">;

export interface SchedulesFile {
  schedules: StoredSchedule[];
}

export interface SchedulerOptions {
  file: JsonStore<SchedulesFile>;
  /** Starts a new session for the schedule and gives it the prompt. */
  launch(schedule: StoredSchedule): Promise<{ sessionId: string }>;
  /** Whether a session is at work, in which case its schedule's next run waits for it. */
  isWorking(sessionId: string): boolean;
  now(): number;
  newId(): string;
  /** Called with the list after it changed. */
  onChange(schedules: Schedule[]): void;
}

const MODES: readonly SessionMode[] = ["readOnly", "auto", "fullAccess"];
const MAX_MINUTES = 60 * 24 * 366;

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function checkTiming(timing: ScheduleTiming): ScheduleTiming {
  if (timing?.kind === "once" && isTime(timing.at)) return { kind: "once", at: timing.at };
  if (
    timing?.kind === "every" &&
    isTime(timing.from) &&
    Number.isInteger(timing.minutes) &&
    timing.minutes >= 1 &&
    timing.minutes <= MAX_MINUTES
  ) {
    return { kind: "every", minutes: timing.minutes, from: timing.from };
  }
  if (
    timing?.kind === "daily" &&
    typeof timing.time === "string" &&
    /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(timing.time)
  ) {
    const days = timing.weekdays;
    if (days === null) return { kind: "daily", time: timing.time, weekdays: null };
    if (
      Array.isArray(days) &&
      days.length > 0 &&
      days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    ) {
      return { kind: "daily", time: timing.time, weekdays: [...new Set(days)].toSorted() };
    }
  }
  throw new Error("That is not a timing a schedule can run on.");
}

/**
 * What a client sent, made into what is stored. The wire is not typed at run
 * time, and a schedule runs unattended for as long as it is kept, so nothing
 * is taken on trust.
 */
export function checkScheduleInput(input: ScheduleInput): ScheduleInput {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!name) throw new Error("A schedule needs a name.");
  if (!prompt) throw new Error("A schedule needs a prompt.");
  if (typeof input.cwd !== "string" || !input.cwd.startsWith("/")) {
    throw new Error("The folder must be an absolute path.");
  }
  if (input.mode !== null && !MODES.includes(input.mode)) throw new Error("Unknown mode.");
  return {
    ...(typeof input.id === "string" && input.id ? { id: input.id } : {}),
    name,
    prompt,
    enabled: input.enabled === true,
    cwd: input.cwd,
    worktree: input.worktree === true,
    model: typeof input.model === "string" && input.model ? input.model : null,
    effort: typeof input.effort === "string" && input.effort ? input.effort : null,
    mode: input.mode,
    timing: checkTiming(input.timing),
  };
}

const sameTiming = (a: ScheduleTiming, b: ScheduleTiming): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** The occurrence a schedule last ran for, which its own runs say, manual ones aside. */
const lastOccurrence = (schedule: StoredSchedule): number | null =>
  schedule.runs.find((run) => !run.manual)?.scheduledFor ?? null;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs each schedule's prompt in a new session when it is due. Nothing here
 * waits on a timer: whoever owns it calls `tick`, and each tick compares the
 * clock with what already ran, so a daemon that slept or was stopped catches
 * up by the rule in `Schedule`.
 */
export class Scheduler {
  private readonly options: SchedulerOptions;
  /** Schedules with a session being started. */
  private readonly launching = new Set<string>();

  constructor(options: SchedulerOptions) {
    this.options = options;
  }

  private get schedules(): StoredSchedule[] {
    return this.options.file.value.schedules;
  }

  private changed(): void {
    this.options.onChange(this.list());
  }

  list(): Schedule[] {
    const now = this.options.now();
    return this.schedules.map((schedule) =>
      structuredClone({
        ...schedule,
        next: schedule.enabled ? nextOccurrence(schedule.timing, now) : null,
      }),
    );
  }

  /** Makes a schedule, or changes the one `input.id` names. Throws on what it cannot take. */
  put(raw: ScheduleInput): Schedule {
    const input = checkScheduleInput(raw);
    const now = this.options.now();
    if (input.enabled && input.timing.kind === "once" && input.timing.at <= now) {
      throw new Error("That time has passed.");
    }
    const old = input.id === undefined ? undefined : this.find(input.id);
    if (input.id !== undefined && !old) throw new Error("That schedule no longer exists.");
    // A new timing, or turning it back on, starts counting occurrences from now.
    const restarts =
      !old || !sameTiming(old.timing, input.timing) || (input.enabled && !old.enabled);
    const schedule: StoredSchedule = {
      ...input,
      id: old?.id ?? this.options.newId(),
      since: old && !restarts ? old.since : now,
      runs: old?.runs ?? [],
    };
    this.options.file.update((file) => {
      const index = old ? file.schedules.indexOf(old) : -1;
      if (index === -1) file.schedules.push(schedule);
      else file.schedules[index] = schedule;
    });
    this.changed();
    return { ...structuredClone(schedule), next: this.nextOf(schedule) };
  }

  private nextOf(schedule: StoredSchedule): number | null {
    return schedule.enabled ? nextOccurrence(schedule.timing, this.options.now()) : null;
  }

  remove(id: string): void {
    const schedule = this.find(id);
    if (!schedule) throw new Error("That schedule no longer exists.");
    this.options.file.update((file) => {
      file.schedules = file.schedules.filter((entry) => entry !== schedule);
    });
    this.changed();
  }

  /** Runs a schedule now, outside its timing. Resolves once the run has a session, or failed. */
  run(id: string): Promise<ScheduleRun> {
    const schedule = this.find(id);
    if (!schedule) return Promise.reject(new Error("That schedule no longer exists."));
    if (this.launching.has(id)) return Promise.reject(new Error("It is already starting."));
    const now = this.options.now();
    return this.fire(schedule, {
      scheduledFor: now,
      startedAt: now,
      manual: true,
      sessionId: null,
      error: null,
    });
  }

  /** Starts what is due now. Call it often: it does nothing when nothing is. */
  tick(): void {
    const now = this.options.now();
    let dirty = false;
    for (const schedule of this.schedules) {
      if (!schedule.enabled || this.launching.has(schedule.id)) continue;
      const floor = Math.max(lastOccurrence(schedule) ?? 0, schedule.since);
      const due = latestOccurrence(schedule.timing, floor, now);
      if (due === null) {
        // A `once` that is past without having run, as one made before the clock moved back.
        if (schedule.timing.kind === "once" && nextOccurrence(schedule.timing, now) === null) {
          schedule.enabled = false;
          dirty = true;
        }
        continue;
      }
      if (schedule.timing.kind === "once" && now - due > ONCE_GRACE_MS) {
        schedule.enabled = false;
        this.record(schedule, {
          scheduledFor: due,
          startedAt: now,
          manual: false,
          sessionId: null,
          error: "Missed by more than 12 hours.",
        });
        dirty = true;
        continue;
      }
      // Runs never overlap. The occurrence waits, and runs if the session ends before the next one.
      const latest = schedule.runs.find((run) => run.sessionId !== null);
      if (latest?.sessionId && this.options.isWorking(latest.sessionId)) continue;
      if (schedule.timing.kind === "once") schedule.enabled = false;
      void this.fire(schedule, {
        scheduledFor: due,
        startedAt: now,
        manual: false,
        sessionId: null,
        error: null,
      });
    }
    if (dirty) {
      this.options.file.update(() => {});
      this.changed();
    }
  }

  /**
   * Records the run before starting it, so that a daemon stopped meanwhile
   * does not run it twice, and fills in what it led to.
   */
  private async fire(schedule: StoredSchedule, started: ScheduleRun): Promise<ScheduleRun> {
    this.launching.add(schedule.id);
    const run: ScheduleRun = { ...started };
    this.record(schedule, run);
    this.options.file.update(() => {});
    this.changed();
    try {
      const { sessionId } = await this.options.launch(structuredClone(schedule));
      run.sessionId = sessionId;
    } catch (error) {
      run.error = message(error);
      if (error instanceof LaunchError) run.sessionId = error.sessionId;
    } finally {
      this.launching.delete(schedule.id);
    }
    // An edit meanwhile replaced the object but kept its runs, this one among them.
    if (this.find(schedule.id)) {
      this.options.file.update(() => {});
      this.changed();
    }
    return { ...run };
  }

  /**
   * Keeps the newest runs, and always the newest scheduled one, which says
   * what occurrence ran last: runs asked for by hand must not push it out, or
   * that occurrence would run again.
   */
  private record(schedule: StoredSchedule, run: ScheduleRun): void {
    const runs = [run, ...schedule.runs];
    const kept = runs.slice(0, SCHEDULE_RUNS_KEPT);
    const scheduled = runs.find((entry) => !entry.manual);
    schedule.runs =
      scheduled && !kept.includes(scheduled)
        ? [...kept.slice(0, SCHEDULE_RUNS_KEPT - 1), scheduled]
        : kept;
  }

  private find(id: string): StoredSchedule | undefined {
    return this.schedules.find((schedule) => schedule.id === id);
  }
}
