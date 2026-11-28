// One Project's Console (CYC-556): the default page of a Loop project. What needs a person (Notices by urgency, then the
// queue of tickets awaiting approval), what the operator agent suggests, and what Loop is doing now. It reads what the
// Loop server answers (Notices, the board, the runs) and writes only through the same calls the board uses: a ticket's
// drawer (`useTicketDrawer`), `loop/intents/retry` and the batch approve / return of awaiting tickets (CYC-451, CYC-387).
import { isComposing } from "@ui-sdk/core";
import { Button } from "@ui-sdk/react/button";
import { Input } from "@ui-sdk/react/input";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LoopBoardAnswer, LoopManyResult, LoopNotice, LoopTicket } from "../api.ts";
import { ConfirmDialog } from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import { CheckIcon, ChevronRightIcon, CloseIcon, ErrorCircleIcon } from "./icons.tsx";
import { priorityRank } from "./loop-board-layout.ts";
import { GraphProgress } from "./loop-graph.tsx";
import {
  joinsSession,
  Notices,
  noticeUrgency,
  RetryFeedback,
  type RetryIntents,
} from "./loop-notices.tsx";
import { TicketStage, useTicketDrawer } from "./loop-ticket.tsx";
import { PageGroup, PageRows } from "./page-layout.tsx";
import { usePlaceActive } from "./shell.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";

const ESCAPE_KEY = "Esc";

