// The settings page (CYCL-78): what belongs to the app, not to one session, in one place. Each section is what used
// to be a menu item or a dialog somewhere else: usage statistics and updates (the menu at the sidebar's foot), the
// colours of code, the environments and each agent's defaults (the menu beside the workspace switcher).
import { Button } from "@ui-sdk/react/button";
import { Field, FieldLabel } from "@ui-sdk/react/field";
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
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type AgentInfo,
  type EnvironmentConfig,
  type EnvironmentStatus,
  type LanguageChoice,
  THEME_CHOICES,
  type ThemeChoice,
} from "../api.ts";
import { CODE_THEMES, type CodeThemeId, codeTheme } from "../code-theme.ts";
import { LANGUAGES, resolveLanguage } from "../languages.ts";
import { SETTINGS_SECTIONS, type SettingsSection } from "../settings-sections.ts";
import { ConfigForm } from "./config-form.tsx";
import { ConfirmDialog } from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import { MoreIcon } from "./icons.tsx";
import { Markdown } from "./markdown.tsx";
import { PageGroup, PageLayout, PageRow, PageRows, type PageSection } from "./page-layout.tsx";
import { MOD } from "./sidebar.tsx";
import { StateBlock } from "./state-block.tsx";
import { ENVIRONMENT_STATE, StatusDot } from "./status.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";
import { updateLine } from "./update.tsx";

export { SETTINGS_SECTIONS, type SettingsSection };

export type SettingsPageProps = {
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onClose: () => void;
  /** What went wrong, said at the top of the page as it is at the top of the sessions. */
  banner?: ReactNode;
  environments: EnvironmentConfig[];
  status: Record<string, EnvironmentStatus>;
  agents: Record<string, AgentInfo[]>;
  /** The environment whose defaults are shown first: the one that is open, when it is connected. */
  environmentId: string | undefined;
  onAddEnvironment: () => void;
  onEditEnvironment: (environmentId: string) => void;
  onRemoveEnvironment: (environmentId: string) => void;
};

export function SettingsPage(props: SettingsPageProps) {
  const { t } = useI18n();
  const content: Record<SettingsSection, PageSection["content"]> = {
    general: <GeneralSection />,
    appearance: <AppearanceSection />,
    environments: <EnvironmentsSection {...props} />,
    defaults: (
      <DefaultsSection
        environments={props.environments}
        status={props.status}
        agents={props.agents}
        environmentId={props.environmentId}
        onShowEnvironments={() => props.onSection("environments")}
      />
    ),
    shortcuts: <ShortcutsSection />,
  };
  return (
    <PageLayout
      title={t("settings.title")}
      sectionsLabel={t("settings.sections")}
      backLabel={t("settings.back")}
      onBack={props.onClose}
      banner={props.banner}
      value={props.section}
      onValueChange={(id) => {
        if ((SETTINGS_SECTIONS as readonly string[]).includes(id))
          props.onSection(id as SettingsSection);
      }}
      sections={SETTINGS_SECTIONS.map((id) => ({
        id,
        label: t(`settings.section.${id}`),
        content: content[id],
      }))}
    />
  );
}

/** Updates and usage statistics: what the menu at the foot of the sidebar held. */
function GeneralSection() {
  const store = useAppStore();
  const { t } = useI18n();
  const update = useAppState((s) => s.update);
  const analytics = useAppState((s) => s.analytics);
  const [confirming, setConfirming] = useState(false);
  const analyticsLabel = useId();
  const asking =
    update?.kind === "checking" || update?.kind === "downloading" || update?.kind === "installing";
  const failedInstall = update?.kind === "error" && update.version !== undefined;
  const installable = update?.kind === "available" || failedInstall;
  const version =
    update?.kind === "available" || update?.kind === "error" ? update.version : undefined;
  const line =
    update === undefined
      ? ""
      : failedInstall
        ? t("update.failed", { version: version ?? "", reason: updateLine(update, t) })
        : updateLine(update, t);
  return (
    <>
      <LanguageGroup />
      {update !== undefined ? (
        <PageGroup title={t("settings.updates")}>
          <PageRows>
            <PageRow
              label={t("update.current", { version: update.current })}
              description={
                line !== "" ? (
                  <span data-update={update.kind} role="status">
                    {line}
                  </span>
                ) : undefined
              }
            >
              {installable ? (
                <Button data-variant="outline" onClick={() => setConfirming(true)}>
                  {t(failedInstall ? "update.tryAgain" : "update.install")}
                </Button>
              ) : null}
              {update.kind !== "disabled" ? (
                <Button
                  data-variant="outline"
                  disabled={asking}
                  onClick={() => void store.checkForUpdate()}
                >
                  {t("app.checkForUpdates")}
                </Button>
              ) : null}
            </PageRow>
          </PageRows>
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title={t("update.confirmTitle", { version: version ?? "" })}
            description={t("update.confirmDescription")}
            confirmLabel={t("update.install")}
            onConfirm={() => store.installUpdate()}
          />
        </PageGroup>
      ) : null}
      {/* With nowhere to report to, or opted out outside the app, there is no switch: it would say nothing true. */}
      {analytics?.available ? (
        <PageGroup title={t("settings.privacy")}>
          <PageRows>
            <PageRow
              label={t("settings.analytics")}
              labelId={analyticsLabel}
              description={t("settings.analytics.description")}
            >
              <Switch
                aria-labelledby={analyticsLabel}
                checked={analytics.enabled}
                onCheckedChange={(checked) => void store.setAnalytics(checked === true)}
              >
                <SwitchThumb />
              </Switch>
            </PageRow>
          </PageRows>
        </PageGroup>
      ) : null}
    </>
  );
}

