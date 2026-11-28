// The Loop views (CYC-386, CYC-387, CYC-533): cross-project Overview from the top Loop action, and one Project's
// Kanban or Timeline opened from under the matched workspace (or from Overview). The page only reads and shows what
// the Loop server answers (the board, the Notices) and asks it to approve or return a batch (`loop-board.tsx`,
// `loop-ticket.tsx`, `loop-notices.tsx`).
import { isComposing } from "@ui-sdk/core";
import { Button } from "@ui-sdk/react/button";
import { useEffect, useRef, useState } from "react";
import type { LoopBoardColumn, LoopProjectInfo, LoopRunsAnswer } from "../api.ts";
import { useI18n } from "./i18n.tsx";
import { ChevronRightIcon, RefreshIcon } from "./icons.tsx";
import { Board } from "./loop-board.tsx";
import { type LoopProjectTab, type LoopView, up, viewProject } from "./loop-nav.ts";
import { Notices, noticeUrgency, type RetryIntents } from "./loop-notices.tsx";
import { LoopTimeline } from "./loop-timeline.tsx";
import { PageGroup, PageRows } from "./page-layout.tsx";
import { ShellNotices, ShellTitle } from "./shell.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";

/** How often the Notices are read again while the page is open. */
const NOTICES_REFRESH_MS = 30_000;

const STATE_OF = {
  backlog: "backlog",
  todo: "unstarted",
  doing: "started",
  done: "completed",
} as const;
/** The tickets of every column of one kind of state, for the overview's counts. */
const countOf = (columns: LoopBoardColumn[], c: keyof typeof STATE_OF): number =>
  columns
    .filter((col) => col.stateType === STATE_OF[c])
    .reduce((n, col) => n + col.tickets.length, 0);
const pendingCountOf = (columns: LoopBoardColumn[]): number =>
  columns
    .filter((col) => col.stateType === "backlog")
    .reduce((n, col) => n + col.tickets.filter((tk) => tk.pending !== undefined).length, 0);
const COLUMNS = ["doing", "todo", "backlog", "done"] as const;

