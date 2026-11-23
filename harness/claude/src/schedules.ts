// What is set to wake a session later: the crons Claude Code holds in the process's memory (CronCreate, ScheduleWakeup,
// /loop), as its Stop hook tells them at the end of every turn (`session_crons`). They live only as long as the process:
// one let go before they fire never fires them, and a resumed process does not fire the ones it missed (measured on SDK
// 0.3.327, CYCL-119). So a process is kept while one of them is due soon (CYCL-145).

/** A cron the Stop hook says is set, as far as this adapter needs it: its id and when it fires. */
export type SessionCron = { id: string; schedule: string; recurring: boolean };

/**
 * How soon a cron must be due for its process to be kept: an hour, the longest a ScheduleWakeup can wait, so every
 * wakeup and every /loop is kept; one further off is left to the resume that the next prompt makes.
 */
export const KEEP_FOR_MS = 60 * 60_000;

/** The crons of a Stop hook's input, or undefined when it does not say (a CLI that predates the field). */
export const cronsOf = (input: unknown): SessionCron[] | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const crons = (input as { session_crons?: unknown }).session_crons;
  if (!Array.isArray(crons)) return undefined;
  const out: SessionCron[] = [];
  for (const c of crons) {
    if (typeof c !== "object" || c === null) continue;
    const { id, schedule, recurring } = c as Record<string, unknown>;
    if (typeof id !== "string" || typeof schedule !== "string") continue;
    out.push({ id, schedule, recurring: recurring === true });
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

/** A five-field cron expression, read as Claude Code writes them; undefined when it cannot be read. */
export const parseCron = (expression: string): Cron | undefined => {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
  const minute = field(m, 0, 59);
  const hour = field(h, 0, 23);
  const days = field(dom, 1, 31);
  const month = field(mon, 1, 12, MONTHS);
  const weekdays = field(dow, 0, 7, DAYS);
  if (!minute || !hour || !days || !month || !weekdays) return undefined;
  // 7 is Sunday too.
  if (weekdays.delete(7)) weekdays.add(0);
  return {
    minute,
    hour,
    dom: days,
    month,
    dow: weekdays,
    eitherDay: dom !== "*" && dow !== "*",
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
 * When a cron next fires, in this machine's local time (Claude Code's too: the adapter runs beside it), looking no
 * further than `withinMs` ahead: the first matching minute from the one `from` is in. Undefined when none is that
 * near; "unreadable" for an expression this cannot read. Claude Code may add an offset of its own to a recurring job,
 * which only makes it later than this says.
 */
export const nextFire = (
  expression: string,
  from: number,
  withinMs: number,
): number | "unreadable" | undefined => {
  const cron = parseCron(expression);
  if (cron === undefined) return "unreadable";
  const start = new Date(from);
  start.setSeconds(0, 0);
  for (let t = start.getTime(); t <= from + withinMs; t += 60_000) {
    if (matches(cron, new Date(t))) return t;
  }
  return undefined;
};

/** Whether any of these fires within `withinMs` of `now`. One that cannot be read counts: better kept than missed. */
export const dueWithin = (
  crons: readonly SessionCron[] | undefined,
  now: number,
  withinMs: number = KEEP_FOR_MS,
): boolean => (crons ?? []).some((c) => nextFire(c.schedule, now, withinMs) !== undefined);
