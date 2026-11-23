// What is set to wake a session later: the crons Claude Code holds in the process's memory (CronCreate, ScheduleWakeup,
// /loop), as its Stop hook tells them at the end of every turn (`session_crons`). They live only as long as the process:
// one let go before they fire never fires them, and a resumed process does not fire the ones it missed (measured on SDK
// 0.3.327, CYCL-119). So a process is kept while one of them is due soon (CYCL-145), and clients are told the list
// (`_cycle/schedule_update`, docs/protocol.md §9, CYCL-146).

/** The `sessionUpdate` of the list: `@cycle/protocol`'s `SCHEDULE_UPDATE`; the adapter stays self-contained. */
export const SCHEDULE_UPDATE = "_cycle/schedule_update";

/** A cron the Stop hook says is set. Its prompt is cut at 1000 characters by Claude Code. */
export type SessionCron = { id: string; schedule: string; recurring: boolean; prompt: string };

/** One thing set to wake the session, as clients are told it (`ScheduledJobSchema` of `@cycle/protocol`). */
export type ScheduledJob = {
  id: string;
  kind: "cron" | "wakeup";
  schedule: string;
  humanSchedule?: string;
  recurring: boolean;
  durable: boolean;
  prompt: string;
  nextFireAt?: number;
  toolCallId?: string;
};

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
  for (const [at, c] of crons.entries()) {
    if (typeof c !== "object" || c === null) continue;
    const { id, schedule, recurring, prompt } = c as Record<string, unknown>;
    if (typeof schedule !== "string") continue;
    // Without an id it still fires, and still keeps its process: it goes by its place in the list.
    out.push({
      id: typeof id === "string" ? id : `cron:${at}`,
      schedule,
      recurring: recurring === true,
      prompt: typeof prompt === "string" ? prompt : "",
    });
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

/** The calls that set or unset what wakes a session. */
const SCHEDULE_TOOLS = new Set(["CronCreate", "CronDelete", "CronList", "ScheduleWakeup"]);

/** How much of a prompt clients are told: the start of it is what tells one job from another. */
const PROMPT_CHARS = 300;
const clipped = (text: string): string => {
  const t = text.trim();
  return t.length > PROMPT_CHARS ? `${t.slice(0, PROMPT_CHARS)}…` : t;
};
/** Whether two prompts are the same one, one of them perhaps cut short. */
const samePrompt = (a: string, b: string): boolean => {
  const n = Math.min(a.trim().length, b.trim().length, 200);
  return n > 0 && a.trim().slice(0, n) === b.trim().slice(0, n);
};
/** How far ahead a next run is worked out: past a week, it is only said in its schedule. */
const AHEAD_MS = 8 * 24 * 60 * 60_000;

const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** A wakeup's time as the one-shot cron Claude Code makes of it: its minute, hour, day and month. */
const pinned = (at: number): string => {
  const d = new Date(at);
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
};

/** Whether a one-shot cron is set for the minute and hour of `at`, as Claude Code writes a wakeup. */
const sameMinute = (schedule: string, at: number): boolean => {
  const [m, h] = schedule.trim().split(/\s+/);
  const d = new Date(at);
  return Number(m) === d.getMinutes() && Number(h) === d.getHours();
};

/**
 * What is set to wake a session, as far as this adapter knows. The Stop hook's last word is all of what the process
 * holds; what calls said since is added to it, for a turn that ends without the hook (stopped, or failed), and names
 * what the hook lists (which call set it, in what words, when it is next). Durable crons are not in the hook's list:
 * they are what CronCreate and CronList last said of them.
 */
export class Schedules {
  private crons: SessionCron[] = [];
  private toldAt = 0;
  private since: number[] = [];
  /** The process's own, as last known. */
  private session: ScheduledJob[] = [];
  /** The ones saved in the project, as last heard. */
  private durable = new Map<string, ScheduledJob>();
  /** The calls not yet answered: what each was asked, to read its result by. */
  private calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  /** What CronCreate said of the crons it made, by their id. */
  private made = new Map<string, ScheduledJob>();
  /** The wakeups asked for, to tell the hook's crons that are wakeups. */
  private wakeups: { prompt: string; toolCallId: string; at: number }[] = [];
  /** True while the process is gone: what is not durable fires only if the session is used before it is due. */
  private dormant = false;
  private toldKey: string | undefined;

  /** A call the model made: kept when it is one of the four, to read its result by. */
  asked(toolCallId: string, name: string, input: unknown): void {
    if (!SCHEDULE_TOOLS.has(name)) return;
    const args = typeof input === "object" && input !== null ? input : {};
    this.calls.set(toolCallId, { name, input: args as Record<string, unknown> });
  }

  /** The Stop hook's list: everything set, so what calls set before it is in it, or has fired, or was deleted. */
  told(crons: SessionCron[], at: number): void {
    this.crons = crons;
    this.toldAt = at;
    this.since = [];
    const claimed = new Set<string>();
    this.session = crons.map((c) => this.named(c, claimed));
    // What the list no longer has is gone: nothing more to name it by.
    const ids = new Set(crons.map((c) => c.id));
    for (const id of this.made.keys())
      if (!ids.has(id) && !this.durable.has(id)) this.made.delete(id);
    this.wakeups = this.wakeups.filter((w) => claimed.has(w.toolCallId));
  }

  /**
   * A cron of the hook's, with what the call that set it said. A wakeup is the call that asked for its minute and its
   * words, each call naming one; `claimed` keeps the calls already named.
   */
  private named(
    c: { id: string; schedule: string; recurring: boolean; prompt: string },
    claimed: Set<string>,
  ): ScheduledJob {
    const base = {
      id: c.id,
      schedule: c.schedule,
      recurring: c.recurring,
      durable: false,
      prompt: clipped(c.prompt),
    };
    const made = this.made.get(c.id);
    if (made !== undefined) return { ...made, ...base };
    const free = (w: { toolCallId: string; prompt: string }) =>
      !claimed.has(w.toolCallId) && samePrompt(w.prompt, c.prompt);
    const wakeup = c.recurring
      ? undefined
      : (this.wakeups.findLast((w) => free(w) && sameMinute(c.schedule, w.at)) ??
        this.wakeups.findLast(free));
    if (wakeup === undefined) return { ...base, kind: "cron" };
    claimed.add(wakeup.toolCallId);
    return { ...base, kind: "wakeup", nextFireAt: wakeup.at, toolCallId: wakeup.toolCallId };
  }

  /**
   * A finished call's result: what it set or unset, kept until the Stop hook next speaks. True when it was one of the
   * four, whose result may change the list.
   */
  called(toolCallId: string | undefined, result: unknown): boolean {
    const at = fireTimeOf(result);
    if (at !== undefined) this.since.push(at);
    const call = toolCallId !== undefined ? this.calls.get(toolCallId) : undefined;
    if (toolCallId === undefined || call === undefined) return false;
    this.calls.delete(toolCallId);
    if (typeof result !== "object" || result === null) return true;
    const r = result as Record<string, unknown>;
    const input = call.input;
    if (call.name === "ScheduleWakeup") {
      if (r.stopped === true) {
        this.session = this.session.filter((j) => j.kind !== "wakeup");
        return true;
      }
      if (typeof r.scheduledFor !== "number") return true;
      const prompt = text(input.prompt) ?? "";
      this.wakeups.push({ prompt, toolCallId, at: r.scheduledFor });
      // Its id is the hook's to give: until then it goes by its call's.
      this.session.push({
        id: `wakeup:${toolCallId}`,
        kind: "wakeup",
        schedule: pinned(r.scheduledFor),
        recurring: false,
        durable: false,
        prompt: clipped(prompt),
        nextFireAt: r.scheduledFor,
        toolCallId,
      });
    } else if (call.name === "CronCreate") {
      const id = text(r.id);
      const schedule = text(input.cron);
      if (id === undefined || schedule === undefined) return true;
      const human = text(r.humanSchedule);
      const job: ScheduledJob = {
        id,
        kind: "cron",
        schedule,
        ...(human !== undefined ? { humanSchedule: human } : {}),
        // Claude Code's default is recurring, when neither the result nor the call says.
        recurring: typeof r.recurring === "boolean" ? r.recurring : input.recurring !== false,
        durable: r.durable === true,
        prompt: clipped(text(input.prompt) ?? ""),
        ...(typeof r.nextFireAt === "number" ? { nextFireAt: r.nextFireAt } : {}),
        toolCallId,
      };
      this.made.set(id, job);
      if (job.durable) this.durable.set(id, job);
      else this.session = [...this.session.filter((j) => j.id !== id), job];
    } else if (call.name === "CronDelete") {
      const id = text(r.id) ?? text(input.id);
      if (id === undefined) return true;
      this.session = this.session.filter((j) => j.id !== id);
      this.durable.delete(id);
    } else if (call.name === "CronList" && Array.isArray(r.jobs)) {
      // All of them, the durable ones too: the fullest word there is, while it lasts.
      const jobs: ScheduledJob[] = [];
      const claimed = new Set<string>();
      for (const raw of r.jobs) {
        if (typeof raw !== "object" || raw === null) continue;
        const j = raw as Record<string, unknown>;
        const id = text(j.id);
        const schedule = text(j.cron);
        if (id === undefined || schedule === undefined) continue;
        const human = text(j.humanSchedule);
        const recurring = j.recurring === true;
        const prompt = text(j.prompt) ?? "";
        jobs.push({
          ...this.named({ id, schedule, recurring, prompt }, claimed),
          ...(human !== undefined ? { humanSchedule: human } : {}),
          durable: j.durable === true,
          ...(typeof j.nextFireAt === "number" ? { nextFireAt: j.nextFireAt } : {}),
        });
      }
      this.session = jobs.filter((j) => !j.durable);
      this.durable = new Map(jobs.filter((j) => j.durable).map((j) => [j.id, j]));
    }
    return true;
  }

  /**
   * The process went (true) or another took its place (false). True when that is news. A call it never answered is
   * not answered now. Waking, the one-shots whose time went by while it slept are gone: Claude Code does not fire them
   * late, and does not set them again.
   */
  sleeping(dormant: boolean, now: number = Date.now()): boolean {
    const was = this.dormant;
    this.dormant = dormant;
    if (dormant) this.calls.clear();
    else if (was)
      this.session = this.session.filter(
        (j) => j.recurring || j.nextFireAt === undefined || j.nextFireAt >= now - FIRING_MS,
      );
    return was !== dormant;
  }

  /** What is set, with when each is next as far as it can be worked out: a time a call gave, or its cron's next minute. */
  list(now: number): ScheduledJob[] {
    return [...this.session, ...this.durable.values()].map((job) => {
      const { nextFireAt: told, ...rest } = job;
      // A one-shot's time, once gone, is not next year's: it fired, or it will not.
      const fresh = told !== undefined && told >= now - FIRING_MS;
      const next = fresh
        ? told
        : told !== undefined && !job.recurring
          ? undefined
          : nextFire(job.schedule, now, AHEAD_MS);
      return typeof next === "number" ? { ...rest, nextFireAt: next } : rest;
    });
  }

  /**
   * The update to tell clients, when the list is not what they were last told; undefined when it is. The first one is
   * told even when empty: it says this agent tells its list, which is not the same as not knowing.
   */
  update(now: number): Record<string, unknown> | undefined {
    const jobs = this.list(now);
    const dormant = this.dormant && jobs.some((j) => !j.durable);
    const update = {
      sessionUpdate: SCHEDULE_UPDATE,
      jobs,
      ...(dormant ? { dormant: true } : {}),
    };
    const key = JSON.stringify(update);
    if (key === this.toldKey) return undefined;
    this.toldKey = key;
    return update;
  }

  /**
   * Whether anything fires within `withinMs` of `now`, or is firing. A recurring cron counts for `RECURRING_LATE_MS`
   * after its minute too, since Claude Code may fire it that late; anything else for `FIRING_MS`. One that cannot be
   * read counts while what was told is fresh: kept rather than missed, but not for as long as the job lives.
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
