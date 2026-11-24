// Settings → Harness page (CYCL-229, docs/harness-settings.md):
// Shows one agent's account status & plan usage at the top, followed by Session defaults
// (`_cycle/agent_defaults/*`) and read-only host diagnostics from `config.json`.
// Degrades smoothly to Session defaults only when connected to an older daemon without `agentSetup`.
import type { AgentWord } from "@cycle/analytics/events";
import { Button } from "@ui-sdk/react/button";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentAuthMode,
  AgentAuthProblemReason,
  AgentInfo,
  AgentRuntimePatchValue,
  AgentSetupSnapshot,
  EnvironmentConfig,
  EnvironmentStatus,
} from "../api.ts";
import { ConfigForm, RuntimeConfigForm, type RuntimeFieldText } from "./config-form.tsx";
import { ConfirmDialog } from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import { PageGroup, PageRow, PageRows } from "./page-layout.tsx";
import { PlanUsageBars, planRowsOf } from "./plan-usage-bars.tsx";
import { StateBlock } from "./state-block.tsx";
import { AGENT_AUTH_DOT, StatusDot } from "./status.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";

const AGY_INSTALL_COMMAND = "curl -fsSL https://antigravity.google/cli/install.sh | bash";

export type HarnessEntry = {
  id: string;
  name: string;
};

/** Built-in harnesses kept in a fixed order in Settings nav regardless of environment availability. */
export const BUILTIN_HARNESSES: readonly HarnessEntry[] = [
  { id: "claude", name: "Claude" },
  { id: "codex", name: "Codex" },
  { id: "agy", name: "Antigravity" },
];

/**
 * Stable ordered harness list for Settings navigation: known built-in harnesses first in fixed order,
 * followed by any additional agents advertised by connected newer daemons (e.g. `pi`).
 */
export const harnessListOf = (agentsByEnv: Record<string, AgentInfo[]>): HarnessEntry[] => {
  const known = new Set<string>(BUILTIN_HARNESSES.map((h) => h.id));
  const extras: HarnessEntry[] = [];
  const seenExtras = new Set<string>();
  for (const list of Object.values(agentsByEnv)) {
    for (const agent of list) {
      if (known.has(agent.id) || seenExtras.has(agent.id)) continue;
      seenExtras.add(agent.id);
      extras.push({ id: agent.id, name: agent.name });
    }
  }
  return [...BUILTIN_HARNESSES, ...extras];
};

const agentWord = (id: string): AgentWord =>
  id === "claude" || id === "codex" || id === "agy" || id === "pi" ? id : "other";

export type HarnessSectionProps = {
  agentId: string;
  agentName: string;
  environments: EnvironmentConfig[];
  status: Record<string, EnvironmentStatus>;
  agents: Record<string, AgentInfo[]>;
  environmentId: string | undefined;
  onEnvironmentChange: (environmentId: string) => void;
  from: "settings" | "blank" | "other";
  onShowEnvironments: () => void;
};

