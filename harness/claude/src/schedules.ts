// What is set to wake a session later: the crons Claude Code holds in the process's memory (CronCreate, ScheduleWakeup,
// /loop), as its Stop hook tells them at the end of every turn (`session_crons`). They live only as long as the process:
// one let go before they fire never fires them, and a resumed process does not fire the ones it missed (measured on SDK
// 0.3.327, CYCL-119). So a process is kept while one of them is due soon (CYCL-145).

/** A cron the Stop hook says is set, as far as this adapter needs it: when it fires. */
export type SessionCron = { schedule: string; recurring: boolean };

/**
 * How soon a cron must be due for its process to be kept: an hour, the longest a ScheduleWakeup can wait, so every
 * wakeup and every /loop is kept; one further off is left to the resume that the next prompt makes.
 */
export const KEEP_FOR_MS = 60 * 60_000;

/**
 * How much later than its minute a recurring job may fire: Claude Code spreads them by an offset of its own, up to half
 * the job's period and at most 30 minutes (CLI 2.1.327). One-shots fire on the minute, or up to 90 seconds early.
 */
export const RECURRING_LATE_MS = 30 * 60_000;

/**
 * How long after its minute any of them still counts: a fire starts a turn, and until that turn says its first word the
 * session looks idle. Measured: a wakeup fired at :00 and its process, let go a second later for being past its minute,
 * never answered it.
 */
export const FIRING_MS = 2 * 60_000;

/** The crons of a Stop hook's input, or undefined when it does not say (a CLI that predates the field). */
export const cronsOf = (input: unknown): SessionCron[] | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const crons = (input as { session_crons?: unknown }).session_crons;
  if (!Array.isArray(crons)) return undefined;
  const out: SessionCron[] = [];
  for (const c of crons) {
    if (typeof c !== "object" || c === null) continue;
    const { schedule, recurring } = c as Record<string, unknown>;
    if (typeof schedule !== "string") continue;
    out.push({ schedule, recurring: recurring === true });
  }
  return out;
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** The values one field of a cron expression allows, or undefined when it cannot be read. */
const field = (
  text: string,
  min: number,
  max: number,
  names?: readonly string[],
): Set<number> | undefined => {
  const value = (s: string): number | undefined => {
    const named = names?.indexOf(s.toLowerCase()) ?? -1;
    if (named >= 0) return named + min;
    return /^\d+$/.test(s) ? Number(s) : undefined;
  };
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const [range, stepText, extra] = part.split("/");
    if (range === undefined || extra !== undefined) return undefined;
    const step = stepText === undefined ? 1 : /^\d+$/.test(stepText) ? Number(stepText) : 0;
    if (step < 1) return undefined;
    let from: number | undefined;
    let to: number | undefined;
    if (range === "*") {
      from = min;
      to = max;
    } else {
      const [a, b, more] = range.split("-");
      if (a === undefined || more !== undefined) return undefined;
      from = value(a);
      // A single value with a step runs to the end of the field, as cron reads it.
      to = b !== undefined ? value(b) : stepText !== undefined ? max : from;
    }
    if (from === undefined || to === undefined || from < min || to > max || from > to) {
      return undefined;
    }
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
};

type Cron = {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** Both day fields restricted: a day matches when either does, as cron has it. */
  eitherDay: boolean;
};

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

/** A five-field cron expression, read as Claude Code writes them; undefined when it cannot be read. */
export const parseCron = (expression: string): Cron | undefined => {
  const text = expression.trim();
  const parts = (MACROS[text.toLowerCase()] ?? text).split(/\s+/);
  if (parts.length !== 5) return undefined;
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
  const minute = field(m, 0, 59);
  const hour = field(h, 0, 23);
  // "?" is "*" in the day fields, as some crons write it.
  const days = field(dom === "?" ? "*" : dom, 1, 31);
  const month = field(mon, 1, 12, MONTHS);
  const weekdays = field(dow === "?" ? "*" : dow, 0, 7, DAYS);
  if (!minute || !hour || !days || !month || !weekdays) return undefined;
  // 7 is Sunday too.
  if (weekdays.delete(7)) weekdays.add(0);
  return {
    minute,
    hour,
    dom: days,
    month,
    dow: weekdays,
    // As Vixie cron reads it: a day field that begins with "*" (also "*/2") does not restrict.
    eitherDay: !/^[*?]/.test(dom) && !/^[*?]/.test(dow),
  };
};

