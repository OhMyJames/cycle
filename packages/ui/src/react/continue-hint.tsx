import { Button } from "@ui-sdk/react/button";
import { useEffect, useState } from "react";
import type { ContextState } from "../model/conversation.ts";
import { useI18n } from "./i18n.tsx";
import { sessionTitle } from "./session-list.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";

/** A window this full makes every reply carry a long conversation again (CYC-279). */
export const LONG_CONTEXT = 200_000;
/** After this long without a reply the agent's cache of the conversation has gone, and the next reply pays for all of it. */
export const IDLE_MS = 55 * 60_000;
/** An idle session is only worth a hint once its conversation is big enough for that to cost something. */
export const IDLE_CONTEXT = 100_000;

export type HintReason = "context" | "idle";

/** What was dismissed, per session: the last activity it was dismissed at, so that a new turn asks again. */
const dismissals = new Map<string, string | undefined>();

/**
 * Whether to suggest carrying on in a new session: the conversation is long, or it was left long enough for the cache to
 * expire while it is big. Only when the session is idle and the daemon can hand its record to another session.
 */
export function useContinueHint(params: {
  locationId: string;
  sessionId: string | undefined;
  sessionKey: string;
  idle: boolean;
  connected: boolean;
  context: ContextState | undefined;
}) {
  const { locationId, sessionId, sessionKey, idle, connected, context } = params;
  const store = useAppStore();
  const canMention = useAppState(
    (s) => s.status[locationId]?.capabilities?.sessionMentions === true,
  );
  const session = useAppState((s) =>
    sessionId === undefined
      ? undefined
      : s.sessions[locationId]?.find((x) => x.sessionId === sessionId),
  );
  const updatedAt = session?.updatedAt;
  const [, redraw] = useState(0);
  const [late, setLate] = useState(false);
  // One timer, set for the moment the threshold is crossed: nothing else makes the page look at the clock.
  useEffect(() => {
    const at = updatedAt === undefined ? Number.NaN : Date.parse(updatedAt);
    if (Number.isNaN(at)) {
      setLate(false);
      return;
    }
    const wait = at + IDLE_MS - Date.now();
    if (wait <= 0) {
      setLate(true);
      return;
    }
    setLate(false);
    const timer = setTimeout(() => setLate(true), Math.min(wait, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [updatedAt]);

  const usage = context?.usage;
  const used = usage !== undefined && usage.beforeCompaction !== true ? usage.used : 0;
  const reason: HintReason | undefined =
    used > LONG_CONTEXT ? "context" : late && used > IDLE_CONTEXT ? "idle" : undefined;
  const dismissed = dismissals.has(sessionKey) && dismissals.get(sessionKey) === updatedAt;
  const shown =
    reason !== undefined &&
    sessionId !== undefined &&
    session !== undefined &&
    idle &&
    connected &&
    canMention &&
    !dismissed;

  useEffect(() => {
    if (shown) store.track("continue_hint_shown", { reason });
  }, [shown, reason, store]);

  return {
    reason: shown ? reason : undefined,
    session,
    dismiss: () => {
      dismissals.set(sessionKey, updatedAt);
      redraw((n) => n + 1);
    },
  };
}

/** The row in the composer's tray: what the length costs, and how to leave it behind. */
export function ContinueRow({
  reason,
  locationId,
  sessionId,
  onDismiss,
}: {
  reason: HintReason;
  locationId: string;
  sessionId: string;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const session = useAppState((s) =>
    s.sessions[locationId]?.find((x) => x.sessionId === sessionId),
  );
  if (session === undefined) return null;
  const carryOn = () => {
    if (store.continueInNewSession(locationId, sessionId, sessionTitle(session))) {
      store.track("continue_hint_used", { reason });
    }
  };
  return (
    <div data-slot="extension-row" data-kind="continue" role="status">
      <span data-slot="continue-text">{t(`composer.continue.${reason}`)}</span>
      <Button data-variant="outline" onClick={carryOn}>
        {t("composer.continue.action")}
      </Button>
      <Button data-variant="ghost" onClick={onDismiss}>
        {t("composer.continue.dismiss")}
      </Button>
    </div>
  );
}
