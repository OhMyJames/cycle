// The Plugins section of the Connectors page (CYCL-84, docs/protocol.md §15): what is installed for one agent on one
// location, what can be installed, and where that list comes from. A plugin is the agent's own; nothing here knows
// how any agent keeps them. Installing one is agreeing to run someone else's code there, so it is always asked.
import { isComposing } from "@ui-sdk/core";
import { Button } from "@ui-sdk/react/button";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@ui-sdk/react/menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { Switch, SwitchThumb } from "@ui-sdk/react/switch";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  ConnectorInfo,
  ConnectorProblem,
  LocationConfig,
  PluginFailure,
  PluginInfo,
  PluginSourceInfo,
} from "../api.ts";
import { pluginsKey } from "../store/store.ts";
import { ConnectorValuesDialog } from "./connector-values.tsx";
import { ConfirmDialog } from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import { MoreIcon } from "./icons.tsx";
import { useKeyedAsyncAction } from "./keyed-action.ts";
import { PageGroup, PageRow, PageRows } from "./page-layout.tsx";
import { StateBlock } from "./state-block.tsx";
import { StatusDot } from "./status.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";

/** How many of what can be installed are asked for at a time. */
const PAGE = 30;
/** How long typing rests before the list is asked for again. */
const SEARCH_REST_MS = 200;
const ALL = "*";

const CONTENT_KINDS = ["skills", "commands", "agents", "hooks", "mcpServers"] as const;

type Words = { location: string; agent: string };

/** A failure as a sentence, and what the agent's own machinery said, kept apart: the second is its words, not ours. */
function Failure({ failure, words }: { failure: PluginFailure; words: Words }) {
  const { t } = useI18n();
  return (
    <>
      <p data-slot="hint" role="alert">
        {t(`plugins.problem.${failure.problem}`, words)}
      </p>
      {failure.message !== undefined && failure.message !== "" ? (
        <pre data-slot="reason">{failure.message}</pre>
      ) : null}
    </>
  );
}

