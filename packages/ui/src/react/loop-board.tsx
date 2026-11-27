// One Project's board (CYC-431), as the Loop server answers it. The layout and interaction follow SakaniUI's
// KanbanBoardBlock (https://www.sakaniui.com/docs/blocks/kanban-board, MIT, samzydd/Sakaniui): full-width toolbar with
// search and filters, side-by-side columns with dot + title + count, crisp elevated cards with badge + footer divider,
// and a floating selection dock at the bottom when awaiting-approval cards are picked. Only the visual and interaction
// patterns are borrowed: nothing of it is imported or copied, and none of its dragging, "Move to" menu or arrow-key
// moves is here, as they would move a ticket without the confirmation CYC-387 asks for. Tickets awaiting approval stay
// at the top of Backlog with an amber card badge and a quick Approve button (CYC-451); clicking any card opens a
// right-side drawer (`loop-ticket.tsx`) without losing board scroll or filter state. The columns are the server's own,
// in its order.
import { isComposing } from "@ui-sdk/core";
import { Button } from "@ui-sdk/react/button";
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@ui-sdk/react/menu";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  LoopActFailure,
  LoopBoardAnswer,
  LoopBoardColumn,
  LoopManyResult,
  LoopTicket,
} from "../api.ts";
import { ConfirmDialog } from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  ErrorCircleIcon,
  RefreshIcon,
  SearchIcon,
} from "./icons.tsx";
import { BatchBar } from "./loop-batch-bar.tsx";
import {
  type Act,
  PRIORITIES,
  PriorityBadge,
  priorityRank,
  TicketActions,
  TicketDrawer,
  TicketStage,
} from "./loop-ticket.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";

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
  selected,
  onTogglePick,
  onOpen,
}: {
  ticket: LoopTicket;
  subtasks?: readonly Child[] | undefined;
  act: Act;
  busyAction?: string | undefined;
  active: boolean;
  selected: boolean;
  onTogglePick?: (() => void) | undefined;
  onOpen: (identifier: string) => void;
}) {
  const { t } = useI18n();
  const isPending = ticket.pending !== undefined;
  const hasFooter = ticket.phase !== undefined || isPending;
  // The title button stretches over the whole card (CSS), so clicking anywhere on the card opens the drawer;
  // the checkbox and action buttons sit above it, so pressing them does not open it.
  return (
    <li
      data-slot="loop-ticket"
      data-id={ticket.identifier}
      data-pending={isPending ? "" : undefined}
      data-active={active ? "" : undefined}
      data-selected={selected ? "" : undefined}
    >
      <div data-slot="loop-ticket-head">
        <span data-slot="loop-ticket-lead">
          {isPending && onTogglePick !== undefined ? (
            <input
              type="checkbox"
              data-slot="loop-pending-pick"
              aria-label={`${t("loop.pending.pick")} ${ticket.identifier}`}
              checked={selected}
              onChange={onTogglePick}
            />
          ) : null}
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
  picked,
  onTogglePick,
  onSelectAllPending,
  allPendingSelected,
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
  picked?: ReadonlySet<string> | undefined;
  onTogglePick?: ((identifier: string) => void) | undefined;
  onSelectAllPending?: (() => void) | undefined;
  allPendingSelected?: boolean | undefined;
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
        {pendingCount !== undefined && pendingCount > 0 && onSelectAllPending !== undefined ? (
          <label data-slot="loop-column-select-all">
            <input
              type="checkbox"
              checked={allPendingSelected === true}
              onChange={onSelectAllPending}
            />
            {t("loop.pending.all")}
          </label>
        ) : null}
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
                selected={picked?.has(ticket.identifier) === true}
                onTogglePick={
                  ticket.pending !== undefined && onTogglePick !== undefined
                    ? () => onTogglePick(ticket.identifier)
                    : undefined
                }
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
  onBack,
  onChatStarted,
}: {
  projectKey: string;
  answer: LoopBoardAnswer | "loading" | undefined;
  /** The ticket whose drawer is open, if any: it is the Loop's navigation state, not the board's. */
  openIdentifier: string | undefined;
  onOpen: (identifier: string) => void;
  onBack: () => void;
  onChatStarted: () => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [priority, setPriority] = useState<PriorityFilter>("all");
  const [onlyPending, setOnlyPending] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [why, setWhy] = useState("");
  const [askingMany, setAskingMany] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchProblem, setBatchProblem] = useState<string | undefined>();
  const [batchOutcome, setBatchOutcome] = useState<LoopManyResult | undefined>();
  const [problem, setProblem] = useState<LoopActFailure | undefined>();
  const [busyAction, setBusyAction] = useState<string | undefined>();
  const [version, setVersion] = useState(0);
  const boardRef = useRef<HTMLDivElement>(null);
  const lastOpened = useRef<string | undefined>(undefined);

  // Restore focus to the ticket card that opened the drawer when the drawer closes.
  useEffect(() => {
    if (openIdentifier !== undefined) {
      lastOpened.current = openIdentifier;
      return;
    }
    const id = lastOpened.current;
    if (id === undefined) return;
    lastOpened.current = undefined;
    boardRef.current
      ?.querySelector<HTMLElement>(
        `[data-slot="loop-ticket"][data-id="${CSS.escape(id)}"] > [data-slot="loop-ticket-title"]`,
      )
      ?.focus();
  }, [openIdentifier]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await store.loadLoopBoard(projectKey);
    } finally {
      setRefreshing(false);
    }
  };

  const request = useAppState((s) => s.loop.request);
  // A pressed notification asks for its ticket once: it is taken (cleared) here, so reopening the page does not repeat it.
  useEffect(() => {
    if (request === undefined || request.projectKey !== projectKey) return;
    onOpen(request.identifier);
    store.takeLoopRequest(request.n);
  }, [request, projectKey, store, onOpen]);

  // Escape clears batch selection before reaching LoopMain (when no ticket drawer is open).
  useEffect(() => {
    if (picked.size === 0 || openIdentifier !== undefined) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isComposing(event)) return;
      if (document.querySelector('[role="alertdialog"], [role="dialog"]') !== null) return;
      event.preventDefault();
      setPicked(new Set());
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [picked.size, openIdentifier]);

  const act: Act = async (ticket, action, confirmed) => {
    const key = `${ticket.identifier}:${action}`;
    setProblem(undefined);
    setBusyAction(key);
    try {
      const result = await store.actOnLoopTicket(projectKey, ticket.identifier, action, confirmed);
      if (result.kind === "ok") {
        setVersion((v) => v + 1);
        return undefined;
      }
      if (action !== "approve") setProblem(result.reason);
      return t(`loop.fail.${result.reason}`);
    } finally {
      setBusyAction(undefined);
    }
  };

  const openTicket = (identifier: string) => {
    setProblem(undefined);
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

  const allPending = useMemo(() => {
    const list: LoopTicket[] = [];
    for (const c of columns) {
      if (c.stateType !== "backlog") continue;
      for (const tk of c.tickets) if (tk.pending !== undefined) list.push(tk);
    }
    return list.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
  }, [columns]);

  // If the filter was set to pending-only and all pending tickets were processed, turn it back off cleanly.
  useEffect(() => {
    if (onlyPending && allPending.length === 0) setOnlyPending(false);
  }, [onlyPending, allPending.length]);

  const chosen = useMemo(
    () => allPending.filter((x) => picked.has(x.identifier)),
    [allPending, picked],
  );

  const openSummary = useMemo(() => {
    if (openIdentifier === undefined) return undefined;
    for (const c of columns) {
      const hit = c.tickets.find((tk) => tk.identifier === openIdentifier);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }, [columns, openIdentifier]);

  // The drawer stays mounted after it is closed until its slide-out has played (CYC-506); a new ticket picked
  // meanwhile replaces it at once.
  const [held, setHeld] = useState<{ identifier: string; summary: LoopTicket | undefined }>();
  if (
    openIdentifier !== undefined &&
    (held?.identifier !== openIdentifier || held.summary !== openSummary)
  ) {
    setHeld({ identifier: openIdentifier, summary: openSummary });
  }
  const drawerId = openIdentifier ?? held?.identifier;
  const drawerSummary = openIdentifier !== undefined ? openSummary : held?.summary;
  const drawerClosing = openIdentifier === undefined;

  const togglePick = (identifier: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(identifier)) next.add(identifier);
      return next;
    });

  const selectAllPending = () => {
    const allSelected = allPending.length > 0 && chosen.length === allPending.length;
    setPicked(allSelected ? new Set() : new Set(allPending.map((x) => x.identifier)));
  };

  const runBatch = async (action: "approve_many" | "return_many"): Promise<string | undefined> => {
    setBatchBusy(true);
    setBatchOutcome(undefined);
    setBatchProblem(undefined);
    const result = await store.actOnLoopMany(
      projectKey,
      action,
      chosen.map((x) => x.identifier),
      true,
      action === "return_many" ? why : undefined,
    );
    setBatchBusy(false);
    if (result.kind === "failed") {
      const words = t(`loop.fail.${result.reason}`);
      setBatchProblem(words);
      return words;
    }
    setBatchOutcome(result);
    setPicked(new Set());
    if (action === "return_many") setWhy("");
    return undefined;
  };

  const alert =
    problem !== undefined ? (
      <div data-slot="loop-board-notice" data-tone="error" role="alert">
        <ErrorCircleIcon size={14} />
        <span>{t(`loop.fail.${problem}`)}</span>
        <Tip label={t("notice.dismiss")}>
          <Button
            data-variant="ghost"
            data-kind="loop-notice-dismiss"
            onClick={() => setProblem(undefined)}
          >
            <CloseIcon size={12} />
          </Button>
        </Tip>
      </div>
    ) : null;

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
  const filtered = q !== "" || priority !== "all" || onlyPending;
  const matches = (tk: LoopTicket) => {
    if (onlyPending && tk.pending === undefined) return false;
    if (priority !== "all" && tk.priority !== priority) return false;
    if (q === "") return true;
    return tk.identifier.toLowerCase().includes(q) || tk.title.toLowerCase().includes(q);
  };

  const outcomeCount = (kind: "ok" | "skipped" | "failed") =>
    batchOutcome?.kind === "done"
      ? batchOutcome.results.filter((r) => r.outcome === kind).length
      : 0;

  return (
    <div ref={boardRef} data-slot="loop-board" data-kind="loop-board">
      <div data-slot="loop-toolbar">
        <div data-slot="loop-toolbar-left">
          <div data-slot="loop-search">
            <SearchIcon size={14} />
            <input
              type="search"
              value={query}
              aria-label={t("loop.search")}
              placeholder={t("loop.search")}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !isComposing(event) && query !== "") {
                  event.preventDefault();
                  event.stopPropagation();
                  setQuery("");
                }
              }}
            />
            {query !== "" ? (
              <Tip label={t("loop.search.clear")}>
                <Button
                  data-variant="ghost"
                  data-kind="loop-search-clear"
                  onClick={() => setQuery("")}
                >
                  <CloseIcon size={12} />
                </Button>
              </Tip>
            ) : null}
          </div>

          {allPending.length > 0 ? (
            <button
              type="button"
              data-slot="loop-filter-chip"
              data-tone="attention"
              data-active={onlyPending ? "" : undefined}
              aria-pressed={onlyPending}
              onClick={() => setOnlyPending((v) => !v)}
            >
              <span data-slot="loop-pending-dot" aria-hidden="true" />
              <span>{t("loop.pending")}</span>
              <span data-slot="loop-filter-count">{allPending.length}</span>
            </button>
          ) : null}

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
                setOnlyPending(false);
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
      {batchProblem !== undefined ? (
        <div data-slot="loop-board-notice" data-tone="error" role="alert">
          <ErrorCircleIcon size={14} />
          <span>{batchProblem}</span>
          <Tip label={t("notice.dismiss")}>
            <Button
              data-variant="ghost"
              data-kind="loop-notice-dismiss"
              onClick={() => setBatchProblem(undefined)}
            >
              <CloseIcon size={12} />
            </Button>
          </Tip>
        </div>
      ) : null}
      {batchOutcome?.kind === "done" ? (
        <div data-slot="loop-board-notice" data-tone="info" role="status">
          <CheckIcon size={14} />
          <span>
            {t("loop.pending.done", {
              ok: outcomeCount("ok"),
              skipped: outcomeCount("skipped"),
              failed: outcomeCount("failed"),
            })}
          </span>
          <Tip label={t("notice.dismiss")}>
            <Button
              data-variant="ghost"
              data-kind="loop-notice-dismiss"
              onClick={() => setBatchOutcome(undefined)}
            >
              <CloseIcon size={12} />
            </Button>
          </Tip>
        </div>
      ) : null}

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
                    picked,
                    onTogglePick: togglePick,
                    onSelectAllPending: selectAllPending,
                    allPendingSelected:
                      allPending.length > 0 && chosen.length === allPending.length,
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

      <BatchBar
        chosen={chosen}
        totalPending={allPending.length}
        why={why}
        busy={batchBusy}
        onWhy={setWhy}
        onSelectAll={selectAllPending}
        onClear={() => setPicked(new Set())}
        onReturn={() => void runBatch("return_many")}
        onApprove={() => setAskingMany(true)}
      />

      {askingMany ? (
        <ConfirmDialog
          open
          onOpenChange={setAskingMany}
          title={t("loop.pending.approve.title", { count: chosen.length })}
          description={t("loop.pending.approve.body")}
          detail={chosen.map((x) => [x.identifier, x.title].join(" ")).join("\n")}
          confirmLabel={t("loop.pending.approve")}
          onConfirm={() => runBatch("approve_many")}
        />
      ) : null}

      {drawerId !== undefined ? (
        <TicketDrawer
          key={drawerId}
          projectKey={projectKey}
          identifier={drawerId}
          summary={drawerSummary}
          closing={drawerClosing}
          onExited={() => setHeld(undefined)}
          act={act}
          busyAction={busyAction}
          onChatStarted={onChatStarted}
          onClose={() => {
            setProblem(undefined);
            onBack();
          }}
          problem={alert}
          version={version}
        />
      ) : null}
    </div>
  );
}
