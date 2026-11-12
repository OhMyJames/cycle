import type { DayUsage, TokenCount } from "@cycle/protocol";
import type { JsonStore } from "./store.ts";

export interface UsageFile {
  days: Record<string, { tokens: TokenCount; turns: number }>;
}

const KEEP_DAYS = 60;

export const ZERO_TOKENS: TokenCount = {
  total: 0,
  input: 0,
  cachedInput: 0,
  output: 0,
  reasoning: 0,
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function localDate(now: number): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** What `to` adds to `from`. A total that went down started over, so all of it counts. */
export function tokenDelta(from: TokenCount | null, to: TokenCount): TokenCount {
  if (!from || to.total < from.total) return to;
  return {
    total: to.total - from.total,
    input: to.input - from.input,
    cachedInput: to.cachedInput - from.cachedInput,
    output: to.output - from.output,
    reasoning: to.reasoning - from.reasoning,
  };
}

/** Tokens used per local day, across every session. It holds numbers only. */
export class UsageLedger {
  private readonly store: JsonStore<UsageFile>;
  private readonly now: () => number;

  constructor(store: JsonStore<UsageFile>, now: () => number) {
    this.store = store;
    this.now = now;
  }

  add(tokens: TokenCount, turns: number): DayUsage {
    const date = localDate(this.now());
    this.store.update((file) => {
      const day = (file.days[date] ??= { tokens: { ...ZERO_TOKENS }, turns: 0 });
      day.tokens.total += tokens.total;
      day.tokens.input += tokens.input;
      day.tokens.cachedInput += tokens.cachedInput;
      day.tokens.output += tokens.output;
      day.tokens.reasoning += tokens.reasoning;
      day.turns += turns;
      const dates = Object.keys(file.days).toSorted();
      for (const old of dates.slice(0, Math.max(0, dates.length - KEEP_DAYS)))
        delete file.days[old];
    });
    return this.today();
  }

  today(): DayUsage {
    const date = localDate(this.now());
    const day = this.store.value.days[date];
    return { date, tokens: day?.tokens ?? { ...ZERO_TOKENS }, turns: day?.turns ?? 0 };
  }

  days(): DayUsage[] {
    return Object.entries(this.store.value.days)
      .map(([date, day]) => ({ date, tokens: day.tokens, turns: day.turns }))
      .toSorted((a, b) => a.date.localeCompare(b.date));
  }
}
