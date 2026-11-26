// The Loop page (CYC-386, CYC-387): the Projects the Loop server on this computer serves, and one Project's itsaplan
// board. It takes the window in place of the sessions, as Connectors does. The Projects are the page's sections: with
// the server away they stay listed, greyed, and say so. A ticket changes state only by a button (approve, back to
// Backlog, back to Todo; never by dragging); which buttons it has is decided by main, and approving asks first.
//
// The board's layout (CYC-431) follows SakaniUI's KanbanBoardBlock (https://www.sakaniui.com/docs/blocks/kanban-board,
// MIT, samzydd/Sakaniui): equal columns side by side, a head of dot + name + count, cards of id and priority, a title,
// and the buttons at the foot. Only the layout is borrowed: nothing of it is imported or copied, and none of its
// dragging, "Move to" menu or arrow-key moves is here, as they would move a ticket without the confirmation CYC-387
// asks for. The one multi-select is the group of tickets waiting for approval (CYC-451): approving a batch asks first and
// lists the titles; returning a batch is the way to say no, and only takes labels off and puts Loop 跳过 on. The columns are itsaplan's own, in its order.
import { Button } from "@ui-sdk/react/button";
import { Input } from "@ui-sdk/react/input";
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";
import { type ReactNode, useEffect, useState } from "react";
import type {
  LoopActFailure,
  LoopAction,
  LoopBoardAnswer,
  LoopBoardColumn,
  LoopChatFailure,
  LoopManyResult,
  LoopNotice,
  LoopProjectInfo,
  LoopRunsAnswer,
  LoopTicket,
  LoopTicketDetail,
} from "../api.ts";
import { AgentLink } from "./agent-link.tsx";
import { ConfirmDialog } from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import { ChevronDownIcon, ChevronRightIcon } from "./icons.tsx";
import { type LoopView, viewProject } from "./loop-nav.ts";
import { useNow } from "./now.ts";
import { PageLayout, type PageSection } from "./page-layout.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";

/** The Backlog is the longest column by far: it opens on this many and shows this many more at a time. */
const BACKLOG_PAGE = 20;

/** How often the Notices are read again while the page is open. */
const NOTICES_REFRESH_MS = 30_000;

/** Items with keys that stay unique when two read the same: the text, and how many came before with it. */
const keyedItems = (items: string[]) => {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const n = seen.get(item) ?? 0;
    seen.set(item, n + 1);
    return { key: `${item}#${n}`, item };
  });
};

type Act = (
  ticket: LoopTicket,
  action: LoopAction,
  confirmed?: boolean,
) => Promise<string | undefined>;

/** The buttons of one ticket. Approving asks first; the others go ahead and report only a failure. */
function TicketActions({ ticket, act }: { ticket: LoopTicket; act: Act }) {
  const { t } = useI18n();
  const [asking, setAsking] = useState(false);
  if (ticket.actions.length === 0) return null;
  return (
    <span data-slot="loop-ticket-actions">
      {ticket.actions.map((action) => (
        <Button
          key={action}
          data-variant="ghost"
          data-kind={`loop-${action}`}
          aria-label={`${t(`loop.act.${action}`)} ${ticket.identifier}`}
          onClick={() => (action === "approve" ? setAsking(true) : void act(ticket, action))}
        >
          {t(`loop.act.${action}`)}
        </Button>
      ))}
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

/** Longer than this on one step, and the stage line asks to be looked at. */
const STAGE_SLOW_MS = 30 * 60_000;

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
      {t("loop.stage.line", { stage: t(`loop.stage.${stage.stage}`), length })}
    </span>
  );
}

