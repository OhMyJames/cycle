// Inline AI status indicator for active agent steps (thinking, working, running tools, awaiting approval).
// Visual layout inspired by Rare UI's Inline AI Status (https://www.rareui.com/components/aistatus);
// clean-room Cycle implementation using Cycle v2 tokens, iconmcp icons, and compositor-only reduced-motion discipline.
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import type { Translator } from "../i18n.ts";
import { useI18n } from "./i18n.tsx";
import { SearchIcon, ThoughtIcon, WarningIcon } from "./icons.tsx";
import { useNowSeconds } from "./now.ts";

export type InlineAiStatusKind = "thinking" | "working" | "approval" | "tool";

export type InlineAiStatusProps = {
  kind: InlineAiStatusKind;
  /** Optional tool activity ("search", "read", "run", ...) for icon selection. */
  activity?: string | undefined;
  /** Localized status text. */
  label: string;
  /** When the current step started (epoch ms, `startedAt`): the elapsed counter counts from it. */
  since: number;
  /** Optional live tool detail rendered beside the status label. */
  detail?: ReactNode;
  className?: string;
};

/** Compact localized elapsed time ("4s", "1m 12s"); hidden during the first second so fast steps stay quiet. */
export const formatElapsed = (seconds: number, t: Translator["t"]): string => {
  const safe = Math.max(0, Math.floor(seconds));
  if (safe < 60) return t("step.elapsedSeconds", { seconds: safe });
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  return remainder === 0
    ? t("step.elapsedMinutes", { minutes })
    : t("step.elapsedMinutesSeconds", { minutes, seconds: remainder });
};

const secondsSince = (since: number): number =>
  Math.max(0, Math.floor((Date.now() - since) / 1000));

/**
 * How long something has been at work, from `since` (epoch ms, `startedAt`): so a line drawn again goes on counting.
 * Nothing for the first second, so quick steps stay quiet. Not for a screen reader: it would hear every tick.
 */
export function Elapsed({ since, slot = "step-elapsed" }: { since: number; slot?: string }) {
  const { t } = useI18n();
  // Worked out as it is drawn, from the clock every count shares: a new `since` is never shown with the old count.
  const now = Math.max(useNowSeconds(), Date.now());
  const elapsed = Math.max(0, Math.floor((now - since) / 1000));
  if (elapsed < 1) return null;
  return (
    <span data-slot={slot} aria-hidden="true">
      {formatElapsed(elapsed, t)}
    </span>
  );
}

function StatusGlyph({
  kind,
  activity,
  reduced,
}: {
  kind: InlineAiStatusKind;
  activity: string | undefined;
  reduced: boolean;
}) {
  if (kind === "approval") return <WarningIcon size={14} />;
  if (kind === "thinking") {
    return <ThoughtIcon size={14} data-slot={reduced ? undefined : "step-pulse"} />;
  }
  if (kind === "tool" && activity === "search") {
    return <SearchIcon size={14} data-slot={reduced ? undefined : "step-pulse"} />;
  }
  return <span data-slot="spinner" aria-hidden="true" />;
}

export function InlineAiStatus({
  kind,
  activity,
  label,
  since,
  detail,
  className,
}: InlineAiStatusProps) {
  const reduced = Boolean(useReducedMotion());
  const trackTime = kind !== "approval";
  const glyphKey = kind === "tool" ? `tool:${activity ?? "other"}` : kind;
  const livePulse = kind !== "approval" && !reduced;

  return (
    <div data-slot="step" data-step={kind} className={className}>
      {/* ElapsedTimer sits outside the live region so 1s ticks never spam screen readers. */}
      <div role="status" aria-live="polite" data-slot="step-live">
        <span data-slot="step-icon" aria-hidden="true">
          <AnimatePresence initial={false}>
            <motion.span
              key={glyphKey}
              data-slot="step-icon-inner"
              initial={reduced ? false : { opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.85 }}
              transition={{ duration: reduced ? 0 : 0.16, ease: [0.2, 0.8, 0.2, 1] }}
            >
              <StatusGlyph kind={kind} activity={activity} reduced={reduced} />
            </motion.span>
          </AnimatePresence>
        </span>
        <motion.span
          key={label}
          data-slot="step-label"
          data-live={livePulse || undefined}
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: reduced ? 0 : 0.16, ease: [0.2, 0.8, 0.2, 1] }}
        >
          {label}
        </motion.span>
        {detail}
      </div>
      {trackTime ? <Elapsed since={since} /> : null}
    </div>
  );
}