export function HarnessSection({
  agentId,
  agentName,
  environments,
  status,
  agents,
  environmentId,
  onEnvironmentChange,
  from,
  onShowEnvironments,
}: HarnessSectionProps) {
  const { t } = useI18n();
  const store = useAppStore();
  const connected = environments.filter((e) => status[e.id]?.state === "connected");
  const environment = connected.find((e) => e.id === environmentId) ?? connected[0];
  const revision = useAppState((s) =>
    environment !== undefined ? (s.defaultsRevision[environment.id] ?? 0) : 0,
  );

  // Track which Harness sub-page is shown (behavioral words only, never environment names or paths).
  const trackedRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (environment === undefined) return;
    const key = `${agentId}:${environment.id}:${from}`;
    if (trackedRef.current === key) return;
    trackedRef.current = key;
    store.track("harness_settings_shown", {
      agent: agentWord(agentId),
      environment: environment.kind,
      from,
    });
  }, [store, agentId, environment, from]);

  if (environment === undefined) {
    return (
      <StateBlock
        size="inline"
        align="start"
        tone="away"
        title={t("settings.defaults.none")}
        body={t("settings.defaults.noneBody")}
        action={{ label: t("settings.defaults.showEnvironments"), onAction: onShowEnvironments }}
      />
    );
  }

  const envStatus = status[environment.id];
  const supportsSetup = envStatus?.capabilities?.agentSetup === true;
  const agentInfo = (agents[environment.id] ?? []).find((a) => a.id === agentId);

  return (
    <>
      {connected.length > 1 ? (
        <div data-slot="page-form">
          <Field name="environment">
            <FieldLabel>{t("settings.defaults.environment")}</FieldLabel>
            <Select
              items={connected.map((e) => ({ value: e.id, label: e.name }))}
              value={environment.id}
              onValueChange={(next) => {
                if (typeof next === "string") onEnvironmentChange(next);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {connected.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      ) : null}

      <HarnessEnvironmentBody
        key={`${environment.id}:${agentId}:${supportsSetup ? "setup" : "legacy"}`}
        agentId={agentId}
        agentName={agentInfo?.name ?? agentName}
        agentInfo={agentInfo}
        environment={environment}
        supportsSetup={supportsSetup}
        revision={revision}
      />
    </>
  );
}

function HarnessEnvironmentBody({
  agentId,
  agentName,
  agentInfo,
  environment,
  supportsSetup,
  revision,
}: {
  agentId: string;
  agentName: string;
  agentInfo: AgentInfo | undefined;
  environment: EnvironmentConfig;
  supportsSetup: boolean;
  revision: number;
}) {
  const { t, date } = useI18n();
  const store = useAppStore();
  const livePlanUsage = useAppState((s) => s.planUsage[environment.id]?.[agentId]);
  const setupRevision = useAppState(
    (s) => s.agentSetupRevision[`${environment.id}:${agentId}`] ?? 0,
  );

  const [snapshot, setSnapshot] = useState<AgentSetupSnapshot | undefined>(undefined);
  const [loading, setLoading] = useState(supportsSetup && agentInfo !== undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [runtimeBusyKey, setRuntimeBusyKey] = useState<string | undefined>(undefined);
  const [runtimeProblem, setRuntimeProblem] = useState<
    { kind: "conflict" } | { kind: "error"; reason?: string | undefined } | undefined
  >(undefined);
  const [copiedLogin, setCopiedLogin] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [defaultsAttempt, setDefaultsAttempt] = useState(0);
  const [signInDialog, setSignInDialog] = useState<SignInModalState | undefined>(undefined);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const mountedRef = useRef(true);
  const seenSetupRevisionRef = useRef(setupRevision);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(copyTimer.current);
    };
  }, []);

  const fetchSetup = useCallback(
    async (opts: { forceRefresh?: boolean; refreshUsage?: boolean; silent?: boolean }) => {
      if (!supportsSetup || agentInfo === undefined) return;
      if (!opts.silent) {
        if (opts.forceRefresh) setRefreshing(true);
        else setLoading(true);
      }
      setLoadError(undefined);
      try {
        const result = await store.readAgentSetup(environment.id, agentId, {
          ...(opts.forceRefresh ? { forceRefresh: true } : {}),
          ...(opts.refreshUsage ? { refreshUsage: true } : {}),
        });
        if (!mountedRef.current) return;
        setSnapshot(result);
        setRuntimeProblem(undefined);
      } catch (error) {
        if (!mountedRef.current) return;
        if (!opts.silent) setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        if (mountedRef.current && !opts.silent) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [supportsSetup, agentInfo, store, environment.id, agentId],
  );

  useEffect(() => {
    if (!supportsSetup || agentInfo === undefined) return;
    void fetchSetup({ refreshUsage: agentId === "codex" });
  }, [fetchSetup, supportsSetup, agentInfo, agentId]);

  useEffect(() => {
    if (setupRevision === seenSetupRevisionRef.current) return;
    seenSetupRevisionRef.current = setupRevision;
    if (!supportsSetup || agentInfo === undefined) return;
    void fetchSetup({ silent: true });
  }, [setupRevision, fetchSetup, supportsSetup, agentInfo]);

  const patchRuntime = useCallback(
    async (patch: Record<string, AgentRuntimePatchValue>) => {
      if (snapshot === undefined || runtimeBusyKey !== undefined) return;
      const key = Object.keys(patch)[0] ?? "*";
      setRuntimeBusyKey(key);
      setRuntimeProblem(undefined);
      try {
        const answer = await store.setAgentRuntimeSettings(
          environment.id,
          agentId,
          patch,
          snapshot.runtime.revision,
        );
        if (!mountedRef.current) return;
        if (answer === undefined) return;
        if (answer.saved) {
          setSnapshot((prev) =>
            prev === undefined
              ? prev
              : {
                  ...prev,
                  runtime: {
                    ...prev.runtime,
                    values: answer.values,
                    overrides: answer.overrides,
                    revision: answer.revision,
                    fileError: undefined,
                  },
                },
          );
          return;
        }
        if (answer.problem === "revision_conflict") {
          setRuntimeProblem({ kind: "conflict" });
          return;
        }
        if (answer.problem === "file_corrupt") {
          setSnapshot((prev) =>
            prev === undefined
              ? prev
              : {
                  ...prev,
                  runtime: {
                    ...prev.runtime,
                    fileError: answer.message ?? prev.runtime.fileError ?? "",
                  },
                },
          );
          return;
        }
        setRuntimeProblem({ kind: "error", reason: answer.message });
      } finally {
        if (mountedRef.current) setRuntimeBusyKey(undefined);
      }
    },
    [snapshot, runtimeBusyKey, store, environment.id, agentId],
  );

  const describeRuntime = useCallback(
    (key: string): RuntimeFieldText | undefined => describeRuntimeField(agentId, key, t),
    [agentId, t],
  );

  const readDefaults = useCallback(
    (id: string) => store.readAgentDefaults(environment.id, id),
    [store, environment.id],
  );
  const saveDefaults = useCallback(
    (id: string, config: Record<string, string>) =>
      store.setAgentDefaults(environment.id, id, config),
    [store, environment.id],
  );

  const flashCopied = (which: "login" | "path") => {
    clearTimeout(copyTimer.current);
    if (which === "login") setCopiedLogin(true);
    else setCopiedPath(true);
    copyTimer.current = setTimeout(() => {
      setCopiedLogin(false);
      setCopiedPath(false);
    }, 1500);
  };

  const copyLoginCommand = (command: string) => {
    void store.copyText(command).then((ok) => {
      if (!ok) return;
      store.track("agent_setup_command_copied", {
        agent: agentWord(agentId),
        kind: "login",
      });
      flashCopied("login");
    });
  };

  const beginSignIn = useCallback(async () => {
    setSignInDialog({ kind: "starting" });
    const answer = await store.startAgentAuth(environment.id, agentId);
    if (!mountedRef.current) return;
    if (!answer.started) {
      setSignInDialog({ kind: "error", reason: answer.reason });
      return;
    }
    setSignInDialog({
      kind: "active",
      flowId: answer.flowId,
      mode: answer.mode,
      hasUrl: answer.hasUrl,
      ...(answer.host !== undefined ? { host: answer.host } : {}),
      ...(answer.userCode !== undefined ? { userCode: answer.userCode } : {}),
    });
  }, [store, environment.id, agentId]);

  const activeFlowId = signInDialog?.kind === "active" ? signInDialog.flowId : undefined;
  const flowCompletion = useAppState((s) =>
    activeFlowId !== undefined
      ? s.agentAuthCompletions[`${environment.id}:${activeFlowId}`]
      : undefined,
  );

  useEffect(() => {
    if (flowCompletion === undefined || activeFlowId === undefined) return;
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
    (environment.kind === "local"
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

  return (
    <>
      {!supportsSetup ? (
        <StateBlock
          size="inline"
          align="start"
          tone="away"
          title={t("settings.harness.oldDaemon", { environment: environment.name })}
          body={t("settings.harness.oldDaemonBody", { environment: environment.name })}
        />
      ) : agentInfo === undefined ? (
        <StateBlock
          size="inline"
          align="start"
          tone="away"
          title={t("settings.harness.unavailable.notListed", {
            agent: agentName,
            environment: environment.name,
          })}
        />
      ) : loading && snapshot === undefined ? (
        <StateBlock
          size="inline"
          align="start"
          tone="loading"
          title={t("settings.harness.loading", { agent: agentName })}
        />
      ) : loadError !== undefined && snapshot === undefined ? (
        <StateBlock
          size="inline"
          align="start"
          tone="error"
          title={t("settings.harness.loadFailed", { agent: agentName })}
          reason={loadError}
          action={{
            label: t("blank.retry"),
            onAction: () => void fetchSetup({ forceRefresh: true, refreshUsage: true }),
          }}
        />
      ) : snapshot !== undefined ? (
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
                      environment: environment.name,
                      minVersion: snapshot.binary.minVersion ?? "",
                    })
                  : snapshot.binary.problem === "probe_failed"
                    ? t("settings.harness.unavailable.probeFailed", {
                        agent: agentName,
                        environment: environment.name,
                      })
                    : t("settings.harness.unavailable.missing", {
                        agent: agentName,
                        environment: environment.name,
                      })
              }
              reason={agentId === "agy" ? AGY_INSTALL_COMMAND : undefined}
              action={{
                label: t("settings.harness.account.refresh"),
                onAction: () => void fetchSetup({ forceRefresh: true, refreshUsage: true }),
              }}
            />
          ) : null}

          <PageGroup
            title={t("settings.harness.account.title")}
            action={
              <Button
                data-variant="outline"
                disabled={refreshing}
                onClick={() => void fetchSetup({ forceRefresh: true, refreshUsage: true })}
              >
                {refreshing
                  ? t("settings.harness.account.refreshing")
                  : t("settings.harness.account.refresh")}
              </Button>
            }
          >
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
              environmentName={environment.name}
              loginCommand={snapshot.auth.loginCommand}
              copiedLogin={copiedLogin}
              onCopyLogin={() => copyLoginCommand(snapshot.auth.loginCommand)}
              onOpenBrowser={(flowId) => void store.openAgentAuthUrl(environment.id, flowId)}
              onSubmitCode={(flowId, code) => store.submitAgentAuth(environment.id, flowId, code)}
              onRetry={() => void beginSignIn()}
              onClose={() => {
                if (signInDialog?.kind === "active") {
                  void store.cancelAgentAuth(environment.id, signInDialog.flowId);
                }
                setSignInDialog(undefined);
              }}
            />

            <ConfirmDialog
              open={confirmSignOut}
              onOpenChange={setConfirmSignOut}
              title={t("settings.harness.auth.signOutTitle", { agent: agentName })}
              description={t("settings.harness.auth.signOutDescription", {
                agent: agentName,
                environment: environment.name,
              })}
              confirmLabel={t("settings.harness.account.signOut")}
              destructive
              onConfirm={async () => {
                const answer = await store.logoutAgent(environment.id, agentId);
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
          </PageGroup>
        </>
      ) : null}

      {agentInfo !== undefined ? (
        <PageGroup
          title={t("settings.harness.defaults.title")}
          lead={t("settings.harness.defaults.lead", {
            agent: agentName,
            environment: environment.name,
          })}
        >
          <HarnessDefaultsFields
            key={`${environment.id}:${agentInfo.id}:${defaultsAttempt}`}
            agent={agentInfo}
            read={readDefaults}
            onSave={saveDefaults}
            revision={revision}
            onRetry={() => setDefaultsAttempt((n) => n + 1)}
          />
        </PageGroup>
      ) : null}

      {supportsSetup &&
      snapshot !== undefined &&
      (Object.keys(snapshot.runtime.schema.properties).length > 0 ||
        snapshot.runtime.fileError !== undefined) ? (
        <PageGroup
          title={t("settings.harness.runtime.title")}
          lead={t("settings.harness.runtime.lead", { environment: environment.name })}
        >
          {snapshot.runtime.fileError !== undefined ? (
            <StateBlock
              size="inline"
              align="start"
              tone="error"
              title={t("settings.harness.runtime.fileErrorTitle")}
              body={t("settings.harness.runtime.fileErrorBody")}
              reason={snapshot.runtime.fileError}
            />
          ) : null}
          {runtimeProblem?.kind === "conflict" ? (
            <StateBlock
              size="inline"
              align="start"
              tone="away"
              title={t("settings.harness.runtime.conflictTitle")}
              body={t("settings.harness.runtime.conflictBody")}
              action={{
                label: t("settings.harness.runtime.reload"),
                onAction: () => void fetchSetup({ forceRefresh: true }),
              }}
            />
          ) : runtimeProblem?.kind === "error" ? (
            <StateBlock
              size="inline"
              align="start"
              tone="error"
              title={t("settings.harness.runtime.saveFailed")}
              reason={runtimeProblem.reason}
            />
          ) : null}
          <RuntimeConfigForm
            schema={snapshot.runtime.schema}
            values={snapshot.runtime.values}
            overrides={snapshot.runtime.overrides}
            disabled={snapshot.runtime.fileError !== undefined}
            busyKey={runtimeBusyKey}
            onPatch={(patch) => void patchRuntime(patch)}
            describe={describeRuntime}
          />
        </PageGroup>
      ) : null}

      {supportsSetup && snapshot !== undefined ? (
        <PageGroup title={t("settings.harness.host.title")} lead={t("settings.harness.host.lead")}>
          {snapshot.environment.configFile.error !== undefined ? (
            <StateBlock
              size="inline"
              align="start"
              tone="error"
              title={t("settings.harness.host.configFile.errorTitle")}
              reason={snapshot.environment.configFile.error}
            />
          ) : null}
          {snapshot.environment.configFile.stale ? (
            <StateBlock
              size="inline"
              align="start"
              tone="away"
              title={t("settings.harness.host.configFile.staleTitle")}
              body={t("settings.harness.host.configFile.staleBody")}
            />
          ) : null}

          <PageRows>
            <PageRow
              label={t("settings.harness.host.binary")}
              description={binaryDescription(snapshot, t)}
              below={
                snapshot.binary.path !== undefined ? (
                  <code data-slot="reason">{snapshot.binary.path}</code>
                ) : undefined
              }
            />
            <PageRow
              label={t("settings.harness.host.dataDir")}
              description={
                snapshot.environment.customDataDir
                  ? t("settings.harness.host.dataDir.custom")
                  : undefined
              }
              below={<code data-slot="reason">{snapshot.environment.dataDir}</code>}
            />
            <PageRow
              label={t("settings.harness.host.allowEnv")}
              description={
                snapshot.environment.allowEnv.length > 0
                  ? snapshot.environment.allowEnv.join(", ")
                  : t("settings.harness.host.none")
              }
            />
            <PageRow
              label={t("settings.harness.host.envNames")}
              description={
                snapshot.environment.envNames.length > 0
                  ? snapshot.environment.envNames.join(", ")
                  : t("settings.harness.host.none")
              }
            />
            <PageRow
              label={t("settings.harness.host.configFile")}
              description={
                snapshot.environment.configFile.exists
                  ? undefined
                  : t("settings.harness.host.configFile.missing")
              }
              below={<code data-slot="reason">{snapshot.environment.configFile.path}</code>}
            >
              {environment.kind === "local" ? (
                <Button
                  data-variant="outline"
                  disabled={!snapshot.environment.configFile.exists}
                  onClick={() => void store.revealDaemonConfig(environment.id)}
                >
                  {t("settings.harness.host.configFile.reveal")}
                </Button>
              ) : (
                <Button
                  data-variant="outline"
                  onClick={() => {
                    void store
                      .copyText(snapshot.environment.configFile.path)
                      .then((ok) => ok && flashCopied("path"));
                  }}
                >
                  {copiedPath
                    ? t("settings.harness.account.copied")
                    : t("settings.harness.host.configFile.copyPath")}
                </Button>
              )}
            </PageRow>
          </PageRows>
        </PageGroup>
      ) : null}
    </>
  );
}

type Translate = ReturnType<typeof useI18n>["t"];
type FormatDate = ReturnType<typeof useI18n>["date"];

type SignInModalState =
  | { kind: "starting" }
  | {
      kind: "active";
      flowId: string;
      mode: AgentAuthMode;
      hasUrl: boolean;
      host?: string | undefined;
      userCode?: string | undefined;
    }
  | { kind: "error"; reason: AgentAuthProblemReason };

const authErrorText = (reason: AgentAuthProblemReason, t: Translate): string => {
  switch (reason) {
    case "binary_unavailable":
      return t("settings.harness.auth.error.binary_unavailable");
    case "auth_in_progress":
      return t("settings.harness.auth.error.auth_in_progress");
    case "parse_failed":
      return t("settings.harness.auth.error.parse_failed");
    case "invalid_code":
      return t("settings.harness.auth.error.invalid_code");
    case "expired":
      return t("settings.harness.auth.error.expired");
    case "cancelled":
      return t("settings.harness.auth.error.cancelled");
    case "process_failed":
      return t("settings.harness.auth.error.process_failed");
    case "timeout":
      return t("settings.harness.auth.error.timeout");
    case "unsupported_mode":
      return t("settings.harness.auth.error.unsupported_mode");
    case "untrusted_url":
      return t("settings.harness.auth.error.untrusted_url");
    case "disconnected":
      return t("settings.harness.auth.error.disconnected");
    default:
      return t("settings.harness.auth.error.failed");
  }
};

function AgentSignInDialog({
  state,
  agentName,
  environmentName,
  loginCommand,
  copiedLogin,
  onCopyLogin,
  onOpenBrowser,
  onSubmitCode,
  onRetry,
  onClose,
}: {
  state: SignInModalState | undefined;
  agentName: string;
  environmentName: string;
  loginCommand: string;
  copiedLogin: boolean;
  onCopyLogin: () => void;
  onOpenBrowser: (flowId: string) => void;
  onSubmitCode: (
    flowId: string,
    code: string,
  ) => Promise<{ ok: true } | { ok: false; reason: AgentAuthProblemReason }>;
  onRetry: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<AgentAuthProblemReason | undefined>(undefined);
  const [copiedDeviceCode, setCopiedDeviceCode] = useState(false);

  const flowId = state?.kind === "active" ? state.flowId : undefined;
  const stateKind = state?.kind;
  useEffect(() => {
    void flowId;
    void stateKind;
    setCode("");
    setSubmitting(false);
    setSubmitError(undefined);
    setCopiedDeviceCode(false);
  }, [flowId, stateKind]);

  const submit = async () => {
    if (state?.kind !== "active" || submitting) return;
    const trimmed = code.trim();
    if (trimmed === "") return;
    setSubmitting(true);
    setSubmitError(undefined);
    const answer = await onSubmitCode(state.flowId, trimmed);
    setSubmitting(false);
    if (!answer.ok) setSubmitError(answer.reason);
  };

  return (
    <Dialog
      open={state !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogBackdrop />
      <DialogContent>
        <div data-slot="stack">
          <DialogTitle>{t("settings.harness.auth.title", { agent: agentName })}</DialogTitle>

          {state?.kind === "starting" ? (
            <DialogDescription>
              {t("settings.harness.auth.starting", { environment: environmentName })}
            </DialogDescription>
          ) : state?.kind === "error" ? (
            <StateBlock
              size="inline"
              align="start"
              tone="error"
              title={authErrorText(state.reason, t)}
              action={{ label: t("settings.harness.auth.retry"), onAction: onRetry }}
            />
          ) : state?.kind === "active" ? (
            <>
              {state.hasUrl && state.host !== undefined ? (
                <DialogDescription>
                  {t("settings.harness.auth.openHost", { host: state.host })}
                </DialogDescription>
              ) : null}

              {state.mode === "device_code" && state.userCode !== undefined ? (
                <Field name="device-code">
                  <FieldLabel>{t("settings.harness.auth.deviceCodeLabel")}</FieldLabel>
                  <div data-slot="harness-command-row">
                    <code data-slot="harness-device-code">{state.userCode}</code>
                    <Button
                      type="button"
                      data-variant="outline"
                      onClick={() => {
                        void store.copyText(state.userCode ?? "").then((ok) => {
                          if (ok) setCopiedDeviceCode(true);
                        });
                      }}
                    >
                      {copiedDeviceCode
                        ? t("settings.harness.account.copied")
                        : t("settings.harness.auth.copyCode")}
                    </Button>
                  </div>
                  {state.host !== undefined ? (
                    <FieldDescription>
                      {t("settings.harness.auth.waitingDevice", { host: state.host })}
                    </FieldDescription>
                  ) : null}
                </Field>
              ) : null}

              {state.hasUrl ? (
                <div data-slot="row">
                  <Button
                    type="button"
                    data-variant="solid"
                    onClick={() => onOpenBrowser(state.flowId)}
                  >
                    {t("settings.harness.auth.openBrowser")}
                  </Button>
                </div>
              ) : null}

              {state.mode === "browser" ? (
                <p data-slot="hint" role="status">
                  {t("settings.harness.auth.waitingBrowser")}
                </p>
              ) : null}

              {state.mode === "code" ? (
                <form
                  data-slot="stack"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submit();
                  }}
                >
                  <Field name="auth-code">
                    <FieldLabel>{t("settings.harness.auth.codeLabel")}</FieldLabel>
                    <Input
                      value={code}
                      placeholder={t("settings.harness.auth.codePlaceholder")}
                      autoComplete="off"
                      disabled={submitting}
                      onChange={(event) => setCode(event.currentTarget.value)}
                    />
                    <FieldDescription>{t("settings.harness.auth.codeHint")}</FieldDescription>
                  </Field>
                  {submitError !== undefined ? (
                    <p data-slot="hint" role="alert">
                      {authErrorText(submitError, t)}
                    </p>
                  ) : null}
                  <div data-slot="row">
                    <Button
                      type="submit"
                      data-variant="solid"
                      disabled={submitting || code.trim() === ""}
                    >
                      {submitting
                        ? t("settings.harness.auth.submitting")
                        : t("settings.harness.auth.submit")}
                    </Button>
                  </div>
                </form>
              ) : null}
            </>
          ) : null}

          <div data-slot="harness-auth-fallback">
            <p data-slot="hint">
              {t("settings.harness.auth.fallbackLabel", { environment: environmentName })}
            </p>
            <div data-slot="harness-command-row">
              <code data-slot="reason">{loginCommand}</code>
              <Button type="button" data-variant="outline" onClick={onCopyLogin}>
                {copiedLogin
                  ? t("settings.harness.account.copied")
                  : t("settings.harness.account.copyLogin")}
              </Button>
            </div>
          </div>
        </div>
        <div data-slot="row" data-dialog-footer="">
          <DialogClose>{t("dialog.cancel")}</DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const accountPrimaryLabel = (snapshot: AgentSetupSnapshot, t: Translate): string => {
  const { auth } = snapshot;
  if (auth.state === "signed_in") {
    return auth.account?.email ?? t("settings.harness.account.signedIn");
  }
  if (auth.state === "signed_out") return t("settings.harness.account.signedOut");
  if (auth.state === "signing_in") return t("settings.harness.account.signingIn");
  if (auth.state === "signing_out") return t("settings.harness.account.signingOut");
  if (auth.state === "binary_unavailable") return t("settings.harness.account.unavailable");
  return t("settings.harness.account.unknown");
};

const accountSubtitle = (snapshot: AgentSetupSnapshot, t: Translate, date: FormatDate): string => {
  const { auth } = snapshot;
  const parts: string[] = [];
  if (auth.state === "auth_unknown" && auth.unknownReason !== undefined) {
    parts.push(t(`settings.harness.account.unknownReason.${auth.unknownReason}`));
  } else {
    parts.push(t(`settings.harness.account.method.${auth.method}`));
  }
  if (auth.account?.plan !== undefined) parts.push(auth.account.plan);
  if (auth.account?.organization !== undefined) parts.push(auth.account.organization);
  if (auth.account?.expiresAt !== undefined) {
    parts.push(
      t("settings.harness.account.expires", {
        when: date(auth.account.expiresAt, { dateStyle: "medium" }),
      }),
    );
  }
  if (auth.account?.tierObservedAt !== undefined) {
    parts.push(
      t("settings.harness.account.tierObserved", {
        when: date(auth.account.tierObservedAt, { dateStyle: "short", timeStyle: "short" }),
      }),
    );
  }
  if (auth.viaEnv !== undefined) {
    parts.push(t("settings.harness.account.viaEnv", { name: auth.viaEnv }));
  }
  return parts.join(" · ");
};

const binaryDescription = (snapshot: AgentSetupSnapshot, t: Translate): string => {
  const { binary } = snapshot;
  const parts: string[] = [t(`settings.harness.host.binary.${binary.source}`)];
  if (binary.version !== undefined) parts.push(`v${binary.version}`);
  if (binary.minVersion !== undefined) {
    parts.push(t("settings.harness.host.binary.minVersion", { version: binary.minVersion }));
  }
  return parts.join(" · ");
};

const describeRuntimeField = (
  agentId: string,
  key: string,
  t: Translate,
): RuntimeFieldText | undefined => {
  if (agentId === "claude") {
    if (key === "warmStart") {
      return {
        title: t("settings.harness.runtime.field.claude.warmStart.title"),
        description: t("settings.harness.runtime.field.claude.warmStart.description"),
      };
    }
    if (key === "maxWarm") {
      return {
        title: t("settings.harness.runtime.field.claude.maxWarm.title"),
        description: t("settings.harness.runtime.field.claude.maxWarm.description"),
      };
    }
    if (key === "progressSummaries") {
      return {
        title: t("settings.harness.runtime.field.claude.progressSummaries.title"),
        description: t("settings.harness.runtime.field.claude.progressSummaries.description"),
      };
    }
  }
  if (agentId === "agy") {
    if (key === "sandbox") {
      return {
        title: t("settings.harness.runtime.field.agy.sandbox.title"),
        description: t("settings.harness.runtime.field.agy.sandbox.description"),
      };
    }
    if (key === "telemetry") {
      return {
        title: t("settings.harness.runtime.field.agy.telemetry.title"),
        description: t("settings.harness.runtime.field.agy.telemetry.description"),
      };
    }
  }
  return undefined;
};

/** Single-agent Session defaults editor (migrated from the former flat `Defaults` tab). */
function HarnessDefaultsFields({
  agent,
  read,
  onSave,
  revision,
  onRetry,
}: {
  agent: AgentInfo;
  read: (agent: string) => Promise<Record<string, string> | undefined>;
  onSave: (agent: string, config: Record<string, string>) => Promise<boolean | undefined>;
  revision: number;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const [config, setConfig] = useState<Record<string, string> | undefined>(undefined);
  const [unread, setUnread] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const agentId = agent.id;
  const read0 = useRef(true);
  useEffect(() => {
    const first = read0.current;
    read0.current = false;
    void revision;
    let current = true;
    read(agentId).then(
      (defaults) => {
        if (!current) return;
        if (defaults !== undefined) setConfig(defaults);
        else if (first) setUnread(true);
      },
      () => {
        if (current && first) setUnread(true);
      },
    );
    return () => {
      current = false;
    };
  }, [read, agentId, revision]);

  const save = async () => {
    if (config === undefined || busy) return;
    setBusy(true);
    try {
      setSaved((await onSave(agentId, config)) !== false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      data-slot="stack"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {config !== undefined ? (
        <ConfigForm
          schema={agent.configSchema}
          value={config}
          onChange={(next) => {
            setConfig(next);
            setSaved(false);
          }}
        />
      ) : unread ? (
        <StateBlock
          size="inline"
          align="start"
          tone="error"
          title={t("defaults.unreadable")}
          action={{ label: t("blank.retry"), onAction: onRetry }}
        />
      ) : (
        <StateBlock size="inline" align="start" tone="loading" title={t("defaults.reading")} />
      )}
      <div data-slot="row" data-page-actions="">
        <Button type="submit" data-variant="solid" disabled={config === undefined || busy}>
          {t("defaults.save")}
        </Button>
        <span data-slot="hint" role="status">
          {saved ? t("settings.defaults.saved") : ""}
        </span>
      </div>
    </form>
  );
}
