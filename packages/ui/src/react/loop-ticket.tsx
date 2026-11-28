// One ticket's drawer (CYC-493, CYC-431): the text, the criteria, the links and why it needs a person, as the Loop server
// answers (`loop/ticket/get`), with the buttons it allows (approve, back to Backlog, to Todo) and the conversation with
// an agent. It opens at the right of the board without unmounting it, so the board's scroll, filters and picks stay.
import { Button } from "@ui-sdk/react/button";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@ui-sdk/react/menu";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type {
  LoopActFailure,
  LoopAction,
  LoopChatFailure,
  LoopRunDetail,
  LoopTicket,
  LoopTicketDetail,
} from "../api.ts";
import { AgentLink } from "./agent-link.tsx";
import { ConfirmDialog, FormDialog } from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import {
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  ErrorCircleIcon,
  MessageIcon,
  WarningIcon,
} from "./icons.tsx";
import { ExecutionGraph } from "./loop-graph.tsx";
import { PHASE_WORD, RunWorkflow } from "./loop-run.tsx";
import { Markdown } from "./markdown.tsx";
import { useNow } from "./now.ts";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";

/** Longer than this on one step, and the stage line asks to be looked at. */
const STAGE_SLOW_MS = 30 * 60_000;
const ESCAPE_KEY = "Esc";

export const PRIORITIES = ["urgent", "high", "medium", "low"] as const;
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
export const priorityRank = (p: string | null): number => PRIORITY_RANK[p ?? ""] ?? 4;

/** Items with keys that stay unique when two read the same: the text, and how many came before with it. */
const keyedItems = (items: string[]) => {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const n = seen.get(item) ?? 0;
    seen.set(item, n + 1);
    return { key: `${item}#${n}`, item };
  });
};

/** What a button needs of a ticket: the card and the drawer both name it, and the server reads it again. */
type Acted = Pick<LoopTicket, "identifier" | "title">;
export type Act = (
  ticket: Acted,
  action: LoopAction,
  confirmed?: boolean,
  reason?: string,
) => Promise<string | undefined>;

export function PriorityBadge({ priority }: { priority: string | null }) {
  const { t } = useI18n();
  if (priority === null) return null;
  const known = (PRIORITIES as readonly string[]).includes(priority);
  return (
    <span data-slot="loop-priority" data-priority={known ? priority : "other"}>
      {known ? t(`loop.priority.${priority}`) : priority}
    </span>
  );
}

