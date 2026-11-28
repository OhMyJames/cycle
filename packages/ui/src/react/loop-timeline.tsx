// Chronological Loop progress timeline for one Project (CYC-534, docs/protocol.md §17):
// aggregates runs (with Task Graph nodes and phase sessions) and planning rounds (Triage / Shape / Shape QA),
// with status/kind filters, ticket search, pagination, and one-click jump into any step's session or ticket drawer.
import { isComposing } from "@ui-sdk/core";
import { Button } from "@ui-sdk/react/button";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  LoopTimelineEntry,
  LoopTimelinePlanEntry,
  LoopTimelineRunEntry,
  LoopTimelineStepStatus,
  SessionOriginRole,
} from "../api.ts";
import { AgentLink } from "./agent-link.tsx";
import { useI18n } from "./i18n.tsx";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  MessageIcon,
  RefreshIcon,
  SearchIcon,
} from "./icons.tsx";
import { useDay } from "./in-front.ts";
import { PHASE_WORD } from "./loop-run.tsx";
import { SessionTime } from "./session-time.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";

type StatusFilter = "all" | "active" | "attention";
type KindFilter = "all" | "dev" | "plan" | "research";

const ROLE_KEY: Record<SessionOriginRole, string> = {
  dev: "loop.run.session.dev",
  qa: "loop.run.session.qa",
  review: "loop.run.session.review",
  research: "loop.run.session.research",
  research_qa: "loop.run.session.research_qa",
  triage: "loop.run.session.triage",
  shape: "loop.run.session.shape",
  shape_qa: "loop.run.session.shape_qa",
  graph_planner: "loop.run.session.graph_planner",
};

const STEP_TONE: Record<LoopTimelineStepStatus, "running" | "done" | "attention" | "idle"> = {
  running: "running",
  passed: "done",
  failed: "attention",
  blocked: "attention",
  pending: "idle",
  skipped: "idle",
};

const PLAN_PHASE_KEY: Record<LoopTimelinePlanEntry["phase"], string> = {
  triage: "loop.timeline.planPhase.triage",
  shaping: "loop.timeline.planPhase.shaping",
  finished: "loop.timeline.planPhase.finished",
  abandoned: "loop.timeline.planPhase.abandoned",
};

const PLAN_ITEM_STATE_KEY: Record<LoopTimelinePlanEntry["items"][number]["state"], string> = {
  waiting: "loop.timeline.planItem.waiting",
  shape: "loop.timeline.planItem.shape",
  shape_qa: "loop.timeline.planItem.shape_qa",
  writing: "loop.timeline.planItem.writing",
  done: "loop.timeline.planItem.done",
  stopped: "loop.timeline.planItem.stopped",
  asked: "loop.timeline.planItem.asked",
  abandoned: "loop.timeline.planItem.abandoned",
};

const needsAttention = (entry: LoopTimelineEntry): boolean => {
  if (entry.entryKind === "run") {
    return (
      entry.state === "blocked" ||
      entry.steps.some((s) => s.status === "blocked" || s.status === "failed")
    );
  }
  return (
    entry.stoppedReason !== null ||
    entry.items.some((i) => i.state === "stopped" || i.state === "asked")
  );
};

const matchesKind = (entry: LoopTimelineEntry, kind: KindFilter): boolean => {
  if (kind === "all") return true;
  if (kind === "plan") return entry.entryKind === "plan";
  return entry.entryKind === "run" && entry.kind === kind;
};

const matchesStatus = (entry: LoopTimelineEntry, status: StatusFilter): boolean => {
  if (status === "all") return true;
  if (status === "active") return entry.state === "active";
  return needsAttention(entry);
};

const matchesQuery = (entry: LoopTimelineEntry, query: string): boolean => {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  if (entry.entryKind === "run") {
    return (
      entry.key.toLowerCase().includes(q) ||
      entry.title.toLowerCase().includes(q) ||
      entry.steps.some((s) => s.label.toLowerCase().includes(q))
    );
  }
  return (
    entry.planId.toLowerCase().includes(q) ||
    entry.items.some((i) => i.key.toLowerCase().includes(q))
  );
};

