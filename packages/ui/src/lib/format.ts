export function basename(path: string): string {
  return path.split("/").findLast(Boolean) ?? path;
}

export function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

/** A path with the owner's home folder written as `~`. */
export function tildePath(path: string, home: string | undefined): string {
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

/** A long path cut from the front, where it says least. */
export function tailPath(path: string, max = 38): string {
  if (path.length <= max) return path;
  const cut = path.slice(path.length - max + 1);
  const slash = cut.indexOf("/");
  return `…${slash > 0 ? cut.slice(slash) : cut}`;
}

export function compactNumber(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 2 : 1)}M`;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const DAY = 86_400_000;

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Which heading of the list a time falls under. */
export function dayBucket(
  time: number,
  now: number,
): "Today" | "Yesterday" | "This week" | "Earlier" {
  const today = startOfDay(now);
  if (time >= today) return "Today";
  if (time >= today - DAY) return "Yesterday";
  if (time >= today - 6 * DAY) return "This week";
  return "Earlier";
}

export function shortTime(time: number, now: number): string {
  const date = new Date(time);
  if (time >= startOfDay(now)) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  if (now - time < 7 * DAY) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Whether every character of `query` appears in `text`, in order, ignoring case. */
export function fuzzyScore(text: string, query: string): number {
  if (!query) return 1;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const direct = haystack.indexOf(needle);
  if (direct !== -1) return 1000 - direct;
  let position = 0;
  let score = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, position);
    if (found === -1) return 0;
    score += found === position ? 3 : 1;
    position = found + 1;
  }
  return score;
}