/** The buttons of one ticket. Approving confirms first; returning asks for an optional reason; the rest go ahead. */
export function TicketActions({
  ticket,
  act,
  surface = "card",
  busyAction,
  quick = false,
}: {
  ticket: Acted & { actions: readonly LoopAction[] };
  act: Act;
  /** The one-press approve on the card of a ticket waiting for approval. */
  quick?: boolean;
  surface?: "card" | "drawer";
  busyAction?: string | undefined;
}) {
  const { t } = useI18n();
  const [asking, setAsking] = useState(false);
  const [returning, setReturning] = useState(false);
  const [returnReason, setReturnReason] = useState("");
  const [returnProblem, setReturnProblem] = useState<string | undefined>();
  useEffect(() => {
    void ticket.identifier;
    setAsking(false);
    setReturning(false);
    setReturnReason("");
    setReturnProblem(undefined);
  }, [ticket.identifier]);
  if (ticket.actions.length === 0 && !asking && !returning) return null;
  const openReturn = () => {
    setReturnReason("");
    setReturnProblem(undefined);
    setReturning(true);
  };
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
            data-quick={action === "approve" && quick ? "" : undefined}
            disabled={busyAction !== undefined}
            data-busy={busy ? "" : undefined}
            aria-label={`${t(`loop.act.${action}`)} ${ticket.identifier}`}
            onClick={() =>
              action === "approve"
                ? setAsking(true)
                : action === "return"
                  ? openReturn()
                  : void act(ticket, action)
            }
          >
            {action === "approve" && (surface === "drawer" || quick) ? (
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
      {returning ? (
        <FormDialog
          open
          kind="loop-return"
          title={t("loop.return.title", { id: ticket.identifier })}
          description={t("loop.return.body")}
          submitLabel={t("loop.act.return")}
          problem={returnProblem}
          onSubmit={async () => {
            setReturnProblem(undefined);
            const error = await act(ticket, "return", false, returnReason);
            if (error !== undefined) {
              setReturnProblem(error);
              return false;
            }
            return true;
          }}
          onClose={() => setReturning(false)}
        >
          <Field name="reason">
            <FieldLabel>{t("loop.return.reason")}</FieldLabel>
            <Input
              autoFocus
              value={returnReason}
              onChange={(event) => setReturnReason(event.currentTarget.value)}
            />
          </Field>
        </FormDialog>
      ) : null}
    </span>
  );
}

/** Where Loop is on a ticket and for how long: "QA · 3 min". */
export function TicketStage({ phase }: { phase: NonNullable<LoopTicket["phase"]> }) {
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
      <span data-slot="loop-stage-dot" aria-hidden="true" />
      {t("loop.stage.line", { stage: word ? t(`loop.stage.${word}`) : phase.name, length })}
    </span>
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
  const allLocalAgents = useAppState((s) => s.agents.local);
  const localAgents = (allLocalAgents ?? []).filter((a) => a.available);
  const [chosenAgent, setChosenAgent] = useState("auto");
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
  const selectedAgent =
    chosenAgent !== "auto" && localAgents.some((a) => a.id === chosenAgent) ? chosenAgent : "auto";
  const selectedLabel =
    selectedAgent === "auto"
      ? t("loop.chat.agentAuto")
      : (localAgents.find((a) => a.id === selectedAgent)?.name ?? selectedAgent);
  const start = async () => {
    setBusy(true);
    setFailure(undefined);
    setOrphan(undefined);
    const result = await store.chatAboutLoopTicket(
      projectKey,
      ticket.identifier,
      selectedAgent === "auto" ? undefined : selectedAgent,
    );
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
      {localAgents.length >= 2 ? (
        <Menu>
          <MenuTrigger
            data-variant="outline"
            data-kind="loop-chat-agent"
            aria-label={`${t("loop.chat.agent")}: ${selectedLabel}`}
            disabled={busy}
          >
            <span>{selectedLabel}</span>
            <ChevronDownIcon size={12} />
          </MenuTrigger>
          <MenuContent>
            <MenuRadioGroup value={selectedAgent} onValueChange={setChosenAgent}>
              <MenuRadioItem value="auto" closeOnSelect>
                {t("loop.chat.agentAuto")}
              </MenuRadioItem>
              {localAgents.map((a) => (
                <MenuRadioItem key={a.id} value={a.id} closeOnSelect>
                  {a.name}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
      ) : null}
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
  session?: { kind: string; id: string } | null | undefined;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const [missing, setMissing] = useState(false);
  return (
    <span data-slot="loop-join">
      <Button
        data-variant="solid"
        data-kind="loop-join"
        onClick={() =>
          setMissing(
            !(
              (session != null && store.joinLoopSession(session.id)) ||
              store.joinLoopDevSession(identifier)
            ),
          )
        }
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
export function TicketDrawer({
  projectKey,
  identifier,
  summary,
  closing = false,
  onExited,
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
  /** Playing the slide-out: the drawer is unmounted by the parent once `onExited` is called. */
  closing?: boolean;
  onExited?: () => void;
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
  const [run, setRun] = useState<LoopRunDetail | undefined>();
  const [retryCount, setRetryCount] = useState(0);

  const waitingTitles = useAppState((s) =>
    Object.values(s.sessions)
      .flat()
      .filter((x) => x.state === "requires_action")
      .map((x) => x.title?.trim() ?? "")
      .join("\n"),
  );
  const waitingOn = (id: string) => waitingTitles.split("\n").includes(`[${id}] Dev`);

  // Which tickets Loop is running changes what the Loop server says of this one (watch or not): it is read again then.
  const runKey = useAppState((s) =>
    s.loop.runs === undefined
      ? "unknown"
      : s.loop.runs.kind === "ok" && (s.loop.runs.running[projectKey] ?? []).includes(identifier)
        ? "running"
        : "idle",
  );
  const activity = useAppState((s) => s.loop.activity[projectKey] ?? 0);

  useEffect(() => {
    // These are dependencies, not read in here: a change of any of them reads the ticket and run again. Not before the
    // run state is known (the ticket would be read twice) and not while the drawer is sliding out.
    void version;
    void retryCount;
    if (closing || runKey === "unknown") return;
    void runKey;
    let live = true;
    void store.loadLoopTicket(projectKey, identifier).then((answer) => {
      // A read again that fails leaves the ticket that was shown.
      if (live)
        setTicket((had) =>
          answer.kind === "ok" ? answer.ticket : typeof had === "object" ? had : "failed",
        );
    });
    void store.loadLoopRun(projectKey, identifier).then((answer) => {
      if (!live) return;
      if (answer.kind === "ok") setRun(answer.run);
      else if (answer.kind === "none") setRun(undefined);
    });
    return () => {
      live = false;
    };
  }, [store, projectKey, identifier, version, retryCount, runKey, closing]);

  // Project-wide Loop events refresh only the lightweight run record (including phase, heartbeat, sessions and graph)
  // without re-fetching full ticket markdown or inflating `loop_ticket_opened` analytics.
  useEffect(() => {
    if (closing || activity === 0 || runKey === "unknown") return;
    let live = true;
    void store.loadLoopRun(projectKey, identifier).then((answer) => {
      if (!live) return;
      if (answer.kind === "ok") setRun(answer.run);
      else if (answer.kind === "none") setRun(undefined);
    });
    return () => {
      live = false;
    };
  }, [store, projectKey, identifier, activity, closing, runKey]);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // No animation event comes with reduced motion (or if the animation never runs): do not wait for one.
  useEffect(() => {
    if (!closing) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(() => onExited?.(), reduced ? 0 : 800);
    return () => window.clearTimeout(timer);
  }, [closing, onExited]);

  const loaded = typeof ticket === "object" ? ticket : undefined;
  const headTicket = loaded ?? summary;
  const isPending = headTicket?.pending !== undefined;
  const effectivePhase =
    run !== undefined
      ? run.state === "active"
        ? { name: run.phase, since: run.updatedAt }
        : undefined
      : (loaded?.phase ?? summary?.phase);
  const effectiveGraph = run?.graph ?? loaded?.graph;

  return (
    <div data-slot="loop-drawer-layer" data-state={closing ? "closing" : "open"} inert={closing}>
      <div data-slot="loop-drawer-backdrop" aria-hidden="true" onClick={onClose} />
      <aside
        data-slot="loop-drawer"
        data-kind="loop-ticket-drawer"
        aria-label={identifier}
        onAnimationEnd={(e) => {
          if (closing && e.target === e.currentTarget) onExited?.();
        }}
      >
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
                onAction: () => {
                  setTicket("loading");
                  setRetryCount((n) => n + 1);
                },
              }}
            />
          ) : (
            <>
              <h3 data-slot="loop-detail-title">{ticket.title}</h3>
              {effectivePhase ? (
                <div data-slot="loop-detail-stage">
                  <TicketStage phase={effectivePhase} />
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
                      session={
                        ticket.attention?.kind === "blocked" ? ticket.attention.session : undefined
                      }
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
                  {ticket.attention.kind === "review" &&
                  ticket.attention.prUrl !== null &&
                  ticket.attention.prUrl !== "" ? (
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

              {run !== undefined ? (
                <RunWorkflow
                  projectKey={projectKey}
                  identifier={ticket.identifier}
                  run={run}
                  awaitingReview={ticket.attention?.kind === "review"}
                  onChanged={() => setRetryCount((n) => n + 1)}
                />
              ) : null}

              {effectiveGraph !== undefined ? (
                <ExecutionGraph
                  projectKey={projectKey}
                  identifier={ticket.identifier}
                  graph={effectiveGraph}
                  onChanged={() => setRetryCount((n) => n + 1)}
                  onJoin={onChatStarted}
                />
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

/**
 * The drawer of one ticket and everything it needs, for any page that can open it (the Board, the Console): the acts
 * and their busy state, the slide-out hold (CYC-506), focus back on the card that opened it, and the ticket a pressed
 * notification asks for, which is taken (cleared) by whichever page is mounted. The card summary comes from the Project's board.
 */
export function useTicketDrawer(
  projectKey: string,
  openIdentifier: string | undefined,
  onOpen: (identifier: string) => void,
  onBack: () => void,
  onChatStarted: () => void,
) {
  const { t } = useI18n();
  const store = useAppStore();
  const board = useAppState((s) => s.loop.boards[projectKey]);
  const [problem, setProblem] = useState<LoopActFailure | undefined>();
  const [busyAction, setBusyAction] = useState<string | undefined>();
  const [version, setVersion] = useState(0);
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
    document
      .querySelector<HTMLElement>(
        `[data-slot="loop-ticket"][data-id="${CSS.escape(id)}"] > [data-slot="loop-ticket-title"]`,
      )
      ?.focus();
  }, [openIdentifier]);

  const request = useAppState((s) => s.loop.request);
  // A pressed notification asks for its ticket once: it is taken (cleared) here, so reopening the page does not repeat it.
  useEffect(() => {
    if (request === undefined || request.projectKey !== projectKey) return;
    onOpen(request.identifier);
    store.takeLoopRequest(request.n);
  }, [request, projectKey, store, onOpen]);

  const act: Act = async (ticket, action, confirmed, reason) => {
    const key = `${ticket.identifier}:${action}`;
    setProblem(undefined);
    setBusyAction(key);
    try {
      const result = await store.actOnLoopTicket(
        projectKey,
        ticket.identifier,
        action,
        confirmed,
        reason,
      );
      if (result.kind === "ok") {
        setVersion((v) => v + 1);
        return undefined;
      }
      if (action !== "approve" && action !== "return") setProblem(result.reason);
      return t(`loop.fail.${result.reason}`);
    } finally {
      setBusyAction(undefined);
    }
  };

  const openSummary = useMemo(() => {
    if (openIdentifier === undefined || typeof board !== "object" || board.kind !== "ok")
      return undefined;
    for (const c of board.columns) {
      const hit = c.tickets.find((tk) => tk.identifier === openIdentifier);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }, [board, openIdentifier]);

  // The drawer stays mounted after it is closed until its slide-out has played (CYC-506); a new ticket picked
  // meanwhile replaces it at once, and switching Projects clears any held drawer from the previous Project.
  const [held, setHeld] = useState<{
    projectKey: string;
    identifier: string;
    summary: LoopTicket | undefined;
  }>();
  const sameProjectHeld = held?.projectKey === projectKey ? held : undefined;
  if (
    openIdentifier !== undefined &&
    (sameProjectHeld?.identifier !== openIdentifier || sameProjectHeld.summary !== openSummary)
  ) {
    setHeld({ projectKey, identifier: openIdentifier, summary: openSummary });
  } else if (openIdentifier === undefined && held !== undefined && held.projectKey !== projectKey) {
    setHeld(undefined);
  }
  const drawerId = openIdentifier ?? sameProjectHeld?.identifier;
  const drawerSummary = openIdentifier !== undefined ? openSummary : sameProjectHeld?.summary;

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

  const drawer =
    drawerId !== undefined ? (
      <TicketDrawer
        key={drawerId}
        projectKey={projectKey}
        identifier={drawerId}
        summary={drawerSummary}
        closing={openIdentifier === undefined}
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
    ) : null;

  return { drawer, act, busyAction, alert, clearProblem: () => setProblem(undefined) };
}
