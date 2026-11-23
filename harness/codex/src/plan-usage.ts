// A ChatGPT login's usage limits, as Codex reads them (`account/rateLimits/read`) and tells them after each response
// (`account/rateLimits/updated`): told on as Cycle's `_cycle/plan_usage` (docs/protocol.md §8 "套餐用量"). A login
// with an API key has none.
import type { RateLimitSnapshot, RateLimitWindow } from "./wire.generated.ts";

/** The `session/update` variant the daemon takes plan usage in. Same as `PLAN_USAGE_UPDATE` of `@cycle/protocol`. */
export const PLAN_USAGE_UPDATE = "_cycle/plan_usage";

export type PlanWindow = {
  kind: string;
  /** The share used, from 0. */
  utilization: number;
  /** In milliseconds since the epoch. */
  resetsAt: number;
  status?: "allowed" | "rejected";
};

/** Codex names a window by its length; Cycle by what it is. The lengths are the plan's (seen on a Pro account). */
const KINDS: Record<number, string> = { 300: "five_hour", 10080: "seven_day" };

const windowOf = (window: RateLimitWindow | null): PlanWindow[] => {
  if (!window || window.windowDurationMins === null || window.resetsAt === null) return [];
  const kind = KINDS[window.windowDurationMins] ?? `window_${window.windowDurationMins}m`;
  const used = window.usedPercent;
  if (!Number.isFinite(used) || used < 0 || !Number.isFinite(window.resetsAt)) return [];
  return [
    {
      kind,
      utilization: used / 100,
      // Codex gives seconds.
      resetsAt: Math.round(window.resetsAt * 1000),
      status: used >= 100 ? "rejected" : "allowed",
    },
  ];
};

/**
 * The windows of the account's own limit: the snapshot whose `limitId` is `codex` (or that names none). Other limits
 * (a model's own allowance) would reuse the same kinds, and are left out.
 */
export const planWindowsOf = (snapshot: RateLimitSnapshot | null | undefined): PlanWindow[] => {
  if (!snapshot || (snapshot.limitId !== null && snapshot.limitId !== "codex")) return [];
  return [...windowOf(snapshot.primary), ...windowOf(snapshot.secondary)];
};
