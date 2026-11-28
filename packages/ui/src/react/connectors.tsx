// The Connectors page (CYCL-82): what a location's daemon keeps for every agent, in one page that takes the window
// in place of the sessions, as Settings does. Its sections share one choice, made at the top of each: which location.
import { Button } from "@ui-sdk/react/button";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@ui-sdk/react/menu";
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { Switch, SwitchThumb } from "@ui-sdk/react/switch";
import { Textarea } from "@ui-sdk/react/textarea";
import { type ReactNode, useEffect, useId, useState } from "react";
import type {
  ConnectorDraft,
  ConnectorInfo,
  ConnectorProblem,
  ConnectorSecrets,
  LocationConfig,
  LocationStatus,
} from "../api.ts";
import { CONNECTORS_SECTIONS, type ConnectorsSection } from "../connectors-sections.ts";
import { ConnectorValuesDialog } from "./connector-values.tsx";
import { ConfirmDialog, FormDialog } from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import { MoreIcon } from "./icons.tsx";
import { useKeyedAsyncAction } from "./keyed-action.ts";
import { PageGroup, PageLayout, PageRow, PageRows } from "./page-layout.tsx";
import { PluginsSection } from "./plugins.tsx";
import { StateBlock } from "./state-block.tsx";
import { type Shape, StatusDot, type Tone } from "./status.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";

export { CONNECTORS_SECTIONS, type ConnectorsSection };

type Problem = { problem: ConnectorProblem; message?: string | undefined };
type Answer = { connector: ConnectorInfo } | Problem | { cancelled: true };
type Pending = Promise<Answer>;
type Act = () => Pending;

/** What a daemon says it can do (docs/protocol.md §3): what a section asks of the location it is shown for. */
type Capabilities = LocationStatus["capabilities"];

/** What every section of the page is given: the location chosen at the top, whose daemon can do what it needs. */
export type ConnectorsSectionProps = {
  /** Connected, and its daemon declares the section's capability. The section is made again for another one. */
  location: LocationConfig;
};

/**
 * Each section: what the location's daemon must be able to do for it, and what it draws once one that can is chosen.
 * A new section is a word in `CONNECTORS_SECTIONS` (connectors-sections.ts) and an entry here; the rest follows.
 */
const SECTIONS: Record<
  ConnectorsSection,
  {
    able: (capabilities: Capabilities) => boolean;
    content: (props: ConnectorsSectionProps) => ReactNode;
  }
> = {
  // Each agent's own extension packages (CYCL-84): there when at least one agent of the daemon has them.
  plugins: {
    able: (capabilities) => (capabilities?.plugins?.length ?? 0) > 0,
    content: (props) => <PluginsSection {...props} />,
  },
  mcp: {
    able: (capabilities) => capabilities?.connectors === true,
    content: (props) => <McpSection {...props} />,
  },
};

/** The locations the page can manage: connected, and able to do what at least one of its sections needs. */
export const connectorLocations = (
  locations: LocationConfig[],
  status: Record<string, LocationStatus>,
): LocationConfig[] =>
  locations.filter(
    (e) =>
      status[e.id]?.state === "connected" &&
      CONNECTORS_SECTIONS.some((id) => SECTIONS[id].able(status[e.id]?.capabilities)),
  );

export type ConnectorsPageProps = {
  section: ConnectorsSection;
  onSection: (section: ConnectorsSection) => void;
  onClose: () => void;
  /** What went wrong, said at the top of the page as it is at the top of the sessions. */
  banner?: ReactNode;
  locations: LocationConfig[];
  status: Record<string, LocationStatus>;
  /** The location to show first, when it is one the page can manage: the one that is open. */
  locationId?: string | undefined;
  /** Where the locations are connected and added (Settings), for when none can be managed here. */
  onShowLocations: () => void;
};

