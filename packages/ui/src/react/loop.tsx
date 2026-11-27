// The Loop page (CYC-386, CYC-387): the Projects the Loop server on this computer serves, and one Project's itsaplan
// board. It takes the window in place of the sessions, as Connectors does. The Projects are the page's sections: with
// the server away they stay listed, greyed, and say so. A ticket changes state only by a button (approve, back to
// Backlog, back to Todo; never by dragging); which buttons it has is decided by main, and approving asks first.
//
// The board's layout and interaction (CYC-431) follow SakaniUI's KanbanBoardBlock
// (https://www.sakaniui.com/docs/blocks/kanban-board, MIT, samzydd/Sakaniui): full-width toolbar with search and
// filters, side-by-side columns with dot + title + count, crisp elevated cards with badge + footer divider, and a
// floating selection dock at the bottom when awaiting-approval cards are picked. Only the visual and interaction
// patterns are borrowed: nothing of it is imported or copied, and none of its dragging, "Move to" menu or arrow-key
// moves is here, as they would move a ticket without the confirmation CYC-387 asks for. Tickets awaiting approval stay
// at the top of Backlog with an amber card badge and quick Approve button (CYC-451); clicking any card opens a
// right-side drawer without losing board scroll or filter state. The columns are itsaplan's own, in its order.
import { isComposing } from "@ui-sdk/core";
import { Button } from "@ui-sdk/react/button";
import { Input } from "@ui-sdk/react/input";
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@ui-sdk/react/menu";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type {
  LoopActFailure,
  LoopAction,
  LoopBoardAnswer,
  LoopBoardColumn,
  LoopChatFailure,
  LoopManyResult,
  LoopNotice,
  LoopProjectInfo,
  LoopTicket,
  LoopTicketDetail,
} from "../api.ts";
import { AgentLink } from "./agent-link.tsx";
import { ConfirmDialog } from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  ErrorCircleIcon,
  MessageIcon,
  RefreshIcon,
  SearchIcon,
  ShieldAlertIcon,
  WarningIcon,
} from "./icons.tsx";
import { type LoopView, viewProject } from "./loop-nav.ts";
import { Markdown } from "./markdown.tsx";
import { useNow } from "./now.ts";
import { PageGroup, PageLayout, PageRows, type PageSection } from "./page-layout.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";

/** The Backlog is the longest column by far: it opens on this many and shows this many more at a time. */
const BACKLOG_PAGE = 20;

/** How often the Notices are read again while the page is open. */
const NOTICES_REFRESH_MS = 30_000;

/** Longer than this on one step, and the stage line asks to be looked at. */
const STAGE_SLOW_MS = 30 * 60_000;

const ESCAPE_KEY = "Esc";

const PRIORITIES = ["urgent", "high", "medium", "low"] as const;
type PriorityFilter = "all" | (typeof PRIORITIES)[number];

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const priorityRank = (p: string | null): number => PRIORITY_RANK[p ?? ""] ?? 4;

/** Items with keys that stay unique when two read the same: the text, and how many came before with it. */
const keyedItems = (items: string[]) => {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const n = seen.get(item) ?? 0;
    seen.set(item, n + 1);
    return { key: `${item}#${n}`, item };
  });
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

type Act = (
  ticket: LoopTicket,
  action: LoopAction,
  confirmed?: boolean,
) => Promise<string | undefined>;

function PriorityBadge({ priority }: { priority: string | null }) {
  const { t } = useI18n();
  if (priority === null) return null;
  const known = (PRIORITIES as readonly string[]).includes(priority);
  return (
    <span data-slot="loop-priority" data-priority={known ? priority : "other"}>
      {known ? t(`loop.priority.${priority}`) : priority}
    </span>
  );
}

