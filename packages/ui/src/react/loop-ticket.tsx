// One ticket's drawer (CYC-493, CYC-431): the text, the criteria, the links and why it needs a person, as the Loop server
// answers (`loop/ticket/get`), with the buttons it allows (approve, back to Backlog, to Todo) and the conversation with
// an agent. It opens at the right of the board without unmounting it, so the board's scroll, filters and picks stay.
import { Button } from "@ui-sdk/react/button";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { LoopAction, LoopChatFailure, LoopTicket, LoopTicketDetail } from "../api.ts";
import { AgentLink } from "./agent-link.tsx";
import { ConfirmDialog } from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import { CheckIcon, CloseIcon, ErrorCircleIcon, MessageIcon, WarningIcon } from "./icons.tsx";
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

/** The buttons of one ticket. Approving asks first; the others go ahead and report only a failure. */
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
  if (ticket.actions.length === 0) return null;
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
            onClick={() => (action === "approve" ? setAsking(true) : void act(ticket, action))}
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
    </span>
  );
}

/** The run phases the page has words for; any other is shown as the server names it. */
const PHASE_WORD: Record<string, string> = {
  dev: "develop",
  qa: "qa",
  review: "review",
  research: "research",
  research_qa: "researchQa",
};

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

  // Which tickets Loop is running changes what the Loop server says of this one (watch or not): it is read again then.
  const runKey = useAppState((s) =>
    s.loop.runs === undefined
      ? "unknown"
      : s.loop.runs.kind === "ok" && (s.loop.runs.running[projectKey] ?? []).includes(identifier)
        ? "running"
        : "idle",
  );

  useEffect(() => {
    // These are dependencies, not read in here: a change of any of them reads the ticket again. Not before the run
    // state is known: the ticket would be read twice.
    void version;
    void retryCount;
    if (runKey === "unknown") return;
    void runKey;
    let live = true;
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
  }, [store, projectKey, identifier, version, retryCount, runKey]);

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
                onAction: () => {
                  setTicket("loading");
                  setRetryCount((n) => n + 1);
                },
              }}
            />
          ) : (
            <>
              <h3 data-slot="loop-detail-title">{ticket.title}</h3>
              {ticket.phase ? (
                <div data-slot="loop-detail-stage">
                  <TicketStage phase={ticket.phase} />
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
