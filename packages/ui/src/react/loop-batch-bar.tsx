// The selection dock of the Loop board (CYC-451, CYC-431): rises when tickets waiting for approval are picked. Approving
// a batch asks first and lists the titles; returning a batch only says no, with an optional reason. The Loop server does
// the writing and reports each ticket's outcome.
import { Button } from "@ui-sdk/react/button";
import { Input } from "@ui-sdk/react/input";
import type { LoopTicket } from "../api.ts";
import { useI18n } from "./i18n.tsx";
import { CloseIcon } from "./icons.tsx";
import { Tip } from "./tip.tsx";

const ESCAPE_KEY = "Esc";

/** Floating selection dock (SakaniUI KanbanBoardBlock `.barDock` / `.bar`): rises only when pending cards are picked. */
export function BatchBar({
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
