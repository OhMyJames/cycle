// The Loop page (CYC-386): the Projects the Loop server on this computer serves, and one Project's itsaplan board, read
// only. It takes the window in place of the sessions, as Connectors does. The Projects are the page's sections: with the
// server away they stay listed, greyed, and say so. Nothing here changes a ticket.
import { Button } from "@ui-sdk/react/button";
import { useEffect, useState } from "react";
import type { LoopBoardAnswer, LoopTicket } from "../api.ts";
import { useI18n } from "./i18n.tsx";
import { ChevronDownIcon, ChevronRightIcon } from "./icons.tsx";
import { PageLayout, type PageSection } from "./page-layout.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";

/** The Backlog is the longest column by far: it opens on this many and shows this many more at a time. */
const BACKLOG_PAGE = 20;

function Ticket({ ticket }: { ticket: LoopTicket }) {
  return (
    <li data-slot="loop-ticket">
      <span data-slot="loop-ticket-id">{ticket.identifier}</span>
      <span data-slot="loop-ticket-title" title={ticket.title}>
        {ticket.title}
      </span>
      <span data-slot="loop-ticket-meta">
        {ticket.column}
        {ticket.priority !== null ? ` · ${ticket.priority}` : ""}
      </span>
    </li>
  );
}

function Column({
  id,
  title,
  tickets,
  collapsible,
  pageSize,
}: {
  id: "doing" | "todo" | "backlog" | "done";
  title: string;
  tickets: LoopTicket[];
  collapsible?: boolean;
  /** Show this many first, and this many more each time asked: for a column that can be very long. */
  pageSize?: number;
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
              <Ticket key={ticket.identifier} ticket={ticket} />
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
  const reload = { label: t("loop.reload"), onAction: () => void store.loadLoopBoard(projectKey) };
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
  return (
    <div data-slot="loop-board" data-kind="loop-board">
      <div data-slot="loop-board-bar">
        <span data-slot="loop-readonly">{t("loop.readOnly")}</span>
        <Button data-variant="ghost" onClick={reload.onAction}>
          {reload.label}
        </Button>
      </div>
      <div data-slot="loop-columns">
        <Column id="doing" title={t("loop.col.doing")} tickets={answer.doing} />
        <Column id="todo" title={t("loop.col.todo")} tickets={answer.todo} />
        <Column
          id="backlog"
          title={t("loop.col.backlog")}
          tickets={answer.backlog}
          pageSize={BACKLOG_PAGE}
        />
      </div>
      <Column id="done" title={t("loop.col.done")} tickets={answer.done} collapsible />
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