/** What the daemons keep for every agent, one location at a time (docs/protocol.md §14). */
export function ConnectorsPage(props: ConnectorsPageProps) {
  const { t } = useI18n();
  const able = connectorLocations(props.locations, props.status);
  // One choice for the whole page: another section shows the same location.
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const location =
    able.find((e) => e.id === chosen) ?? able.find((e) => e.id === props.locationId) ?? able[0];
  return (
    <PageLayout
      title={t("connectors.title")}
      sectionsLabel={t("connectors.sections")}
      backLabel={t("settings.back")}
      onBack={props.onClose}
      banner={props.banner}
      value={props.section}
      onValueChange={(id) => {
        if ((CONNECTORS_SECTIONS as readonly string[]).includes(id))
          props.onSection(id as ConnectorsSection);
      }}
      sections={CONNECTORS_SECTIONS.map((id) => ({
        id,
        label: t(`connectors.section.${id}`),
        content:
          location === undefined ? (
            <StateBlock
              size="inline"
              align="start"
              tone="away"
              title={t("connectors.none")}
              body={t("connectors.noneBody")}
              action={{
                label: t("settings.defaults.showLocations"),
                onAction: props.onShowLocations,
              }}
            />
          ) : (
            <>
              {able.length > 1 ? (
                <LocationChoice locations={able} value={location.id} onChange={setChosen} />
              ) : null}
              {SECTIONS[id].able(props.status[location.id]?.capabilities) ? (
                // Keyed by the location: another one's section starts from nothing, and reads its own.
                <SectionOf key={location.id} id={id} location={location} />
              ) : (
                <StateBlock
                  size="inline"
                  align="start"
                  tone="away"
                  title={t("connectors.unsupported", { location: location.name })}
                  body={t(
                    able.length > 1
                      ? "connectors.unsupportedBody.choose"
                      : "connectors.unsupportedBody",
                  )}
                />
              )}
            </>
          ),
      }))}
    />
  );
}

/** A component of its own, so a section's state belongs to the section and its location (`key`). */
function SectionOf({ id, location }: { id: ConnectorsSection } & ConnectorsSectionProps) {
  return SECTIONS[id].content({ location });
}