/** The Loop overview: what needs the person, then a card of Projects with each Project's ticket breakdown. */
function Overview({
  projects,
  away,
  onOpenProject,
  onOpenTicket,
}: {
  projects: LoopProjectInfo[];
  away: boolean;
  onOpenProject: (projectKey: string) => void;
  onOpenTicket: (projectKey: string, identifier: string) => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const boards = useAppState((s) => s.loop.boards);
  const noticeAnswers = useAppState((s) => s.loop.notices);
  const runs = useAppState((s) => s.loop.runs);
  const [refreshing, setRefreshing] = useState(false);

  const notices = projects
    .flatMap((p) => {
      const answer = noticeAnswers[p.projectKey];
      return answer?.kind === "ok"
        ? answer.notices.map((notice) => ({ projectKey: p.projectKey, notice }))
        : [];
    })
    .sort((a, b) => noticeUrgency(a.notice) - noticeUrgency(b.notice));

  const retryIntents: RetryIntents = async (projectKey, identifier) => {
    const result = await store.retryLoopIntents(projectKey, identifier);
    if (result.kind === "failed") return { ok: false, message: t(`loop.fail.${result.reason}`) };
    return {
      ok: true,
      message:
        result.retried > 0
          ? t("loop.notices.retried", { count: result.retried })
          : t("loop.notices.retryNone"),
    };
  };

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      await store.loadLoopProjects();
      await Promise.all(
        projects.flatMap((p) => [
          store.loadLoopBoard(p.projectKey),
          store.loadLoopNotices(p.projectKey),
        ]),
      );
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div data-slot="loop-overview" data-kind="loop-overview">
      <Notices
        notices={notices}
        onRetryIntents={retryIntents}
        onOpen={(projectKey, notice) => {
          store.track("loop_notice_opened", { kind: notice.kind });
          // The session it names, when it is here; else the ticket's page, where it is joined or its story is read.
          if (notice.session === null || !store.joinLoopSession(notice.session.id)) {
            if (notice.identifier !== null) onOpenTicket(projectKey, notice.identifier);
          }
        }}
      />
      <section data-slot="loop-projects" aria-label={t("loop.projects")}>
        <PageGroup
          title={t("loop.projects")}
          action={
            <Button
              data-variant="outline"
              data-kind="loop-refresh"
              data-busy={refreshing ? "" : undefined}
              disabled={refreshing || away}
              onClick={() => void refreshAll()}
            >
              <RefreshIcon size={14} />
              <span>{t("loop.reload")}</span>
            </Button>
          }
        >
          <PageRows>
            <ul data-slot="loop-project-list">
              {projects.map((p) => {
                const board = boards[p.projectKey];
                const pending =
                  board && board !== "loading" && board.kind === "ok"
                    ? pendingCountOf(board.columns)
                    : 0;
                return (
                  <li key={p.projectKey} data-slot="loop-project-row" data-project={p.projectKey}>
                    <button
                      type="button"
                      data-slot="loop-project-open"
                      disabled={away}
                      onClick={() => onOpenProject(p.projectKey)}
                    >
                      <span data-slot="loop-project-info">
                        <span data-slot="loop-project-title">
                          <span data-slot="loop-project-name">{p.name}</span>
                          <span data-slot="loop-project-key">{p.projectKey}</span>
                          <RunState runs={runs} projectKey={p.projectKey} />
                        </span>
                        <span data-slot="loop-repo">{p.repo.displayName}</span>
                      </span>
                      {board === undefined || board === "loading" ? (
                        <span data-slot="loop-repo">{away ? "" : t("loop.loading")}</span>
                      ) : board.kind === "ok" ? (
                        <span data-slot="loop-project-counts">
                          {pending > 0 ? (
                            <span data-slot="loop-pending-badge">
                              <span data-slot="loop-pending-dot" aria-hidden="true" />
                              {t("loop.pending")} {pending}
                            </span>
                          ) : null}
                          {COLUMNS.map((c) => [c, countOf(board.columns, c)] as const)
                            .filter(([, n]) => n > 0)
                            .map(([c, n]) => (
                              <span key={c} data-slot="loop-project-count" data-column={c}>
                                <span data-slot="loop-count-dot" aria-hidden="true" />
                                {t(`loop.col.${c}`)} <strong>{n}</strong>
                              </span>
                            ))}
                        </span>
                      ) : null}
                      <ChevronRightIcon size={14} />
                    </button>
                    {board !== undefined && board !== "loading" && board.kind !== "ok" ? (
                      <span data-slot="loop-project-failed" data-kind="loop-project-failed">
                        <span data-slot="loop-problem">
                          {board.kind === "no_server"
                            ? t("loop.offline.title")
                            : t("loop.unreachable.title")}
                        </span>
                        <Button
                          data-variant="outline"
                          aria-label={`${t("loop.reload")} ${p.name}`}
                          onClick={() => void store.loadLoopBoard(p.projectKey)}
                        >
                          {t("loop.reload")}
                        </Button>
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </PageRows>
        </PageGroup>
      </section>
    </div>
  );
}

/**
 * Whether Loop is running a Project: read-only, from the run data (CYC-458), never from a board column. Said in words, not
 * by colour alone. Before the first read it says nothing; a server that did not answer is "not running", never "running".
 */
function RunState({ runs, projectKey }: { runs: LoopRunsAnswer | undefined; projectKey: string }) {
  const { t } = useI18n();
  if (runs === undefined) return null;
  const running = runs.kind === "ok" && (runs.running[projectKey]?.length ?? 0) > 0;
  const state = running ? "running" : "idle";
  return (
    <span data-slot="loop-run" data-kind="loop-run" data-state={state}>
      {t(`loop.run.${state}`)}
    </span>
  );
}

/** The main area in a Loop view: the title bar, what is wrong, then the overview, one Project's board, or its timeline. */
export function LoopMain({
  view,
  onView,
  onOpenProject,
  onBack,
  onClose,
  onTimelineSessionOpened,
  active = true,
}: {
  view: LoopView;
  onView: (view: LoopView) => void;
  /** Opens a Project's Kanban or Timeline from Overview or Timeline; syncs workspace & tracks analytics in App. */
  onOpenProject?: (
    projectKey: string,
    tab: LoopProjectTab,
    from: "overview" | "sidebar" | "timeline",
  ) => void;
  /** Closes the open ticket drawer back to its board; does nothing elsewhere in Loop. */
  onBack: () => void;
  /** Out of the Loop: a conversation about a ticket was started. */
  onClose: () => void;
  /** Called when a session is opened from Timeline so the session view can offer a one-click return (CYC-534). */
  onTimelineSessionOpened?: (projectKey: string, sessionId: string) => void;
  /** False while Settings or Connectors is over the window: Escape is theirs then. */
  active?: boolean;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const loop = useAppState((s) => s.loop);
  const { projects, connected } = loop;

  // The run state is read once; after that main pushes it when Loop's events change it, so it is not read again here.
  useEffect(() => {
    void store.loadLoopProjects();
    void store.loadLoopRuns();
  }, [store]);

  // What is shown: the overview, or the Project asked for (when the server has it).
  const projectKey = viewProject(view);
  const chosen = projects.find((p) => p.projectKey === projectKey);
  const chosenKey = chosen?.projectKey;
  const isTimeline = view.at === "project" && view.tab === "timeline";
  const allKeys = projects.map((p) => p.projectKey).join("\n");

  const openProject = (
    key: string,
    tab: LoopProjectTab,
    from: "overview" | "sidebar" | "timeline",
  ) => {
    if (onOpenProject !== undefined) onOpenProject(key, tab, from);
    else onView({ at: "project", projectKey: key, tab });
  };

  useEffect(() => {
    if (connected !== true) return;
    if (chosenKey !== undefined) {
      if (!isTimeline) void store.loadLoopBoard(chosenKey);
    } else for (const key of allKeys.split("\n")) if (key !== "") void store.loadLoopBoard(key);
  }, [store, chosenKey, isTimeline, connected, allKeys]);

  // Sessions that wait on an answer are part of the Notices: they are read again when that set changes.
  const waiting = useAppState((s) =>
    Object.values(s.sessions)
      .flat()
      .filter((x) => x.state === "requires_action")
      .map((x) => x.sessionId)
      .sort()
      .join(),
  );
  // Read every Project's Notices while the Loop view is open (Overview, Kanban, or Timeline), so badges and the
  // board's compact alert strip stay fresh.
  useEffect(() => {
    if (connected !== true) return;
    const read = () => {
      for (const key of allKeys.split("\n")) if (key !== "") void store.loadLoopNotices(key);
    };
    read();
    void waiting;
    const timer = setInterval(read, NOTICES_REFRESH_MS);
    return () => clearInterval(timer);
  }, [store, connected, allKeys, waiting]);
  // A notification asked for a Project the server does not have, or whose board cannot be read: no Board will take
  // the request, and it would open an old ticket on a later visit, so it is dropped.
  const request = useAppState((s) => s.loop.request);
  const requestedBoard = useAppState((s) =>
    request === undefined ? undefined : s.loop.boards[request.projectKey],
  );
  useEffect(() => {
    if (request === undefined || connected !== true) return;
    const unknown = !projects.some((p) => p.projectKey === request.projectKey);
    const failed = typeof requestedBoard === "object" && requestedBoard.kind !== "ok";
    if (unknown || failed) store.takeLoopRequest(request.n);
  }, [store, request, requestedBoard, connected, projects]);

  // Escape closes the ticket drawer (one level up). It does not leave Loop: picking a session or New session does.
  // What is drawn over the page (a dialog, a menu) takes its own Escape first, and the board's batch selection before this.
  const goBack = useRef(onBack);
  goBack.current = onBack;
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isComposing(event)) return;
      const target = event.target as Node | null;
      const inMain =
        target instanceof Element &&
        target.closest('[data-slot="main"], [data-slot="sidebar"]') !== null;
      if (target !== null && target !== document.body && !inMain) return;
      // Only a ticket's drawer is closed by it; elsewhere the key is left alone.
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null)
        return;
      if (up(viewRef.current) === undefined) return;
      event.preventDefault();
      goBack.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  const away = connected === false;
  const heading =
    chosen === undefined ? (
      <h1 data-slot="loop-heading">{t("loop.overview")}</h1>
    ) : (
      <nav data-slot="loop-crumbs" aria-label={t("loop.crumbs")}>
        <button
          type="button"
          data-slot="loop-crumb"
          onClick={() =>
            onView(
              view.at === "ticket"
                ? { at: "project", projectKey: chosen.projectKey, tab: "kanban" }
                : { at: "overview" },
            )
          }
        >
          {chosen.name}
        </button>
        <span aria-hidden="true">/</span>
        <span aria-current="page">
          {view.at === "ticket" && view.projectKey === chosen.projectKey
            ? view.identifier
            : isTimeline
              ? t("loop.tab.timeline")
              : t("loop.tab.kanban")}
        </span>
      </nav>
    );

  return (
    <>
      <ShellTitle>{heading}</ShellTitle>
      {away ? (
        <ShellNotices>
          <div data-slot="loop-offline-banner">
            <StateBlock
              tone="away"
              size="inline"
              title={t("loop.offline.title")}
              body={t("loop.offline.body")}
              action={{ label: t("loop.reload"), onAction: () => void store.loadLoopProjects() }}
            />
          </div>
        </ShellNotices>
      ) : null}
      <div
        data-slot="page-body"
        data-kind="loop-body"
        // The board is a fixed frame whose columns scroll; the Timeline is a long page that scrolls as a whole.
        data-full={chosen !== undefined && !isTimeline ? "" : undefined}
      >
        {chosen !== undefined && isTimeline ? (
          <LoopTimeline
            key={chosen.projectKey}
            projectKey={chosen.projectKey}
            onOpenTicket={(identifier) =>
              onView({ at: "ticket", projectKey: chosen.projectKey, identifier })
            }
            onOpenKanban={() => openProject(chosen.projectKey, "kanban", "timeline")}
            onSessionOpened={(key, sessionId) => onTimelineSessionOpened?.(key, sessionId)}
          />
        ) : chosen !== undefined ? (
          <Board
            projectKey={chosen.projectKey}
            answer={loop.boards[chosen.projectKey]}
            openIdentifier={
              view.at === "ticket" && view.projectKey === chosen.projectKey
                ? view.identifier
                : undefined
            }
            onOpen={(identifier) =>
              onView({ at: "ticket", projectKey: chosen.projectKey, identifier })
            }
            onOpenOverview={() => onView({ at: "overview" })}
            onBack={onBack}
            onChatStarted={onClose}
          />
        ) : (
          <div data-slot="page-column">
            {projects.length === 0 ? (
              connected === undefined ? (
                <StateBlock tone="loading" title={t("loop.loading")} />
              ) : away ? null : (
                <StateBlock
                  tone="empty"
                  title={t("loop.noProjects.title")}
                  body={t("loop.noProjects.body")}
                  action={{
                    label: t("loop.reload"),
                    onAction: () => void store.loadLoopProjects(),
                  }}
                />
              )
            ) : (
              <Overview
                projects={projects}
                away={away}
                onOpenProject={(key) => openProject(key, "kanban", "overview")}
                onOpenTicket={(key, identifier) =>
                  onView({ at: "ticket", projectKey: key, identifier })
                }
              />
            )}
          </div>
        )}
      </div>
    </>
  );
}
