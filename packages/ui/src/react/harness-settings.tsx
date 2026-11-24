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
  AgentRuntimePatchValue,
  AgentSetupSnapshot,
  LocationConfig,
  LocationStatus,
} from "../api.ts";
import { ConfigForm, RuntimeConfigForm, type RuntimeFieldText } from "./config-form.tsx";
import { StorageGroup } from "./harness-storage.tsx";
import { useI18n } from "./i18n.tsx";
import { PageGroup, PageRow, PageRows } from "./page-layout.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";

const AGY_INSTALL_COMMAND = "curl -fsSL https://antigravity.google/cli/install.sh | bash";

export type HarnessEntry = {
  id: string;
  name: string;
};

/** Built-in harnesses kept in a fixed order in Settings nav regardless of location availability. */
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
  locations: LocationConfig[];
  status: Record<string, LocationStatus>;
  agents: Record<string, AgentInfo[]>;
  locationId: string | undefined;
  onLocationChange: (locationId: string) => void;
  from: "settings" | "blank" | "other";
  onShowLocations: () => void;
};

export function HarnessSection({
  agentId,
  agentName,
  locations,
  status,
  agents,
  locationId,
  onLocationChange,
  from,
  onShowLocations,
}: HarnessSectionProps) {
  const { t } = useI18n();
  const store = useAppStore();
  const connected = locations.filter((e) => status[e.id]?.state === "connected");
  // The chosen location stays chosen while it reconnects: swapping to another (or to none) would unmount the page
  // and with it a sign-in dialog, which must say that the connection dropped and offer the command instead.
  const chosen = locations.find((e) => e.id === locationId);
  const holding = chosen !== undefined && status[chosen.id]?.state === "reconnecting";
  const location = holding ? chosen : (connected.find((e) => e.id === locationId) ?? connected[0]);
  const choices = locations.filter(
    (e) => status[e.id]?.state === "connected" || (holding && e === chosen),
  );
  const knownSetup = useRef<Record<string, boolean>>({});
  const revision = useAppState((s) =>
    location !== undefined ? (s.defaultsRevision[location.id] ?? 0) : 0,
  );

  // Track which Harness sub-page is shown (behavioral words only, never location names or paths).
  const trackedRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (location === undefined) return;
    const key = `${agentId}:${location.id}:${from}`;
    if (trackedRef.current === key) return;
    trackedRef.current = key;
    store.track("harness_settings_shown", {
      agent: agentWord(agentId),
      location: location.kind,
      from,
    });
  }, [store, agentId, location, from]);

  if (location === undefined) {
    return (
      <StateBlock
        size="inline"
        align="start"
        tone="away"
        title={t("settings.defaults.none")}
        body={t("settings.defaults.noneBody")}
        action={{ label: t("settings.defaults.showLocations"), onAction: onShowLocations }}
      />
    );
  }

  const envStatus = status[location.id];
  // What the daemon said it can do, kept through a reconnect (when it has not said again yet).
  const said = envStatus?.capabilities?.agentSetup;
  if (said !== undefined) knownSetup.current[location.id] = said === true;
  const supportsSetup =
    said === true || (said === undefined && knownSetup.current[location.id] === true);
  const agentInfo = (agents[location.id] ?? []).find((a) => a.id === agentId);

  return (
    <>
      {choices.length > 1 ? (
        <div data-slot="page-form">
          <Field name="location">
            <FieldLabel>{t("settings.defaults.location")}</FieldLabel>
            <Select
              items={choices.map((e) => ({ value: e.id, label: e.name }))}
              value={location.id}
              onValueChange={(next) => {
                if (typeof next === "string") onLocationChange(next);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {choices.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      ) : null}

      <HarnessLocationBody
        key={`${location.id}:${agentId}:${supportsSetup ? "setup" : "legacy"}`}
        agentId={agentId}
        agentName={agentInfo?.name ?? agentName}
        agentInfo={agentInfo}
        location={location}
        supportsSetup={supportsSetup}
        supportsStorage={envStatus?.capabilities?.storage === true}
        revision={revision}
      />
    </>
  );
}

function HarnessLocationBody({
  agentId,
  agentName,
  agentInfo,
  location,
  supportsSetup,
  supportsStorage,
  revision,
}: {
  agentId: string;
  agentName: string;
  agentInfo: AgentInfo | undefined;
  location: LocationConfig;
  supportsSetup: boolean;
  /** The daemon can say what the agent keeps and clear its caches. */
  supportsStorage: boolean;
  revision: number;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const setupRevision = useAppState((s) => s.agentSetupRevision[`${location.id}:${agentId}`] ?? 0);

  const [snapshot, setSnapshot] = useState<AgentSetupSnapshot | undefined>(undefined);
  // Whether the agent is listed, not the listing itself: a new agents list (a reconnect) is not a reason to read again.
  const hasAgent = agentInfo !== undefined;
  const [loading, setLoading] = useState(supportsSetup && hasAgent);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [runtimeBusyKey, setRuntimeBusyKey] = useState<string | undefined>(undefined);
  const [runtimeProblem, setRuntimeProblem] = useState<
    { kind: "conflict" } | { kind: "error"; reason?: string | undefined } | undefined
  >(undefined);
  const [copiedPath, setCopiedPath] = useState(false);
  const [defaultsAttempt, setDefaultsAttempt] = useState(0);
  const mountedRef = useRef(true);
  const seenSetupRevisionRef = useRef(setupRevision);
  const fetchSeqRef = useRef(0);
  /** The newest read (or save) whose answer is on screen: an older answer arriving later is dropped. */
  const appliedSeqRef = useRef(0);
  const pendingLoudRef = useRef(0);
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
      if (!supportsSetup || !hasAgent) return;
      // Each read is numbered; an answer is kept only if no newer one (or a save) has been kept since. The spinner
      // belongs to the visible reads still out, so a silent read that overtakes a visible one cannot leave it spinning.
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
        setRuntimeProblem(undefined);
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
    [supportsSetup, hasAgent, store, location.id, agentId],
  );

  useEffect(() => {
    if (!supportsSetup || !hasAgent) return;
    void fetchSetup({ refreshUsage: agentId === "codex" });
  }, [fetchSetup, supportsSetup, hasAgent, agentId]);

  useEffect(() => {
    if (setupRevision === seenSetupRevisionRef.current) return;
    seenSetupRevisionRef.current = setupRevision;
    if (!supportsSetup || !hasAgent) return;
    void fetchSetup({ silent: true });
  }, [setupRevision, fetchSetup, supportsSetup, hasAgent]);

  const patchRuntime = useCallback(
    async (patch: Record<string, AgentRuntimePatchValue>) => {
      if (snapshot === undefined || runtimeBusyKey !== undefined) return;
      const key = Object.keys(patch)[0] ?? "*";
      setRuntimeBusyKey(key);
      setRuntimeProblem(undefined);
      try {
        const answer = await store.setAgentRuntimeSettings(
          location.id,
          agentId,
          patch,
          snapshot.runtime.revision,
        );
        if (!mountedRef.current) return;
        if (answer === undefined) return;
        if (answer.saved) {
          // Every read already sent is older than this save: none of their answers may replace it.
          appliedSeqRef.current = fetchSeqRef.current;
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
    [snapshot, runtimeBusyKey, store, location.id, agentId],
  );

  const describeRuntime = useCallback(
    (key: string): RuntimeFieldText | undefined => describeRuntimeField(agentId, key, t),
    [agentId, t],
  );

  const readDefaults = useCallback(
    (id: string) => store.readAgentDefaults(location.id, id),
    [store, location.id],
  );
  const saveDefaults = useCallback(
    (id: string, config: Record<string, string>) => store.setAgentDefaults(location.id, id, config),
    [store, location.id],
  );

  const flashCopied = () => {
    clearTimeout(copyTimer.current);
    setCopiedPath(true);
    copyTimer.current = setTimeout(() => setCopiedPath(false), 1500);
  };

  return (
    <>
      {!supportsSetup ? (
        <StateBlock
          size="inline"
          align="start"
          tone="away"
          title={t("settings.harness.oldDaemon", { location: location.name })}
          body={t("settings.harness.oldDaemonBody", { location: location.name })}
        />
      ) : agentInfo === undefined ? (
        <StateBlock
          size="inline"
          align="start"
          tone="away"
          title={t("settings.harness.unavailable.notListed", {
            agent: agentName,
            location: location.name,
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
        snapshot.binary.problem !== undefined ? (
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
            action={{
              label: refreshing
                ? t("settings.harness.account.refreshing")
                : t("settings.harness.account.refresh"),
              onAction: () => {
                if (!refreshing) void fetchSetup({ forceRefresh: true, refreshUsage: true });
              },
            }}
          />
        ) : null
      ) : null}

      {agentInfo !== undefined ? (
        <PageGroup
          title={t("settings.harness.defaults.title")}
          lead={t("settings.harness.defaults.lead", {
            agent: agentName,
            location: location.name,
          })}
        >
          <HarnessDefaultsFields
            key={`${location.id}:${agentInfo.id}:${defaultsAttempt}`}
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
          lead={t("settings.harness.runtime.lead", { location: location.name })}
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
              {location.kind === "local" ? (
                <Button
                  data-variant="outline"
                  disabled={!snapshot.environment.configFile.exists}
                  onClick={() => void store.revealDaemonConfig(location.id)}
                >
                  {t("settings.harness.host.configFile.reveal")}
                </Button>
              ) : (
                <Button
                  data-variant="outline"
                  onClick={() => {
                    void store
                      .copyText(snapshot.environment.configFile.path)
                      .then((ok) => ok && flashCopied());
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
      {supportsStorage && hasAgent ? (
        <StorageGroup
          key={`${location.id}:${agentId}`}
          location={location}
          agentId={agentId}
          agentName={agentName}
        />
      ) : null}
    </>
  );
}

type Translate = ReturnType<typeof useI18n>["t"];

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
    if (key === "skipPermissions") {
      return {
        title: t("settings.harness.runtime.field.agy.skipPermissions.title"),
        description: t("settings.harness.runtime.field.agy.skipPermissions.description"),
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