/** Which location the page manages, when more than one can be: a row of its own above the section. */
function LocationChoice({
  locations,
  value,
  onChange,
}: {
  locations: LocationConfig[];
  value: string;
  onChange: (locationId: string) => void;
}) {
  const { t } = useI18n();
  const label = useId();
  return (
    <PageGroup>
      <PageRows>
        <PageRow
          label={t("connectors.location")}
          labelId={label}
          description={t("connectors.location.description")}
        >
          <Select
            items={locations.map((e) => ({ value: e.id, label: e.name }))}
            value={value}
            onValueChange={(next) => {
              if (typeof next === "string") onChange(next);
            }}
          >
            <SelectTrigger aria-labelledby={label}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {locations.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </PageRow>
      </PageRows>
    </PageGroup>
  );
}

const useProblemText = (location: LocationConfig) => {
  const { t } = useI18n();
  return (p: Problem) =>
    t(`connectors.problem.${p.problem}`, {
      location: location.name,
      reason: p.message ?? "",
    });
};

/** Where a connector is: the host of its URL, or the command it runs. Never a secret: those are not here at all. */
const whereOf = (connector: ConnectorInfo): string => {
  if (connector.transport.type === "stdio")
    return [connector.transport.command, ...connector.transport.args].join(" ");
  try {
    return new URL(connector.transport.url).host;
  } catch {
    return connector.transport.url;
  }
};

/** How a connector stands, as a mark before its name: never by colour alone, the word is beside it. */
const STATUS_MARK: Record<ConnectorInfo["status"]["state"], { tone: Tone; shape: Shape }> = {
  ready: { tone: "success", shape: "solid" },
  needs_auth: { tone: "attention", shape: "ring" },
  disabled: { tone: "muted", shape: "ring" },
  error: { tone: "danger", shape: "cross" },
};

/** The MCP servers the location's daemon keeps for every agent: each one's state, its switch, and what can be done with it. */
function McpSection({ location }: ConnectorsSectionProps) {
  const { t } = useI18n();
  const store = useAppStore();
  const problemText = useProblemText(location);
  const locationId = location.id;
  const read = useAppState((s) => s.connectors[locationId]);
  const list = read?.list;
  /** Which connectors have an action under way, and what went wrong with each, shown under its row. */
  const { busy, problems, run } = useKeyedAsyncAction<Problem>();
  const [waiting, setWaiting] = useState<ConnectorInfo | undefined>(undefined);
  const [signedIn, setSignedIn] = useState<string | undefined>(undefined);
  const [removing, setRemoving] = useState<ConnectorInfo | undefined>(undefined);
  /** The form, opened over the page: for a new connector, or one that is there. */
  const [editing, setEditing] = useState<ConnectorInfo | "new" | undefined>(undefined);
  /** The values a plugin's server leaves to the person, being filled in. */
  const [values, setValues] = useState<ConnectorInfo | undefined>(undefined);

  useEffect(() => {
    void store.loadConnectors(locationId);
  }, [store, locationId]);

  const act = (connector: ConnectorInfo, action: Act) => run(connector.id, action);

  const signIn = async (connector: ConnectorInfo) => {
    setWaiting(connector);
    setSignedIn(undefined);
    const answer = await act(connector, () => store.authorizeConnector(locationId, connector.id));
    setWaiting((w) => (w?.id === connector.id ? undefined : w));
    if ("connector" in answer) setSignedIn(connector.name);
  };

  const add = (
    <Button data-variant="outline" onClick={() => setEditing("new")}>
      {t("connectors.add")}
    </Button>
  );
  return (
    // With none yet, the way to add one is in what says so, not twice.
    <PageGroup
      lead={t("connectors.lead", { location: location.name })}
      action={list !== undefined && list.length > 0 ? add : undefined}
    >
      {read?.error !== undefined ? (
        <StateBlock
          size="inline"
          align="start"
          tone="error"
          title={t("connectors.unreadable")}
          reason={read.error}
          action={{
            label: t("connectors.retry"),
            onAction: () => void store.loadConnectors(locationId),
          }}
        />
      ) : null}
      {waiting !== undefined ? (
        <div data-slot="row" role="status">
          <span data-slot="hint">{t("connectors.waiting", { name: waiting.name })}</span>
          <Button data-variant="outline" onClick={() => void store.cancelConnectorAuth()}>
            {t("connectors.stopWaiting")}
          </Button>
        </div>
      ) : signedIn !== undefined ? (
        <p data-slot="hint" role="status">
          {t("connectors.signedIn", { name: signedIn })}
        </p>
      ) : null}
      {list === undefined ? (
        read?.error === undefined ? (
          <StateBlock size="inline" align="start" tone="loading" title={t("connectors.loading")} />
        ) : null
      ) : list.length === 0 ? (
        <StateBlock
          size="inline"
          align="start"
          tone="empty"
          title={t("connectors.empty")}
          body={t("connectors.emptyBody")}
          action={{ label: t("connectors.add"), onAction: () => setEditing("new") }}
        />
      ) : (
        <PageRows>
          {list.map((connector) => {
            const oauth = connector.auth.type === "oauth";
            const problem = problems[connector.id];
            const where = whereOf(connector);
            // A plugin's server: it comes, goes and is switched with its plugin (docs/protocol.md §15).
            const origin = connector.origin;
            const requires = connector.requires ?? [];
            const unfilled = requires.some((name) => !connector.secrets.env.includes(name));
            return (
              <PageRow
                key={connector.id}
                label={origin?.server ?? connector.name}
                before={<StatusDot {...STATUS_MARK[connector.status.state]} />}
                description={
                  <>
                    <span data-slot="connector-status">
                      {unfilled && connector.enabled
                        ? t("connectors.status.needs_values")
                        : statusWord(t, connector)}
                    </span>
                    {origin !== undefined ? (
                      <span data-slot="connector-status">
                        {t("connectors.fromPlugin", {
                          plugin: origin.pluginName ?? origin.pluginId,
                        })}
                      </span>
                    ) : null}
                    <code data-slot="connector-where" title={where}>
                      {where}
                    </code>
                  </>
                }
                below={
                  problem !== undefined ? (
                    <p data-slot="hint" role="alert">
                      {problemText(problem)}
                    </p>
                  ) : undefined
                }
              >
                {requires.length > 0 && unfilled && connector.enabled ? (
                  <Button data-variant="outline" onClick={() => setValues(connector)}>
                    {t("connectors.setValues")}
                  </Button>
                ) : oauth && connector.enabled && connector.status.state === "needs_auth" ? (
                  <Button
                    data-variant="outline"
                    disabled={busy[connector.id] === true}
                    onClick={() => void signIn(connector)}
                  >
                    {t("connectors.signIn")}
                  </Button>
                ) : null}
                {origin === undefined ? (
                  <Switch
                    aria-label={t("connectors.use", { name: connector.name })}
                    checked={connector.enabled}
                    disabled={busy[connector.id] === true}
                    onCheckedChange={(enabled) =>
                      void act(connector, () =>
                        store.updateConnector(locationId, connector.id, { enabled }),
                      )
                    }
                  >
                    <SwitchThumb />
                  </Switch>
                ) : null}
                {origin !== undefined &&
                requires.length === 0 &&
                !(oauth && connector.authorized) ? null : (
                  <Menu
                    onAction={(value) => {
                      if (value === "edit") setEditing(connector);
                      else if (value === "values") setValues(connector);
                      else if (value === "sign-out")
                        void act(connector, () => store.signOutConnector(locationId, connector.id));
                      else if (value === "remove") setRemoving(connector);
                    }}
                  >
                    <Tip label={t("connectors.actions", { name: connector.name })}>
                      <MenuTrigger data-variant="ghost">
                        <MoreIcon />
                      </MenuTrigger>
                    </Tip>
                    <MenuContent align="end">
                      {origin === undefined ? (
                        <MenuItem value="edit">{t("connectors.edit")}</MenuItem>
                      ) : null}
                      {requires.length > 0 ? (
                        <MenuItem value="values">{t("connectors.setValues")}</MenuItem>
                      ) : null}
                      {oauth && connector.authorized ? (
                        <MenuItem value="sign-out">{t("connectors.signOut")}</MenuItem>
                      ) : null}
                      {origin === undefined ? (
                        <MenuItem value="remove" data-destructive>
                          {t("connectors.remove")}
                        </MenuItem>
                      ) : null}
                    </MenuContent>
                  </Menu>
                )}
              </PageRow>
            );
          })}
        </PageRows>
      )}
      {editing !== undefined ? (
        <ConnectorFormDialog
          location={location}
          editing={editing === "new" ? undefined : editing}
          onDone={() => setEditing(undefined)}
        />
      ) : null}
      {values !== undefined ? (
        <ConnectorValuesDialog
          location={location}
          connector={values}
          onDone={() => setValues(undefined)}
        />
      ) : null}
      {removing !== undefined ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setRemoving(undefined)}
          title={t("connectors.removeTitle", { name: removing.name })}
          description={t("connectors.removeDescription")}
          confirmLabel={t("connectors.removeConfirm")}
          destructive
          onConfirm={async () => {
            const target = removing;
            const answer = await store.removeConnector(locationId, target.id);
            if ("problem" in answer) return problemText(answer);
            return undefined;
          }}
        />
      ) : null}
    </PageGroup>
  );
}

