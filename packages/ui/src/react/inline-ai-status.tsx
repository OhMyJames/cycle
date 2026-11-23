// Inline AI status indicator for the turn that is going (thinking, working, replying, awaiting approval).
// Visual layout inspired by Rare UI's Inline AI Status (https://www.rareui.com/components/aistatus); the mark is the
// brand's MorphLoader (./loader, CYCL-215), and the rules (one loader, held words, a fixed line) are Cycle v2's StatusBar.
import type { Translator } from "../i18n.ts";
import { useI18n } from "./i18n.tsx";
import { type LoaderState, MorphLoader } from "./loader/index.ts";
import { useNowSeconds } from "./now.ts";

export type InlineAiStatusKind = "thinking" | "working" | "replying" | "approval";

export type InlineAiStatusProps = {
  kind: InlineAiStatusKind;
  /** Localized status text. */
  label: string;
  /** When the turn started (epoch ms, `startedAt`): the elapsed counter counts from it. */
  since: number;
  /**
   * A call is at work and its own row says so, with its time: the line keeps its height and says nothing to the eye, so
   * there is one loader and one clock in the conversation. A screen reader still hears the label.
   */
  quiet?: boolean;
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

/** Which of the loader's animations each kind of step is. Waiting for the person is the slow swim, in its own colour. */
const LOOK: Record<InlineAiStatusKind, LoaderState> = {
  thinking: "thinking",
  working: "thinking",
  replying: "responding",
  approval: "waiting",
};

/**
 * One line, always 28px high, whatever it shows (app.css): what comes into it fades in, the mark and the words on one
 * beat (`--cycle-motion-enter`), and what leaves it goes at once, so nothing below or above it moves. The mark is the
 * MorphLoader, which morphs from one state to the next rather than being swapped.
 */
export function InlineAiStatus({ kind, label, since, quiet = false }: InlineAiStatusProps) {
  return (
    <div data-slot="step" data-step={kind} data-quiet={quiet || undefined}>
      {/* The time sits outside the live region so 1s ticks never spam screen readers. */}
      <div role="status" aria-live="polite" data-slot="step-live">
        {/* Kept while quiet, out of the layout (app.css): it asks for no frames then, and morphs on from where it was
            when the line speaks again, rather than starting afresh. */}
        <span data-slot="step-icon">
          <MorphLoader state={LOOK[kind]} />
        </span>
        {quiet ? (
          <span data-slot="visually-hidden">{label}</span>
        ) : (
          // Drawn anew with each new label, so it comes in on the same beat as the mark does.
          <span key={label} data-slot="step-label">
            {label}
          </span>
        )}
      </div>
      {!quiet && kind !== "approval" ? <Elapsed since={since} /> : null}
    </div>
  );
}
