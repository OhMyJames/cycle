// Settings → Harness page (CYCL-229, docs/harness-settings.md):
// Shows one agent's account status & plan usage at the top, followed by Session defaults
// (`_cycle/agent_defaults/*`) and read-only host diagnostics from `config.json`.
// Degrades smoothly to Session defaults only when connected to an older daemon without `agentSetup`.
import type { AgentWord } from "@cycle/analytics/events";
import { Button } from "@ui-sdk/react/button";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentInfo,
  AgentSetupSnapshot,
  EnvironmentConfig,
  EnvironmentStatus,
} from "../api.ts";
import { ConfigForm } from "./config-form.tsx";
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

  const [snapshot, setSnapshot] = useState<AgentSetupSnapshot | undefined>(undefined);
  const [loading, setLoading] = useState(supportsSetup && agentInfo !== undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [copiedLogin, setCopiedLogin] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [defaultsAttempt, setDefaultsAttempt] = useState(0);
  const mountedRef = useRef(true);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(copyTimer.current);
    };
  }, []);

  const fetchSetup = useCallback(
    async (opts: { forceRefresh?: boolean; refreshUsage?: boolean }) => {
      if (!supportsSetup || agentInfo === undefined) return;
      if (opts.forceRefresh) setRefreshing(true);
      else setLoading(true);
      setLoadError(undefined);
      try {
        const result = await store.readAgentSetup(environment.id, agentId, opts);
        if (!mountedRef.current) return;
        setSnapshot(result);
      } catch (error) {
        if (!mountedRef.current) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        if (mountedRef.current) {
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
              />
            </PageRows>

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