/**
 * The interface's language: the system's, or one the app has. Each is named in its own words. What an agent writes, and
 * what a system or a remote machine says in its own words, stays as it came.
 */
function LanguageGroup() {
  const store = useAppStore();
  const { t } = useI18n();
  const preferences = useAppState((s) => s.preferences);
  const label = useId();
  if (preferences === undefined) return null;
  const followed = LANGUAGES.find(
    (l) => l.id === resolveLanguage("system", preferences.systemLanguage),
  );
  const items = [
    { value: "system", label: t("settings.language.system", { language: followed?.name ?? "" }) },
    ...LANGUAGES.map((l) => ({ value: l.id as string, label: l.name })),
  ];
  return (
    <PageGroup>
      <PageRows>
        <PageRow
          label={t("settings.language")}
          labelId={label}
          description={t("settings.language.description")}
        >
          <Select
            items={items}
            value={preferences.language}
            onValueChange={(next) => {
              if (typeof next === "string" && next !== preferences.language)
                void store.setPreferences({ language: next as LanguageChoice });
            }}
          >
            <SelectTrigger aria-labelledby={label}>
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
        </PageRow>
      </PageRows>
    </PageGroup>
  );
}

/** Not an agent's words: a few lines of ours, so the choice of colours can be seen where it is made. */
const CODE_SAMPLE = [
  "```ts",
  "// Sessions that still need an answer, newest first.",
  "export const waiting = (sessions: Session[]): Session[] =>",
  "  sessions",
  '    .filter((s) => s.state === "requires_action")',
  "    .sort((a, b) => b.updatedAt - a.updatedAt);",
  "```",
].join("\n");

