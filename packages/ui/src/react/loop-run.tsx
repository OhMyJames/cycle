// One ticket's Loop run workflow (`loop/run/get`, docs/protocol.md §17, CYC-409): pipeline progress, round & elapsed
// time, heartbeat liveness, session jump buttons (Dev/QA/Review/Research), confirmed cancel (`loop/run/cancel`), and
// collapsible recent events. Behaviour-only analytics (`loop_run_viewed`): never text, titles or session ids.
import { Button } from "@ui-sdk/react/button";
import { useEffect, useRef, useState } from "react";
import type { LoopRunDetail } from "../api.ts";
import { ConfirmDialog } from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  MessageIcon,
  StopIcon,
} from "./icons.tsx";
import { useNow } from "./now.ts";
import { useAppStore } from "./store-context.tsx";

/** A heartbeat older than this while a run is active warns the person (matches Loop server `STALE_HEARTBEAT_MS`). */
const HEARTBEAT_STALE_MS = 15 * 60_000;

/** All Loop run phases mapped to their `loop.stage.*` i18n suffix; unknown phases fall back to their raw name. */
export const PHASE_WORD: Record<string, string> = {
  claimed: "claimed",
  graph_plan: "graphPlan",
  dev: "develop",
  verify: "verify",
  qa: "qa",
  delivering: "delivering",
  ci: "ci",
  review: "review",
  research: "research",
  research_qa: "researchQa",
  publishing: "publishing",
  blocked: "blocked",
  done: "done",
};

const KNOWN_SESSION_KINDS = new Set([
  "dev",
  "qa",
  "review",
  "research",
  "research_qa",
  "triage",
  "shape",
  "shape_qa",
]);

type StepDef = { id: string; phases: readonly string[]; labelKey: string };
const DEV_STEPS: readonly StepDef[] = [
  { id: "dev", phases: ["claimed", "graph_plan", "dev"], labelKey: "loop.stage.develop" },
  { id: "verify", phases: ["verify"], labelKey: "loop.stage.verify" },
  { id: "qa", phases: ["qa"], labelKey: "loop.stage.qa" },
  { id: "delivering", phases: ["delivering"], labelKey: "loop.stage.delivering" },
  { id: "ci", phases: ["ci"], labelKey: "loop.stage.ci" },
  { id: "review", phases: ["review"], labelKey: "loop.stage.review" },
  { id: "done", phases: ["done"], labelKey: "loop.stage.done" },
];
const RESEARCH_STEPS: readonly StepDef[] = [
  { id: "research", phases: ["claimed", "research"], labelKey: "loop.stage.research" },
  { id: "research_qa", phases: ["research_qa"], labelKey: "loop.stage.researchQa" },
  { id: "publishing", phases: ["publishing"], labelKey: "loop.stage.publishing" },
  { id: "done", phases: ["done"], labelKey: "loop.stage.done" },
];

type StepState = "done" | "active" | "blocked" | "pending";

/** Infers the step index a run reached from its recorded sessions and PR, falling back to the first step. */
const inferredStepIndex = (run: LoopRunDetail, steps: readonly StepDef[]): number => {
  const kinds = new Set(run.sessions.map((s) => s.kind));
  const target =
    run.kind === "research"
      ? kinds.has("research_qa")
        ? "research_qa"
        : "research"
      : kinds.has("review")
        ? "review"
        : run.prUrl !== null
          ? "ci"
          : kinds.has("qa")
            ? "qa"
            : "dev";
  const idx = steps.findIndex((s) => s.id === target);
  return Math.max(idx, 0);
};

/** Maps each step to done / active / blocked / pending based on the run's current phase and state. */
const stepStatesOf = (run: LoopRunDetail): { id: string; labelKey: string; state: StepState }[] => {
  const steps = run.kind === "research" ? RESEARCH_STEPS : DEV_STEPS;
  if (run.state === "done" || run.phase === "done")
    return steps.map((s) => ({ id: s.id, labelKey: s.labelKey, state: "done" }));
  if (run.state === "blocked" || run.phase === "blocked") {
    const blockedAt = inferredStepIndex(run, steps);
    return steps.map((s, i) => ({
      id: s.id,
      labelKey: s.labelKey,
      state: i < blockedAt ? "done" : i === blockedAt ? "blocked" : "pending",
    }));
  }
  const matched = steps.findIndex((s) => s.phases.includes(run.phase));
  if (matched === -1) {
    // Unknown/future phase: mark steps clearly completed before the inferred progress, without falsely marking step 0 active.
    const reached = inferredStepIndex(run, steps);
    return steps.map((s, i) => ({
      id: s.id,
      labelKey: s.labelKey,
      state: i < reached ? "done" : "pending",
    }));
  }
  return steps.map((s, i) => ({
    id: s.id,
    labelKey: s.labelKey,
    state: i < matched ? "done" : i === matched ? "active" : "pending",
  }));
};

