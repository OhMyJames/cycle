// Right-side session panel opened from Loop Timeline: lets the user inspect, answer permissions,
// and steer or reply to a Loop session alongside the timeline without leaving the Timeline page.
import { Button } from "@ui-sdk/react/button";
import { useEffect, useMemo, useState } from "react";
import { contextOf } from "../model/conversation.ts";
import { viewKey } from "../store/index.ts";
import { PendingRequest } from "./app-main.tsx";
import { useMarkRead } from "./app-navigation.ts";
import { Composer } from "./composer.tsx";
import { mergeConfigSchema } from "./config-form.tsx";
import { ConversationView } from "./conversation.tsx";
import { useI18n } from "./i18n.tsx";
import { CloseIcon, ExpandIcon } from "./icons.tsx";
import { SessionNotices } from "./notice-line.tsx";
import { currentPlan } from "./plan.tsx";
import { SessionScopeProvider } from "./session-scope.tsx";
import { sessionTitle } from "./sidebar.tsx";
import { StateBlock } from "./state-block.tsx";
import { MARK_STYLE, MARK_WORD, StatusDot } from "./status.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";

const ESCAPE_KEY = "Esc";

export function LoopSessionPanel({
  locationId,
  sessionId,
  onClose,
  onOpenFull,
}: {
  locationId: string;
  sessionId: string;
  onClose: () => void;
  onOpenFull: () => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const status = useAppState((s) => s.status);
  const session = useAppState((s) =>
    s.sessions[locationId]?.find((x) => x.sessionId === sessionId),
  );
  const agents = useAppState((s) => s.agents[locationId]);
  const key = viewKey(locationId, sessionId);
  const view = useAppState((s) => s.views[key]);
  const planUsage = useAppState((s) =>
    session !== undefined ? s.planUsage[locationId]?.[session.agent] : undefined,
  );
  const [sent, setSent] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  const locationState = status[locationId]?.state;
  const connected = locationState === "connected";
  const agent = agents?.find((a) => a.id === session?.agent);
  const hasSession = session !== undefined;

  useMarkRead(session, status, true);

  // Load the session once when opened, switched, reconnected, or retried — never in a loop if a read fails.
  useEffect(() => {
    void retryCount;
    if (!connected || !hasSession) return;
    setLoadFailed(false);
    let live = true;
    void store.openSessionView(locationId, sessionId).then((ok) => {
      if (live && !ok) setLoadFailed(true);
    });
    return () => {
      live = false;
    };
  }, [connected, hasSession, store, locationId, sessionId, retryCount]);

  const sessionSchema = useMemo(
    () =>
      agent === undefined
        ? undefined
        : mergeConfigSchema(agent.configSchema, view?.conversation.configOptions),
    [agent, view?.conversation.configOptions],
  );
  const conversation = view?.conversation;
  const counted = conversation === undefined ? undefined : contextOf(conversation);
  const usage = counted?.usage;
  const compactions = counted?.compactions ?? 0;
  const compacting = counted?.compacting ?? false;
  const hasConversation = conversation !== undefined;
  const context = useMemo(
    () => (hasConversation ? { usage, compactions, compacting } : undefined),
    [hasConversation, usage, compactions, compacting],
  );
  const activity = view?.permissions.length
    ? "requires_action"
    : (view?.conversation.status ?? "idle");
  const plan = view !== undefined ? currentPlan(view.conversation) : undefined;

  const scope = useMemo(
    () => ({ locationId, sessionId, hasSidePanel: false }),
    [locationId, sessionId],
  );
  const target = useMemo(() => ({ locationId, sessionId }), [locationId, sessionId]);
  const title = session !== undefined ? sessionTitle(session) : t("loop.timeline.sessionPanel");
  const mark =
    activity === "requires_action" ? "needs-you" : activity !== "idle" ? "running" : undefined;

  return (
    <SessionScopeProvider value={scope}>
      <header data-slot="loop-session-panel-head">
        <div data-slot="loop-session-panel-heading">
          {mark !== undefined ? (
            <>
              <StatusDot {...MARK_STYLE[mark]} />
              <span data-slot="visually-hidden">{t(MARK_WORD[mark])}</span>
            </>
          ) : null}
          <h2 data-slot="loop-session-panel-title" title={title}>
            {title}
          </h2>
        </div>
        <div data-slot="row">
          {session !== undefined ? (
            <Tip label={t("loop.timeline.openFullSession")} side="bottom">
              <Button data-variant="ghost" data-kind="panel-toggle" onClick={onOpenFull}>
                <ExpandIcon />
              </Button>
            </Tip>
          ) : null}
          <Tip label={t("loop.timeline.closeSession")} shortcut={ESCAPE_KEY} side="bottom">
            <Button data-variant="ghost" data-kind="panel-toggle" onClick={onClose}>
              <CloseIcon />
            </Button>
          </Tip>
        </div>
      </header>
      <SessionNotices
        locationId={locationId}
        shows={view !== undefined ? "session" : "nothing"}
        errors={false}
      />
      {view !== undefined ? (
        <>
          <ConversationView
            key={key}
            sessionKey={key}
            follow={sent}
            conversation={view.conversation}
            loading={view.loading}
            awaitingApproval={activity === "requires_action"}
          />
          <PendingRequest
            permissions={view.permissions}
            conversation={conversation}
            connected={connected}
          />
          <Composer
            key={`composer:${key}`}
            locationId={locationId}
            sessionId={sessionId}
            sessionKey={key}
            canAttach={agent?.promptCapabilities?.image != null}
            canAttachFiles={agent?.promptCapabilities?.embeddedContext != null}
            settings={
              sessionSchema !== undefined && session !== undefined
                ? { schema: sessionSchema, value: session.config ?? {}, live: true }
                : undefined
            }
            onSetting={(k, v) => store.setSessionConfig(k, v, target)}
            canSteer={agent?.steer === true}
            enabled={!view.loading}
            connected={connected}
            activity={activity}
            plan={plan}
            context={context}
            planUsage={planUsage}
            onSent={() => setSent((n) => n + 1)}
          />
        </>
      ) : session === undefined ? (
        <div data-slot="loop-session-panel-state">
          <StateBlock tone="empty" title={t("loop.run.sessionMissing")} />
        </div>
      ) : !connected ? (
        <div data-slot="loop-session-panel-state">
          <StateBlock
            tone="away"
            title={t("location.notConnected")}
            action={{
              label: t("location.connectAgain"),
              onAction: () => void store.connectLocation(locationId),
            }}
          />
        </div>
      ) : loadFailed ? (
        <div data-slot="loop-session-panel-state">
          <StateBlock
            tone="error"
            title={t("loop.timeline.sessionFailed")}
            action={{
              label: t("loop.reload"),
              onAction: () => setRetryCount((n) => n + 1),
            }}
          />
        </div>
      ) : (
        <div data-slot="loop-session-panel-state">
          <StateBlock tone="loading" title={t("conversation.loading")} />
        </div>
      )}
    </SessionScopeProvider>
  );
}
