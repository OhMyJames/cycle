import { Button } from "@ui-sdk/react/button";
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@ui-sdk/react/menu";
import { useMemo, useRef, useState } from "react";
import type { LoopBoardAnswer, LoopBoardColumn, LoopTicket } from "../api.ts";
import { useI18n } from "./i18n.tsx";
import { ChevronDownIcon, ChevronRightIcon, RefreshIcon } from "./icons.tsx";
import {
  type BacklogRow,
  backlogRows,
  filterRows,
  foldedByDefault,
  orderColumns,
  type Progress,
  pageRows,
  parentProgress,
  priorityRank,
} from "./loop-board-layout.ts";
import { GraphProgress } from "./loop-graph.tsx";
import { BoardAlerts, type RetryIntents } from "./loop-notices.tsx";
import {
  type Act,
  PRIORITIES,
  PriorityBadge,
  TicketActions,
  TicketStage,
  useTicketDrawer,
} from "./loop-ticket.tsx";
import { SearchField } from "./search-field.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";

type PriorityFilter = "all" | (typeof PRIORITIES)[number];

/** The Backlog is the longest column by far: it opens on this many and shows this many more at a time. */
const BACKLOG_PAGE = 20;

type BoardView = {
  projectKey: string;
  columns: ReadonlyMap<number, boolean>;
  groups: ReadonlySet<string>;
};

/** Started columns follow Loop's board-order convention: 1st In Progress, 2nd In Review, 3rd Blocked. */
type ColumnRole = "progress" | "review" | "blocked";
const columnRoleOf = (
  columns: readonly LoopBoardColumn[],
  column: LoopBoardColumn,
): ColumnRole | undefined => {
  if (column.stateType !== "started") return undefined;
  const started = columns.filter((c) => c.stateType === "started");
  const nth = started.findIndex((c) => c.id === column.id);
  return nth === 0 ? "progress" : nth === 1 ? "review" : nth === 2 ? "blocked" : undefined;
};