function Ticket({
  ticket,
  act,
  onOpen,
}: {
  ticket: LoopTicket;
  act: Act;
  onOpen: (identifier: string) => void;
}) {
  // The title button stretches over the whole card (CSS), so the card opens the ticket by click or keyboard; the
  // buttons sit above it, so pressing one does not open it.
  return (
    <li data-slot="loop-ticket">
      <span data-slot="loop-ticket-head">
        <span data-slot="loop-ticket-id">{ticket.identifier}</span>
        {ticket.priority !== null ? (
          <span data-slot="loop-ticket-priority">{ticket.priority}</span>
        ) : null}
      </span>
      <button
        type="button"
        data-slot="loop-ticket-title"
        title={ticket.title}
        onClick={() => onOpen(ticket.identifier)}
      >
        <span data-slot="loop-ticket-text">{ticket.title}</span>
      </button>
      {ticket.loopStage ? <TicketStage stage={ticket.loopStage} /> : null}
      <TicketActions ticket={ticket} act={act} />
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
        data-variant="ghost"
        data-kind="loop-chat"
        disabled={busy}
        aria-label={`${t("loop.chat.start")} ${ticket.identifier}`}
        onClick={() => void start()}
      >
        {t("loop.chat.start")}
      </Button>
      {failure !== undefined ? (
        <p data-slot="loop-problem" data-kind="loop-chat-failure" role="alert">
          {t(`loop.chat.fail.${failure}`)}
        </p>
      ) : null}
      {orphan !== undefined ? (
        <Button
          data-variant="ghost"
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

/** What needs a person, most urgent first. Each opens its ticket's page, where the session is joined. */
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
      <h3 data-slot="loop-column-title">{t("loop.notices")}</h3>
      <ul data-slot="loop-tickets">
        {notices.map(({ projectKey, notice }) => (
          <li
            key={`${projectKey}:${notice.kind}:${notice.identifier}`}
            data-slot="loop-notice"
            data-notice={notice.kind}
          >
            <span data-slot="loop-ticket-id">{notice.identifier}</span>
            <button
              type="button"
              data-slot="loop-ticket-title"
              onClick={() => onOpen(projectKey, notice)}
            >
              {t(`loop.notice.${notice.kind}`)}
              {notice.kind === "blocked" && notice.reason !== "" ? `: ${notice.reason}` : ""}
            </button>
          </li>
        ))}
      </ul>
    </section>
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
        data-variant="ghost"
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

function TicketPage({
  projectKey,
  identifier,
  act,
  onBack,
  onChatStarted,
  problem,
}: {
  projectKey: string;
  identifier: string;
  act: Act;
  onBack: () => void;
  onChatStarted: () => void;
  problem: ReactNode;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const [ticket, setTicket] = useState<LoopTicketDetail | "loading" | "failed">("loading");
  // Titles of the sessions waiting on an answer: a ticket Loop works on has none to join unless one asks.
  const waitingTitles = useAppState((s) =>
    Object.values(s.sessions)
      .flat()
      .filter((x) => x.state === "requires_action")
      .map((x) => x.title?.trim() ?? "")
      .join("\n"),
  );
  const waitingOn = (id: string) => waitingTitles.split("\n").includes(`[${id}] Dev`);
  // Which tickets Loop is running changes what the page says of this one (watch or not): it is read again then.
  const runKey = useAppState((s) =>
    s.loop.runs?.kind === "ok" ? (s.loop.runs.running[projectKey] ?? []).join(",") : "",
  );
  useEffect(() => {
    let live = true;
    void runKey;
    void store.loadLoopTicket(projectKey, identifier).then((answer) => {
      // A read again that fails leaves the ticket that was shown.
      if (live)
        setTicket((had) =>
          answer.kind === "ok" ? answer.ticket : typeof had === "object" ? had : "failed",
        );
    });
    return () => {
      live = false;
    };
  }, [store, projectKey, identifier, runKey]);
  return (
    <div data-slot="loop-ticket-page" data-kind="loop-ticket-page">
      <Button data-variant="ghost" onClick={onBack}>
        {t("loop.detail.back")}
      </Button>
      {problem}
      {ticket === "loading" ? (
        <StateBlock tone="loading" title={t("loop.detail.loading")} />
      ) : ticket === "failed" ? (
        <StateBlock tone="error" title={t("loop.detail.failed")} />
      ) : (
        <>
          <h3 data-slot="loop-detail-title">
            <span data-slot="loop-ticket-id">{ticket.identifier}</span> {ticket.title}
          </h3>
          <span data-slot="loop-ticket-meta">
            {ticket.column}
            {ticket.priority !== null ? ` · ${ticket.priority}` : ""}
          </span>
          <TicketActions ticket={ticket} act={act} />
          <TicketChat projectKey={projectKey} ticket={ticket} onStarted={onChatStarted} />
          {ticket.attention !== undefined || waitingOn(ticket.identifier) ? (
            <JoinSession identifier={ticket.identifier} session={ticket.attention?.session} />
          ) : null}
          {ticket.attention !== undefined ? (
            <section data-slot="loop-detail-section" data-attention={ticket.attention.kind}>
              <h4>{t(`loop.attention.${ticket.attention.kind}`)}</h4>
              {ticket.attention.text !== "" ? (
                <pre data-slot="loop-detail-body">{ticket.attention.text}</pre>
              ) : null}
              {ticket.attention.prUrl !== undefined && ticket.attention.prUrl !== "" ? (
                <AgentLink href={ticket.attention.prUrl}>{ticket.attention.prUrl}</AgentLink>
              ) : null}
            </section>
          ) : null}
          <section data-slot="loop-detail-section">
            <h4>{t("loop.detail.body")}</h4>
            <pre data-slot="loop-detail-body">{ticket.body}</pre>
          </section>
          <section data-slot="loop-detail-section">
            <h4>{t("loop.detail.acceptance")}</h4>
            {ticket.acceptance.length === 0 ? (
              <p data-slot="loop-column-empty">{t("loop.detail.none")}</p>
            ) : (
              <ol>
                {keyedItems(ticket.acceptance).map(({ key, item }) => (
                  <li key={key}>{item}</li>
                ))}
              </ol>
            )}
          </section>
          <section data-slot="loop-detail-section">
            <h4>{t("loop.detail.links")}</h4>
            {ticket.links.length === 0 ? (
              <p data-slot="loop-column-empty">{t("loop.detail.none")}</p>
            ) : (
              <ul>
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
  );
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const priorityRank = (p: string | null): number => PRIORITY_RANK[p ?? ""] ?? 4;

/** The tickets the planning node left for a person (CYC-451): chosen a batch at a time, approved or returned. */
function PendingGroup({
  projectKey,
  tickets,
  more,
  outcome,
  onOutcome,
  onOpen,
}: {
  projectKey: string;
  tickets: LoopTicket[];
  /** The Backlog has tickets that were not listed, so some waiting ones may not be here. */
  more: boolean;
  /** Kept by the Board: the board is read again after a batch, and the group may be gone by then. */
  outcome: LoopManyResult | undefined;
  onOutcome: (result: LoopManyResult | undefined) => void;
  onOpen: (identifier: string) => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [asking, setAsking] = useState(false);
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  // Stable by priority, then as the tracker lists them.
  const sorted = [...tickets].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
  // A ticket gone from the group (the board was read again) is not still chosen.
  const chosen = sorted.filter((x) => picked.has(x.identifier));
  const all = sorted.length > 0 && chosen.length === sorted.length;
  const toggle = (identifier: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(identifier)) next.add(identifier);
      return next;
    });
  const run = async (action: "approve_many" | "return_many"): Promise<string | undefined> => {
    setBusy(true);
    onOutcome(undefined);
    setProblem(undefined);
    const result = await store.actOnLoopMany(
      projectKey,
      action,
      chosen.map((x) => x.identifier),
      true,
      action === "return_many" ? why : undefined,
    );
    setBusy(false);
    if (result.kind === "failed") {
      const words = t(`loop.fail.${result.reason}`);
      setProblem(words);
      return words;
    }
    onOutcome(result);
    setPicked(new Set());
    if (action === "return_many") setWhy("");
    return undefined;
  };
  const lost =
    outcome?.kind === "done"
      ? outcome.results.filter((r) => r.outcome === "ok" && r.commentFailed === true).length
      : 0;
  const count = (kind: "ok" | "skipped" | "failed") =>
    outcome?.kind === "done" ? outcome.results.filter((r) => r.outcome === kind).length : 0;
  return (
    <section data-slot="loop-pending" data-kind="loop-pending" aria-label={t("loop.pending")}>
      {tickets.length > 0 ? (
        <>
          <header data-slot="loop-pending-head">
            <h4 data-slot="loop-column-title">{t("loop.pending")}</h4>
            <span data-slot="loop-column-count">{tickets.length}</span>
            <label data-slot="loop-pending-all">
              <input
                type="checkbox"
                checked={all}
                onChange={() =>
                  setPicked(all ? new Set() : new Set(sorted.map((x) => x.identifier)))
                }
              />
              {t("loop.pending.all")}
            </label>
          </header>
          <ul data-slot="loop-tickets">
            {sorted.map((ticket) => (
              <li key={ticket.identifier} data-slot="loop-ticket" data-pending="">
                <span data-slot="loop-ticket-head">
                  <input
                    type="checkbox"
                    data-slot="loop-pending-pick"
                    aria-label={`${t("loop.pending.pick")} ${ticket.identifier}`}
                    checked={picked.has(ticket.identifier)}
                    onChange={() => toggle(ticket.identifier)}
                  />
                  <span data-slot="loop-ticket-id">{ticket.identifier}</span>
                  {ticket.priority !== null ? (
                    <span data-slot="loop-ticket-priority">{ticket.priority}</span>
                  ) : null}
                  <span data-slot="loop-ticket-meta">
                    {ticket.pending?.criteria !== undefined
                      ? t("loop.pending.criteria", { count: ticket.pending.criteria })
                      : null}
                  </span>
                </span>
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
              </li>
            ))}
          </ul>
          <div data-slot="loop-pending-bar">
            <Input
              value={why}
              aria-label={t("loop.pending.why")}
              placeholder={t("loop.pending.why")}
              onChange={(event) => setWhy(event.currentTarget.value)}
            />
            <Button
              data-variant="ghost"
              data-kind="loop-return-many"
              disabled={chosen.length === 0 || busy}
              onClick={() => void run("return_many")}
            >
              {t("loop.pending.return")}
            </Button>
            <Button
              data-kind="loop-approve-many"
              disabled={chosen.length === 0 || busy}
              onClick={() => setAsking(true)}
            >
              {t("loop.pending.approve")}
            </Button>
          </div>
          {problem !== undefined ? (
            <p data-slot="loop-problem" role="alert">
              {problem}
            </p>
          ) : null}
        </>
      ) : null}
      {more ? <p data-slot="loop-problem">{t("loop.pending.more")}</p> : null}
      {lost > 0 ? (
        <p data-slot="loop-problem" role="alert">
          {t("loop.pending.commentLost", { count: lost })}
        </p>
      ) : null}
      {outcome?.kind === "done" ? (
        <p data-slot="loop-problem" role="status">
          {t("loop.pending.done", {
            ok: count("ok"),
            skipped: count("skipped"),
            failed: count("failed"),
          })}
        </p>
      ) : null}
      {asking ? (
        <ConfirmDialog
          open
          onOpenChange={setAsking}
          title={t("loop.pending.approve.title", { count: chosen.length })}
          description={t("loop.pending.approve.body")}
          detail={chosen.map((x) => [x.identifier, x.title].join(" ")).join("\n")}
          confirmLabel={t("loop.pending.approve")}
          onConfirm={() => run("approve_many")}
        />
      ) : null}
    </section>
  );
}

function Column({
  id,
  title,
  stateType,
  tickets,
  more,
  collapsible,
  pageSize,
  pending,
  batch,
  onBatch,
  act,
  onOpen,
  projectKey,
}: {
  id: number;
  title: string;
  stateType: string;
  tickets: LoopTicket[];
  /** The column has tickets that are not in the list. */
  more?: boolean;
  /** Starts folded to its count; a press unfolds it. */
  collapsible?: boolean;
  /** Show this many first, and this many more each time asked: for a column that can be very long. */
  pageSize?: number;
  /** The tickets waiting for approval, drawn as a group above the column's own tickets and left out of them. */
  pending?: LoopTicket[];
  batch?: LoopManyResult | undefined;
  onBatch?: (result: LoopManyResult | undefined) => void;
  projectKey: string;
  act: Act;
  onOpen: (identifier: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(collapsible !== true);
  const [shown, setShown] = useState(pageSize ?? Number.POSITIVE_INFINITY);
  const visible = tickets.slice(0, shown);
  const count = (
    <span data-slot="loop-column-count">
      {more === true
        ? `${tickets.length + (pending?.length ?? 0)}+`
        : tickets.length + (pending?.length ?? 0)}
    </span>
  );
  return (
    <section
      data-slot="loop-column"
      data-column={id}
      data-state-type={stateType}
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
            aria-label={`${open ? t("loop.done.hide") : t("loop.done.show")}`}
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
        {count}
      </header>
      {open && pending !== undefined && (pending.length > 0 || batch !== undefined) ? (
        <PendingGroup
          projectKey={projectKey}
          tickets={pending}
          more={more === true}
          outcome={batch}
          onOutcome={onBatch ?? (() => {})}
          onOpen={onOpen}
        />
      ) : null}
      {open ? (
        tickets.length === 0 ? (
          (pending?.length ?? 0) > 0 ? null : (
            <p data-slot="loop-column-empty">{t("loop.column.empty")}</p>
          )
        ) : (
          <ul data-slot="loop-tickets">
            {visible.map((ticket) => (
              <Ticket key={ticket.identifier} ticket={ticket} act={act} onOpen={onOpen} />
            ))}
          </ul>
        )
      ) : null}
      {open && visible.length < tickets.length && pageSize !== undefined ? (
        <Button
          data-variant="ghost"
          data-kind="loop-more"
          onClick={() => setShown((n) => n + pageSize)}
        >
          {t("loop.more", { count: tickets.length - visible.length })}
        </Button>
      ) : null}
    </section>
  );
}

/** The columns' places while the board is read: its columns are not known yet, so three, each with cards of no words. */
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
  /** The ticket whose page is shown, if any: it is the Loop's navigation state, not the board's. */
  openIdentifier: string | undefined;
  onOpen: (identifier: string) => void;
  onBack: () => void;
  onChatStarted: () => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const reload = {
    label: t("loop.reload"),
    onAction: () => {
      void store.loadLoopBoard(projectKey);
    },
  };
  const request = useAppState((s) => s.loop.request);
  const open = openIdentifier;
  // A pressed notification asks for its ticket once: it is taken (cleared) here, so reopening the page does not repeat it.
  useEffect(() => {
    if (request === undefined || request.projectKey !== projectKey) return;
    onOpen(request.identifier);
    store.takeLoopRequest(request.n);
  }, [request, projectKey, store, onOpen]);
  const [problem, setProblem] = useState<LoopActFailure | undefined>();
  const [version, setVersion] = useState(0);
  // The result of the last batch stays here: the board is read again after it, and the group may be gone with it.
  const [batch, setBatch] = useState<LoopManyResult | undefined>();
  // Returns the words of a failure (the approve dialog shows them inline); the other buttons show them on the board.
  const act: Act = async (ticket, action, confirmed) => {
    setProblem(undefined);
    const result = await store.actOnLoopTicket(projectKey, ticket.identifier, action, confirmed);
    if (result.kind === "ok") {
      setVersion((v) => v + 1);
      return undefined;
    }
    if (action !== "approve") setProblem(result.reason);
    return t(`loop.fail.${result.reason}`);
  };
  const openTicket = (identifier: string) => {
    setProblem(undefined);
    onOpen(identifier);
  };
  const alert =
    problem !== undefined ? (
      <p data-slot="loop-problem" role="alert">
        {t(`loop.fail.${problem}`)}
      </p>
    ) : null;
  if (answer === undefined || answer === "loading") return <BoardSkeleton />;
  if (answer.kind === "no_key")
    return (
      <StateBlock
        tone="empty"
        title={t("loop.noKey.title")}
        body={t("loop.noKey.body")}
        action={reload}
      />
    );
  if (answer.kind === "unreachable")
    return (
      <StateBlock
        tone="error"
        title={t("loop.unreachable.title")}
        body={t("loop.unreachable.body")}
        action={reload}
      />
    );
  if (open !== undefined)
    return (
      <TicketPage
        // A button changed a ticket: the page starts over and reads it again.
        key={version}
        projectKey={projectKey}
        identifier={open}
        act={act}
        onChatStarted={onChatStarted}
        onBack={() => {
          setProblem(undefined);
          onBack();
        }}
        problem={alert}
      />
    );
  return (
    <div data-slot="loop-board" data-kind="loop-board">
      <div data-slot="loop-board-bar">
        <span data-slot="loop-hint">{t("loop.hint")}</span>
        <Button data-variant="ghost" onClick={reload.onAction}>
          {reload.label}
        </Button>
      </div>
      {alert}
      <div data-slot="loop-columns">
        {answer.columns.map((c) => {
          const waiting =
            c.stateType === "backlog" ? c.tickets.filter((x) => x.pending !== undefined) : [];
          return (
            <Column
              key={c.id}
              id={c.id}
              projectKey={projectKey}
              title={c.name}
              stateType={c.stateType}
              tickets={
                waiting.length > 0 ? c.tickets.filter((x) => x.pending === undefined) : c.tickets
              }
              pending={waiting}
              {...(c.stateType === "backlog" ? { batch, onBatch: setBatch } : {})}
              more={c.more}
              {...(c.stateType === "backlog" ? { pageSize: BACKLOG_PAGE } : {})}
              {...(c.stateType === "completed" ? { collapsible: true } : {})}
              act={act}
              onOpen={openTicket}
            />
          );
        })}
      </div>
    </div>
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
  const runs = useAppState((s) => s.loop.runs);
  const notices = projects.flatMap((p) => {
    const answer = noticeAnswers[p.projectKey];
    return answer?.kind === "ok"
      ? answer.notices.map((notice) => ({ projectKey: p.projectKey, notice }))
      : [];
  });
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
                  <RunState runs={runs} projectKey={p.projectKey} />
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
                      {board.kind === "no_key"
                        ? t("loop.noKey.title")
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
