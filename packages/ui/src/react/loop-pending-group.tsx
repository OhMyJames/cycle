// The tickets the planning node left for a person (CYC-451): chosen a batch at a time, approved or returned. Approving
// a batch asks first and lists the titles; returning a batch only says no, with an optional reason. The Loop server does
// the writing and reports each ticket's outcome.
import { Button } from "@ui-sdk/react/button";
import { Input } from "@ui-sdk/react/input";
import { useState } from "react";
import type { LoopManyResult, LoopTicket } from "../api.ts";
import { ConfirmDialog } from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import { useAppStore } from "./store-context.tsx";

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const priorityRank = (p: string | null): number => PRIORITY_RANK[p ?? ""] ?? 4;

export function PendingGroup({
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
  // Stable by priority, then as the server lists them.
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