const matches = (cron: Cron, at: Date): boolean => {
  if (!cron.minute.has(at.getMinutes()) || !cron.hour.has(at.getHours())) return false;
  if (!cron.month.has(at.getMonth() + 1)) return false;
  const dom = cron.dom.has(at.getDate());
  const dow = cron.dow.has(at.getDay());
  return cron.eitherDay ? dom || dow : dom && dow;
};

/**
 * The first minute a cron matches at or after `from`, in this machine's local time (Claude Code's too: the adapter runs
 * beside it), looking no further than `withinMs` ahead. Undefined when none is that near; "unreadable" for an
 * expression this cannot read. The minute the cron names, not when Claude Code fires it (`RECURRING_LATE_MS`).
 */
export const nextFire = (
  expression: string,
  from: number,
  withinMs: number,
): number | "unreadable" | undefined => {
  const cron = parseCron(expression);
  if (cron === undefined) return "unreadable";
  const first = Math.ceil(from / 60_000) * 60_000;
  for (let t = first; t <= from + withinMs; t += 60_000) {
    if (matches(cron, new Date(t))) return t;
  }
  return undefined;
};

/**
 * What a finished call says it set, for the few that set something to fire: a wakeup's time, or a session cron's next
 * run. Undefined for anything else, and for a durable cron, which outlives the process anyway.
 */
export const fireTimeOf = (result: unknown): number | undefined => {
  if (typeof result !== "object" || result === null) return undefined;
  const r = result as Record<string, unknown>;
  // ScheduleWakeup: { scheduledFor, clampedDelaySeconds, stopped? }.
  if (typeof r.scheduledFor === "number" && typeof r.clampedDelaySeconds === "number") {
    return r.stopped === true ? undefined : r.scheduledFor;
  }
  // CronCreate: { id, humanSchedule, nextFireAt, durable? }. Not CronList, whose jobs are in a list.
  if (typeof r.id === "string" && typeof r.humanSchedule === "string") {
    return typeof r.nextFireAt === "number" && r.durable !== true ? r.nextFireAt : undefined;
  }
  return undefined;
};

/**
 * What is set to wake a session, as far as this adapter knows: the Stop hook's last word, which is all of it, and what
 * calls since then set, for a turn that ends without the hook (stopped, or failed).
 */
export class Schedules {
  private crons: SessionCron[] = [];
  private toldAt = 0;
  private since: number[] = [];

  /** The Stop hook's list: everything set, so what calls set before it is in it, or has fired, or was deleted. */
  told(crons: SessionCron[], at: number): void {
    this.crons = crons;
    this.toldAt = at;
    this.since = [];
  }

  /** A finished call's result: kept when it set something, until the Stop hook next speaks. */
  called(result: unknown): void {
    const at = fireTimeOf(result);
    if (at !== undefined) this.since.push(at);
  }

  /**
   * Whether anything fires within `withinMs` of `now`, or is firing. A recurring cron counts for `RECURRING_LATE_MS`
   * after its minute too, since Claude Code may fire it that late; anything else for `FIRING_MS`. One that cannot be read counts while what was told is fresh: kept
   * rather than missed, but not for as long as the job lives.
   */
  dueWithin(now: number, withinMs: number = KEEP_FOR_MS): boolean {
    if (this.since.some((at) => at >= now - FIRING_MS && at <= now + withinMs)) return true;
    return this.crons.some((c) => {
      const late = c.recurring ? RECURRING_LATE_MS : FIRING_MS;
      const next = nextFire(c.schedule, now - late, withinMs + late);
      return next === "unreadable" ? now - this.toldAt < withinMs : next !== undefined;
    });
  }
}