function TicketCard({
  ticket,
  progress,
  hideParent,
  act,
  busyAction,
  active,
  onOpen,
}: {
  ticket: LoopTicket;
  /** Read-only done/total of the tickets under this one, shown in the foot. */
  progress?: Progress | undefined;
  /** Inside a group the head already names the parent. */
  hideParent?: boolean | undefined;
  act: Act;
  busyAction?: string | undefined;
  active: boolean;
  onOpen: (identifier: string) => void;
}) {
  const { t } = useI18n();
  const isPending = ticket.pending !== undefined;
  const hasFooter =
    ticket.phase !== undefined || isPending || ticket.graph !== undefined || progress !== undefined;
  // The title button stretches over the whole card (CSS), so clicking anywhere on the card opens the drawer;
  // the checkbox and action buttons sit above it, so pressing them does not open it.
  return (
    <li
      data-slot="loop-ticket"
      data-id={ticket.identifier}
      data-pending={isPending ? "" : undefined}
      data-active={active ? "" : undefined}
    >
      <div data-slot="loop-ticket-head">
        <span data-slot="loop-ticket-lead">
          <span data-slot="loop-ticket-id">{ticket.identifier}</span>
          {ticket.type ? <span data-slot="loop-ticket-type">{ticket.type}</span> : null}
          {ticket.parent && hideParent !== true ? (
            <button
              type="button"
              data-slot="loop-ticket-parent"
              title={ticket.parent.title}
              aria-label={`${t("loop.parent")} ${ticket.parent.identifier}`}
              onClick={() => onOpen(ticket.parent?.identifier ?? "")}
            >
              ↑ {ticket.parent.identifier}
            </button>
          ) : null}
        </span>
        <span data-slot="loop-ticket-badges">
          {isPending ? (
            <span data-slot="loop-pending-badge">
              <span data-slot="loop-pending-dot" aria-hidden="true" />
              {t("loop.pending")}
            </span>
          ) : (
            <PriorityBadge priority={ticket.priority} />
          )}
        </span>
      </div>
      <button
        type="button"
        data-slot="loop-ticket-title"
        title={ticket.title}
        onClick={() => onOpen(ticket.identifier)}
      >
        <span data-slot="loop-ticket-text">{ticket.title}</span>
      </button>
      {ticket.pending?.reason ? (
        <p data-slot="loop-pending-reason">{ticket.pending.reason}</p>
      ) : null}
      {hasFooter ? (
        <div data-slot="loop-ticket-foot">
          <span data-slot="loop-ticket-foot-meta">
            {isPending ? <PriorityBadge priority={ticket.priority} /> : null}
            {ticket.phase ? <TicketStage phase={ticket.phase} /> : null}
            {ticket.graph ? <GraphProgress graph={ticket.graph} /> : null}
            {progress ? (
              <span data-slot="loop-ticket-progress">
                {t("loop.group.progress", { done: progress.done, total: progress.total })}
              </span>
            ) : null}
          </span>
          {isPending ? (
            // A ticket the server lists as waiting can be approved: the board does not ask for the other buttons.
            <TicketActions
              ticket={{ ...ticket, actions: ["approve"] }}
              act={act}
              busyAction={busyAction}
              quick
            />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** A Backlog group: the head (arrow folds, title opens the head's drawer) and, when open, the children under it. */
function GroupRow({
  row,
  open,
  onToggle,
  progressOf,
  act,
  busyAction,
  openIdentifier,
  onOpen,
}: {
  row: Extract<BacklogRow, { kind: "group" }>;
  open: boolean;
  onToggle: () => void;
  progressOf: ReadonlyMap<string, Progress>;
  act: Act;
  busyAction?: string | undefined;
  openIdentifier?: string | undefined;
  onOpen: (identifier: string) => void;
}) {
  const { t } = useI18n();
  const { head, progress } = row;
  return (
    <li data-slot="loop-group" data-key={row.key} data-open={open ? "" : undefined}>
      <div data-slot="loop-group-head">
        <button
          type="button"
          data-slot="loop-group-toggle"
          aria-expanded={open}
          aria-label={t("loop.group.toggle", { id: head.identifier })}
          onClick={onToggle}
        >
          {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        </button>
        <span data-slot="loop-ticket-id">{head.identifier}</span>
        {head.ticket?.type ? <span data-slot="loop-ticket-type">{head.ticket.type}</span> : null}
        {progress ? (
          <span data-slot="loop-group-progress">
            {t("loop.group.progress", { done: progress.done, total: progress.total })}
          </span>
        ) : null}
        {head.ticket ? <PriorityBadge priority={head.ticket.priority} /> : null}
        <button
          type="button"
          data-slot="loop-group-title"
          title={head.title}
          onClick={() => onOpen(head.identifier)}
        >
          {head.title}
        </button>
        {row.elsewhere ? (
          <span data-slot="loop-group-note">{t("loop.group.elsewhere")}</span>
        ) : null}
      </div>
      {open ? (
        <ul data-slot="loop-group-children">
          {row.children.map((ticket) => (
            <TicketCard
              key={ticket.identifier}
              ticket={ticket}
              progress={progressOf.get(ticket.identifier)}
              hideParent
              act={act}
              busyAction={busyAction}
              active={openIdentifier === ticket.identifier}
              onOpen={onOpen}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function Column({
  id,
  title,
  stateType,
  role,
  rows,
  ticketCount,
  totalCount,
  more,
  filtered,
  pageSize,
  openIdentifier,
  pendingCount,
  progressOf,
  collapsed,
  canHide,
  onFold,
  groupOpen,
  onToggleGroup,
  act,
  busyAction,
  onOpen,
}: {
  id: number;
  title: string;
  stateType: string;
  role?: ColumnRole | undefined;
  /** What the column shows, top to bottom: cards, and (Backlog only) groups. */
  rows: BacklogRow[];
  /** How many tickets `rows` hold. */
  ticketCount: number;
  totalCount: number;
  more?: boolean;
  filtered?: boolean;
  pageSize?: number;
  openIdentifier?: string | undefined;
  pendingCount?: number | undefined;
  progressOf: ReadonlyMap<string, Progress>;
  collapsed: boolean;
  /** An open column that starts folded can be folded again. */
  canHide: boolean;
  onFold: (fold: boolean) => void;
  groupOpen: (key: string) => boolean;
  onToggleGroup: (key: string, open: boolean) => void;
  act: Act;
  busyAction?: string | undefined;
  onOpen: (identifier: string) => void;
}) {
  const { t } = useI18n();
  const [limit, setLimit] = useState(pageSize ?? Number.POSITIVE_INFINITY);
  const { shown, hidden } = pageRows(rows, limit);
  const countLabel =
    filtered === true && ticketCount !== totalCount
      ? `${ticketCount}/${totalCount}`
      : more === true
        ? `${totalCount}+`
        : `${totalCount}`;
  if (collapsed) {
    return (
      <section
        data-slot="loop-column"
        data-collapsed=""
        data-column={id}
        data-state-type={stateType}
        data-role={role}
        aria-label={title}
      >
        <button
          type="button"
          data-slot="loop-column-fold"
          aria-expanded={false}
          aria-label={t("loop.column.show", { name: title })}
          onClick={() => onFold(false)}
        >
          <span data-slot="loop-column-dot" aria-hidden="true" />
          <span data-slot="loop-column-title">{title}</span>
          <span data-slot="loop-column-count">{countLabel}</span>
        </button>
      </section>
    );
  }
  return (
    <section
      data-slot="loop-column"
      data-column={id}
      data-state-type={stateType}
      data-role={role}
      aria-label={title}
    >
      <header data-slot="loop-column-head">
        <span data-slot="loop-column-dot" aria-hidden="true" />
        <h3 data-slot="loop-column-title">{title}</h3>
        <span data-slot="loop-column-count">{countLabel}</span>
        {canHide ? (
          <button
            type="button"
            data-slot="loop-column-hide"
            aria-expanded={true}
            aria-label={t("loop.column.hide", { name: title })}
            onClick={() => onFold(true)}
          >
            <ChevronRightIcon size={12} />
          </button>
        ) : null}
      </header>
      <div data-slot="loop-column-body">
        {rows.length === 0 ? (
          <p data-slot="loop-column-empty">
            {filtered === true ? t("loop.filter.empty") : t("loop.column.empty")}
          </p>
        ) : (
          <ul data-slot="loop-tickets">
            {shown.map((row) =>
              row.kind === "card" ? (
                <TicketCard
                  key={row.ticket.identifier}
                  ticket={row.ticket}
                  progress={progressOf.get(row.ticket.identifier)}
                  act={act}
                  busyAction={busyAction}
                  active={openIdentifier === row.ticket.identifier}
                  onOpen={onOpen}
                />
              ) : (
                <GroupRow
                  key={`group:${row.key}`}
                  row={row}
                  open={groupOpen(row.key)}
                  onToggle={() => onToggleGroup(row.key, !groupOpen(row.key))}
                  progressOf={progressOf}
                  act={act}
                  busyAction={busyAction}
                  openIdentifier={openIdentifier}
                  onOpen={onOpen}
                />
              ),
            )}
          </ul>
        )}
        {hidden > 0 && pageSize !== undefined ? (
          <Button
            data-variant="ghost"
            data-kind="loop-more"
            onClick={() => setLimit((n) => n + pageSize)}
          >
            {t("loop.more", { count: hidden })}
          </Button>
        ) : null}
        {more === true && pendingCount !== undefined && pendingCount > 0 ? (
          <p data-slot="loop-column-note">{t("loop.pending.more")}</p>
        ) : null}
      </div>
    </section>
  );
}

/** The columns' places while the board is loaded: four columns with card skeletons matching SakaniUI's loading state. */
function BoardSkeleton() {
  const { t } = useI18n();
  return (
    <div data-slot="loop-board" data-kind="loop-board" aria-busy="true">
      <div data-slot="loop-columns" role="status" aria-label={t("loop.loading")}>
        {[0, 1, 2].map((c) => (
          <div key={c} data-slot="loop-column" data-skeleton="">
            <div data-slot="loop-column-head">
              <span data-slot="loop-skeleton" data-size="title" />
            </div>
            <div data-slot="loop-column-body">
              <ul data-slot="loop-tickets">
                {[0, 1, 2].map((i) => (
                  <li key={i} data-slot="loop-ticket" data-skeleton="">
                    <span data-slot="loop-skeleton" data-size="id" />
                    <span data-slot="loop-skeleton" data-size="line" />
                    <span data-slot="loop-skeleton" data-size="line-short" />
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Board({
  projectKey,
  answer,
  openIdentifier,
  onOpen,
  onOpenConsole,
  onBack,
  onChatStarted,
}: {
  projectKey: string;
  answer: LoopBoardAnswer | "loading" | undefined;
  /** The ticket whose drawer is open, if any: it is the Loop's navigation state, not the board's. */
  openIdentifier: string | undefined;
  onOpen: (identifier: string) => void;
  onOpenConsole?: (() => void) | undefined;
  onBack: () => void;
  onChatStarted: () => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [priority, setPriority] = useState<PriorityFilter>("all");
  const boardRef = useRef<HTMLDivElement>(null);
  const { drawer, act, busyAction, alert, clearProblem } = useTicketDrawer(
    projectKey,
    openIdentifier,
    onOpen,
    onBack,
    onChatStarted,
  );

  const refresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([store.loadLoopBoard(projectKey), store.loadLoopNotices(projectKey)]);
    } finally {
      setRefreshing(false);
    }
  };

  const noticesAnswer = useAppState((s) => s.loop.notices[projectKey]);
  const projectNotices = noticesAnswer?.kind === "ok" ? noticesAnswer.notices : [];
  const retryIntents: RetryIntents = async (key, identifier) => {
    const result = await store.retryLoopIntents(key, identifier);
    if (result.kind === "failed") return { ok: false, message: t(`loop.fail.${result.reason}`) };
    return {
      ok: true,
      message:
        result.retried > 0
          ? t("loop.notices.retried", { count: result.retried })
          : t("loop.notices.retryNone"),
    };
  };

  const openTicket = (identifier: string) => {
    clearProblem();
    onOpen(identifier);
  };

  const columns =
    answer !== undefined && answer !== "loading" && answer.kind === "ok" ? answer.columns : [];
  // Columns left to right by state; other consumers (pending counts, ticket lookup) deliberately use server order.
  const displayColumns = useMemo(() => orderColumns(columns), [columns]);
  const folded = useMemo(() => foldedByDefault(columns), [columns]);
  const progressOf = useMemo(() => parentProgress(columns), [columns]);

  // What a person opened or folded by hand, for this project only: switching project starts over.
  const fresh = (key: string): BoardView => ({
    projectKey: key,
    columns: new Map(),
    groups: new Set(),
  });
  const [view, setView] = useState<BoardView>(() => fresh(projectKey));
  const mine = view.projectKey === projectKey ? view : fresh(projectKey);
  if (mine !== view) setView(mine);
  const isCollapsed = (id: number) => mine.columns.get(id) ?? folded.has(id);
  const setCollapsed = (id: number, collapsed: boolean) =>
    setView({ ...mine, columns: new Map(mine.columns).set(id, collapsed) });
  const setGroupOpen = (key: string, open: boolean) => {
    const groups = new Set(mine.groups);
    if (open) groups.add(key);
    else groups.delete(key);
    setView({ ...mine, groups });
  };

  if (answer === undefined || answer === "loading") return <BoardSkeleton />;
  if (answer.kind === "no_server")
    return (
      <div data-slot="loop-board-state">
        <StateBlock
          tone="away"
          title={t("loop.offline.title")}
          body={t("loop.offline.body")}
          action={{ label: t("loop.reload"), onAction: () => void refresh() }}
        />
      </div>
    );
  if (answer.kind === "unreachable")
    return (
      <div data-slot="loop-board-state">
        <StateBlock
          tone="error"
          title={t("loop.unreachable.title")}
          body={t("loop.unreachable.body")}
          action={{ label: t("loop.reload"), onAction: () => void refresh() }}
        />
      </div>
    );

  const q = query.trim().toLowerCase();
  const filtered = q !== "" || priority !== "all";
  const matches = (tk: LoopTicket) => {
    if (priority !== "all" && tk.priority !== priority) return false;
    if (q === "") return true;
    return tk.identifier.toLowerCase().includes(q) || tk.title.toLowerCase().includes(q);
  };

  return (
    <div ref={boardRef} data-slot="loop-board" data-kind="loop-board">
      <div data-slot="loop-toolbar">
        <div data-slot="loop-toolbar-left">
          <SearchField value={query} onChange={setQuery} label={t("loop.search")} />

          <Menu>
            <MenuTrigger
              data-variant="outline"
              data-kind="loop-priority-filter"
              data-active={priority !== "all" ? "" : undefined}
            >
              <span>
                {priority === "all"
                  ? t("loop.filter.priority")
                  : `${t("loop.filter.priority")}: ${t(`loop.priority.${priority}`)}`}
              </span>
              <ChevronDownIcon size={12} />
            </MenuTrigger>
            <MenuContent>
              <MenuRadioGroup
                value={priority}
                onValueChange={(next) => setPriority(next as PriorityFilter)}
              >
                <MenuRadioItem value="all">{t("loop.filter.all")}</MenuRadioItem>
                {PRIORITIES.map((p) => (
                  <MenuRadioItem key={p} value={p}>
                    {t(`loop.priority.${p}`)}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuContent>
          </Menu>

          {filtered ? (
            <Button
              data-variant="ghost"
              data-kind="loop-filter-clear"
              onClick={() => {
                setQuery("");
                setPriority("all");
              }}
            >
              {t("loop.filter.clear")}
            </Button>
          ) : null}
        </div>

        <div data-slot="loop-toolbar-right">
          {answer.stale ? (
            <span data-slot="loop-hint" data-kind="loop-stale" role="status">
              {t("loop.stale")}
            </span>
          ) : null}
          <Button
            data-variant="outline"
            data-kind="loop-refresh"
            data-busy={refreshing ? "" : undefined}
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            <RefreshIcon size={14} />
            <span>{t("loop.reload")}</span>
          </Button>
        </div>
      </div>

      {openIdentifier === undefined ? alert : null}
      <BoardAlerts
        projectKey={projectKey}
        notices={projectNotices}
        onRetryIntents={retryIntents}
        onOpenConsole={onOpenConsole}
        onOpen={(notice) => {
          store.track("loop_notice_opened", { kind: notice.kind, from: "board" });
          if (notice.session === null || !store.joinLoopSession(notice.session.id)) {
            if (notice.identifier !== null) openTicket(notice.identifier);
          }
        }}
      />
      <div data-slot="loop-columns">
        {displayColumns.map((c) => {
          const isBacklog = c.stateType === "backlog";
          const byPriority = (list: LoopTicket[]) =>
            [...list].sort((x, y) => priorityRank(x.priority) - priorityRank(y.priority));
          const cards = (list: LoopTicket[]): BacklogRow[] =>
            list.map((ticket) => ({ kind: "card", ticket }));
          // Done and Canceled keep the server's most-recent-first order; every open column sorts by priority (stable).
          let rows: BacklogRow[];
          if (isBacklog) {
            rows = backlogRows(c.tickets, columns);
            if (filtered) rows = filterRows(rows, matches);
          } else {
            const ordered =
              c.stateType === "completed" || c.stateType === "canceled"
                ? c.tickets
                : byPriority(c.tickets);
            rows = cards(filtered ? ordered.filter(matches) : ordered);
          }
          const ticketCount = rows.reduce(
            (n, r) =>
              n +
              (r.kind === "card" ? 1 : r.children.length + (r.head.ticket !== undefined ? 1 : 0)),
            0,
          );
          const colPending = rows.filter((r) => r.kind === "card" && r.ticket.pending).length;
          return (
            <Column
              key={c.id}
              id={c.id}
              title={c.name}
              stateType={c.stateType}
              role={columnRoleOf(columns, c)}
              rows={rows}
              ticketCount={ticketCount}
              totalCount={c.tickets.length}
              more={c.more}
              filtered={filtered}
              openIdentifier={openIdentifier}
              {...(isBacklog ? { pageSize: BACKLOG_PAGE, pendingCount: colPending } : {})}
              progressOf={progressOf}
              collapsed={isCollapsed(c.id)}
              canHide={folded.has(c.id)}
              onFold={(fold) => setCollapsed(c.id, fold)}
              // A filter opens the groups it leaves; clearing it brings back what the person had set.
              groupOpen={(key) => filtered || mine.groups.has(key)}
              onToggleGroup={setGroupOpen}
              act={act}
              busyAction={busyAction}
              onOpen={openTicket}
            />
          );
        })}
      </div>

      {drawer}
    </div>
  );
}
