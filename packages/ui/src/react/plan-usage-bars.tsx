// Reusable subscription plan usage progress bars (docs/protocol.md §8 "套餐用量", CYCL-229).
// Shared between the composer's context popover (`context-details.tsx`) and Settings → Harness (`harness-settings.tsx`).
import type { PlanUsage, PlanWindow } from "../api.ts";
import { useI18n } from "./i18n.tsx";

/** The plan limits Cycle shows, in this order; one it does not know by name is not shown. */
export const PLAN_NAMES = {
  five_hour: "composer.plan.fiveHour",
  seven_day: "composer.plan.weekly",
  seven_day_opus: "composer.plan.weeklyOpus",
  seven_day_sonnet: "composer.plan.weeklySonnet",
} as const;

/**
 * The plan's limits worth showing at `now`: the ones Cycle names, that have not started over since they were told (what
 * they are at after a reset is not known, so they are not shown as they were).
 */
export const planRowsOf = (plan: PlanUsage | undefined, now: number): PlanWindow[] =>
  plan === undefined
    ? []
    : Object.keys(PLAN_NAMES).flatMap((kind) =>
        plan.windows.filter((w) => w.kind === kind && w.resetsAt > now),
      );

export function PlanUsageBars({
  plan,
  showHeading = true,
  now = Date.now(),
}: {
  plan: PlanUsage | undefined;
  /** When true, renders the `composer.plan.title` heading above the bars (used inside ContextDetails). */
  showHeading?: boolean;
  now?: number;
}) {
  const { t, number, date } = useI18n();
  const limits = planRowsOf(plan, now);
  if (limits.length === 0) return null;

  const resetsOf = (at: number) => {
    const minutes = Math.max(1, Math.ceil((at - now) / 60_000));
    if (minutes < 60) return t("composer.plan.resetsInMinutes", { minutes: number(minutes) });
    if (minutes < 24 * 60)
      return t("composer.plan.resetsInHours", {
        hours: number(Math.floor(minutes / 60)),
        minutes: number(minutes % 60),
      });
    return t("composer.plan.resetsOn", {
      when: date(at, { weekday: "short", hour: "numeric", minute: "2-digit" }),
    });
  };

  return (
    <section data-slot="plan-usage" aria-label={t("composer.plan.title")}>
      {showHeading ? (
        <div data-slot="context-head">
          <span>{t("composer.plan.title")}</span>
        </div>
      ) : null}
      {limits.map((w) => {
        const share = Math.max(0, Math.min(1, w.utilization));
        const tone =
          w.status === "rejected" || share >= 0.9
            ? "danger"
            : w.status === "allowed_warning" || share >= 0.7
              ? "attention"
              : undefined;
        return (
          <div key={w.kind} data-slot="plan-limit" data-tone={tone}>
            <div data-slot="plan-limit-row">
              <span data-slot="plan-limit-name">
                {t(PLAN_NAMES[w.kind as keyof typeof PLAN_NAMES])}
              </span>
              <span data-slot="plan-limit-value">
                {t("composer.plan.used", {
                  // Down, not to the nearest: 99.6% is not yet at the limit, and does not read as 100%.
                  percent: number(Math.floor(w.utilization * 100) / 100, { style: "percent" }),
                  resets: resetsOf(w.resetsAt),
                })}
              </span>
            </div>
            <div data-slot="plan-bar" aria-hidden="true">
              <span data-slot="plan-bar-fill" style={{ width: `${share * 100}%` }} />
            </div>
          </div>
        );
      })}
    </section>
  );
}
