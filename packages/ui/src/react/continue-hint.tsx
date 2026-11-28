import { useEffect, useState } from "react";
import type { ContextState } from "../model/conversation.ts";
import { useI18n } from "./i18n.tsx";
import { MessageIcon } from "./icons.tsx";
import { NoticeLine } from "./notice-line.tsx";
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
 * expire while it is big. Only when the session is idle, nothing it started still runs in the background (what that
 * brings back comes to this session, not to a new one), and the daemon can hand its record to another session.
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
  // Which last activity the idle time was reached for: a new turn is not late until its own time comes.
  const [lateFor, setLateFor] = useState<string | undefined>();
  const late = updatedAt !== undefined && lateFor === updatedAt;
  // One timer, set for the moment the threshold is crossed: nothing else makes the page look at the clock.
  useEffect(() => {
    const at = updatedAt === undefined ? Number.NaN : Date.parse(updatedAt);
    if (updatedAt === undefined || Number.isNaN(at)) return;
    const wait = at + IDLE_MS - Date.now();
    if (wait <= 0) {
      setLateFor(updatedAt);
      return;
    }
    const timer = setTimeout(() => setLateFor(updatedAt), Math.min(wait, 2 ** 31 - 1));
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
    (session.background ?? 0) === 0 &&
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

/**
 * The session's notice about it, under the title bar (DESIGN.md §4.4, "会话提示栏"): what the length costs, and how to
 * leave it behind. Advice, not a fault: the plain tone, with what else is said of the session, not over the input box.
 */
export function ContinueNotice(params: Parameters<typeof useContinueHint>[0]) {
  const { t } = useI18n();
  const store = useAppStore();
  const { reason, session, dismiss } = useContinueHint(params);
  const { locationId, sessionId } = params;
  if (reason === undefined || session === undefined || sessionId === undefined) return null;
  return (
    <NoticeLine
      kind="continue"
      tone="info"
      icon={<MessageIcon />}
      text={t(`composer.continue.${reason}`)}
      action={{
        label: t("composer.continue.action"),
        onAction: () => {
          if (store.continueInNewSession(locationId, sessionId, sessionTitle(session)))
            store.track("continue_hint_used", { reason });
        },
      }}
      onDismiss={dismiss}
    />
  );
}