/** Minute-level formatting matching `useNow()` (30 s cadence) so numbers never appear frozen. */
const formatDuration = (
  ms: number,
  t: (key: string, params?: Record<string, string | number>) => string,
): string => {
  const safe = Math.max(0, ms);
  const totalMinutes = Math.floor(safe / 60_000);
  if (totalMinutes < 1) return t("loop.run.underMinute");
  const hours = Math.floor(totalMinutes / 60);
  return hours > 0
    ? t("loop.stage.hoursMinutes", { hours, minutes: totalMinutes % 60 })
    : t("loop.stage.minutes", { minutes: totalMinutes });
};

const formatEventTime = (ts: string): string => {
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return ts;
  const d = new Date(parsed);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export function RunWorkflow({
  projectKey,
  identifier,
  run,
  onChanged,
}: {
  projectKey: string;
  identifier: string;
  run: LoopRunDetail;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const now = useNow();
  const [missingSession, setMissingSession] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelNotice, setCancelNotice] = useState<string | undefined>();
  const [eventsOpen, setEventsOpen] = useState(false);

  // Clear transient status when switching tickets or when the run advances to a new phase/round.
  const prevRunKey = useRef(`${identifier}:${run.round}:${run.phase}`);
  const currentRunKey = `${identifier}:${run.round}:${run.phase}`;
  useEffect(() => {
    if (prevRunKey.current === currentRunKey) return;
    const prevId = prevRunKey.current.split(":")[0];
    prevRunKey.current = currentRunKey;
    setCancelNotice(undefined);
    if (prevId !== identifier) {
      setMissingSession(false);
      setConfirmCancel(false);
      setEventsOpen(false);
    }
  }, [currentRunKey, identifier]);

  const viewed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (viewed.current === identifier) return;
    viewed.current = identifier;
    store.track("loop_run_viewed", {
      kind: run.kind,
      state: run.state,
      sessions: run.sessions.length,
    });
  }, [store, identifier, run.kind, run.state, run.sessions.length]);

  const steps = stepStatesOf(run);
  const startedMs = Date.parse(run.startedAt);
  const endMs = run.state === "done" ? Date.parse(run.updatedAt) : now;
  const elapsedLabel =
    !Number.isNaN(startedMs) && !Number.isNaN(endMs)
      ? t("loop.run.elapsed", { length: formatDuration(endMs - startedMs, t) })
      : undefined;

  const beatAt = run.heartbeat !== null ? Date.parse(run.heartbeat.at) : Number.NaN;
  const beatAgeMs = !Number.isNaN(beatAt) ? Math.max(0, now - beatAt) : undefined;
  const beatStale = beatAgeMs !== undefined && beatAgeMs >= HEARTBEAT_STALE_MS;
  const beatLabel =
    beatAgeMs === undefined
      ? undefined
      : beatStale
        ? t("loop.run.heartbeatStale", { length: formatDuration(beatAgeMs, t) })
        : beatAgeMs < 60_000
          ? t("loop.run.heartbeatJustNow")
          : t("loop.run.heartbeat", { ago: formatDuration(beatAgeMs, t) });

  const sessionLabel = (kind: string): string =>
    KNOWN_SESSION_KINDS.has(kind)
      ? t(`loop.run.session.${kind}`)
      : t("loop.run.session.other", { kind });

  const cancelTurn = async (): Promise<string | undefined> => {
    setCancelNotice(undefined);
    const result = await store.cancelLoopRun(projectKey, identifier);
    if (result.kind === "failed") return t(`loop.fail.${result.reason}`);
    setCancelNotice(result.cancelled ? t("loop.run.cancelled") : t("loop.run.notRunning"));
    onChanged();
    return undefined;
  };

  const recentEvents = (() => {
    const seen = new Map<string, number>();
    return [...run.events].reverse().map((ev) => {
      const base = `${ev.ts}:${ev.kind}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return { key: `${base}#${n}`, ev };
    });
  })();

  return (
    <section
      data-slot="loop-detail-section"
      data-kind="loop-run-workflow"
      aria-label={t("loop.run.workflow")}
    >
      <header data-slot="loop-run-head">
        <div data-slot="loop-detail-section-head">
          <h4>{t("loop.run.workflow")}</h4>
          {run.round > 0 ? (
            <span data-slot="loop-column-count">{t("loop.run.round", { count: run.round })}</span>
          ) : null}
          {elapsedLabel !== undefined ? (
            <span data-slot="loop-run-meta">{elapsedLabel}</span>
          ) : null}
        </div>
        {run.state === "active" ? (
          <Button
            data-variant="outline"
            data-kind="loop-run-cancel"
            onClick={() => setConfirmCancel(true)}
          >
            <StopIcon size={12} />
            <span>{t("loop.run.cancel")}</span>
          </Button>
        ) : null}
      </header>

      <ol data-slot="loop-run-steps" aria-label={t("loop.run.steps")}>
        {steps.map((step) => (
          <li
            key={step.id}
            data-slot="loop-run-step"
            data-state={step.state}
            aria-current={step.state === "active" ? "step" : undefined}
            title={t(`loop.run.stepState.${step.state}`)}
          >
            <span data-slot="loop-run-step-mark" aria-hidden="true">
              {step.state === "done" ? (
                <CheckIcon size={10} />
              ) : step.state === "blocked" ? (
                <CloseIcon size={8} />
              ) : null}
            </span>
            <span data-slot="loop-run-step-label">{t(step.labelKey)}</span>
            <span data-slot="loop-sr-only"> ({t(`loop.run.stepState.${step.state}`)})</span>
          </li>
        ))}
      </ol>

      {run.state === "active" && beatLabel !== undefined ? (
        <div data-slot="loop-run-heartbeat" data-stale={beatStale ? "true" : undefined}>
          <span data-slot="loop-run-heartbeat-dot" aria-hidden="true" />
          <span>{beatLabel}</span>
          {run.heartbeat?.detail ? (
            <span data-slot="loop-run-heartbeat-detail" title={run.heartbeat.detail}>
              {run.heartbeat.detail}
            </span>
          ) : null}
        </div>
      ) : null}

      {run.sessions.length > 0 ? (
        <section data-slot="loop-run-sessions" aria-label={t("loop.run.sessions")}>
          {run.sessions.map((s) => (
            <Button
              key={`${s.kind}:${s.id}`}
              data-variant="outline"
              data-kind="loop-run-session"
              onClick={() => {
                const ok = store.joinLoopSession(s.id);
                setMissingSession(!ok);
              }}
            >
              <MessageIcon size={12} />
              <span>{sessionLabel(s.kind)}</span>
            </Button>
          ))}
        </section>
      ) : null}

      {missingSession ? (
        <p data-slot="loop-problem" role="alert">
          {t("loop.run.sessionMissing")}
        </p>
      ) : null}

      {cancelNotice !== undefined ? (
        <p data-slot="loop-run-status" role="status">
          {cancelNotice}
        </p>
      ) : null}

      {recentEvents.length > 0 ? (
        <div data-slot="loop-run-events">
          <button
            type="button"
            data-slot="loop-run-events-toggle"
            aria-expanded={eventsOpen}
            onClick={() => setEventsOpen((v) => !v)}
          >
            {eventsOpen ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
            <span>{t("loop.run.events", { count: recentEvents.length })}</span>
          </button>
          {eventsOpen ? (
            <ol data-slot="loop-run-events-list">
              {recentEvents.map(({ key, ev }) => (
                <li key={key}>
                  <span data-slot="loop-run-event-time">{formatEventTime(ev.ts)}</span>
                  <span data-slot="loop-run-event-kind">{ev.kind}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}

      {confirmCancel ? (
        <ConfirmDialog
          open
          onOpenChange={setConfirmCancel}
          title={t("loop.run.cancelTitle", { id: identifier })}
          description={t("loop.run.cancelBody")}
          confirmLabel={t("loop.run.cancelConfirm")}
          destructive
          onConfirm={cancelTurn}
        />
      ) : null}
    </section>
  );
}
