import { Button } from "@ui-sdk/react/button";
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@ui-sdk/react/menu";
import { useMemo, useRef, useState } from "react";
import type { LoopBoardAnswer, LoopBoardColumn, LoopTicket } from "../api.ts";
import { useI18n } from "./i18n.tsx";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, RefreshIcon } from "./icons.tsx";
import { priorityRank } from "./loop-board-layout.ts";
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

/** One sub-ticket of a parent card, with the state of the column it sits in. */
type Child = {
  identifier: string;
  title: string;
  stateType: string;
  role: ColumnRole | undefined;
  done: boolean;
};

/** `parent identifier -> its sub-tickets`, from every column (not only the ones shown), in board order. */
const childrenByParent = (columns: readonly LoopBoardColumn[]): ReadonlyMap<string, Child[]> => {
  const map = new Map<string, Child[]>();
  for (const c of columns) {
    const role = columnRoleOf(columns, c);
    for (const tk of c.tickets) {
      const parent = tk.parent?.identifier;
      if (parent === undefined) continue;
      const list = map.get(parent) ?? [];
      list.push({
        identifier: tk.identifier,
        title: tk.title,
        stateType: c.stateType,
        role,
        done: c.stateType === "completed",
      });
      map.set(parent, list);
    }
  }
  return map;
};

/** The foldable sub-ticket list at the bottom of a parent card. Its controls sit above the card-wide title button. */
function SubtaskList({ items, onOpen }: { items: readonly Child[]; onOpen: (id: string) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const done = items.filter((x) => x.done).length;
  return (
    <div data-slot="loop-subtasks" data-open={open || undefined}>
      <button
        type="button"
        data-slot="loop-subtasks-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        <span>{t("loop.subtasks")}</span>
        <span data-slot="loop-subtasks-count">
          {done}/{items.length}
        </span>
      </button>
      {open ? (
        <ul data-slot="loop-subtask-list">
          {items.map((c) => (
            <li key={c.identifier}>
              <button
                type="button"
                data-slot="loop-subtask"
                data-id={c.identifier}
                data-state-type={c.stateType}
                data-role={c.role}
                data-done={c.done ? "" : undefined}
                title={c.title}
                onClick={() => onOpen(c.identifier)}
              >
                <span data-slot="loop-subtask-dot" aria-hidden="true">
                  {c.done ? <CheckIcon size={10} /> : null}
                </span>
                <span data-slot="loop-subtask-id">{c.identifier}</span>
                <span data-slot="loop-subtask-title">{c.title}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function TicketCard({
  ticket,
  subtasks,
  act,
  busyAction,
  active,
  onOpen,
}: {
  ticket: LoopTicket;
  subtasks?: readonly Child[] | undefined;
  act: Act;
  busyAction?: string | undefined;
  active: boolean;
  onOpen: (identifier: string) => void;
}) {
  const { t } = useI18n();
  const isPending = ticket.pending !== undefined;
  const hasFooter = ticket.phase !== undefined || isPending || ticket.graph !== undefined;
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
          {ticket.parent ? (
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
      {subtasks !== undefined && subtasks.length > 0 ? (
        <SubtaskList items={subtasks} onOpen={onOpen} />
      ) : null}
    </li>
  );
}

function Column({
  id,
  title,
  stateType,
  role,
  tickets,
  totalCount,
  more,
  filtered,
  pageSize,
  openIdentifier,
  pendingCount,
  childrenOf,
  act,
  busyAction,
  onOpen,
}: {
  id: number;
  title: string;
  stateType: string;
  role?: ColumnRole | undefined;
  tickets: LoopTicket[];
  totalCount: number;
  more?: boolean;
  filtered?: boolean;
  pageSize?: number;
  openIdentifier?: string | undefined;
  pendingCount?: number | undefined;
  childrenOf?: ReadonlyMap<string, Child[]> | undefined;
  act: Act;
  busyAction?: string | undefined;
  onOpen: (identifier: string) => void;
}) {
  const { t } = useI18n();
  const [shown, setShown] = useState(pageSize ?? Number.POSITIVE_INFINITY);
  const visible = tickets.slice(0, shown);
  const countLabel =
    filtered === true && tickets.length !== totalCount
      ? `${tickets.length}/${totalCount}`
      : more === true
        ? `${totalCount}+`
        : `${totalCount}`;
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
      </header>
      <div data-slot="loop-column-body">
        {tickets.length === 0 ? (
          <p data-slot="loop-column-empty">
            {filtered === true ? t("loop.filter.empty") : t("loop.column.empty")}
          </p>
        ) : (
          <ul data-slot="loop-tickets">
            {visible.map((ticket) => (
              <TicketCard
                key={ticket.identifier}
                ticket={ticket}
                subtasks={childrenOf?.get(ticket.identifier)}
                act={act}
                busyAction={busyAction}
                active={openIdentifier === ticket.identifier}
                onOpen={onOpen}
              />
            ))}
          </ul>
        )}
        {visible.length < tickets.length && pageSize !== undefined ? (
          <Button
            data-variant="ghost"
            data-kind="loop-more"
            onClick={() => setShown((n) => n + pageSize)}
          >
            {t("loop.more", { count: tickets.length - visible.length })}
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
  // Done (completed) columns sit last; every other column keeps the server's order.
  // Other consumers (pending counts, ticket lookup) deliberately use server order.
  const displayColumns = useMemo(
    () => [
      ...columns.filter((c) => c.stateType !== "completed"),
      ...columns.filter((c) => c.stateType === "completed"),
    ],
    [columns],
  );

  const childrenOf = useMemo(() => childrenByParent(columns), [columns]);

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
          // In Backlog, keep awaiting-approval tickets pinned at the top sorted by priority,
          // followed by ordinary Backlog tickets — marked by card badge, never wrapped in a box.
          const byPriority = (list: LoopTicket[]) =>
            [...list].sort((x, y) => priorityRank(x.priority) - priorityRank(y.priority));
          // Done keeps the server's most-recent-first order; every open column sorts by priority (stable).
          const ordered =
            c.stateType === "completed"
              ? c.tickets
              : isBacklog
                ? [
                    ...byPriority(c.tickets.filter((x) => x.pending !== undefined)),
                    ...byPriority(c.tickets.filter((x) => x.pending === undefined)),
                  ]
                : byPriority(c.tickets);
          const shownTickets = filtered ? ordered.filter(matches) : ordered;
          const colPending = isBacklog
            ? shownTickets.filter((x) => x.pending !== undefined).length
            : 0;
          return (
            <Column
              key={c.id}
              id={c.id}
              title={c.name}
              stateType={c.stateType}
              role={columnRoleOf(columns, c)}
              tickets={shownTickets}
              totalCount={c.tickets.length}
              more={c.more}
              filtered={filtered}
              openIdentifier={openIdentifier}
              {...(isBacklog
                ? {
                    pageSize: BACKLOG_PAGE,
                    pendingCount: colPending,
                  }
                : {})}
              childrenOf={childrenOf}
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
