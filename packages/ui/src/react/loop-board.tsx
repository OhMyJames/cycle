// One Project's board (CYC-431), as the Loop server answers it. The layout follows SakaniUI's KanbanBoardBlock
// (https://www.sakaniui.com/docs/blocks/kanban-board, MIT, samzydd/Sakaniui): equal columns side by side, a head of dot
// + name + count, cards of id and priority, and a title. Only the layout is borrowed: nothing of it is imported or
// copied, and none of its dragging or moving is here. A ticket never changes state on this page except through the
// batch of tickets waiting for approval. The columns are the server's own, in its order.
import { Button } from "@ui-sdk/react/button";
import { useEffect, useState } from "react";
import type { LoopActFailure, LoopBoardAnswer, LoopManyResult, LoopTicket } from "../api.ts";
import { useI18n } from "./i18n.tsx";
import { ChevronDownIcon, ChevronRightIcon } from "./icons.tsx";
import { PendingGroup } from "./loop-pending-group.tsx";
import { type Act, TicketPage } from "./loop-ticket.tsx";
import { useNow } from "./now.ts";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";

/** The Backlog is the longest column by far: it opens on this many and shows this many more at a time. */
const BACKLOG_PAGE = 20;

/** Longer than this on one step, and the stage line asks to be looked at. */
const STAGE_SLOW_MS = 30 * 60_000;

/** The run phases the page has words for; any other is shown as the server names it. */
const PHASE_WORD: Record<string, string> = {
  dev: "develop",
  qa: "qa",
  review: "review",
  research: "research",
  research_qa: "researchQa",
};

/** Where Loop is on a ticket and for how long: "QA · 3 min". */
function TicketStage({ phase }: { phase: NonNullable<LoopTicket["phase"]> }) {
  const { t } = useI18n();
  const now = useNow();
  const since = Date.parse(phase.since);
  if (Number.isNaN(since)) return null;
  const ms = Math.max(0, now - since);
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const length =
    hours > 0
      ? t("loop.stage.hoursMinutes", { hours, minutes: minutes % 60 })
      : t("loop.stage.minutes", { minutes });
  const word = PHASE_WORD[phase.name];
  return (
    <span data-slot="loop-ticket-stage" data-slow={ms > STAGE_SLOW_MS ? "true" : undefined}>
      {t("loop.stage.line", { stage: word ? t(`loop.stage.${word}`) : phase.name, length })}
    </span>
  );
}

function Ticket({ ticket, onOpen }: { ticket: LoopTicket; onOpen: (identifier: string) => void }) {
  // The title button stretches over the whole card (CSS), so the card opens the ticket by click or keyboard.
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
      {ticket.phase ? <TicketStage phase={ticket.phase} /> : null}
    </li>
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
  projectKey,
  onOpen,
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
              <Ticket key={ticket.identifier} ticket={ticket} onOpen={onOpen} />
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
  // Returns the words of a failure (the approve dialog shows them inline); the other buttons show them on the page.
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
  if (answer.kind === "no_server")
    return (
      <StateBlock
        tone="away"
        title={t("loop.offline.title")}
        body={t("loop.offline.body")}
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
        {answer.stale ? (
          <span data-slot="loop-hint" data-kind="loop-stale" role="status">
            {t("loop.stale")}
          </span>
        ) : null}
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
              onOpen={openTicket}
            />
          );
        })}
      </div>
    </div>
  );
}
