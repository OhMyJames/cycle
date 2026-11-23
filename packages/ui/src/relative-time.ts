// How long ago something was, in the few characters a row of the sidebar has for it. No React and no DOM.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Past this many days the date says more than a count of them. */
const DAYS = 7;

/** `narrow` for a row's few characters ("5m": a column of them, so no "ago" on each), `long` where there is room ("5 minutes ago"). */
export type TimeStyle = "narrow" | "long";

const formats = new Map<string, Intl.RelativeTimeFormat>();
/** One formatter per language and style, not one per row each minute. */
const relativeFormat = (locale: string, style: TimeStyle): Intl.RelativeTimeFormat => {
  const key = `${locale} ${style}`;
  let format = formats.get(key);
  if (format === undefined) {
    format = new Intl.RelativeTimeFormat(locale, { style, numeric: "auto" });
    formats.set(key, format);
  }
  return format;
};

const units = new Map<string, Intl.NumberFormat>();
/** A count in its narrowest unit, "5m" or "5分钟": how long since, without "ago", which every row would repeat. */
const narrowUnit = (locale: string, unit: "minute" | "hour" | "day"): Intl.NumberFormat => {
  const key = `${locale} ${unit}`;
  let format = units.get(key);
  if (format === undefined) {
    format = new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "narrow" });
    units.set(key, format);
  }
  return format;
};

/** Whole local days from `then` to `now`: 1 for any time yesterday, whatever the hour. */
const daysBetween = (then: Date, now: Date): number => {
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((start(now) - start(then)) / (24 * HOUR));
};

/**
 * `at` (epoch milliseconds) as a short time relative to `now`, in `locale`. Narrow: "now", "5m", "3h" (up to a day),
 * "1d" (any time yesterday), "4d", then the date ("Mar 4", with the year when it is not this one); zh-CN: 现在, 5分钟,
 * 3小时, 1天, 4天, 3月4日. Long says it as a phrase: "5 minutes ago", "yesterday", "4 days ago".
 * A time ahead of `now` (another machine's clock) is "now".
 */
export const relativeTime = (
  at: number,
  now: number,
  locale: string,
  style: TimeStyle = "narrow",
): string => {
  const ago = Math.max(0, now - at);
  const relative = relativeFormat(locale, style);
  if (ago < MINUTE) return relative.format(0, "second");
  const count = (n: number, unit: "minute" | "hour" | "day"): string =>
    style === "narrow" ? narrowUnit(locale, unit).format(n) : relative.format(-n, unit);
  if (ago < HOUR) return count(Math.floor(ago / MINUTE), "minute");
  const then = new Date(at);
  const today = new Date(now);
  if (ago < 24 * HOUR) return count(Math.floor(ago / HOUR), "hour");
  const days = daysBetween(then, today);
  if (days < DAYS) return count(Math.max(1, days), "day");
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(then.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  }).format(then);
};

/** The whole local date and time, for where there is room to say it: "Mar 4, 2026, 3:03 PM". */
export const fullTime = (at: number, locale: string): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at);