const statusWord = (
  t: (key: string, params?: Record<string, string>) => string,
  connector: ConnectorInfo,
): string => {
  const { state, reason } = connector.status;
  if (state === "error")
    return reason !== undefined ? t(`connectors.status.${reason}`) : t("connectors.status.error");
  return t(`connectors.status.${state}`);
};

type SecretKind = "headers" | "env";
type NewSecret = { key: number; name: string; value: string };

/** One connector's fields, in a dialog over the page: mounted when it opens, so it starts from what is being edited. */
function ConnectorFormDialog(props: {
  location: LocationConfig;
  editing: ConnectorInfo | undefined;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const problemText = useProblemText(props.location);
  const before = props.editing;
  const [name, setName] = useState(before?.name ?? "");
  const [kind, setKind] = useState<"http" | "stdio">(before?.transport.type ?? "http");
  const [url, setUrl] = useState(before?.transport.type === "http" ? before.transport.url : "");
  const [command, setCommand] = useState(
    before?.transport.type === "stdio" ? before.transport.command : "",
  );
  const [args, setArgs] = useState(
    before?.transport.type === "stdio" ? before.transport.args.join("\n") : "",
  );
  const [cwd, setCwd] = useState(
    before?.transport.type === "stdio" ? (before.transport.cwd ?? "") : "",
  );
  const [auth, setAuth] = useState<"none" | "oauth">(before?.auth.type ?? "none");
  const [clientId, setClientId] = useState(
    before?.auth.type === "oauth" ? (before.auth.clientId ?? "") : "",
  );
  const secretKind: SecretKind = kind === "http" ? "headers" : "env";
  /** Names kept that are to be removed on save. */
  const [dropped, setDropped] = useState<ReadonlySet<string>>(new Set());
  const [added, setAdded] = useState<NewSecret[]>([]);
  const [counter, setCounter] = useState(0);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const kept = before?.secrets[secretKind] ?? [];

  const draft = (): ConnectorDraft => {
    const secrets: Record<string, string | null> = {};
    for (const removed of dropped) secrets[removed] = null;
    for (const pair of added)
      if (pair.name.trim() !== "" && pair.value !== "") secrets[pair.name.trim()] = pair.value;
    const written: ConnectorSecrets | undefined =
      Object.keys(secrets).length > 0 ? { [secretKind]: secrets } : undefined;
    return {
      name: name.trim(),
      transport:
        kind === "http"
          ? { type: "http", url: url.trim() }
          : {
              type: "stdio",
              command: command.trim(),
              args: args
                .split("\n")
                .map((a) => a.trim())
                .filter((a) => a !== ""),
              ...(cwd.trim() !== "" ? { cwd: cwd.trim() } : {}),
            },
      auth:
        kind === "http" && auth === "oauth"
          ? {
              type: "oauth",
              ...(clientId.trim() !== "" ? { clientId: clientId.trim() } : {}),
              // Scopes have no field here: what the connector has is kept, not dropped by an edit.
              ...(before?.auth.type === "oauth" && before.auth.scopes !== undefined
                ? { scopes: before.auth.scopes }
                : {}),
            }
          : { type: "none" },
      ...(written !== undefined ? { secrets: written } : {}),
    };
  };

  const ready = name.trim() !== "" && (kind === "http" ? url.trim() !== "" : command.trim() !== "");

  const save = async () => {
    setProblem(undefined);
    const answer =
      before === undefined
        ? await store.addConnector(props.location.id, draft())
        : await store.updateConnector(props.location.id, before.id, draft());
    if ("connector" in answer) return true;
    setProblem(answer);
    return false;
  };

  const fields = (
    <>
      <Field name="name">
        <FieldLabel>{t("connectors.form.name")}</FieldLabel>
        <Input autoFocus value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <FieldDescription>{t("connectors.form.nameHint")}</FieldDescription>
      </Field>
      <Field name="transport">
        <FieldLabel>{t("connectors.form.transport")}</FieldLabel>
        <SegmentedControl
          value={kind}
          onValueChange={(next) => {
            if (next === "http" || next === "stdio") setKind(next);
          }}
        >
          <SegmentedControlIndicator />
          <SegmentedControlItem value="http">
            {t("connectors.form.transport.http")}
          </SegmentedControlItem>
          <SegmentedControlItem value="stdio">
            {t("connectors.form.transport.stdio")}
          </SegmentedControlItem>
        </SegmentedControl>
      </Field>
      {kind === "http" ? (
        <>
          <Field name="url">
            <FieldLabel>{t("connectors.form.url")}</FieldLabel>
            <Input
              value={url}
              placeholder="https://"
              onChange={(e) => setUrl(e.currentTarget.value)}
            />
          </Field>
          <Field name="auth">
            <FieldLabel>{t("connectors.form.auth")}</FieldLabel>
            <SegmentedControl
              value={auth}
              onValueChange={(next) => {
                if (next === "none" || next === "oauth") setAuth(next);
              }}
            >
              <SegmentedControlIndicator />
              <SegmentedControlItem value="none">
                {t("connectors.form.auth.none")}
              </SegmentedControlItem>
              <SegmentedControlItem value="oauth">
                {t("connectors.form.auth.oauth")}
              </SegmentedControlItem>
            </SegmentedControl>
          </Field>
          {auth === "oauth" ? (
            <Field name="clientId">
              <FieldLabel>{t("connectors.form.clientId")}</FieldLabel>
              <Input value={clientId} onChange={(e) => setClientId(e.currentTarget.value)} />
              <FieldDescription>{t("connectors.form.clientIdHint")}</FieldDescription>
            </Field>
          ) : null}
        </>
      ) : (
        <>
          <Field name="command">
            <FieldLabel>{t("connectors.form.command")}</FieldLabel>
            <Input value={command} onChange={(e) => setCommand(e.currentTarget.value)} />
          </Field>
          <Field name="args">
            <FieldLabel>{t("connectors.form.args")}</FieldLabel>
            <Textarea value={args} rows={3} onChange={(e) => setArgs(e.currentTarget.value)} />
          </Field>
          <Field name="cwd">
            <FieldLabel>{t("connectors.form.cwd")}</FieldLabel>
            <Input value={cwd} onChange={(e) => setCwd(e.currentTarget.value)} />
            <FieldDescription>{t("connectors.form.cwdHint")}</FieldDescription>
          </Field>
        </>
      )}
      <fieldset data-slot="secrets">
        <legend>{t(kind === "http" ? "connectors.form.headers" : "connectors.form.env")}</legend>
        <p data-slot="hint">
          {t("connectors.form.secretsHint", { location: props.location.name })}
        </p>
        {kept.map((secret) => {
          const gone = dropped.has(secret);
          return (
            <div key={secret} data-slot="row">
              <span data-slot="secret-name" data-removed={gone}>
                {t(gone ? "connectors.form.secretRemoving" : "connectors.form.secretSet", {
                  name: secret,
                })}
              </span>
              <Button
                type="button"
                data-variant="ghost"
                onClick={() =>
                  setDropped((set) => {
                    const next = new Set(set);
                    if (gone) next.delete(secret);
                    else next.add(secret);
                    return next;
                  })
                }
              >
                {t(gone ? "connectors.form.secretKeep" : "connectors.form.secretRemove", {
                  name: secret,
                })}
              </Button>
            </div>
          );
        })}
        {added.map((pair) => (
          <div key={pair.key} data-slot="row">
            <Input
              aria-label={t("connectors.form.secretName")}
              placeholder={t("connectors.form.secretName")}
              value={pair.name}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setAdded((list) =>
                  list.map((p) => (p.key === pair.key ? { ...p, name: value } : p)),
                );
              }}
            />
            <Input
              type="password"
              autoComplete="off"
              aria-label={t("connectors.form.secretValue")}
              placeholder={t("connectors.form.secretValue")}
              value={pair.value}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setAdded((list) => list.map((p) => (p.key === pair.key ? { ...p, value } : p)));
              }}
            />
          </div>
        ))}
        <div data-slot="row">
          <Button
            type="button"
            data-variant="ghost"
            onClick={() => {
              setAdded((list) => [...list, { key: counter, name: "", value: "" }]);
              setCounter((n) => n + 1);
            }}
          >
            {t("connectors.form.secretAdd")}
          </Button>
        </div>
      </fieldset>
    </>
  );

  return (
    <FormDialog
      kind="connector-form"
      title={
        before === undefined
          ? t("connectors.form.addTitle")
          : t("connectors.form.editTitle", { name: before.name })
      }
      ready={ready}
      submitLabel={t(before === undefined ? "connectors.form.create" : "connectors.form.save")}
      onSubmit={save}
      onClose={props.onDone}
      problem={problem !== undefined ? problemText(problem) : undefined}
    >
      {fields}
    </FormDialog>
  );
}