function AppearanceSection() {
  const store = useAppStore();
  const { t } = useI18n();
  const current = useSyncExternalStore(codeTheme.subscribe, codeTheme.get, codeTheme.get);
  const preferences = useAppState((s) => s.preferences);
  const label = useId();
  const themeLabel = useId();
  return (
    <PageGroup>
      <PageRows>
        {preferences !== undefined ? (
          <PageRow
            label={t("settings.theme")}
            labelId={themeLabel}
            description={t("settings.theme.description")}
          >
            <SegmentedControl
              aria-labelledby={themeLabel}
              value={preferences.theme}
              onValueChange={(next) => {
                if (typeof next === "string" && next !== preferences.theme)
                  void store.setPreferences({ theme: next as ThemeChoice });
              }}
            >
              <SegmentedControlIndicator />
              {THEME_CHOICES.map((theme) => (
                <SegmentedControlItem key={theme} value={theme}>
                  {t(`settings.theme.${theme}`)}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          </PageRow>
        ) : null}
        <PageRow
          label={t("codeTheme.label")}
          labelId={label}
          description={t("settings.codeTheme.description")}
        >
          <Select
            items={CODE_THEMES.map((theme) => ({ value: theme.id, label: theme.label }))}
            value={current}
            onValueChange={(next) => {
              if (typeof next !== "string" || next === current) return;
              codeTheme.set(next as CodeThemeId);
              store.track("code_theme_changed", {});
            }}
          >
            <SelectTrigger aria-labelledby={label}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CODE_THEMES.map((theme) => (
                <SelectItem key={theme.id} value={theme.id}>
                  {theme.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </PageRow>
      </PageRows>
      {/* Drawn as a message of the agent is, so the sample is the code block the conversation shows. */}
      <figure data-slot="code-preview" aria-label={t("settings.codeTheme.preview")}>
        <div data-slot="message" data-role="agent">
          <Markdown text={CODE_SAMPLE} />
        </div>
      </figure>
    </PageGroup>
  );
}

/** Every environment, how its connection stands, and what can be done with it. */
function EnvironmentsSection(props: SettingsPageProps) {
  const store = useAppStore();
  const { t } = useI18n();
  return (
    <PageGroup
      lead={t("settings.environments.lead")}
      action={
        <Button data-variant="outline" onClick={props.onAddEnvironment}>
          {t("environment.add")}
        </Button>
      }
    >
      <PageRows>
        {props.environments.map((environment) => {
          const state = props.status[environment.id];
          const connection = state?.state ?? "closed";
          const how = ENVIRONMENT_STATE[connection];
          const closed = connection === "closed";
          return (
            <PageRow
              key={environment.id}
              label={environment.name}
              before={<StatusDot tone={how.tone} shape={how.shape} />}
              description={
                <>
                  <span data-slot="environment-word">{t(how.word)}</span>
                  {environment.kind === "remote" ? (
                    <code data-slot="environment-where" title={environment.transport.host}>
                      {environment.transport.host}
                    </code>
                  ) : null}
                </>
              }
              below={
                closed && state?.error !== undefined ? (
                  <code data-slot="reason">{state.error}</code>
                ) : undefined
              }
            >
              {closed ? (
                <Button
                  data-variant="outline"
                  onClick={() => void store.connectEnvironment(environment.id)}
                >
                  {t("environment.connectAgain")}
                </Button>
              ) : null}
              {environment.kind === "remote" ? (
                <Menu
                  onAction={(value) => {
                    if (value === "edit") props.onEditEnvironment(environment.id);
                    else if (value === "remove") props.onRemoveEnvironment(environment.id);
                  }}
                >
                  <Tip label={t("settings.environments.actions", { name: environment.name })}>
                    <MenuTrigger data-variant="ghost">
                      <MoreIcon />
                    </MenuTrigger>
                  </Tip>
                  <MenuContent align="end">
                    <MenuItem value="edit">{t("settings.environments.edit")}</MenuItem>
                    <MenuItem value="remove" data-destructive>
                      {t("settings.environments.remove")}
                    </MenuItem>
                  </MenuContent>
                </Menu>
              ) : null}
            </PageRow>
          );
        })}
      </PageRows>
    </PageGroup>
  );
}

/** What every new session of an agent starts with, on one environment: the daemon there keeps it. */
function DefaultsSection({
  environments,
  status,
  agents,
  environmentId,
  onShowEnvironments,
}: {
  environments: EnvironmentConfig[];
  status: Record<string, EnvironmentStatus>;
  agents: Record<string, AgentInfo[]>;
  environmentId: string | undefined;
  onShowEnvironments: () => void;
}) {
  const { t } = useI18n();
  const connected = environments.filter((e) => status[e.id]?.state === "connected");
  const [chosen, setChosen] = useState<string | undefined>(environmentId);
  const environment = connected.find((e) => e.id === chosen) ?? connected[0];
  const revision = useAppState((s) =>
    environment !== undefined ? (s.defaultsRevision[environment.id] ?? 0) : 0,
  );
  if (environment === undefined)
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
  return (
    <PageGroup lead={t("settings.defaults.lead")}>
      <div data-slot="page-form">
        {connected.length > 1 ? (
          <Field name="environment">
            <FieldLabel>{t("settings.defaults.environment")}</FieldLabel>
            <Select
              items={connected.map((e) => ({ value: e.id, label: e.name }))}
              value={environment.id}
              onValueChange={(next) => {
                if (typeof next === "string") setChosen(next);
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
        ) : null}
        {/* Another environment's form starts from nothing. What this one says of its defaults (`revision`) is read again in place. */}
        <EnvironmentDefaults
          key={environment.id}
          environment={environment}
          agents={agents[environment.id] ?? []}
          revision={revision}
        />
      </div>
    </PageGroup>
  );
}

function EnvironmentDefaults({
  environment,
  agents,
  revision,
}: {
  environment: EnvironmentConfig;
  agents: AgentInfo[];
  revision: number;
}) {
  const store = useAppStore();
  const environmentId = environment.id;
  const read = useCallback(
    (agent: string) => store.readAgentDefaults(environmentId, agent),
    [store, environmentId],
  );
  const save = useCallback(
    (agent: string, config: Record<string, string>) =>
      store.setAgentDefaults(environmentId, agent, config),
    [store, environmentId],
  );
  return (
    <AgentDefaultsForm
      environmentName={environment.name}
      agents={agents}
      read={read}
      onSave={save}
      revision={revision}
    />
  );
}

export type AgentDefaultsFormProps = {
  /** For the words said when it has no agent. */
  environmentName: string;
  agents: AgentInfo[];
  read: (agent: string) => Promise<Record<string, string> | undefined>;
  /** Answering `false` says it was not saved (what went wrong is shown elsewhere). */
  onSave: (agent: string, config: Record<string, string>) => Promise<boolean | undefined>;
  /**
   * Counts the times the environment said its defaults changed, here or elsewhere: each is read again, in place. A save
   * made here comes back as one too, so the form must not start over for it.
   */
  revision?: number;
};

/** The defaults of one environment's agents: which agent, when it has several, and that agent's settings. */
export function AgentDefaultsForm({
  environmentName,
  agents,
  read,
  onSave,
  revision = 0,
}: AgentDefaultsFormProps) {
  const { t } = useI18n();
  const [agentId, setAgentId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const agent = agents.find((a) => a.id === agentId) ?? agents[0];
  if (agent === undefined)
    return (
      <StateBlock
        size="inline"
        align="start"
        tone="empty"
        title={t("blank.noAgent", { environment: environmentName })}
        body={t("blank.noAgentHint", { environment: environmentName })}
      />
    );
  return (
    <>
      {agents.length > 1 ? (
        <Field name="agent">
          <FieldLabel>{t("defaults.agent")}</FieldLabel>
          <Select
            items={agents.map((a) => ({ value: a.id, label: a.name }))}
            value={agent.id}
            onValueChange={(next) => setAgentId(next as string | null)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : null}
      {/* Keyed by the agent and the attempt: another agent, or asking again, reads again and starts from what is read. */}
      <AgentDefaultsFields
        key={`${agent.id}:${attempt}`}
        agent={agent}
        read={read}
        onSave={onSave}
        revision={revision}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    </>
  );
}

function AgentDefaultsFields({
  agent,
  read,
  onSave,
  revision,
  onRetry,
}: {
  agent: AgentInfo;
  read: AgentDefaultsFormProps["read"];
  onSave: AgentDefaultsFormProps["onSave"];
  revision: number;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  // Saved only once it holds what was read: saving over a read that failed would replace what is saved with the near-empty form.
  const [config, setConfig] = useState<Record<string, string> | undefined>(undefined);
  const [unread, setUnread] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const agentId = agent.id;
  // Read when shown, and again each time the environment says its defaults changed. What is shown stays while the new
  // is read; a read that fails then leaves it, since it is still what was last read.
  const read0 = useRef(true);
  useEffect(() => {
    const first = read0.current;
    read0.current = false;
    // `revision` is what asks for the read again.
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

/** A key as it is written here: the modifier is ⌘ on a Mac and Ctrl elsewhere. Names of keys are not translated. */
const keysOf = (keys: string): string[] =>
  keys.split(" ").map((key) => (key === "mod" ? (MOD === "⌘" ? "⌘" : "Ctrl") : key));

/** Every shortcut the app has (DESIGN.md §5.4), by what it is for. They cannot be changed here: this is where to look them up. */
const SHORTCUTS: readonly { group: string; rows: readonly { action: string; keys: string }[] }[] = [
  {
    group: "settings.shortcuts.app",
    rows: [
      { action: "settings.shortcuts.newSession", keys: "mod N" },
      { action: "settings.shortcuts.folder", keys: "mod O" },
      { action: "settings.shortcuts.search", keys: "mod K" },
      { action: "settings.shortcuts.settings", keys: "mod ," },
      { action: "settings.shortcuts.sidebar", keys: "mod B" },
      { action: "settings.shortcuts.panel", keys: "mod \\" },
      { action: "settings.shortcuts.previous", keys: "mod [" },
      { action: "settings.shortcuts.next", keys: "mod ]" },
    ],
  },
  {
    group: "settings.shortcuts.session",
    rows: [
      { action: "settings.shortcuts.focus", keys: "mod L" },
      { action: "settings.shortcuts.send", keys: "Enter" },
      { action: "settings.shortcuts.newline", keys: "Shift Enter" },
      { action: "settings.shortcuts.queue", keys: "mod Enter" },
      { action: "settings.shortcuts.allow", keys: "mod Enter" },
      { action: "settings.shortcuts.stop", keys: "mod ." },
      { action: "settings.shortcuts.recall", keys: "↑" },
    ],
  },
];

function ShortcutsSection() {
  const { t } = useI18n();
  return (
    <>
      {SHORTCUTS.map((group) => (
        <PageGroup key={group.group} title={t(group.group)}>
          <PageRows>
            {group.rows.map((row) => (
              <PageRow key={row.action} label={t(row.action)}>
                <span data-slot="keys">
                  {keysOf(row.keys).map((key) => (
                    <kbd key={key}>{key}</kbd>
                  ))}
                </span>
              </PageRow>
            ))}
          </PageRows>
        </PageGroup>
      ))}
    </>
  );
}
