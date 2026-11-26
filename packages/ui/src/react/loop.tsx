// The Loop page (CYC-386, CYC-387): the Projects the Loop server on this computer serves, and one Project's itsaplan
// board. It takes the window in place of the sessions, as Connectors does. The Projects are the page's sections: with
// the server away they stay listed, greyed, and say so. A ticket changes state only by a button (approve, back to
// Backlog, back to Todo; never by dragging); which buttons it has is decided by main, and approving asks first.
import { Button } from "@ui-sdk/react/button";
import { type ReactNode, useEffect, useState } from "react";
import type {
  LoopActFailure,
  LoopAction,
  LoopBoardAnswer,
  LoopNotice,
  LoopTicket,
  LoopTicketDetail,
} from "../api.ts";
import { AgentLink } from "./agent-link.tsx";
import { ConfirmDialog } from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import { ChevronDownIcon, ChevronRightIcon } from "./icons.tsx";
import { PageLayout, type PageSection } from "./page-layout.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";

/** The Backlog is the longest column by far: it opens on this many and shows this many more at a time. */
const BACKLOG_PAGE = 20;

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

function Ticket({
  ticket,
  act,
  onOpen,
}: {
  ticket: LoopTicket;
  act: Act;
  onOpen: (identifier: string) => void;
}) {
  return (
    <li data-slot="loop-ticket">
      <span data-slot="loop-ticket-id">{ticket.identifier}</span>
      <button
        type="button"
        data-slot="loop-ticket-title"
        title={ticket.title}
        onClick={() => onOpen(ticket.identifier)}
      >
        {ticket.title}
      </button>
      <span data-slot="loop-ticket-meta">
        {ticket.column}
        {ticket.priority !== null ? ` · ${ticket.priority}` : ""}
      </span>
      <TicketActions ticket={ticket} act={act} />
    </li>
  );
}

