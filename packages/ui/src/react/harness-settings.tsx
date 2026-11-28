// Settings → Harness page (CYCL-229, docs/harness-settings.md):
// Shows one agent's account status & plan usage at the top, followed by Session defaults
// (`_cycle/agent_defaults/*`) and read-only host diagnostics from `config.json`.
// Degrades smoothly to Session defaults only when connected to an older daemon without `agentSetup`.

import { Button } from "@ui-sdk/react/button";
import { useCallback, useEffect, useRef, useState } from "react";
import { agentWord } from "../agent-word.ts";
import type {
  AgentInfo,
  AgentRuntimePatchValue,
  AgentSetupSnapshot,
  LocationConfig,
  LocationStatus,
} from "../api.ts";
import { useAgentSetup } from "./agent-setup.ts";
import { UnavailableBinary } from "./agent-unavailable.tsx";
import { ConfigForm, RuntimeConfigForm, type RuntimeFieldText } from "./config-form.tsx";
import { StorageGroup } from "./harness-storage.tsx";
import { useI18n } from "./i18n.tsx";
import { LocationScope } from "./location-scope.tsx";
import { PageGroup, PageRow, PageRows } from "./page-layout.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";

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
  const store = useAppStore();
  const knownSetup = useRef<Record<string, boolean>>({});
  const tracked = useRef<string | undefined>(undefined);
  const trackShown = useCallback(
    (location: LocationConfig) => {
      const key = `${agentId}:${location.id}:${from}`;
      if (tracked.current === key) return;
      tracked.current = key;
      store.track("harness_settings_shown", {
        agent: agentWord(agentId),
        location: location.kind,
        from,
      });
    },
    [agentId, from, store],
  );

  return (
    <LocationScope
      locations={locations}
      status={status}
      locationId={locationId}
      onLocationChange={onLocationChange}
      onShowLocations={onShowLocations}
      knownSetup={knownSetup}
    >
      {(location, supportsSetup) => {
        const agentInfo = agents[location.id]?.find((agent) => agent.id === agentId);
        return (
          <HarnessLocationBody
            key={`${location.id}:${agentId}:${supportsSetup ? "setup" : "legacy"}`}
            agentId={agentId}
            agentName={agentInfo?.name ?? agentName}
            agentInfo={agentInfo}
            location={location}
            supportsSetup={supportsSetup}
            supportsStorage={status[location.id]?.capabilities?.storage === true}
            onShown={trackShown}
          />
        );
      }}
    </LocationScope>
  );
}

function HarnessLocationBody({
  agentId,
  agentName,
  agentInfo,
  location,
  supportsSetup,
  supportsStorage,
  onShown,
}: {
  agentId: string;
  agentName: string;
  agentInfo: AgentInfo | undefined;
  location: LocationConfig;
  supportsSetup: boolean;
  /** The daemon can say what the agent keeps and clear its caches. */
  supportsStorage: boolean;
  onShown: (location: LocationConfig) => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const revision = useAppState((s) => s.defaultsRevision[location.id] ?? 0);
  useEffect(() => onShown(location), [location, onShown]);
  // Whether the agent is listed, not the listing itself: a new agents list (a reconnect) is not a reason to read again.
  const hasAgent = agentInfo !== undefined;
  const [runtimeBusyKey, setRuntimeBusyKey] = useState<string | undefined>(undefined);
  const [runtimeProblem, setRuntimeProblem] = useState<
    { kind: "conflict" } | { kind: "error"; reason?: string | undefined } | undefined
  >(undefined);
  const [copiedPath, setCopiedPath] = useState(false);
  const [defaultsAttempt, setDefaultsAttempt] = useState(0);
  const {
    snapshot,
    setSnapshot,
    loading,
    refreshing,
    loadError,
    read: fetchSetup,
    supersede,
    mounted: mountedRef,
  } = useAgentSetup(location.id, agentId, supportsSetup && hasAgent, () =>
    setRuntimeProblem(undefined),
  );
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(copyTimer.current), []);

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
          supersede();
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
    [snapshot, runtimeBusyKey, store, location.id, agentId, supersede, setSnapshot, mountedRef],
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
        <UnavailableBinary
          binary={snapshot.binary}
          agentId={agentId}
          agentName={agentName}
          locationName={location.name}
          action={{
            label: refreshing
              ? t("settings.harness.account.refreshing")
              : t("settings.harness.account.refresh"),
            onAction: () => {
              if (!refreshing) void fetchSetup({ forceRefresh: true, refreshUsage: true });
            },
          }}
        />
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

/**
 * One agent's Session defaults. Saved only once it holds what was read: saving over a read that failed would replace
 * what is saved with the near-empty form. Exported for its tests.
 */
export function HarnessDefaultsFields({
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
