// The Loop page (CYC-386, CYC-387): the Projects the Loop server on this computer serves, and one Project's board. It
// takes the window in place of the sessions, as Connectors does. The Projects are the page's sections: with the server
// away they stay listed, greyed, and say so. The page only reads and shows what the Loop server answers (the board, the
// Notices) and asks it to approve or return a batch (`loop-board.tsx`, `loop-notices.tsx`, `loop-pending-group.tsx`).
import { Button } from "@ui-sdk/react/button";
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";
import { useEffect } from "react";
import type { LoopBoardColumn, LoopNotice, LoopProjectInfo } from "../api.ts";
import { useI18n } from "./i18n.tsx";
import { Board } from "./loop-board.tsx";
import { type LoopView, viewProject } from "./loop-nav.ts";
import { Notices } from "./loop-notices.tsx";
import { PageLayout, type PageSection } from "./page-layout.tsx";
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
const COLUMNS = ["doing", "todo", "backlog", "done"] as const;

/** The Loop overview: what needs the person, then one row per Project with its tickets per column. */
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
  const notices = projects
    .flatMap((p) => {
      const answer = noticeAnswers[p.projectKey];
      return answer?.kind === "ok"
        ? answer.notices.map((notice) => ({ projectKey: p.projectKey, notice }))
        : [];
    })
    .sort((a, b) => urgency(a.notice) - urgency(b.notice));
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
        <h3 data-slot="loop-column-title">{t("loop.projects")}</h3>
        <ul data-slot="loop-project-list">
          {projects.map((p) => {
            const board = boards[p.projectKey];
            return (
              <li key={p.projectKey} data-slot="loop-project-row" data-project={p.projectKey}>
                <button
                  type="button"
                  data-slot="loop-project-open"
                  disabled={away}
                  onClick={() => onOpenProject(p.projectKey)}
                >
                  <span data-slot="loop-project-name">{p.name}</span>
                  <span data-slot="loop-repo">{p.repo.displayName}</span>
                  {board === undefined || board === "loading" ? (
                    <span data-slot="loop-repo">{away ? "" : t("loop.loading")}</span>
                  ) : board.kind === "ok" ? (
                    <span data-slot="loop-project-counts">
                      {COLUMNS.map((c) => [c, countOf(board.columns, c)] as const)
                        .filter(([, n]) => n > 0)
                        .map(([c, n]) => (
                          <span key={c} data-slot="loop-project-count" data-column={c}>
                            {t(`loop.col.${c}`)} {n}
                          </span>
                        ))}
                    </span>
                  ) : null}
                </button>
                {board !== undefined && board !== "loading" && board.kind !== "ok" ? (
                  <span data-slot="loop-project-failed" data-kind="loop-project-failed">
                    <span data-slot="loop-problem">
                      {board.kind === "no_server"
                        ? t("loop.offline.title")
                        : t("loop.unreachable.title")}
                    </span>
                    <Button
                      data-variant="ghost"
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
      </section>
    </div>
  );
}

export function LoopPage({
  view,
  onView,
  onBack,
  onClose,
  banner,
}: {
  view: LoopView;
  onView: (view: LoopView) => void;
  /** One level up; out of the Loop from the top. */
  onBack: () => void;
  /** Out of the Loop whatever the level: a conversation about a ticket was started. */
  onClose: () => void;
  banner?: React.ReactNode;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const loop = useAppState((s) => s.loop);
  const { projects, connected } = loop;

  useEffect(() => {
    void store.loadLoopProjects();
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
  // a new Blocked or escalated ticket shows while the page is open, not only after Read again.
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

  const away = connected === false;
  const overview: PageSection = {
    id: "overview",
    label: t("loop.overview"),
    content:
      projects.length === 0 ? (
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
          onOpenTicket={(key, identifier) => onView({ at: "ticket", projectKey: key, identifier })}
        />
      ),
  };
  const sections: PageSection[] = [
    overview,
    ...projects.map((p) => ({
      id: p.projectKey,
      group: t("loop.projects"),
      label: p.name,
      note: away ? t("loop.offline.note") : p.projectKey,
      disabled: away,
      heading: (
        <nav data-slot="loop-crumbs" aria-label={t("loop.crumbs")}>
          <button
            type="button"
            data-slot="loop-crumb"
            onClick={() =>
              onView(
                view.at === "ticket"
                  ? { at: "project", projectKey: p.projectKey, tab: "kanban" }
                  : { at: "overview" },
              )
            }
          >
            {p.name}
          </button>
          <span aria-hidden="true">/</span>
          <span aria-current="page">
            {view.at === "ticket" && view.projectKey === p.projectKey
              ? view.identifier
              : view.at === "project" && view.tab === "overview"
                ? t("loop.tab.overview")
                : t("loop.tab.kanban")}
          </span>
        </nav>
      ),
      content: (
        <>
          {view.at === "project" && view.projectKey === p.projectKey ? (
            <div data-slot="loop-tabs">
              <SegmentedControl value={view.tab} aria-label={t("loop.tabs")}>
                <SegmentedControlIndicator />
                <SegmentedControlItem value="kanban">{t("loop.tab.kanban")}</SegmentedControlItem>
                <SegmentedControlItem value="overview" disabled>
                  {t("loop.tab.overview")}
                </SegmentedControlItem>
              </SegmentedControl>
              <span data-slot="loop-tab-note">{t("loop.tab.later")}</span>
            </div>
          ) : null}
          <Board
            projectKey={p.projectKey}
            answer={loop.boards[p.projectKey]}
            openIdentifier={
              view.at === "ticket" && view.projectKey === p.projectKey ? view.identifier : undefined
            }
            onOpen={(identifier) => onView({ at: "ticket", projectKey: p.projectKey, identifier })}
            onBack={onBack}
            onChatStarted={onClose}
          />
        </>
      ),
    })),
  ];

  return (
    <PageLayout
      title={t("loop.title")}
      sectionsLabel={t("loop.sections")}
      backLabel={t("settings.back")}
      onBack={onBack}
      banner={
        <>
          {banner}
          {away ? (
            <StateBlock
              tone="away"
              size="inline"
              title={t("loop.offline.title")}
              body={t("loop.offline.body")}
              action={{ label: t("loop.reload"), onAction: () => void store.loadLoopProjects() }}
            />
          ) : null}
        </>
      }
      sections={sections}
      value={chosenKey ?? "overview"}
      onValueChange={(key) =>
        onView(
          key === "overview"
            ? { at: "overview" }
            : { at: "project", projectKey: key, tab: "kanban" },
        )
      }
    />
  );
}
