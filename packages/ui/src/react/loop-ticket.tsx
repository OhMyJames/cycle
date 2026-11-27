// One ticket's page (CYC-493): the text, the criteria, the links and why it needs a person, as the Loop server answers
// (`loop/ticket/get`), with the buttons it allows (approve, back to Backlog, to Todo) and the conversation with an agent.
import { Button } from "@ui-sdk/react/button";
import { type ReactNode, useEffect, useState } from "react";
import type { LoopAction, LoopChatFailure, LoopTicketDetail } from "../api.ts";
import { AgentLink } from "./agent-link.tsx";
import { ConfirmDialog } from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";

const keyedItems = (items: string[]) => {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const n = seen.get(item) ?? 0;
    seen.set(item, n + 1);
    return { key: `${item}#${n}`, item };
  });
};

export type Act = (
  ticket: LoopTicketDetail,
  action: LoopAction,
  confirmed?: boolean,
) => Promise<string | undefined>;

/** The buttons of one ticket. Approving asks first; the others go ahead and report only a failure. */
function TicketActions({ ticket, act }: { ticket: LoopTicketDetail; act: Act }) {
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
        data-variant="ghost"
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

export function TicketPage({
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
  useEffect(() => {
    let live = true;
    void store.loadLoopTicket(projectKey, identifier).then((answer) => {
      if (live) setTicket(answer.kind === "ok" ? answer.ticket : "failed");
    });
    return () => {
      live = false;
    };
  }, [store, projectKey, identifier]);
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
            <JoinSession
              identifier={ticket.identifier}
              session={ticket.attention?.kind === "blocked" ? ticket.attention.session : undefined}
            />
          ) : null}
          {ticket.attention !== undefined ? (
            <section data-slot="loop-detail-section" data-attention={ticket.attention.kind}>
              <h4>{t(`loop.attention.${ticket.attention.kind}`)}</h4>
              {ticket.attention.text !== "" ? (
                <pre data-slot="loop-detail-body">{ticket.attention.text}</pre>
              ) : null}
              {ticket.attention.kind === "review" &&
              ticket.attention.prUrl !== null &&
              ticket.attention.prUrl !== "" ? (
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