/** The buttons of one ticket. Approving asks first; the others go ahead and report only a failure. */
function TicketActions({
  ticket,
  act,
  surface = "card",
  busyAction,
}: {
  ticket: LoopTicket;
  act: Act;
  surface?: "card" | "drawer";
  busyAction?: string | undefined;
}) {
  const { t } = useI18n();
  const [asking, setAsking] = useState(false);
  if (ticket.actions.length === 0) return null;
  const isPending = ticket.pending !== undefined;
  return (
    <span data-slot="loop-ticket-actions" data-surface={surface}>
      {ticket.actions.map((action) => {
        const key = `${ticket.identifier}:${action}`;
        const busy = busyAction === key;
        const variant =
          surface === "drawer" ? (action === "approve" ? "solid" : "outline") : "ghost";
        return (
          <Button
            key={action}
            data-variant={variant}
            data-kind={`loop-${action}`}
            data-quick={action === "approve" && isPending ? "" : undefined}
            disabled={busyAction !== undefined}
            data-busy={busy ? "" : undefined}
            aria-label={`${t(`loop.act.${action}`)} ${ticket.identifier}`}
            onClick={() => (action === "approve" ? setAsking(true) : void act(ticket, action))}
          >
            {action === "approve" && (surface === "drawer" || isPending) ? (
              <CheckIcon size={12} />
            ) : null}
            <span>{t(`loop.act.${action}`)}</span>
          </Button>
        );
      })}
      {asking ? (
        <ConfirmDialog
          open
          onOpenChange={setAsking}
          title={t("loop.approve.title", { id: ticket.identifier })}
          description={t("loop.approve.body")}
          detail={ticket.title}
          confirmLabel={t("loop.act.approve")}
          onConfirm={() => act(ticket, "approve", true)}
        />
      ) : null}
    </span>
  );
}

/** Where Loop is on an In Progress ticket and for how long: "QA · 3 min". */
function TicketStage({ stage }: { stage: NonNullable<LoopTicket["loopStage"]> }) {
  const { t } = useI18n();
  const now = useNow();
  const since = Date.parse(stage.since);
  if (Number.isNaN(since)) return null;
  const ms = Math.max(0, now - since);
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const length =
    hours > 0
      ? t("loop.stage.hoursMinutes", { hours, minutes: minutes % 60 })
      : t("loop.stage.minutes", { minutes });
  return (
    <span data-slot="loop-ticket-stage" data-slow={ms > STAGE_SLOW_MS ? "true" : undefined}>
      <span data-slot="loop-stage-dot" aria-hidden="true" />
      {t("loop.stage.line", { stage: t(`loop.stage.${stage.stage}`), length })}
    </span>
  );
}

function TicketCard({
  ticket,
  act,
  busyAction,
  active,
  selected,
  onTogglePick,
  onOpen,
}: {
  ticket: LoopTicket;
  act: Act;
  busyAction?: string | undefined;
  active: boolean;
  selected: boolean;
  onTogglePick?: (() => void) | undefined;
  onOpen: (identifier: string) => void;
}) {
  const { t } = useI18n();
  const isPending = ticket.pending !== undefined;
  const hasCriteria = ticket.pending?.criteria !== undefined;
  const hasFooter =
    ticket.loopStage !== undefined ||
    hasCriteria ||
    (isPending && ticket.priority !== null) ||
    ticket.actions.length > 0;
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
            {ticket.loopStage ? <TicketStage stage={ticket.loopStage} /> : null}
            {hasCriteria && ticket.pending?.criteria !== undefined ? (
              <span data-slot="loop-ticket-criteria">
                {t("loop.pending.criteria", { count: ticket.pending.criteria })}
              </span>
            ) : null}
          </span>
          <TicketActions ticket={ticket} act={act} busyAction={busyAction} />
        </div>
      ) : null}
    </li>
  );
}

