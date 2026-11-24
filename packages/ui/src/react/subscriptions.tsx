// Settings → Model providers → Subscriptions: the accounts the agents themselves are signed in with (Claude, Codex,
// Antigravity), one location at a time. What an agent's session may use depends on it, so signing in and out, and what
// the plan has left, are here and not on the agent's Harness page.
import type { AgentWord } from "@cycle/analytics/events";
import { Button } from "@ui-sdk/react/button";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentAuthProblemReason,
  AgentInfo,
  AgentSetupSnapshot,
  LocationConfig,
  LocationStatus,
} from "../api.ts";
import {
  AgentSignInDialog,
  accountPrimaryLabel,
  accountSubtitle,
  authErrorText,
  type SignInModalState,
} from "./agent-account-parts.tsx";
import { ConfirmDialog } from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import { LocationScope } from "./location-scope.tsx";
import { PageGroup, PageRow, PageRows } from "./page-layout.tsx";
import { PlanUsageBars, planRowsOf } from "./plan-usage-bars.tsx";
import { StateBlock } from "./state-block.tsx";
import { AGENT_AUTH_DOT, StatusDot } from "./status.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";

const AGY_INSTALL_COMMAND = "curl -fsSL https://antigravity.google/cli/install.sh | bash";

/** The agents that are signed in to a subscription, in the order they are listed. */
export const SUBSCRIPTION_AGENTS: readonly { id: string; name: string }[] = [
  { id: "claude", name: "Claude" },
  { id: "codex", name: "Codex" },
  { id: "agy", name: "Antigravity" },
];

const agentWord = (id: string): AgentWord =>
  id === "claude" || id === "codex" || id === "agy" || id === "pi" ? id : "other";

export type SubscriptionsSectionProps = {
  locations: LocationConfig[];
  status: Record<string, LocationStatus>;
  agents: Record<string, AgentInfo[]>;
  locationId: string | undefined;
  onLocationChange: (locationId: string) => void;
  onShowLocations: () => void;
};

export function SubscriptionsSection(props: SubscriptionsSectionProps) {
  return (
    <LocationScope
      locations={props.locations}
      status={props.status}
      locationId={props.locationId}
      onLocationChange={props.onLocationChange}
      onShowLocations={props.onShowLocations}
    >
      {(location, supportsSetup) =>
        SUBSCRIPTION_AGENTS.map((agent) => (
          <SubscriptionGroup
            key={`${location.id}:${agent.id}:${supportsSetup ? "setup" : "legacy"}`}
            agentId={agent.id}
            agentName={agent.name}
            agentInfo={(props.agents[location.id] ?? []).find((a) => a.id === agent.id)}
            location={location}
            supportsSetup={supportsSetup}
          />
        ))
      }
    </LocationScope>
  );
}