/** What needs a person, most urgent first. Each opens its ticket's page, where the session is joined. */
function Notices({
  notices,
  onOpen,
}: {
  notices: LoopNotice[];
  onOpen: (notice: LoopNotice) => void;
}) {
  const { t } = useI18n();
  if (notices.length === 0) return null;
  return (
    <section data-slot="loop-notices" data-kind="loop-notices" aria-label={t("loop.notices")}>
      <h3 data-slot="loop-column-title">{t("loop.notices")}</h3>
      <ul data-slot="loop-tickets">
        {notices.map((notice) => (
          <li
            key={`${notice.kind}:${notice.identifier}`}
            data-slot="loop-notice"
            data-notice={notice.kind}
          >
            <span data-slot="loop-ticket-id">{notice.identifier}</span>
            <button type="button" data-slot="loop-ticket-title" onClick={() => onOpen(notice)}>
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
function JoinSession({ identifier }: { identifier: string }) {
  const { t } = useI18n();
  const store = useAppStore();
  const [missing, setMissing] = useState(false);
  return (
    <span data-slot="loop-join">
      <Button
        data-variant="ghost"
        data-kind="loop-join"
        onClick={() => setMissing(!store.joinLoopSession(identifier))}
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
  problem,
}: {
  projectKey: string;
  identifier: string;
  act: Act;
  onBack: () => void;
  problem: ReactNode;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const [ticket, setTicket] = useState<LoopTicketDetail | "loading" | "failed">("loading");
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
          <JoinSession identifier={ticket.identifier} />
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

function Column({
  id,
  title,
  tickets,
  collapsible,
  pageSize,
  act,
  onOpen,
}: {
  id: "doing" | "todo" | "backlog" | "done";
  title: string;
  tickets: LoopTicket[];
  collapsible?: boolean;
  /** Show this many first, and this many more each time asked: for a column that can be very long. */
  pageSize?: number;
  act: Act;
  onOpen: (identifier: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(collapsible !== true);
  const [shown, setShown] = useState(pageSize ?? Number.POSITIVE_INFINITY);
  const visible = tickets.slice(0, shown);
  return (
    <section
      data-slot="loop-column"
      data-column={id}
      data-open={open || undefined}
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
            <span data-slot="loop-column-title">{title}</span>
          </Button>
        ) : (
          <h3 data-slot="loop-column-title">{title}</h3>
        )}
        <span data-slot="loop-column-count">{tickets.length}</span>
      </header>
      {open ? (
        tickets.length === 0 ? (
          <p data-slot="loop-column-empty">{t("loop.column.empty")}</p>
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

function Board({
  projectKey,
  answer,
}: {
  projectKey: string;
  answer: LoopBoardAnswer | "loading" | undefined;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const reload = {
    label: t("loop.reload"),
    onAction: () => {
      void store.loadLoopBoard(projectKey);
      void store.loadLoopNotices(projectKey);
    },
  };
  const notices = useAppState((s) => s.loop.notices[projectKey]);
  const request = useAppState((s) => s.loop.request);
  const [open, setOpen] = useState<string | undefined>();
  // A pressed notification asks for its ticket once: it is taken (cleared) here, so reopening the page does not repeat it.
  useEffect(() => {
    if (request === undefined || request.projectKey !== projectKey) return;
    setOpen(request.identifier);
    store.takeLoopRequest(request.n);
  }, [request, projectKey, store]);
  const [problem, setProblem] = useState<LoopActFailure | undefined>();
  const [version, setVersion] = useState(0);
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
    setOpen(identifier);
  };
  const alert =
    problem !== undefined ? (
      <p data-slot="loop-problem" role="alert">
        {t(`loop.fail.${problem}`)}
      </p>
    ) : null;
  if (answer === undefined || answer === "loading")
    return <StateBlock tone="loading" title={t("loop.loading")} />;
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
        onBack={() => {
          setProblem(undefined);
          setOpen(undefined);
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
      {notices?.kind === "ok" ? (
        <Notices
          notices={notices.notices}
          onOpen={(notice) => {
            store.track("loop_notice_opened", { kind: notice.kind });
            openTicket(notice.identifier);
          }}
        />
      ) : null}
      <div data-slot="loop-columns">
        <Column
          id="doing"
          title={t("loop.col.doing")}
          tickets={answer.doing}
          act={act}
          onOpen={openTicket}
        />
        <Column
          id="todo"
          title={t("loop.col.todo")}
          tickets={answer.todo}
          act={act}
          onOpen={openTicket}
        />
        <Column
          id="backlog"
          title={t("loop.col.backlog")}
          tickets={answer.backlog}
          pageSize={BACKLOG_PAGE}
          act={act}
          onOpen={openTicket}
        />
      </div>
      <Column
        id="done"
        title={t("loop.col.done")}
        tickets={answer.done}
        collapsible
        act={act}
        onOpen={openTicket}
      />
    </div>
  );
}

export function LoopPage({
  projectKey,
  onProject,
  onClose,
  banner,
}: {
  projectKey: string | undefined;
  onProject: (key: string) => void;
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

  // The Project shown: the one asked for, else the first the server has.
  const chosen = projects.find((p) => p.projectKey === projectKey) ?? projects[0];
  const chosenKey = chosen?.projectKey;
  useEffect(() => {
    if (chosenKey !== undefined && connected === true) void store.loadLoopBoard(chosenKey);
  }, [store, chosenKey, connected]);

  // Sessions that wait on an answer are part of the Notices: they are read again when that set changes.
  const waiting = useAppState((s) =>
    Object.values(s.sessions)
      .flat()
      .filter((x) => x.state === "requires_action")
      .map((x) => x.sessionId)
      .sort()
      .join(),
  );
  useEffect(() => {
    if (chosenKey !== undefined && connected === true) void store.loadLoopNotices(chosenKey);
    void waiting;
  }, [store, chosenKey, connected, waiting]);

  const away = connected === false;
  const sections: PageSection[] =
    projects.length === 0
      ? [
          {
            id: "projects",
            label: t("loop.projects"),
            content:
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
              ),
          },
        ]
      : projects.map((p) => ({
          id: p.projectKey,
          label: p.name,
          note: away ? t("loop.offline.note") : p.projectKey,
          disabled: away,
          heading: (
            <>
              {p.name} <span data-slot="loop-repo">{p.repo.displayName}</span>
            </>
          ),
          content: <Board projectKey={p.projectKey} answer={loop.boards[p.projectKey]} />,
        }));

  return (
    <PageLayout
      title={t("loop.title")}
      sectionsLabel={t("loop.sections")}
      backLabel={t("settings.back")}
      onBack={onClose}
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
      value={chosen?.projectKey ?? "projects"}
      onValueChange={onProject}
    />
  );
}
