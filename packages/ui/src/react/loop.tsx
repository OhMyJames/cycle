// The Loop mode (CYC-386, CYC-387, CYC-500): the Projects the Loop server on this computer serves, and one Project's board.
// The sidebar keeps its frame and only its lower half becomes the Loop's navigation (`LoopNav`); the main area shows the
// overview or the board (`LoopMain`). The Projects are listed in the navigation: with the server away they stay listed,
// greyed, and say so. The page only reads and shows what the Loop server answers (the board, the
// Notices) and asks it to approve or return a batch (`loop-board.tsx`, `loop-ticket.tsx`, `loop-notices.tsx`).
import { isComposing } from "@ui-sdk/core";
import { Button } from "@ui-sdk/react/button";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { LoopBoardColumn, LoopNotice, LoopProjectInfo, LoopRunsAnswer } from "../api.ts";
import { useI18n } from "./i18n.tsx";
import { ChevronRightIcon, RefreshIcon } from "./icons.tsx";
import { Board } from "./loop-board.tsx";
import { type LoopView, viewProject } from "./loop-nav.ts";
import { Notices } from "./loop-notices.tsx";
import { PageGroup, PageRows } from "./page-layout.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";

/** How often the Notices are read again while the page is open. */
const NOTICES_REFRESH_MS = 30_000;

/** Most urgent first; the kinds the page has no special place for come after. */
const URGENCY: Record<string, number> = { permission: 0, blocked: 1, review: 2 };
const urgency = (n: LoopNotice): number => URGENCY[n.kind] ?? 3;

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
    .sort((a, b) => urgency(a.notice) - urgency(b.notice));

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
        onOpen={(projectKey, notice) => {
          if (notice.kind === "permission" || notice.kind === "blocked" || notice.kind === "review")
            store.track("loop_notice_opened", { kind: notice.kind });
          // The session it names, when it is here; else the ticket's page, where it is joined or its story is read.
          if (notice.session === null || !store.joinLoopSession(notice.session.id))
            onOpenTicket(projectKey, notice.identifier);
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

/** The sidebar's lower half in the Loop mode: the Overview, then every Project with its Kanban. */
export function LoopNav({ view, onView }: { view: LoopView; onView: (view: LoopView) => void }) {
  const { t } = useI18n();
  const { projects, connected } = useAppState((s) => s.loop);
  const away = connected === false;
  const chosenKey = projects.find((p) => p.projectKey === viewProject(view))?.projectKey;
  return (
    <section data-slot="loop-nav" aria-label={t("loop.title")}>
      <button
        type="button"
        data-slot="loop-nav-item"
        data-kind="loop-nav-overview"
        aria-current={chosenKey === undefined ? "page" : undefined}
        onClick={() => onView({ at: "overview" })}
      >
        {t("loop.overview")}
      </button>
      {projects.length > 0 ? (
        <div data-slot="loop-nav-group">
          <div data-slot="loop-nav-heading">{t("loop.projects")}</div>
          {projects.map((p) => (
            <div key={p.projectKey} data-slot="loop-nav-project" data-project={p.projectKey}>
              <span data-slot="loop-nav-name" title={p.name}>
                {p.name}
              </span>
              <button
                type="button"
                data-slot="loop-nav-item"
                data-kind="loop-nav-kanban"
                data-child=""
                aria-label={`${p.name} ${t("loop.tab.kanban")}`}
                aria-current={chosenKey === p.projectKey ? "page" : undefined}
                disabled={away}
                onClick={() => onView({ at: "project", projectKey: p.projectKey, tab: "kanban" })}
              >
                <span>{t("loop.tab.kanban")}</span>
                {away ? <span data-slot="loop-nav-note">{t("loop.offline.note")}</span> : null}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** The main area in the Loop mode: the title bar, what is wrong, then the overview or one Project's board. */
export function LoopMain({
  view,
  onView,
  onBack,
  onClose,
  banner,
  sidebarToggle,
  active = true,
}: {
  view: LoopView;
  onView: (view: LoopView) => void;
  /** One level up (ticket → board → overview); nothing from the overview. */
  onBack: () => void;
  /** Out of the Loop: a conversation about a ticket was started. */
  onClose: () => void;
  banner?: ReactNode;
  /** The button that shows the sidebar again, in the title bar, while it is put away. */
  sidebarToggle?: ReactNode;
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
  const onOverview = chosen === undefined;
  const allKeys = projects.map((p) => p.projectKey).join("\n");

  // Entering with nowhere remembered: the board when there is only one Project, else the overview.
  const landing = view.at === "overview" && view.landing === true;
  useEffect(() => {
    if (!landing || connected !== true || projects.length === 0) return;
    const only = projects.length === 1 ? projects[0] : undefined;
    onView(
      only !== undefined
        ? { at: "project", projectKey: only.projectKey, tab: "kanban" }
        : { at: "overview" },
    );
  }, [landing, connected, projects, onView]);

  useEffect(() => {
    if (connected !== true) return;
    if (chosenKey !== undefined) void store.loadLoopBoard(chosenKey);
    else for (const key of allKeys.split("\n")) if (key !== "") void store.loadLoopBoard(key);
  }, [store, chosenKey, connected, allKeys]);

  // Sessions that wait on an answer are part of the Notices: they are read again when that set changes.
  const waiting = useAppState((s) =>
    Object.values(s.sessions)
      .flat()
      .filter((x) => x.state === "requires_action")
      .map((x) => x.sessionId)
      .sort()
      .join(),
  );
  // The Notices are on the overview: every Project's, read when it opens, when that set changes, and every so often, so
  // a new Blocked or escalated ticket shows while the page is open, not only after Refresh.
  useEffect(() => {
    if (!onOverview || connected !== true) return;
    const read = () => {
      for (const key of allKeys.split("\n")) if (key !== "") void store.loadLoopNotices(key);
    };
    read();
    void waiting;
    const timer = setInterval(read, NOTICES_REFRESH_MS);
    return () => clearInterval(timer);
  }, [store, onOverview, connected, allKeys, waiting]);
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

  // Escape closes the ticket drawer (one level up). It does not leave the Loop mode: the sidebar's Sessions does. What is
  // drawn over the page (a dialog, a menu) takes its own Escape first, and the board's batch selection before this.
  const goBack = useRef(onBack);
  goBack.current = onBack;
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isComposing(event)) return;
      const target = event.target as Node | null;
      const inMain =
        target instanceof Element &&
        target.closest('[data-slot="main"], [data-slot="sidebar"]') !== null;
      if (target !== null && target !== document.body && !inMain) return;
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
            : t("loop.tab.kanban")}
        </span>
      </nav>
    );

  return (
    <>
      <header data-slot="session-header" data-empty-header="" data-kind="loop-header">
        {sidebarToggle}
        {heading}
      </header>
      {banner}
      {away ? (
        <div data-slot="loop-offline-banner">
          <StateBlock
            tone="away"
            size="inline"
            title={t("loop.offline.title")}
            body={t("loop.offline.body")}
            action={{ label: t("loop.reload"), onAction: () => void store.loadLoopProjects() }}
          />
        </div>
      ) : null}
      <div data-slot="page-body" data-full={chosen !== undefined ? "" : undefined}>
        {chosen !== undefined ? (
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
                onOpenProject={(key) => onView({ at: "project", projectKey: key, tab: "kanban" })}
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