/** One agent's account on one location: read when shown, kept up by the daemon's events. */
function SubscriptionGroup({
  agentId,
  agentName,
  agentInfo,
  location,
  supportsSetup,
}: {
  agentId: string;
  agentName: string;
  agentInfo: AgentInfo | undefined;
  location: LocationConfig;
  supportsSetup: boolean;
}) {
  const { t, date } = useI18n();
  const store = useAppStore();
  const livePlanUsage = useAppState((s) => s.planUsage[location.id]?.[agentId]);
  const setupRevision = useAppState((s) => s.agentSetupRevision[`${location.id}:${agentId}`] ?? 0);
  const hasAgent = agentInfo !== undefined;
  const readable = supportsSetup && hasAgent;

  const [snapshot, setSnapshot] = useState<AgentSetupSnapshot | undefined>(undefined);
  const [loading, setLoading] = useState(readable);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [copiedLogin, setCopiedLogin] = useState(false);
  const [signInDialog, setSignInDialog] = useState<SignInModalState | undefined>(undefined);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const mountedRef = useRef(true);
  const seenSetupRevisionRef = useRef(setupRevision);
  /** Each read is numbered: an answer is kept only if no newer one has been kept since. */
  const fetchSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);
  const pendingLoudRef = useRef(0);
  const signInSessionRef = useRef(0);
  const activeFlowIdRef = useRef<string | undefined>(undefined);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      signInSessionRef.current += 1;
      const pendingFlow = activeFlowIdRef.current;
      activeFlowIdRef.current = undefined;
      if (pendingFlow !== undefined) void store.cancelAgentAuth(location.id, pendingFlow);
      clearTimeout(copyTimer.current);
    };
  }, [store, location.id]);

  const fetchSetup = useCallback(
    async (opts: { forceRefresh?: boolean; refreshUsage?: boolean; silent?: boolean }) => {
      if (!readable) return;
      const seq = ++fetchSeqRef.current;
      const loud = opts.silent !== true;
      if (loud) {
        pendingLoudRef.current += 1;
        if (opts.forceRefresh) setRefreshing(true);
        else setLoading(true);
        setLoadError(undefined);
      }
      try {
        const result = await store.readAgentSetup(location.id, agentId, {
          ...(opts.forceRefresh ? { forceRefresh: true } : {}),
          ...(opts.refreshUsage ? { refreshUsage: true } : {}),
        });
        if (!mountedRef.current || seq <= appliedSeqRef.current) return;
        appliedSeqRef.current = seq;
        setSnapshot(result);
        setLoadError(undefined);
      } catch (error) {
        if (!mountedRef.current || seq <= appliedSeqRef.current) return;
        if (loud) setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        if (loud && mountedRef.current) {
          pendingLoudRef.current -= 1;
          if (pendingLoudRef.current === 0) {
            setLoading(false);
            setRefreshing(false);
          }
        }
      }
    },
    [readable, store, location.id, agentId],
  );

  useEffect(() => {
    if (readable) void fetchSetup({ refreshUsage: agentId === "codex" });
  }, [fetchSetup, readable, agentId]);

  useEffect(() => {
    if (setupRevision === seenSetupRevisionRef.current) return;
    seenSetupRevisionRef.current = setupRevision;
    if (readable) void fetchSetup({ silent: true });
  }, [setupRevision, fetchSetup, readable]);

  const copyLoginCommand = (command: string) => {
    void store.copyText(command).then((ok) => {
      if (!ok) return;
      store.track("agent_setup_command_copied", { agent: agentWord(agentId), kind: "login" });
      clearTimeout(copyTimer.current);
      setCopiedLogin(true);
      copyTimer.current = setTimeout(() => setCopiedLogin(false), 1500);
    });
  };

  const beginSignIn = useCallback(async () => {
    const session = ++signInSessionRef.current;
    activeFlowIdRef.current = undefined;
    setSignInDialog({ kind: "starting" });
    const answer = await store.startAgentAuth(location.id, agentId);
    if (!mountedRef.current || signInSessionRef.current !== session) {
      // Left or cancelled while starting: cancel it on the daemon so the agent is not locked for 10 minutes.
      if (answer.started) void store.cancelAgentAuth(location.id, answer.flowId);
      return;
    }
    if (!answer.started) {
      setSignInDialog({ kind: "error", reason: answer.reason });
      return;
    }
    activeFlowIdRef.current = answer.flowId;
    setSignInDialog({
      kind: "active",
      flowId: answer.flowId,
      mode: answer.mode,
      hasUrl: answer.hasUrl,
      ...(answer.host !== undefined ? { host: answer.host } : {}),
      ...(answer.userCode !== undefined ? { userCode: answer.userCode } : {}),
    });
  }, [store, location.id, agentId]);

  const activeFlowId = signInDialog?.kind === "active" ? signInDialog.flowId : undefined;
  const flowCompletion = useAppState((s) =>
    activeFlowId !== undefined
      ? s.agentAuthCompletions[`${location.id}:${activeFlowId}`]
      : undefined,
  );
  useEffect(() => {
    if (flowCompletion === undefined || activeFlowId === undefined) return;
    if (activeFlowIdRef.current === activeFlowId) activeFlowIdRef.current = undefined;
    if (flowCompletion.ok) {
      setSignInDialog(undefined);
      void fetchSetup({ forceRefresh: true, refreshUsage: agentId === "codex" });
      return;
    }
    if (flowCompletion.reason === "cancelled") {
      setSignInDialog(undefined);
      return;
    }
    setSignInDialog({
      kind: "error",
      reason: (flowCompletion.reason as AgentAuthProblemReason | undefined) ?? "failed",
    });
  }, [flowCompletion, activeFlowId, fetchSetup, agentId]);

  const canInAppSignIn =
    snapshot !== undefined &&
    snapshot.binary.problem === undefined &&
    (snapshot.auth.state === "signed_out" || snapshot.auth.state === "auth_unknown") &&
    (location.kind === "local"
      ? snapshot.auth.signInModes.length > 0
      : snapshot.auth.signInModes.some((m) => !m.requiresLocalLoopback));
  const canSignOut =
    snapshot !== undefined &&
    snapshot.binary.problem === undefined &&
    snapshot.auth.state === "signed_in" &&
    snapshot.auth.canSignOut;

  const effectivePlanUsage = snapshot?.planUsage ?? livePlanUsage;
  const now = Date.now();
  const hasUsageBars = planRowsOf(effectivePlanUsage, now).length > 0;
  const retry = () => void fetchSetup({ forceRefresh: true, refreshUsage: true });

  return (
    <PageGroup
      title={agentName}
      action={
        snapshot !== undefined ? (
          <Button data-variant="outline" disabled={refreshing} onClick={retry}>
            {refreshing
              ? t("settings.harness.account.refreshing")
              : t("settings.harness.account.refresh")}
          </Button>
        ) : undefined
      }
    >
      {!supportsSetup ? (
        <StateBlock
          size="inline"
          align="start"
          tone="away"
          title={t("settings.harness.oldDaemon", { location: location.name })}
          body={t("settings.harness.oldDaemonBody", { location: location.name })}
        />
      ) : !hasAgent ? (
        <StateBlock
          size="inline"
          align="start"
          tone="away"
          title={t("settings.harness.unavailable.notListed", {
            agent: agentName,
            location: location.name,
          })}
        />
      ) : snapshot === undefined ? (
        loadError !== undefined ? (
          <StateBlock
            size="inline"
            align="start"
            tone="error"
            title={t("settings.harness.loadFailed", { agent: agentName })}
            reason={loadError}
            action={{ label: t("blank.retry"), onAction: retry }}
          />
        ) : loading ? (
          <StateBlock
            size="inline"
            align="start"
            tone="loading"
            title={t("settings.harness.loading", { agent: agentName })}
          />
        ) : null
      ) : (
        <>
          {snapshot.binary.problem !== undefined ? (
            <StateBlock
              size="inline"
              align="start"
              tone="away"
              title={
                snapshot.binary.problem === "version_too_old"
                  ? t("settings.harness.unavailable.tooOld", {
                      agent: agentName,
                      version: snapshot.binary.version ?? "",
                      location: location.name,
                      minVersion: snapshot.binary.minVersion ?? "",
                    })
                  : snapshot.binary.problem === "probe_failed"
                    ? t("settings.harness.unavailable.probeFailed", {
                        agent: agentName,
                        location: location.name,
                      })
                    : t("settings.harness.unavailable.missing", {
                        agent: agentName,
                        location: location.name,
                      })
              }
              reason={agentId === "agy" ? AGY_INSTALL_COMMAND : undefined}
              action={{ label: t("settings.harness.account.refresh"), onAction: retry }}
            />
          ) : null}
          {loadError !== undefined ? (
            <StateBlock
              size="inline"
              align="start"
              tone="error"
              title={t("settings.harness.loadFailed", { agent: agentName })}
              reason={loadError}
              action={{ label: t("blank.retry"), onAction: retry }}
            />
          ) : null}
          <PageRows>
            <PageRow
              label={accountPrimaryLabel(snapshot, t)}
              before={
                <StatusDot
                  tone={AGENT_AUTH_DOT[snapshot.auth.state].tone}
                  shape={AGENT_AUTH_DOT[snapshot.auth.state].shape}
                />
              }
              description={accountSubtitle(snapshot, t, date)}
              below={
                snapshot.auth.state === "signed_out" || snapshot.auth.state === "auth_unknown" ? (
                  <div data-slot="harness-command-row">
                    <code data-slot="reason">{snapshot.auth.loginCommand}</code>
                    <Button
                      data-variant="outline"
                      onClick={() => copyLoginCommand(snapshot.auth.loginCommand)}
                    >
                      {copiedLogin
                        ? t("settings.harness.account.copied")
                        : t("settings.harness.account.copyLogin")}
                    </Button>
                  </div>
                ) : undefined
              }
            >
              {canInAppSignIn ? (
                <Button
                  type="button"
                  data-variant="solid"
                  disabled={signInDialog?.kind === "starting"}
                  onClick={() => void beginSignIn()}
                >
                  {t("settings.harness.account.signIn")}
                </Button>
              ) : null}
              {canSignOut ? (
                <Button
                  type="button"
                  data-variant="outline"
                  onClick={() => setConfirmSignOut(true)}
                >
                  {t("settings.harness.account.signOut")}
                </Button>
              ) : null}
            </PageRow>
          </PageRows>

          <AgentSignInDialog
            state={signInDialog}
            agentName={agentName}
            locationName={location.name}
            loginCommand={snapshot.auth.loginCommand}
            copiedLogin={copiedLogin}
            onCopyLogin={() => copyLoginCommand(snapshot.auth.loginCommand)}
            onOpenBrowser={(flowId) => store.openAgentAuthUrl(location.id, flowId)}
            onSubmitCode={(flowId, code) => store.submitAgentAuth(location.id, flowId, code)}
            onRetry={() => void beginSignIn()}
            onClose={() => {
              signInSessionRef.current += 1;
              const pendingFlow = activeFlowIdRef.current;
              activeFlowIdRef.current = undefined;
              if (pendingFlow !== undefined) void store.cancelAgentAuth(location.id, pendingFlow);
              setSignInDialog(undefined);
            }}
          />

          <ConfirmDialog
            open={confirmSignOut}
            onOpenChange={setConfirmSignOut}
            title={t("settings.harness.auth.signOutTitle", { agent: agentName })}
            description={t("settings.harness.auth.signOutDescription", {
              agent: agentName,
              location: location.name,
            })}
            confirmLabel={t("settings.harness.account.signOut")}
            destructive
            onConfirm={async () => {
              const answer = await store.logoutAgent(location.id, agentId);
              if (!answer.ok) return authErrorText(answer.reason, t);
              void fetchSetup({ forceRefresh: true });
              return undefined;
            }}
          />

          {hasUsageBars ? (
            <div data-slot="harness-usage">
              <PlanUsageBars plan={effectivePlanUsage} showHeading={false} now={now} />
            </div>
          ) : snapshot.auth.state === "signed_in" && agentId === "claude" ? (
            <p data-slot="hint">{t("settings.harness.account.usagePassiveHint")}</p>
          ) : null}
        </>
      )}
    </PageGroup>
  );
}