export function LoopConsole({
  projectKey,
  answer,
  openIdentifier,
  onOpen,
  onBack,
  onChatStarted,
}: {
  projectKey: string;
  answer: LoopBoardAnswer | "loading" | undefined;
  /** The ticket whose drawer is open over the Console, if any. */
  openIdentifier: string | undefined;
  onOpen: (identifier: string) => void;
  onBack: () => void;
  onChatStarted: () => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const { drawer, alert, clearProblem } = useTicketDrawer(
    projectKey,
    openIdentifier,
    onOpen,
    onBack,
    onChatStarted,
  );
  const noticesAnswer = useAppState((s) => s.loop.notices[projectKey]);
  const runs = useAppState((s) => s.loop.runs);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [why, setWhy] = useState("");
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retryFeedback, setRetryFeedback] = useState<
    { ok: boolean; message: string } | undefined
  >();
  const [problem, setProblem] = useState<string | undefined>();
  const [outcome, setOutcome] = useState<LoopManyResult | undefined>();

  const boardOk = typeof answer === "object" && answer.kind === "ok";
  const columns = boardOk ? answer.columns : [];
  const notices = noticesAnswer?.kind === "ok" ? noticesAnswer.notices : [];
  const needsYou = useMemo(
    () =>
      notices
        .filter((n) => n.kind !== "operator")
        .map((n, i) => ({ n, i }))
        .sort((a, b) => noticeUrgency(a.n) - noticeUrgency(b.n) || a.i - b.i)
        .map((x) => x.n),
    [notices],
  );
  const operator = useMemo(() => notices.filter((n) => n.kind === "operator"), [notices]);

  const tickets = useMemo(() => {
    const map = new Map<string, LoopTicket>();
    for (const c of columns) for (const tk of c.tickets) map.set(tk.identifier, tk);
    return map;
  }, [columns]);

  const pending = useMemo(() => {
    const list: LoopTicket[] = [];
    for (const c of columns) {
      if (c.stateType !== "backlog") continue;
      for (const tk of c.tickets) if (tk.pending !== undefined) list.push(tk);
    }
    return list.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
  }, [columns]);
  const chosen = useMemo(() => pending.filter((x) => picked.has(x.identifier)), [pending, picked]);

  const running = useMemo(() => {
    const ids = runs?.kind === "ok" ? (runs.running[projectKey] ?? []) : [];
    return ids
      .map((id, i) => ({ id, i, ticket: tickets.get(id) }))
      .sort((a, b) => {
        const sa = a.ticket?.phase ? Date.parse(a.ticket.phase.since) : Number.NaN;
        const sb = b.ticket?.phase ? Date.parse(b.ticket.phase.since) : Number.NaN;
        if (Number.isNaN(sa) !== Number.isNaN(sb)) return Number.isNaN(sa) ? 1 : -1;
        return (Number.isNaN(sa) ? 0 : sa - sb) || a.i - b.i;
      });
  }, [runs, projectKey, tickets]);

  // One count of what the person meets here per visit: when the board and the Notices are both read, not on the
  // 30-second reads after.
  const tracked = useRef(false);
  useEffect(() => {
    if (tracked.current || !boardOk || noticesAnswer?.kind !== "ok") return;
    tracked.current = true;
    store.track("loop_console_shown", {
      needs_you: needsYou.length,
      pending: pending.length,
      operator: operator.length,
      running: running.length,
    });
  }, [
    store,
    boardOk,
    noticesAnswer,
    needsYou.length,
    pending.length,
    operator.length,
    running.length,
  ]);

  // Escape clears the selection, when no drawer is open over the Console and no page from the Loop is over it.
  const active = usePlaceActive();
  useEffect(() => {
    if (!active || picked.size === 0 || openIdentifier !== undefined) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isComposing(event)) return;
      if (document.querySelector('[role="alertdialog"], [role="dialog"]') !== null) return;
      event.preventDefault();
      setPicked(new Set());
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, picked.size, openIdentifier]);

  // A selection belongs to its Project.
  const shownFor = useRef(projectKey);
  useEffect(() => {
    if (shownFor.current === projectKey) return;
    shownFor.current = projectKey;
    setPicked(new Set());
    setOutcome(undefined);
    setProblem(undefined);
    setRetryFeedback(undefined);
  }, [projectKey]);

  const openTicket = (identifier: string) => {
    clearProblem();
    onOpen(identifier);
  };

  const retryIntents: RetryIntents = async (key, identifier) => {
    const answer = await retryOnce(key, identifier);
    setRetryFeedback(answer);
    return answer;
  };
  const retryOnce: RetryIntents = async (key, identifier) => {
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

  const openNotice = (notice: LoopNotice) => {
    store.track("loop_notice_opened", { kind: notice.kind, from: "console" });
    if (notice.session !== null && joinsSession(notice) && store.joinLoopSession(notice.session.id))
      return;
    if (notice.identifier !== null) openTicket(notice.identifier);
  };

  const togglePick = (identifier: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(identifier)) next.add(identifier);
      return next;
    });
  const allChosen = pending.length > 0 && chosen.length === pending.length;
  const selectAll = () =>
    setPicked(allChosen ? new Set() : new Set(pending.map((x) => x.identifier)));

  const runBatch = async (action: "approve_many" | "return_many"): Promise<string | undefined> => {
    setBusy(true);
    setOutcome(undefined);
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
    setOutcome(result);
    setPicked(new Set());
    if (action === "return_many") setWhy("");
    return undefined;
  };
  const count = (kind: "ok" | "skipped" | "failed") =>
    outcome?.kind === "done" ? outcome.results.filter((r) => r.outcome === kind).length : 0;

  const refresh = async () => {
    await Promise.all([store.loadLoopBoard(projectKey), store.loadLoopNotices(projectKey)]);
  };

  if (answer === undefined || answer === "loading")
    return (
      <div data-slot="loop-console" data-kind="loop-console">
        <StateBlock tone="loading" title={t("loop.loading")} />
      </div>
    );
  if (answer.kind !== "ok")
    return (
      <div data-slot="loop-console" data-kind="loop-console">
        <StateBlock
          tone={answer.kind === "no_server" ? "away" : "error"}
          title={t(answer.kind === "no_server" ? "loop.offline.title" : "loop.unreachable.title")}
          body={t(answer.kind === "no_server" ? "loop.offline.body" : "loop.unreachable.body")}
          action={{ label: t("loop.reload"), onAction: () => void refresh() }}
        />
      </div>
    );

  const hasNeeds =
    needsYou.length > 0 ||
    pending.length > 0 ||
    outcome !== undefined ||
    retryFeedback !== undefined;
  return (
    <div data-slot="loop-console" data-kind="loop-console">
      {/* The place for the metrics strip of CYC-391: nothing is drawn, and it takes no height. */}
      {openIdentifier === undefined ? alert : null}
      {hasNeeds ? (
        <section data-slot="loop-console-needs" aria-label={t("loop.notices")}>
          <PageGroup title={t("loop.notices")}>
            {needsYou.length > 0 ? (
              <PageRows>
                <Notices
                  projectKey={projectKey}
                  notices={needsYou}
                  onOpen={openNotice}
                  onRetryIntents={retryIntents}
                />
              </PageRows>
            ) : null}
            {retryFeedback !== undefined ? (
              <RetryFeedback
                feedback={retryFeedback}
                onDismiss={() => setRetryFeedback(undefined)}
              />
            ) : null}
            {problem !== undefined ? (
              <div data-slot="loop-board-notice" data-tone="error" role="alert">
                <ErrorCircleIcon size={14} />
                <span>{problem}</span>
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
            ) : null}
            {outcome?.kind === "done" ? (
              <div data-slot="loop-board-notice" data-tone="info" role="status">
                <CheckIcon size={14} />
                <span>
                  {t("loop.pending.done", {
                    ok: count("ok"),
                    skipped: count("skipped"),
                    failed: count("failed"),
                  })}
                </span>
                <Tip label={t("notice.dismiss")}>
                  <Button
                    data-variant="ghost"
                    data-kind="loop-notice-dismiss"
                    onClick={() => setOutcome(undefined)}
                  >
                    <CloseIcon size={12} />
                  </Button>
                </Tip>
              </div>
            ) : null}
            {pending.length > 0 ? (
              <PageRows>
                <section data-slot="loop-pending-queue" aria-label={t("loop.pending")}>
                  <div data-slot="loop-pending-head">
                    <label data-slot="loop-column-select-all">
                      <input type="checkbox" checked={allChosen} onChange={selectAll} />
                      {t("loop.pending.all")}
                    </label>
                    <span data-slot="loop-pending-title">
                      {t("loop.pending")} {pending.length}
                    </span>
                    {chosen.length > 0 ? (
                      <>
                        <span data-slot="loop-batch-label">
                          {t("loop.pending.selected", { count: chosen.length })}
                        </span>
                        <Input
                          data-kind="loop-batch-why"
                          value={why}
                          aria-label={t("loop.pending.why")}
                          placeholder={t("loop.pending.why")}
                          onChange={(event) => setWhy(event.currentTarget.value)}
                        />
                        <Button
                          data-variant="outline"
                          data-kind="loop-return-many"
                          disabled={busy}
                          onClick={() => void runBatch("return_many")}
                        >
                          {t("loop.pending.return")}
                        </Button>
                        <Button
                          data-variant="solid"
                          data-kind="loop-approve-many"
                          disabled={busy}
                          onClick={() => setAsking(true)}
                        >
                          {t("loop.pending.approve")}
                        </Button>
                        <Tip label={t("loop.pending.clear")} shortcut={ESCAPE_KEY}>
                          <Button
                            data-variant="ghost"
                            data-kind="loop-batch-clear"
                            aria-disabled={busy || undefined}
                            onClick={() => {
                              if (!busy) setPicked(new Set());
                            }}
                          >
                            <CloseIcon size={14} />
                          </Button>
                        </Tip>
                      </>
                    ) : null}
                  </div>
                  <ul data-slot="loop-notice-list">
                    {pending.map((tk) => (
                      <li
                        key={tk.identifier}
                        data-slot="loop-notice"
                        data-notice="pending"
                        data-id={tk.identifier}
                      >
                        <input
                          type="checkbox"
                          data-slot="loop-pending-pick"
                          aria-label={`${t("loop.pending.pick")} ${tk.identifier}`}
                          checked={picked.has(tk.identifier)}
                          onChange={() => togglePick(tk.identifier)}
                        />
                        <button
                          type="button"
                          data-slot="loop-notice-open"
                          onClick={() => openTicket(tk.identifier)}
                        >
                          <span data-slot="loop-notice-body">
                            <span data-slot="loop-notice-head">
                              <span data-slot="loop-ticket-id">{tk.identifier}</span>
                              <span data-slot="loop-ticket-text">{tk.title}</span>
                            </span>
                            {tk.pending?.reason ? (
                              <span data-slot="loop-notice-detail">{tk.pending.reason}</span>
                            ) : null}
                          </span>
                          <span data-slot="loop-notice-go">{t("loop.console.view")}</span>
                          <ChevronRightIcon size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              </PageRows>
            ) : null}
          </PageGroup>
        </section>
      ) : null}

      {operator.length > 0 ? (
        <section data-slot="loop-console-operator" aria-label={t("loop.console.operator")}>
          <PageGroup title={t("loop.console.operator")}>
            <PageRows>
              <Notices projectKey={projectKey} notices={operator} onOpen={openNotice} />
            </PageRows>
          </PageGroup>
        </section>
      ) : null}

      <section data-slot="loop-console-running" aria-label={t("loop.console.running")}>
        <PageGroup title={t("loop.console.running")}>
          {running.length === 0 ? (
            <p data-slot="loop-console-idle">{t("loop.console.idle")}</p>
          ) : (
            <PageRows>
              <ul data-slot="loop-notice-list">
                {running.map(({ id, ticket }) => (
                  <li key={id} data-slot="loop-notice" data-notice="running" data-id={id}>
                    <button
                      type="button"
                      data-slot="loop-notice-open"
                      onClick={() => openTicket(id)}
                    >
                      <span data-slot="loop-notice-body">
                        <span data-slot="loop-notice-head">
                          <span data-slot="loop-ticket-id">{id}</span>
                          {ticket !== undefined ? (
                            <span data-slot="loop-ticket-text" title={ticket.title}>
                              {ticket.title}
                            </span>
                          ) : null}
                        </span>
                      </span>
                      {ticket?.phase ? <TicketStage phase={ticket.phase} /> : null}
                      {ticket?.graph ? <GraphProgress graph={ticket.graph} /> : null}
                      <ChevronRightIcon size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            </PageRows>
          )}
        </PageGroup>
      </section>

      {asking ? (
        <ConfirmDialog
          open
          onOpenChange={setAsking}
          title={t("loop.pending.approve.title", { count: chosen.length })}
          description={t("loop.pending.approve.body")}
          detail={chosen.map((x) => [x.identifier, x.title].join(" ")).join("\n")}
          confirmLabel={t("loop.pending.approve")}
          onConfirm={() => runBatch("approve_many")}
        />
      ) : null}
      {drawer}
    </div>
  );
}