/** What the person can do with an agent on this ticket: start a conversation, or only look when Loop has it. */
function TicketChat({
  projectKey,
  ticket,
  onStarted,
}: {
  projectKey: string;
  ticket: LoopTicketDetail;
  onStarted: () => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<LoopChatFailure | undefined>();
  const [orphan, setOrphan] = useState<{ locationId: string; sessionId: string } | undefined>();
  if (ticket.chat === "none") return null;
  if (ticket.chat === "watch")
    return (
      <p data-slot="loop-chat-note" data-kind="loop-watch">
        {t("loop.chat.watch")}
      </p>
    );
  const start = async () => {
    setBusy(true);
    setFailure(undefined);
    setOrphan(undefined);
    const result = await store.chatAboutLoopTicket(projectKey, ticket.identifier);
    setBusy(false);
    if (result.kind === "failed") {
      setFailure(result.reason);
      if (result.sessionId !== undefined && result.locationId !== undefined)
        setOrphan({ locationId: result.locationId, sessionId: result.sessionId });
      return;
    }
    onStarted();
    await store.selectSession(result.locationId, result.sessionId);
  };
  return (
    <span data-slot="loop-chat">
      <Button
        data-variant="outline"
        data-kind="loop-chat"
        disabled={busy}
        aria-label={`${t("loop.chat.start")} ${ticket.identifier}`}
        onClick={() => void start()}
      >
        <MessageIcon size={14} />
        <span>{t("loop.chat.start")}</span>
      </Button>
      {failure !== undefined ? (
        <p data-slot="loop-problem" data-kind="loop-chat-failure" role="alert">
          {t(`loop.chat.fail.${failure}`)}
        </p>
      ) : null}
      {orphan !== undefined ? (
        <Button
          data-variant="outline"
          data-kind="loop-chat-open"
          onClick={() => {
            onStarted();
            void store.selectSession(orphan.locationId, orphan.sessionId);
          }}
        >
          {t("loop.chat.openMade")}
        </Button>
      ) : null}
    </span>
  );
}

/** Opens the ticket's Dev session (`[CYC-1] Dev`) to answer it or give it instructions; says so when it is not there. */
function JoinSession({
  identifier,
  session,
}: {
  identifier: string;
  session?: string | undefined;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const [missing, setMissing] = useState(false);
  return (
    <span data-slot="loop-join">
      <Button
        data-variant="solid"
        data-kind="loop-join"
        onClick={() => setMissing(!store.joinLoopSession(identifier, session))}
      >
        {t("loop.join")}
      </Button>
      {missing ? (
        <span role="alert" data-slot="loop-problem">
          {t("loop.join.missing")}
        </span>
      ) : null}
    </span>
  );
}

/** Right-side drawer for one ticket: keeps the board mounted underneath so scroll, filters and picks stay intact. */
function TicketDrawer({
  projectKey,
  identifier,
  summary,
  act,
  busyAction,
  onClose,
  onChatStarted,
  problem,
  version,
}: {
  projectKey: string;
  identifier: string;
  /** The ticket card from the board (when available) so the drawer shows header info immediately while loading details. */
  summary?: LoopTicket | undefined;
  act: Act;
  busyAction?: string | undefined;
  onClose: () => void;
  onChatStarted: () => void;
  problem: ReactNode;
  version: number;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [ticket, setTicket] = useState<LoopTicketDetail | "loading" | "failed">("loading");
  const [retryCount, setRetryCount] = useState(0);

  const waitingTitles = useAppState((s) =>
    Object.values(s.sessions)
      .flat()
      .filter((x) => x.state === "requires_action")
      .map((x) => x.title?.trim() ?? "")
      .join("\n"),
  );
  const waitingOn = (id: string) => waitingTitles.split("\n").includes(`[${id}] Dev`);

  useEffect(() => {
    void version;
    void retryCount;
    let live = true;
    setTicket("loading");
    void store.loadLoopTicket(projectKey, identifier).then((answer) => {
      if (live) setTicket(answer.kind === "ok" ? answer.ticket : "failed");
    });
    return () => {
      live = false;
    };
  }, [store, projectKey, identifier, version, retryCount]);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const loaded = typeof ticket === "object" ? ticket : undefined;
  const headTicket = loaded ?? summary;
  const isPending = headTicket?.pending !== undefined;

  return (
    <div data-slot="loop-drawer-layer">
      <div data-slot="loop-drawer-backdrop" aria-hidden="true" onClick={onClose} />
      <aside data-slot="loop-drawer" data-kind="loop-ticket-drawer" aria-label={identifier}>
        <header data-slot="loop-drawer-head">
          <div data-slot="loop-drawer-meta">
            <span data-slot="loop-ticket-id">{identifier}</span>
            {headTicket !== undefined ? (
              <span data-slot="loop-drawer-column">{headTicket.column}</span>
            ) : null}
            {headTicket ? <PriorityBadge priority={headTicket.priority} /> : null}
            {isPending ? (
              <span data-slot="loop-pending-badge">
                <span data-slot="loop-pending-dot" aria-hidden="true" />
                {t("loop.pending")}
              </span>
            ) : null}
          </div>
          <Tip label={t("loop.detail.close")} shortcut={ESCAPE_KEY}>
            <Button
              ref={closeRef}
              data-variant="ghost"
              data-kind="loop-drawer-close"
              onClick={onClose}
            >
              <CloseIcon size={16} />
            </Button>
          </Tip>
        </header>

        <div data-slot="loop-drawer-body">
          {problem}
          {ticket === "loading" ? (
            <StateBlock size="inline" tone="loading" title={t("loop.detail.loading")} />
          ) : ticket === "failed" ? (
            <StateBlock
              size="inline"
              tone="error"
              title={t("loop.detail.failed")}
              action={{
                label: t("loop.reload"),
                onAction: () => setRetryCount((n) => n + 1),
              }}
            />
          ) : (
            <>
              <h3 data-slot="loop-detail-title">{ticket.title}</h3>
              {ticket.loopStage ? (
                <div data-slot="loop-detail-stage">
                  <TicketStage stage={ticket.loopStage} />
                </div>
              ) : null}

              {ticket.actions.length > 0 ||
              ticket.chat !== "none" ||
              ticket.attention !== undefined ||
              waitingOn(ticket.identifier) ? (
                <div data-slot="loop-detail-actions">
                  <TicketActions
                    ticket={ticket}
                    act={act}
                    surface="drawer"
                    busyAction={busyAction}
                  />
                  {ticket.attention !== undefined || waitingOn(ticket.identifier) ? (
                    <JoinSession
                      identifier={ticket.identifier}
                      session={ticket.attention?.session}
                    />
                  ) : null}
                  {ticket.chat === "new" ? (
                    <TicketChat projectKey={projectKey} ticket={ticket} onStarted={onChatStarted} />
                  ) : null}
                </div>
              ) : null}

              {ticket.chat === "watch" ? (
                <TicketChat projectKey={projectKey} ticket={ticket} onStarted={onChatStarted} />
              ) : null}

              {ticket.attention !== undefined ? (
                <section data-slot="loop-attention-card" data-attention={ticket.attention.kind}>
                  <header data-slot="loop-attention-head">
                    {ticket.attention.kind === "blocked" ? (
                      <ErrorCircleIcon size={16} />
                    ) : (
                      <WarningIcon size={16} />
                    )}
                    <h4>{t(`loop.attention.${ticket.attention.kind}`)}</h4>
                  </header>
                  {ticket.attention.text !== "" ? (
                    <div data-slot="loop-detail-markdown">
                      <Markdown text={ticket.attention.text} />
                    </div>
                  ) : null}
                  {ticket.attention.prUrl !== undefined && ticket.attention.prUrl !== "" ? (
                    <div data-slot="loop-attention-link">
                      <AgentLink href={ticket.attention.prUrl}>{ticket.attention.prUrl}</AgentLink>
                    </div>
                  ) : null}
                </section>
              ) : null}

              {summary?.pending?.reason ? (
                <section data-slot="loop-pending-callout">
                  <h4>{t("loop.pending.note")}</h4>
                  <p>{summary.pending.reason}</p>
                </section>
              ) : null}

              <section data-slot="loop-detail-section">
                <h4>{t("loop.detail.body")}</h4>
                {ticket.body.trim() === "" ? (
                  <p data-slot="loop-detail-empty">{t("loop.detail.none")}</p>
                ) : (
                  <div data-slot="loop-detail-markdown">
                    <Markdown text={ticket.body} />
                  </div>
                )}
              </section>

              <section data-slot="loop-detail-section">
                <header data-slot="loop-detail-section-head">
                  <h4>{t("loop.detail.acceptance")}</h4>
                  {ticket.acceptance.length > 0 ? (
                    <span data-slot="loop-column-count">{ticket.acceptance.length}</span>
                  ) : null}
                </header>
                {ticket.acceptance.length === 0 ? (
                  <p data-slot="loop-detail-empty">{t("loop.detail.none")}</p>
                ) : (
                  <ol data-slot="loop-acceptance-list">
                    {keyedItems(ticket.acceptance).map(({ key, item }) => (
                      <li key={key}>{item}</li>
                    ))}
                  </ol>
                )}
              </section>

              <section data-slot="loop-detail-section">
                <header data-slot="loop-detail-section-head">
                  <h4>{t("loop.detail.links")}</h4>
                  {ticket.links.length > 0 ? (
                    <span data-slot="loop-column-count">{ticket.links.length}</span>
                  ) : null}
                </header>
                {ticket.links.length === 0 ? (
                  <p data-slot="loop-detail-empty">{t("loop.detail.none")}</p>
                ) : (
                  <ul data-slot="loop-links-list">
                    {ticket.links.map((href) => (
                      <li key={href}>
                        <AgentLink href={href}>{href}</AgentLink>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

/** Floating selection dock (SakaniUI KanbanBoardBlock `.barDock` / `.bar`): rises only when pending cards are picked. */
function BatchBar({
  chosen,
  totalPending,
  why,
  busy,
  onWhy,
  onSelectAll,
  onClear,
  onReturn,
  onApprove,
}: {
  chosen: LoopTicket[];
  totalPending: number;
  why: string;
  busy: boolean;
  onWhy: (value: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onReturn: () => void;
  onApprove: () => void;
}) {
  const { t } = useI18n();
  if (chosen.length === 0) return null;
  const all = chosen.length === totalPending;
  return (
    <div data-slot="loop-batch-dock">
      <section data-slot="loop-batch-bar" aria-label={t("loop.pending")}>
        <span data-slot="loop-batch-count">{chosen.length}</span>
        <span data-slot="loop-batch-label">
          {t("loop.pending.selected", { count: chosen.length })}
        </span>
        {!all ? (
          <Button data-variant="ghost" data-kind="loop-batch-all" onClick={onSelectAll}>
            {t("loop.pending.all")}
          </Button>
        ) : null}
        <span data-slot="loop-batch-divider" aria-hidden="true" />
        <Input
          data-kind="loop-batch-why"
          value={why}
          aria-label={t("loop.pending.why")}
          placeholder={t("loop.pending.why")}
          onChange={(event) => onWhy(event.currentTarget.value)}
        />
        <Button
          data-variant="outline"
          data-kind="loop-return-many"
          disabled={busy}
          onClick={onReturn}
        >
          {t("loop.pending.return")}
        </Button>
        <Button
          data-variant="solid"
          data-kind="loop-approve-many"
          disabled={busy}
          onClick={onApprove}
        >
          {t("loop.pending.approve")}
        </Button>
        <Tip label={t("loop.pending.clear")} shortcut={ESCAPE_KEY}>
          <Button
            data-variant="ghost"
            data-kind="loop-batch-clear"
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) onClear();
            }}
          >
            <CloseIcon size={14} />
          </Button>
        </Tip>
      </section>
    </div>
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
  collapsible,
  pageSize,
  openIdentifier,
  picked,
  onTogglePick,
  onSelectAllPending,
  allPendingSelected,
  pendingCount,
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
  collapsible?: boolean;
  pageSize?: number;
  openIdentifier?: string | undefined;
  picked?: ReadonlySet<string> | undefined;
  onTogglePick?: ((identifier: string) => void) | undefined;
  onSelectAllPending?: (() => void) | undefined;
  allPendingSelected?: boolean | undefined;
  pendingCount?: number | undefined;
  act: Act;
  busyAction?: string | undefined;
  onOpen: (identifier: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(collapsible !== true);
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
      data-open={open || undefined}
      data-folded={open ? undefined : ""}
      aria-label={title}
    >
      <header data-slot="loop-column-head">
        {collapsible === true ? (
          <Button
            data-variant="ghost"
            data-kind="loop-toggle"
            aria-expanded={open}
            aria-label={open ? t("loop.done.hide") : t("loop.done.show")}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
            <span data-slot="loop-column-dot" aria-hidden="true" />
            {open ? <span data-slot="loop-column-title">{title}</span> : null}
          </Button>
        ) : (
          <>
            <span data-slot="loop-column-dot" aria-hidden="true" />
            <h3 data-slot="loop-column-title">{title}</h3>
          </>
        )}
        <span data-slot="loop-column-count">{countLabel}</span>
        {open &&
        pendingCount !== undefined &&
        pendingCount > 0 &&
        onSelectAllPending !== undefined ? (
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
      {open ? (
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
      ) : null}
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

function Board({
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

  // Esc clears batch selection before bubbling to PageLayout (when no ticket drawer is open).
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
  if (answer.kind === "no_key")
    return (
      <div data-slot="loop-board-state">
        <StateBlock
          tone="empty"
          title={t("loop.noKey.title")}
          body={t("loop.noKey.body")}
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

  const lost =
    batchOutcome?.kind === "done"
      ? batchOutcome.results.filter((r) => r.outcome === "ok" && r.commentFailed === true).length
      : 0;
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
      {lost > 0 ? (
        <div data-slot="loop-board-notice" data-tone="warning" role="alert">
          <WarningIcon size={14} />
          <span>{t("loop.pending.commentLost", { count: lost })}</span>
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
        {columns.map((c) => {
          const isBacklog = c.stateType === "backlog";
          // In Backlog, keep awaiting-approval tickets pinned at the top sorted by priority,
          // followed by ordinary Backlog tickets — marked by card badge, never wrapped in a box.
          const ordered = isBacklog
            ? [
                ...c.tickets
                  .filter((x) => x.pending !== undefined)
                  .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority)),
                ...c.tickets.filter((x) => x.pending === undefined),
              ]
            : c.tickets;
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
              {...(c.stateType === "completed" ? { collapsible: true } : {})}
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

      {openIdentifier !== undefined ? (
        <TicketDrawer
          key={openIdentifier}
          projectKey={projectKey}
          identifier={openIdentifier}
          summary={openSummary}
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

/** What needs a person, most urgent first. Each opens its ticket's drawer, where the session is joined. */
function Notices({
  notices,
  onOpen,
}: {
  notices: { projectKey: string; notice: LoopNotice }[];
  onOpen: (projectKey: string, notice: LoopNotice) => void;
}) {
  const { t } = useI18n();
  if (notices.length === 0) return null;
  return (
    <section data-slot="loop-notices" data-kind="loop-notices" aria-label={t("loop.notices")}>
      <PageGroup title={t("loop.notices")}>
        <PageRows>
          <ul data-slot="loop-notice-list">
            {notices.map(({ projectKey, notice }) => (
              <li
                key={`${projectKey}:${notice.kind}:${notice.identifier}`}
                data-slot="loop-notice"
                data-notice={notice.kind}
              >
                <button
                  type="button"
                  data-slot="loop-notice-open"
                  onClick={() => onOpen(projectKey, notice)}
                >
                  <span data-slot="loop-notice-icon" aria-hidden="true">
                    {notice.kind === "permission" ? (
                      <ShieldAlertIcon size={16} />
                    ) : notice.kind === "blocked" ? (
                      <ErrorCircleIcon size={16} />
                    ) : (
                      <WarningIcon size={16} />
                    )}
                  </span>
                  <span data-slot="loop-notice-body">
                    <span data-slot="loop-notice-head">
                      <span data-slot="loop-ticket-id">{notice.identifier}</span>
                      <span data-slot="loop-notice-kind" data-notice={notice.kind}>
                        {t(`loop.notice.${notice.kind}`)}
                      </span>
                    </span>
                    {notice.kind === "blocked" && notice.reason !== "" ? (
                      <span data-slot="loop-notice-detail">{notice.reason}</span>
                    ) : notice.kind !== "permission" && notice.title !== "" ? (
                      <span data-slot="loop-notice-detail">{notice.title}</span>
                    ) : null}
                  </span>
                  <ChevronRightIcon size={14} />
                </button>
              </li>
            ))}
          </ul>
        </PageRows>
      </PageGroup>
    </section>
  );
}

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
  const [refreshing, setRefreshing] = useState(false);

  const notices = projects.flatMap((p) => {
    const answer = noticeAnswers[p.projectKey];
    return answer?.kind === "ok"
      ? answer.notices.map((notice) => ({ projectKey: p.projectKey, notice }))
      : [];
  });

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
          store.track("loop_notice_opened", { kind: notice.kind });
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
                          {board.kind === "no_key"
                            ? t("loop.noKey.title")
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
    ...projects.map(
      (p): PageSection => ({
        id: p.projectKey,
        group: t("loop.projects"),
        label: p.name,
        note: away ? t("loop.offline.note") : p.projectKey,
        disabled: away,
        layout: "full",
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
                : t("loop.tab.kanban")}
            </span>
          </nav>
        ),
        content: (
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
        ),
      }),
    ),
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