export function PluginsSection({ location }: { location: LocationConfig }) {
  const { t } = useI18n();
  const locationId = location.id;
  const agents = useAppState((s) => s.status[locationId]?.capabilities?.plugins) ?? [];
  const known = useAppState((s) => s.agents[locationId]);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const agentId = agents.find((id) => id === chosen) ?? agents[0];
  const label = useId();
  const nameOf = (id: string) => known?.find((a) => a.id === id)?.name ?? id;
  if (agentId === undefined) return null;
  return (
    <>
      {agents.length > 1 ? (
        <PageGroup>
          <PageRows>
            <PageRow
              label={t("plugins.agent")}
              labelId={label}
              description={t("plugins.agent.description")}
            >
              <Select
                items={agents.map((id) => ({ value: id, label: nameOf(id) }))}
                value={agentId}
                onValueChange={(next) => {
                  if (typeof next === "string") setChosen(next);
                }}
              >
                <SelectTrigger aria-labelledby={label}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {agents.map((id) => (
                    <SelectItem key={id} value={id}>
                      {nameOf(id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </PageRow>
          </PageRows>
        </PageGroup>
      ) : null}
      {/* Keyed by the agent: another one's plugins start from nothing. */}
      <AgentPlugins
        key={agentId}
        location={location}
        agentId={agentId}
        agentName={nameOf(agentId)}
      />
    </>
  );
}

function AgentPlugins({
  location,
  agentId,
  agentName,
}: {
  location: LocationConfig;
  agentId: string;
  agentName: string;
}) {
  const store = useAppStore();
  const locationId = location.id;
  const read = useAppState((s) => s.plugins[pluginsKey(locationId, agentId)]);
  const keepsConnectors = useAppState(
    (s) => s.status[locationId]?.capabilities?.connectors === true,
  );
  const words: Words = { location: location.name, agent: agentName };
  /** Counts what changed what is installed or listed, so the list of what can be installed is read again. */
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => setRevision((n) => n + 1), []);

  useEffect(() => {
    void store.loadPlugins(locationId, agentId);
    // The servers plugins bring are connectors: their state says whether one still wants a sign-in.
    if (keepsConnectors) void store.loadConnectors(locationId);
  }, [store, locationId, agentId, keepsConnectors]);

  return (
    <>
      <Installed location={location} agentId={agentId} words={words} onChanged={changed} />
      <Available
        location={location}
        agentId={agentId}
        words={words}
        sources={read?.sources ?? []}
        revision={revision}
        installed={read?.list}
        onChanged={changed}
      />
      {read?.sources !== undefined ? (
        <Sources
          location={location}
          agentId={agentId}
          words={words}
          sources={read.sources}
          onChanged={changed}
        />
      ) : null}
    </>
  );
}

type SectionProps = {
  location: LocationConfig;
  agentId: string;
  words: Words;
  onChanged: () => void;
};

/** What a plugin's servers still want from the person before they work. */
const wantsOf = (
  plugin: PluginInfo,
  connectors: ConnectorInfo[] | undefined,
): { server: string; connector: ConnectorInfo; kind: "values" | "signIn" }[] => {
  if (plugin.enabled !== true) return [];
  const out: { server: string; connector: ConnectorInfo; kind: "values" | "signIn" }[] = [];
  for (const server of plugin.servers ?? []) {
    const connector = connectors?.find((c) => c.id === server.connectorId);
    if (connector === undefined || connector.status.state !== "needs_auth") continue;
    const unfilled = (connector.requires ?? []).some((n) => !connector.secrets.env.includes(n));
    out.push({ server: server.name, connector, kind: unfilled ? "values" : "signIn" });
  }
  return out;
};

function Installed({ location, agentId, words, onChanged }: SectionProps) {
  const { t } = useI18n();
  const store = useAppStore();
  const locationId = location.id;
  const read = useAppState((s) => s.plugins[pluginsKey(locationId, agentId)]);
  const connectors = useAppState((s) => s.connectors[locationId]?.list);
  const list = read?.list;
  const { busy, problems: failures, run } = useKeyedAsyncAction<PluginFailure>();
  /** What the last action came to, said once for a screen reader and the eye alike. */
  const [said, setSaid] = useState<string | undefined>(undefined);
  const [removing, setRemoving] = useState<PluginInfo | undefined>(undefined);
  const [values, setValues] = useState<ConnectorInfo | undefined>(undefined);
  /** The server whose sign-in the browser has, by its connector: it is waited for, and the wait can be given up. */
  const [waiting, setWaiting] = useState<string | undefined>(undefined);
  /** Why a server's sign-in did not happen, by its connector. */
  const [refusals, setRefusals] = useState<
    Record<string, { problem: ConnectorProblem; message?: string | undefined }>
  >({});

  const act = async <T extends object>(
    plugin: PluginInfo,
    action: () => Promise<T | PluginFailure>,
  ) => {
    setSaid(undefined);
    const answer = await run(plugin.id, action);
    if (!("problem" in answer)) onChanged();
    return answer;
  };

  const signIn = async (connector: ConnectorInfo) => {
    setWaiting(connector.id);
    setRefusals(({ [connector.id]: _gone, ...rest }) => rest);
    try {
      const answer = await store.authorizeConnector(locationId, connector.id);
      if ("problem" in answer) setRefusals((r) => ({ ...r, [connector.id]: answer }));
    } finally {
      setWaiting((w) => (w === connector.id ? undefined : w));
    }
  };

  return (
    <PageGroup title={t("plugins.installed.title")} lead={t("plugins.lead", words)}>
      {read?.error !== undefined ? (
        <StateBlock
          size="inline"
          align="start"
          tone="error"
          title={t("plugins.unreadable")}
          reason={read.error}
          action={{
            label: t("plugins.retry"),
            onAction: () => void store.loadPlugins(locationId, agentId),
          }}
        />
      ) : null}
      {said !== undefined ? (
        <p data-slot="hint" role="status">
          {said}
        </p>
      ) : null}
      {list === undefined ? (
        read?.error === undefined ? (
          <StateBlock size="inline" align="start" tone="loading" title={t("plugins.loading")} />
        ) : null
      ) : list.length === 0 ? (
        <StateBlock
          size="inline"
          align="start"
          tone="empty"
          title={t("plugins.empty")}
          body={t("plugins.emptyBody")}
        />
      ) : (
        <PageRows>
          {list.map((plugin) => {
            const on = plugin.enabled === true;
            const failure = failures[plugin.id];
            const wants = wantsOf(plugin, connectors);
            const contents = CONTENT_KINDS.flatMap((kind) => {
              const count = plugin.contents?.[kind] ?? 0;
              return count > 0 ? [t(`plugins.contents.${kind}`, { count })] : [];
            });
            const facts = [
              t(on ? "plugins.state.on" : "plugins.state.off"),
              ...(plugin.version !== undefined
                ? [t("plugins.version", { version: plugin.version })]
                : []),
              ...contents,
            ];
            return (
              <PageRow
                key={plugin.id}
                label={plugin.name}
                before={
                  <>
                    {plugin.icon !== undefined ? (
                      <img
                        data-slot="plugin-icon"
                        src={plugin.icon}
                        alt=""
                        width={16}
                        height={16}
                      />
                    ) : null}
                    <StatusDot
                      tone={!on ? "muted" : wants.length > 0 ? "attention" : "success"}
                      shape={on && wants.length === 0 ? "solid" : "ring"}
                    />
                  </>
                }
                description={
                  <>
                    <span data-slot="plugin-facts">{facts.join(" · ")}</span>
                    {plugin.description !== undefined ? (
                      <span data-slot="plugin-description" title={plugin.description}>
                        {plugin.description}
                      </span>
                    ) : null}
                  </>
                }
                below={
                  failure !== undefined || wants.length > 0 ? (
                    <>
                      {wants.map((want) => {
                        const refusal = refusals[want.connector.id];
                        return waiting === want.connector.id ? (
                          <div
                            key={want.connector.id}
                            data-slot="row"
                            data-plugin-want=""
                            role="status"
                          >
                            <span data-slot="hint">
                              {t("connectors.waiting", { name: want.server })}
                            </span>
                            <Button
                              data-variant="outline"
                              onClick={() => void store.cancelConnectorAuth()}
                            >
                              {t("connectors.stopWaiting")}
                            </Button>
                          </div>
                        ) : (
                          <div key={want.connector.id} data-slot="stack" data-plugin-want-of="">
                            <div data-slot="row" data-plugin-want="">
                              <span data-slot="hint">
                                {t(
                                  want.kind === "values"
                                    ? "plugins.server.values"
                                    : "plugins.server.signIn",
                                  { server: want.server },
                                )}
                              </span>
                              <Button
                                data-variant="outline"
                                // One sign-in has the browser at a time.
                                disabled={busy[plugin.id] === true || waiting !== undefined}
                                onClick={() =>
                                  want.kind === "values"
                                    ? setValues(want.connector)
                                    : void signIn(want.connector)
                                }
                              >
                                {t(
                                  want.kind === "values"
                                    ? "connectors.setValues"
                                    : "connectors.signIn",
                                )}
                              </Button>
                            </div>
                            {refusal !== undefined ? (
                              <p data-slot="hint" role="alert">
                                {t(`connectors.problem.${refusal.problem}`, {
                                  location: location.name,
                                  reason: refusal.message ?? "",
                                })}
                              </p>
                            ) : null}
                          </div>
                        );
                      })}
                      {failure !== undefined ? <Failure failure={failure} words={words} /> : null}
                    </>
                  ) : undefined
                }
              >
                <Switch
                  aria-label={t("plugins.use", { name: plugin.name })}
                  checked={on}
                  disabled={busy[plugin.id] === true}
                  onCheckedChange={(enabled) =>
                    void act(plugin, () =>
                      store.setPluginEnabled(locationId, agentId, plugin.id, enabled),
                    )
                  }
                >
                  <SwitchThumb />
                </Switch>
                <Menu
                  onAction={(value) => {
                    if (value === "remove") setRemoving(plugin);
                    else if (value === "update")
                      void act(plugin, () =>
                        store.updatePlugin(locationId, agentId, plugin.id),
                      ).then((answer) => {
                        if ("updated" in answer)
                          setSaid(
                            t(answer.updated ? "plugins.updated" : "plugins.current", {
                              name: plugin.name,
                            }),
                          );
                      });
                  }}
                >
                  <Tip label={t("plugins.actions", { name: plugin.name })}>
                    <MenuTrigger data-variant="ghost" disabled={busy[plugin.id] === true}>
                      <MoreIcon />
                    </MenuTrigger>
                  </Tip>
                  <MenuContent align="end">
                    <MenuItem value="update">{t("plugins.update")}</MenuItem>
                    {plugin.builtin !== true && (
                      <MenuItem value="remove" data-destructive>
                        {t("plugins.uninstall")}
                      </MenuItem>
                    )}
                  </MenuContent>
                </Menu>
              </PageRow>
            );
          })}
        </PageRows>
      )}
      {removing !== undefined ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setRemoving(undefined)}
          title={t("plugins.uninstallTitle", { name: removing.name })}
          description={t("plugins.uninstallDescription", words)}
          confirmLabel={t("plugins.uninstallConfirm")}
          destructive
          onConfirm={async () => {
            const answer = await store.uninstallPlugin(locationId, agentId, removing.id);
            if ("problem" in answer) return failureText(t, answer, words);
            onChanged();
            return undefined;
          }}
        />
      ) : null}
      {values !== undefined ? (
        <ConnectorValuesDialog
          location={location}
          connector={values}
          onDone={() => setValues(undefined)}
        />
      ) : null}
    </PageGroup>
  );
}

/** A failure in one line, for where there is room for no more (a dialog's own error line). */
const failureText = (
  t: (key: string, params?: Record<string, string>) => string,
  failure: PluginFailure,
  words: Words,
): string => {
  const sentence = t(`plugins.problem.${failure.problem}`, words);
  return failure.message !== undefined && failure.message !== ""
    ? `${sentence} ${failure.message}`
    : sentence;
};

type Listing = { plugins: PluginInfo[]; nextCursor?: string | undefined; total: number };

function Available({
  location,
  agentId,
  words,
  sources,
  revision,
  installed,
  onChanged,
}: SectionProps & {
  sources: PluginSourceInfo[];
  revision: number;
  installed: PluginInfo[] | undefined;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const locationId = location.id;
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [sourceId, setSourceId] = useState(ALL);
  const [listing, setListing] = useState<Listing | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [more, setMore] = useState(false);
  const [confirming, setConfirming] = useState<PluginInfo | undefined>(undefined);
  const [installing, setInstalling] = useState<string | undefined>(undefined);
  const [failures, setFailures] = useState<Record<string, PluginFailure>>({});
  const sourceLabel = useId();
  /** Only the latest question's answer is shown: an older one that arrives late is dropped. */
  const asked = useRef(0);

  // Typing rests before the list is asked for again.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), SEARCH_REST_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  const load = useCallback(
    async (cursor: string | undefined, onto: PluginInfo[]) => {
      const mine = ++asked.current;
      try {
        const answer = await store.availablePlugins(locationId, {
          agentId,
          limit: PAGE,
          ...(query !== "" ? { query } : {}),
          ...(sourceId !== ALL ? { sourceId } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        });
        if (mine !== asked.current) return;
        setListing({ ...answer, plugins: [...onto, ...answer.plugins] });
        setError(undefined);
      } catch (failed) {
        if (mine !== asked.current) return;
        setError(failed instanceof Error ? failed.message : String(failed));
      }
    },
    [store, locationId, agentId, query, sourceId],
  );

  // From the top again when what is asked changes, or when something was installed, removed or refreshed.
  useEffect(() => {
    // `revision` counts up from 0: it is here so that a change asks again.
    if (revision >= 0) void load(undefined, []);
  }, [load, revision]);

  const install = async (plugin: PluginInfo): Promise<string | undefined> => {
    setInstalling(plugin.id);
    setFailures(({ [plugin.id]: _gone, ...rest }) => rest);
    try {
      const answer = await store.installPlugin(locationId, agentId, plugin.id);
      if ("problem" in answer) {
        setFailures((f) => ({ ...f, [plugin.id]: answer }));
        return undefined;
      }
      onChanged();
      return undefined;
    } finally {
      setInstalling(undefined);
    }
  };

  const sourceName = (id: string) => sources.find((s) => s.id === id)?.name ?? id;
  const isInstalled = (plugin: PluginInfo) =>
    plugin.installed || (installed?.some((p) => p.id === plugin.id) ?? false);
  const items = [
    { value: ALL, label: t("plugins.source.all") },
    ...sources.map((s) => ({ value: s.id, label: s.name })),
  ];

  return (
    <PageGroup title={t("plugins.available.title")}>
      <div data-slot="row" data-plugin-filters="">
        <Input
          type="search"
          aria-label={t("plugins.search")}
          placeholder={t("plugins.search")}
          value={typed}
          onChange={(e) => setTyped(e.currentTarget.value)}
          onKeyDown={(e) => {
            // Enter asks at once, unless it is an input method's own.
            if (e.key === "Enter" && !isComposing(e)) setQuery(typed.trim());
          }}
        />
        {sources.length > 1 ? (
          <>
            <span id={sourceLabel} data-slot="visually-hidden">
              {t("plugins.source")}
            </span>
            <Select
              items={items}
              value={sourceId}
              onValueChange={(next) => {
                if (typeof next === "string") setSourceId(next);
              }}
            >
              <SelectTrigger aria-labelledby={sourceLabel}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {items.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        ) : null}
      </div>
      {error !== undefined ? (
        <StateBlock
          size="inline"
          align="start"
          tone="error"
          title={t("plugins.available.unreadable")}
          reason={error}
          action={{ label: t("plugins.retry"), onAction: () => void load(undefined, []) }}
        />
      ) : listing === undefined ? (
        <StateBlock
          size="inline"
          align="start"
          tone="loading"
          title={t("plugins.available.loading")}
        />
      ) : listing.plugins.length === 0 ? (
        query !== "" ? (
          <StateBlock
            size="inline"
            align="start"
            tone="empty"
            title={t("plugins.available.noMatch", { query })}
            body={t("plugins.available.noMatchBody")}
          />
        ) : (
          <StateBlock
            size="inline"
            align="start"
            tone="empty"
            title={t("plugins.available.empty")}
            body={t("plugins.available.emptyBody")}
          />
        )
      ) : (
        <>
          <PageRows>
            {listing.plugins.map((plugin) => {
              const failure = failures[plugin.id];
              return (
                <PageRow
                  key={plugin.id}
                  label={plugin.name}
                  description={
                    <>
                      <span data-slot="plugin-facts">{sourceName(plugin.sourceId)}</span>
                      {plugin.description !== undefined ? (
                        <span data-slot="plugin-description" title={plugin.description}>
                          {plugin.description}
                        </span>
                      ) : null}
                    </>
                  }
                  below={
                    failure !== undefined ? <Failure failure={failure} words={words} /> : undefined
                  }
                >
                  {isInstalled(plugin) ? (
                    <span data-slot="hint">{t("plugins.installedMark")}</span>
                  ) : (
                    <Button
                      data-variant="outline"
                      aria-label={t("plugins.installNamed", { name: plugin.name })}
                      disabled={installing !== undefined}
                      onClick={() => setConfirming(plugin)}
                    >
                      {t(installing === plugin.id ? "plugins.installing" : "plugins.install")}
                    </Button>
                  )}
                </PageRow>
              );
            })}
          </PageRows>
          <div data-slot="row" data-plugin-more="">
            <span data-slot="hint" role="status">
              {t("plugins.available.count", {
                shown: listing.plugins.length,
                total: listing.total,
              })}
            </span>
            {listing.nextCursor !== undefined ? (
              <Button
                data-variant="outline"
                disabled={more}
                onClick={async () => {
                  setMore(true);
                  try {
                    await load(listing.nextCursor, listing.plugins);
                  } finally {
                    setMore(false);
                  }
                }}
              >
                {t("plugins.available.more")}
              </Button>
            ) : null}
          </div>
        </>
      )}
      {confirming !== undefined ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirming(undefined)}
          title={t("plugins.installTitle", { name: confirming.name })}
          description={t("plugins.installDescription", {
            ...words,
            source: sourceName(confirming.sourceId),
          })}
          confirmLabel={t("plugins.installConfirm")}
          // The dialog closes at once: fetching it can take a while, and the row says how it went.
          onConfirm={() => {
            void install(confirming);
            return undefined;
          }}
        />
      ) : null}
    </PageGroup>
  );
}

function Sources({
  location,
  agentId,
  words,
  sources,
  onChanged,
}: SectionProps & { sources: PluginSourceInfo[] }) {
  const { t } = useI18n();
  const store = useAppStore();
  const locationId = location.id;
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<PluginSourceInfo | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [failure, setFailure] = useState<PluginFailure | undefined>(undefined);
  const [said, setSaid] = useState<string | undefined>(undefined);

  const refresh = async () => {
    setRefreshing(true);
    setFailure(undefined);
    setSaid(undefined);
    try {
      const answer = await store.refreshPluginSources(locationId, agentId);
      if ("problem" in answer) setFailure(answer);
      else {
        setSaid(t("plugins.sources.refreshed"));
        onChanged();
      }
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <PageGroup
      title={t("plugins.sources.title")}
      lead={t("plugins.sources.lead")}
      action={
        <div data-slot="row">
          <Button data-variant="ghost" disabled={refreshing} onClick={() => void refresh()}>
            {t(refreshing ? "plugins.sources.refreshing" : "plugins.sources.refresh")}
          </Button>
          <Button data-variant="outline" onClick={() => setAdding(true)}>
            {t("plugins.sources.add")}
          </Button>
        </div>
      }
    >
      {failure !== undefined ? <Failure failure={failure} words={words} /> : null}
      {said !== undefined ? (
        <p data-slot="hint" role="status">
          {said}
        </p>
      ) : null}
      <PageRows>
        {sources.map((source) => (
          <PageRow
            key={source.id}
            label={source.name}
            description={
              <>
                <span data-slot="plugin-facts">
                  {t(`plugins.source.kind.${source.kind}`, words)}
                </span>
                {source.location !== undefined ? (
                  <code data-slot="connector-where" title={source.location}>
                    {source.location}
                  </code>
                ) : null}
              </>
            }
          >
            {source.removable ? (
              <Button
                data-variant="ghost"
                aria-label={t("plugins.sources.removeNamed", { name: source.name })}
                onClick={() => setRemoving(source)}
              >
                {t("plugins.sources.remove")}
              </Button>
            ) : null}
          </PageRow>
        ))}
      </PageRows>
      {adding ? (
        <SourceFormDialog
          location={location}
          agentId={agentId}
          words={words}
          onDone={(added) => {
            setAdding(false);
            if (added) onChanged();
          }}
        />
      ) : null}
      {removing !== undefined ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setRemoving(undefined)}
          title={t("plugins.sources.removeTitle", { name: removing.name })}
          description={t("plugins.sources.removeDescription", words)}
          confirmLabel={t("plugins.sources.removeConfirm")}
          destructive
          onConfirm={async () => {
            const answer = await store.removePluginSource(locationId, agentId, removing.id);
            if ("problem" in answer) return failureText(t, answer, words);
            onChanged();
            return undefined;
          }}
        />
      ) : null}
    </PageGroup>
  );
}

/** Where plugins come from, typed by the person: what it lists can then be installed, so the form says what that means. */
function SourceFormDialog({
  location,
  agentId,
  words,
  onDone,
}: {
  location: LocationConfig;
  agentId: string;
  words: Words;
  onDone: (added: boolean) => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<PluginFailure | undefined>(undefined);
  const ready = source.trim() !== "";

  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const answer = await store.addPluginSource(location.id, agentId, source.trim());
      if ("problem" in answer) setFailure(answer);
      else onDone(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onDone(false)}>
      <DialogBackdrop />
      <DialogContent data-kind="plugin-source-form">
        <DialogTitle>{t("plugins.sourceForm.title")}</DialogTitle>
        <form
          data-slot="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field name="location">
            <FieldLabel>{t("plugins.sourceForm.location")}</FieldLabel>
            <Input
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={source}
              onChange={(e) => setSource(e.currentTarget.value)}
            />
            <FieldDescription>{t("plugins.sourceForm.hint", words)}</FieldDescription>
          </Field>
          <p data-slot="hint">{t("plugins.sourceForm.warning", words)}</p>
          {failure !== undefined ? <Failure failure={failure} words={words} /> : null}
          <div data-slot="row" data-dialog-footer="">
            <DialogClose disabled={busy}>{t("dialog.cancel")}</DialogClose>
            <Button data-variant="solid" type="submit" disabled={!ready || busy}>
              {t("plugins.sourceForm.submit")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
