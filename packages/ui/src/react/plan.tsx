import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { motion, type Transition, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import type { Conversation, PlanEntry, PlanItem } from "../model/index.ts";
import { useI18n } from "./i18n.tsx";
import { ChevronRightIcon } from "./icons.tsx";
import { useAppStore } from "./store-context.tsx";

// The list's look and its ticking are ported from Rare UI's Task list (https://www.rareui.com/components/tasklist,
// Copyright (c) 2026 Swami Malode, MIT + Commons Clause + Attribution): a dashed ring for what is to do, a filled
// circle drawing its tick for what is done, the done label struck through and moved below what is still open. Cycle's
// plan is the agent's, so the rows are not buttons; the ticking runs when the agent marks an entry done. Its pop and
// flick are left out, and its timings held to Cycle's (motion.md).

const EASE = [0.2, 0.8, 0.2, 1] as const;
const FILL: Transition = { duration: 0.16, ease: EASE };
const TICK: Transition = { duration: 0.16, ease: EASE, delay: 0.06 };
const STRIKE: Transition = { duration: 0.2, ease: EASE };
const REORDER: Transition = { duration: 0.2, ease: EASE };
const INSTANT: Transition = { duration: 0 };

// Thirteen dashes divide the circumference, so the ring closes without a seam.
const RING_R = 11;
const RING_DASH = `1 ${(2 * Math.PI * RING_R) / 13 - 1}`;

function PlanMark({ status }: { status: PlanEntry["status"] }) {
  const reduced = useReducedMotion() ?? false;
  const timing = (transition: Transition) => (reduced ? INSTANT : transition);
  const done = status === "completed";
  return (
    <svg
      viewBox="0 0 24 24"
      preserveAspectRatio="xMidYMid meet"
      data-slot="plan-mark"
      data-status={status}
      aria-hidden="true"
    >
      <motion.circle
        data-slot="plan-ring"
        cx="12"
        cy="12"
        r={RING_R}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={RING_DASH}
        initial={false}
        animate={{ opacity: done ? 0 : 1 }}
        transition={timing(FILL)}
      />
      <motion.circle
        cx="12"
        cy="12"
        r="12"
        fill="var(--cycle-accent)"
        style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}
        initial={false}
        animate={{ scale: done ? 1 : 0 }}
        transition={timing(FILL)}
      />
      <motion.path
        d="M7.4 12.4 10.6 15.5 16.6 8.9"
        fill="none"
        stroke="var(--cycle-accent-foreground)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={false}
        animate={{ pathLength: done ? 1 : 0, opacity: done ? 1 : 0 }}
        transition={timing(TICK)}
      />
    </svg>
  );
}

/** How long a row the agent has just marked done stays where it is: its tick (60ms + 160ms) and strike are drawn. */
const SETTLE_MS = 240;

/**
 * The plan's entries: what is still open first, in the plan's order, then what is done. An entry the agent marks done
 * while the list is shown ticks and is struck through where it stands, and only then moves down, so the change is seen
 * before the row goes. One that comes done (in a new plan, or when the list opens) is below at once.
 */