type DayBucket = "today" | "yesterday" | "earlier";

const bucketOf = (iso: string, now: Date): DayBucket => {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "earlier";
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((midnight(now) - midnight(new Date(parsed))) / 86_400_000);
  if (diff <= 0) return "today";
  if (diff === 1) return "yesterday";
  return "earlier";
};

const durationText = (startIso: string | null, endIso: string | null): string | null => {
  if (startIso === null || endIso === null) return null;
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return rem > 0 ? `${min}m ${rem}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
};

export function LoopTimeline({
  projectKey,
  onOpenTicket,
  onOpenKanban,
  onSessionOpened,
}: {
  projectKey: string;
  onOpenTicket: (identifier: string) => void;
  onOpenKanban: () => void;
  onSessionOpened: (projectKey: string, sessionId: string) => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const state = useAppState((s) => s.loop.timelines[projectKey]);
  const activity = useAppState((s) => s.loop.activity[projectKey] ?? 0);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [kind, setKind] = useState<KindFilter>("all");
  const [query, setQuery] = useState("");
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [missingSession, setMissingSession] = useState(false);
  const day = useDay();

  useEffect(() => {
    void store.loadLoopTimeline(projectKey);
  }, [store, projectKey]);

  const seenActivity = useRef(activity);
  useEffect(() => {
    if (activity === seenActivity.current) return;
    seenActivity.current = activity;
    void store.loadLoopTimeline(projectKey, { merge: true });
  }, [store, projectKey, activity]);

  const applyFilter = (nextStatus: StatusFilter, nextKind: KindFilter) => {
    if (nextStatus === status && nextKind === kind) return;
    setStatus(nextStatus);
    setKind(nextKind);
    store.track("loop_timeline_filtered", { status: nextStatus, kind: nextKind });
  };

  const openSession = (sessionId: string, entryKind: "run" | "plan", role: SessionOriginRole) => {
    const ok = store.joinLoopSession(sessionId);
    if (!ok) {
      setMissingSession(true);
      return;
    }
    setMissingSession(false);
    store.track("loop_timeline_session_opened", { entry_kind: entryKind, role });
    onSessionOpened(projectKey, sessionId);
  };

  const entries = typeof state === "object" && state.kind === "ok" ? state.entries : [];
  const filtered = useMemo(
    () =>
      entries.filter(
        (entry) =>
          matchesStatus(entry, status) && matchesKind(entry, kind) && matchesQuery(entry, query),
      ),
    [entries, status, kind, query],
  );

  const grouped = useMemo(() => {
    const now = new Date(day);
    const groups: { bucket: DayBucket; items: LoopTimelineEntry[] }[] = [];
    for (const bucket of ["today", "yesterday", "earlier"] as const) {
      const items = filtered.filter((e) => bucketOf(e.updatedAt, now) === bucket);
      if (items.length > 0) groups.push({ bucket, items });
    }
    return groups;
  }, [filtered, day]);

  if (state === undefined || state === "loading") {
    return (
      <div data-slot="loop-timeline" data-kind="loop-timeline" aria-busy="true">
        <output data-slot="loop-timeline-skeleton-list" aria-label={t("loop.loading")}>
          {[0, 1, 2].map((i) => (
            <div key={i} data-slot="loop-timeline-skeleton" aria-hidden="true" />
          ))}
        </output>
      </div>
    );
  }

  if (state.kind === "no_server") {
    return (
      <div data-slot="loop-board-state" data-kind="loop-timeline">
        <StateBlock
          tone="away"
          title={t("loop.offline.title")}
          body={t("loop.offline.body")}
          action={{
            label: t("loop.reload"),
            onAction: () => void store.loadLoopTimeline(projectKey),
          }}
        />
      </div>
    );
  }

  if (state.kind === "unreachable") {
    return (
      <div data-slot="loop-board-state" data-kind="loop-timeline">
        <StateBlock
          tone="error"
          title={t("loop.timeline.error.title")}
          body={t("loop.timeline.error.body")}
          action={{
            label: t("loop.reload"),
            onAction: () => void store.loadLoopTimeline(projectKey),
          }}
        />
      </div>
    );
  }

  const hasFilters = status !== "all" || kind !== "all" || query.trim() !== "";
  const isExpanded = (entry: LoopTimelineEntry): boolean => {
    const explicit = toggled[entry.id];
    if (explicit !== undefined) return explicit;
    return entry.state === "active" || (entry.entryKind === "run" && entry.state === "blocked");
  };
  const toggleEntry = (entry: LoopTimelineEntry) =>
    setToggled((prev) => ({ ...prev, [entry.id]: !isExpanded(entry) }));

  return (
    <div data-slot="loop-timeline" data-kind="loop-timeline">
      <div data-slot="loop-timeline-bar">
        <div data-slot="loop-timeline-filters">
          <fieldset data-slot="loop-timeline-chips" aria-label={t("loop.timeline.filter.status")}>
            {(["all", "active", "attention"] as const).map((s) => (
              <button
                key={s}
                type="button"
                data-slot="loop-filter-chip"
                aria-pressed={status === s}
                onClick={() => applyFilter(s, kind)}
              >
                {t(`loop.timeline.filter.${s}`)}
              </button>
            ))}
          </fieldset>
          <fieldset data-slot="loop-timeline-chips" aria-label={t("loop.timeline.filter.kind")}>
            {(["all", "dev", "plan", "research"] as const).map((k) => (
              <button
                key={k}
                type="button"
                data-slot="loop-filter-chip"
                aria-pressed={kind === k}
                onClick={() => applyFilter(status, k)}
              >
                {t(`loop.timeline.kind.${k}`)}
              </button>
            ))}
          </fieldset>
        </div>
        <div data-slot="loop-timeline-search-row">
          <label data-slot="loop-board-search">
            <SearchIcon />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && !isComposing(e) && query !== "") {
                  e.preventDefault();
                  setQuery("");
                }
              }}
              placeholder={t("loop.timeline.searchPlaceholder")}
              aria-label={t("loop.timeline.searchPlaceholder")}
            />
          </label>
          <Tip label={t("loop.reload")}>
            <Button
              data-variant="ghost"
              aria-label={t("loop.reload")}
              onClick={() => void store.loadLoopTimeline(projectKey)}
            >
              <RefreshIcon />
            </Button>
          </Tip>
        </div>
      </div>

      {missingSession ? (
        <p role="alert" data-slot="loop-timeline-alert">
          {t("loop.run.sessionMissing")}
        </p>
      ) : null}

      {entries.length === 0 ? (
        <div data-slot="loop-board-state">
          <StateBlock
            tone="empty"
            title={t("loop.timeline.empty.title")}
            body={t("loop.timeline.empty.body")}
            action={{ label: t("loop.openKanban"), onAction: onOpenKanban }}
          />
        </div>
      ) : grouped.length === 0 ? (
        <div data-slot="loop-board-state">
          <StateBlock
            tone="empty"
            title={t("loop.timeline.noMatch.title")}
            body={t("loop.timeline.noMatch.body")}
            action={
              hasFilters
                ? {
                    label: t("loop.timeline.clearFilters"),
                    onAction: () => {
                      setQuery("");
                      applyFilter("all", "all");
                    },
                  }
                : undefined
            }
          />
        </div>
      ) : (
        <div data-slot="loop-timeline-groups">
          {grouped.map(({ bucket, items }) => (
            <section
              key={bucket}
              data-slot="loop-timeline-group"
              aria-label={t(`sessions.group.${bucket}`)}
            >
              <h2 data-slot="loop-timeline-group-title">{t(`sessions.group.${bucket}`)}</h2>
              <ol data-slot="loop-timeline-list">
                {items.map((entry) =>
                  entry.entryKind === "run" ? (
                    <RunTimelineCard
                      key={entry.id}
                      entry={entry}
                      expanded={isExpanded(entry)}
                      onToggle={() => toggleEntry(entry)}
                      onOpenTicket={onOpenTicket}
                      onOpenSession={(sessionId, role) => openSession(sessionId, "run", role)}
                    />
                  ) : (
                    <PlanTimelineCard
                      key={entry.id}
                      entry={entry}
                      expanded={isExpanded(entry)}
                      onToggle={() => toggleEntry(entry)}
                      onOpenTicket={onOpenTicket}
                      onOpenSession={(sessionId, role) => openSession(sessionId, "plan", role)}
                    />
                  ),
                )}
              </ol>
            </section>
          ))}
          {state.hasMore ? (
            <div data-slot="loop-timeline-more">
              <Button
                data-variant="outline"
                disabled={state.loadingMore}
                onClick={() => void store.loadMoreLoopTimeline(projectKey)}
              >
                {state.loadingMore ? t("loop.loading") : t("loop.timeline.loadMore")}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function RunTimelineCard({
  entry,
  expanded,
  onToggle,
  onOpenTicket,
  onOpenSession,
}: {
  entry: LoopTimelineRunEntry;
  expanded: boolean;
  onToggle: () => void;
  onOpenTicket: (identifier: string) => void;
  onOpenSession: (sessionId: string, role: SessionOriginRole) => void;
}) {
  const { t } = useI18n();
  const tone =
    entry.state === "blocked" ? "attention" : entry.state === "active" ? "running" : "done";
  const phaseSuffix = PHASE_WORD[entry.phase];
  const phaseLabel = phaseSuffix !== undefined ? t(`loop.stage.${phaseSuffix}`) : entry.phase;
  const totalDur = entry.state === "done" ? durationText(entry.startedAt, entry.updatedAt) : null;

  return (
    <li data-slot="loop-timeline-item" data-entry-kind="run" data-state={tone}>
      <span data-slot="loop-timeline-dot" data-state={tone} aria-hidden="true" />
      <article data-slot="loop-timeline-card">
        <div data-slot="loop-timeline-head">
          <button
            type="button"
            data-slot="loop-timeline-toggle"
            aria-expanded={expanded}
            onClick={onToggle}
          >
            {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
            <span data-slot="loop-timeline-badge" data-kind={entry.kind}>
              {t(`loop.timeline.kind.${entry.kind}`)}
            </span>
          </button>
          <button
            type="button"
            data-slot="loop-timeline-ticket-link"
            onClick={() => onOpenTicket(entry.key)}
          >
            {entry.key}
          </button>
          <span data-slot="loop-timeline-title" title={entry.title}>
            {entry.title}
          </span>
          <span data-slot="loop-timeline-meta">
            <span data-slot="loop-timeline-phase" data-state={tone}>
              {phaseLabel}
            </span>
            {entry.graph !== null ? (
              <span data-slot="loop-timeline-pill">
                {entry.graph.passed}/{entry.graph.total}
              </span>
            ) : null}
            {entry.round > 1 ? (
              <span data-slot="loop-timeline-pill">
                {t("loop.run.round", { round: entry.round })}
              </span>
            ) : null}
            {totalDur !== null ? <span data-slot="loop-timeline-dur">{totalDur}</span> : null}
            <SessionTime at={entry.updatedAt} />
          </span>
        </div>
        {expanded ? (
          <div data-slot="loop-timeline-body">
            {entry.blockedReason !== null ? (
              <p data-slot="loop-timeline-alert">{entry.blockedReason}</p>
            ) : null}
            {entry.prUrl?.startsWith("https://") ? (
              <div data-slot="loop-timeline-pr">
                <AgentLink href={entry.prUrl}>{entry.prUrl.replace(/^https:\/\//, "")}</AgentLink>
              </div>
            ) : null}
            {entry.steps.length > 0 ? (
              <ol data-slot="loop-timeline-steps">
                {entry.steps.map((step) => {
                  const stepTone = STEP_TONE[step.status];
                  const dur = durationText(step.startedAt, step.finishedAt);
                  const roleLabel = t(ROLE_KEY[step.role]);
                  const showLabel =
                    step.label.toLowerCase() !== step.role.toLowerCase() && step.label !== "";
                  return (
                    <li key={step.id} data-slot="loop-timeline-step" data-state={stepTone}>
                      <span
                        data-slot="loop-timeline-step-dot"
                        data-state={stepTone}
                        aria-hidden="true"
                      />
                      <span data-slot="loop-timeline-step-main">
                        <span data-slot="loop-timeline-step-row">
                          <span data-slot="loop-timeline-step-role">{roleLabel}</span>
                          {showLabel ? (
                            <span data-slot="loop-timeline-step-label" title={step.label}>
                              {step.label}
                            </span>
                          ) : null}
                          {dur !== null ? <span data-slot="loop-timeline-dur">{dur}</span> : null}
                        </span>
                        {step.error !== null ? (
                          <span data-slot="loop-timeline-step-note" data-tone="attention">
                            {step.error}
                          </span>
                        ) : step.summary !== null ? (
                          <span data-slot="loop-timeline-step-note">{step.summary}</span>
                        ) : null}
                      </span>
                      {step.sessionId !== null ? (
                        <button
                          type="button"
                          data-slot="loop-timeline-session-btn"
                          aria-label={t("loop.timeline.openSessionFor", {
                            target: showLabel ? step.label : roleLabel,
                          })}
                          onClick={() => onOpenSession(step.sessionId as string, step.role)}
                        >
                          <MessageIcon />
                          <span>{t("loop.timeline.openSession")}</span>
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            ) : null}
          </div>
        ) : null}
      </article>
    </li>
  );
}

function PlanTimelineCard({
  entry,
  expanded,
  onToggle,
  onOpenTicket,
  onOpenSession,
}: {
  entry: LoopTimelinePlanEntry;
  expanded: boolean;
  onToggle: () => void;
  onOpenTicket: (identifier: string) => void;
  onOpenSession: (sessionId: string, role: SessionOriginRole) => void;
}) {
  const { t } = useI18n();
  const hasAttention = needsAttention(entry);
  const tone = entry.state === "active" ? "running" : hasAttention ? "attention" : "done";
  const totalDur = durationText(entry.startedAt, entry.endedAt);
  const doneCount = entry.items.filter((i) => i.state === "done").length;

  return (
    <li data-slot="loop-timeline-item" data-entry-kind="plan" data-state={tone}>
      <span data-slot="loop-timeline-dot" data-state={tone} aria-hidden="true" />
      <article data-slot="loop-timeline-card">
        <div data-slot="loop-timeline-head">
          <button
            type="button"
            data-slot="loop-timeline-toggle"
            aria-expanded={expanded}
            onClick={onToggle}
          >
            {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
            <span data-slot="loop-timeline-badge" data-kind="plan">
              {t("loop.timeline.kind.plan")}
            </span>
          </button>
          <span data-slot="loop-timeline-title">
            {t("loop.timeline.planTitle", {
              candidates: entry.candidateCount,
              shaped: doneCount,
            })}
          </span>
          <span data-slot="loop-timeline-meta">
            <span data-slot="loop-timeline-phase" data-state={tone}>
              {t(PLAN_PHASE_KEY[entry.phase])}
            </span>
            {totalDur !== null ? <span data-slot="loop-timeline-dur">{totalDur}</span> : null}
            <SessionTime at={entry.updatedAt} />
          </span>
        </div>
        {expanded ? (
          <div data-slot="loop-timeline-body">
            {entry.stoppedReason !== null ? (
              <p data-slot="loop-timeline-alert">{entry.stoppedReason}</p>
            ) : null}
            {entry.triageSessionId !== null || entry.items.length > 0 ? (
              <ol data-slot="loop-timeline-steps">
                {entry.triageSessionId !== null ? (
                  <li
                    data-slot="loop-timeline-step"
                    data-state={entry.phase === "triage" ? "running" : "done"}
                  >
                    <span
                      data-slot="loop-timeline-step-dot"
                      data-state={entry.phase === "triage" ? "running" : "done"}
                      aria-hidden="true"
                    />
                    <span data-slot="loop-timeline-step-main">
                      <span data-slot="loop-timeline-step-row">
                        <span data-slot="loop-timeline-step-role">
                          {t("loop.run.session.triage")}
                        </span>
                        <span data-slot="loop-timeline-step-label">
                          {t("loop.timeline.planCandidates", { count: entry.candidateCount })}
                        </span>
                      </span>
                    </span>
                    <button
                      type="button"
                      data-slot="loop-timeline-session-btn"
                      aria-label={t("loop.timeline.openSessionFor", {
                        target: t("loop.run.session.triage"),
                      })}
                      onClick={() => onOpenSession(entry.triageSessionId as string, "triage")}
                    >
                      <MessageIcon />
                      <span>{t("loop.timeline.openSession")}</span>
                    </button>
                  </li>
                ) : null}
                {entry.items.map((item) => {
                  const itemTone =
                    item.state === "done"
                      ? "done"
                      : item.state === "stopped" || item.state === "asked"
                        ? "attention"
                        : item.state === "shape" ||
                            item.state === "shape_qa" ||
                            item.state === "writing"
                          ? "running"
                          : "idle";
                  return (
                    <li key={item.key} data-slot="loop-timeline-step" data-state={itemTone}>
                      <span
                        data-slot="loop-timeline-step-dot"
                        data-state={itemTone}
                        aria-hidden="true"
                      />
                      <span data-slot="loop-timeline-step-main">
                        <span data-slot="loop-timeline-step-row">
                          <button
                            type="button"
                            data-slot="loop-timeline-ticket-link"
                            onClick={() => onOpenTicket(item.key)}
                          >
                            {item.key}
                          </button>
                          <span data-slot="loop-timeline-phase" data-state={itemTone}>
                            {item.resultKind === "split" && item.splitCount > 0
                              ? t("loop.timeline.planItem.split", { count: item.splitCount })
                              : t(PLAN_ITEM_STATE_KEY[item.state])}
                          </span>
                        </span>
                        {item.stoppedReason !== null ? (
                          <span data-slot="loop-timeline-step-note" data-tone="attention">
                            {item.stoppedReason}
                          </span>
                        ) : null}
                      </span>
                      <span data-slot="loop-timeline-step-actions">
                        {item.shapeSessionId !== null ? (
                          <button
                            type="button"
                            data-slot="loop-timeline-session-btn"
                            aria-label={t("loop.timeline.openSessionFor", {
                              target: `${item.key} ${t("loop.run.session.shape")}`,
                            })}
                            onClick={() => onOpenSession(item.shapeSessionId as string, "shape")}
                          >
                            <MessageIcon />
                            <span>{t("loop.run.session.shape")}</span>
                          </button>
                        ) : null}
                        {item.qaSessionId !== null ? (
                          <button
                            type="button"
                            data-slot="loop-timeline-session-btn"
                            aria-label={t("loop.timeline.openSessionFor", {
                              target: `${item.key} ${t("loop.run.session.shape_qa")}`,
                            })}
                            onClick={() => onOpenSession(item.qaSessionId as string, "shape_qa")}
                          >
                            <MessageIcon />
                            <span>{t("loop.run.session.shape_qa")}</span>
                          </button>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ol>
            ) : null}
          </div>
        ) : null}
      </article>
    </li>
  );
}