export function PlanList({ entries }: { entries: readonly PlanEntry[] }) {
  const { t } = useI18n();
  const reduced = useReducedMotion() ?? false;
  // An entry's key is its text, and which time that text is in the plan: the row is followed when it moves.
  const seen = new Map<string, number>();
  const keyed = entries.map((entry) => {
    const n = seen.get(entry.content) ?? 0;
    seen.set(entry.content, n + 1);
    return { entry, key: `${n}:${entry.content}` };
  });
  // What each row was at the last render, to see which have just been marked done (set while rendering, as React
  // allows, so the row is never drawn below for a frame before it is held).
  const now = keyed.map(({ entry, key }) => `${key}\u0000${entry.status}`).join("\u0001");
  const [last, setLast] = useState<{ sig: string; status: ReadonlyMap<string, string> }>(() => ({
    sig: now,
    status: new Map(keyed.map(({ entry, key }) => [key, entry.status])),
  }));
  // Rows just marked done, held in place until their tick and strike are drawn.
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set());
  if (last.sig !== now) {
    const justDone = keyed
      .filter(({ entry, key }) => {
        const before = last.status.get(key);
        return entry.status === "completed" && before !== undefined && before !== "completed";
      })
      .map(({ key }) => key);
    setLast({ sig: now, status: new Map(keyed.map(({ entry, key }) => [key, entry.status])) });
    if (justDone.length > 0 && !reduced) setHeld((h) => new Set([...h, ...justDone]));
  }
  useEffect(() => {
    if (held.size === 0) return;
    const timer = setTimeout(() => setHeld(new Set()), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [held]);
  const isDown = ({ entry, key }: (typeof keyed)[number]) =>
    entry.status === "completed" && !held.has(key);
  const ordered = [...keyed.filter((row) => !isDown(row)), ...keyed.filter(isDown)];
  return (
    <ol data-slot="plan" aria-label={t("plan.label")}>
      {ordered.map(({ entry, key }) => {
        const done = entry.status === "completed";
        return (
          <motion.li
            key={key}
            layout="position"
            transition={reduced ? INSTANT : REORDER}
            data-status={entry.status}
          >
            <PlanMark status={entry.status} />
            <span data-slot="plan-text">
              <motion.span
                data-slot="plan-label"
                initial={false}
                animate={{ backgroundSize: `${done ? 100 : 0}% 1px` }}
                transition={reduced ? INSTANT : STRIKE}
              >
                {entry.content}
              </motion.span>
            </span>
            <span data-slot="visually-hidden">{entry.status.replace("_", " ")}</span>
          </motion.li>
        );
      })}
    </ol>
  );
}

const doneOf = (entries: readonly PlanEntry[]) =>
  entries.filter((entry) => entry.status === "completed").length;

/**
 * Where the plan was first made, in the conversation: one line, "Plan · 2 of 5 done", that opens to the list. The plan
 * is one for the session and changes in place, so the line always says how it stands now; the strip above the input
 * box is where it is followed.
 */
export function PlanBlock({ item }: { item: PlanItem }) {
  const { t } = useI18n();
  const done = doneOf(item.entries);
  return (
    <Collapsible data-kind="plan" data-item-id={item.id}>
      <CollapsibleTrigger>
        {/* Laid out as a tool's line, text only, so the eye runs down one edge. */}
        <span data-slot="tool-verb">{t("plan.label")}</span>{" "}
        <span data-slot="tool-facts">
          {t("plan.progress", { done, count: item.entries.length })}
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <PlanList entries={item.entries} />
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** The session's plan while some of it is still to do: the newest plan item, if any of its entries is not done. */
export const currentPlan = (conversation: Conversation): PlanItem | undefined => {
  const plan = conversation.items.findLast((item): item is PlanItem => item.kind === "plan");
  return plan?.entries.some((entry) => entry.status !== "completed") ? plan : undefined;
};

/**
 * The plan above the input box, while there is some of it to do: how far along it is and what is being done now, one
 * line that opens to the list. It goes when everything in it is done.
 */
export function PlanStrip({ plan }: { plan: PlanItem }) {
  const { t } = useI18n();
  const store = useAppStore();
  const done = doneOf(plan.entries);
  const now =
    plan.entries.find((entry) => entry.status === "in_progress") ??
    plan.entries.find((entry) => entry.status !== "completed");
  return (
    <Collapsible
      data-kind="plan-strip"
      onOpenChange={(open) => {
        if (open) store.track("plan_opened", {});
      }}
    >
      <CollapsibleTrigger>
        <span data-slot="plan-count">{t("plan.count", { done, count: plan.entries.length })}</span>{" "}
        <span data-slot="plan-now">{now?.content ?? ""}</span>{" "}
        <ChevronRightIcon size={12} data-slot="tool-chevron" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <PlanList entries={plan.entries} />
      </CollapsiblePanel>
    </Collapsible>
  );
}
