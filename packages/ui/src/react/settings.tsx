// The settings page (CYCL-78): what belongs to the app, not to one session, in one place. Each section is what used
// to be a menu item or a dialog somewhere else: usage statistics and updates (the menu at the sidebar's foot), the
// colours of code, the locations and each agent's defaults (the menu beside the workspace switcher).
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
import { type ReactNode, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import {
  type AgentInfo,
  type LanguageChoice,
  type LocationConfig,
  type LocationStatus,
  THEME_CHOICES,
  type ThemeChoice,
} from "../api.ts";
import { CODE_THEMES, type CodeThemeId, codeTheme } from "../code-theme.ts";
import { LANGUAGES, resolveLanguage } from "../languages.ts";
import { SETTINGS_SECTIONS, type SettingsSection } from "../settings-sections.ts";
import { AccountGroup } from "./account.tsx";
import { AgentLogo } from "./agent-logos.tsx";
import { ConfigForm } from "./config-form.tsx";
import { ConfirmDialog } from "./dialogs.tsx";
import { EnvironmentsSection } from "./environments.tsx";
import { HarnessSection, harnessListOf } from "./harness-settings.tsx";
import { useI18n } from "./i18n.tsx";
import { MoreIcon } from "./icons.tsx";
import { Markdown } from "./markdown.tsx";
import { PageGroup, PageLayout, PageRow, PageRows, type PageSection } from "./page-layout.tsx";
import { ApiKeysSection } from "./providers.tsx";
import { MOD } from "./sidebar.tsx";
import { StateBlock } from "./state-block.tsx";
import { LOCATION_STATE, StatusDot } from "./status.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { SubscriptionsSection } from "./subscriptions.tsx";
import { Tip } from "./tip.tsx";
import { updateLine } from "./update.tsx";

export { SETTINGS_SECTIONS, type SettingsSection };

export type SettingsPageProps = {
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  /** Currently selected agent id when `section === "harness"`. */
  harnessAgent?: string | undefined;
  /** Where the Harness page was opened from, for behavioral analytics. */
  harnessFrom?: "settings" | "blank" | "other" | undefined;
  onHarnessAgent?: ((agentId: string) => void) | undefined;
  onClose: () => void;
  /** What went wrong, said at the top of the page as it is at the top of the sessions. */
  banner?: ReactNode;
  locations: LocationConfig[];
  status: Record<string, LocationStatus>;
  agents: Record<string, AgentInfo[]>;
  /** The location whose defaults/harness settings are shown first: the one that is open, when connected. */
  locationId: string | undefined;
  onAddLocation: () => void;
  onEditLocation: (locationId: string) => void;
  onRemoveLocation: (locationId: string) => void;
};

const HARNESS_TAB_PREFIX = "harness:";

export function SettingsPage(props: SettingsPageProps) {
  const { t } = useI18n();
  const harnesses = harnessListOf(props.agents);
  const [chosenEnv, setChosenEnv] = useState<string | undefined>(props.locationId);
  useEffect(() => {
    if (props.locationId !== undefined) setChosenEnv(props.locationId);
  }, [props.locationId]);
  const [localHarness, setLocalHarness] = useState<string>(
    props.harnessAgent ?? harnesses[0]?.id ?? "claude",
  );
  const activeHarness = props.harnessAgent ?? localHarness;
  const activeTabValue =
    props.section === "harness" ? `${HARNESS_TAB_PREFIX}${activeHarness}` : props.section;

  const topSections: PageSection[] = [
    { id: "general", label: t("settings.section.general"), content: <GeneralSection /> },
    { id: "appearance", label: t("settings.section.appearance"), content: <AppearanceSection /> },
    {
      id: "locations",
      label: t("settings.section.locations"),
      content: <LocationsSection {...props} />,
    },
    {
      id: "environments",
      label: t("settings.section.environments"),
      content: <EnvironmentsSection />,
    },
    { id: "shortcuts", label: t("settings.section.shortcuts"), content: <ShortcutsSection /> },
  ];

  const providersGroup = t("settings.providers.group");
  const location = {
    locations: props.locations,
    status: props.status,
    locationId: chosenEnv,
    onLocationChange: setChosenEnv,
    onShowLocations: () => props.onSection("locations"),
  };
  const providerSections: PageSection[] = [
    {
      id: "subscriptions",
      label: t("settings.section.subscriptions"),
      group: providersGroup,
      content: <SubscriptionsSection {...location} agents={props.agents} />,
    },
    {
      id: "api_keys",
      label: t("settings.section.apiKeys"),
      group: providersGroup,
      content: <ApiKeysSection {...location} />,
    },
    // The team's gateway comes later: listed so it is known to come, and not yet there to choose.
    {
      id: "team",
      label: t("settings.section.team"),
      group: providersGroup,
      disabled: true,
      note: t("settings.section.soon"),
      content: null,
    },
  ];

  const harnessGroup = t("settings.harness.group");
  const harnessSections: PageSection[] = harnesses.map((harness) => ({
    id: `${HARNESS_TAB_PREFIX}${harness.id}`,
    label: harness.name,
    group: harnessGroup,
    icon: <AgentLogo agentId={harness.id} name={harness.name} decorative />,
    heading: (
      <span data-slot="harness-heading">
        <AgentLogo agentId={harness.id} name={harness.name} decorative />
        <span>{harness.name}</span>
      </span>
    ),
    content: (
      <HarnessSection
        agentId={harness.id}
        agentName={harness.name}
        locations={props.locations}
        status={props.status}
        agents={props.agents}
        locationId={chosenEnv}
        onLocationChange={setChosenEnv}
        from={props.harnessFrom ?? "settings"}
        onShowLocations={() => props.onSection("locations")}
      />
    ),
  }));

  return (
    <PageLayout
      title={t("settings.title")}
      sectionsLabel={t("settings.sections")}
      backLabel={t("settings.back")}
      onBack={props.onClose}
      banner={props.banner}
      value={activeTabValue}
      onValueChange={(id) => {
        if (id.startsWith(HARNESS_TAB_PREFIX)) {
          const agentId = id.slice(HARNESS_TAB_PREFIX.length);
          setLocalHarness(agentId);
          props.onHarnessAgent?.(agentId);
          if (props.section !== "harness") props.onSection("harness");
          return;
        }
        if ((SETTINGS_SECTIONS as readonly string[]).includes(id)) {
          props.onSection(id as SettingsSection);
        }
      }}
      sections={[...topSections, ...providerSections, ...harnessSections]}
    />
  );
}

/** The account, the language, updates and usage statistics: what belongs to the app as a whole. */
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
      <AccountGroup />
      <LanguageGroup />
      <SuggestionsGroup />
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

/** Whether the agent suggests what to say next, in the empty message box (CYCL-225). On until turned off. */
function SuggestionsGroup() {
  const store = useAppStore();
  const { t } = useI18n();
  const preferences = useAppState((s) => s.preferences);
  const label = useId();
  if (preferences === undefined) return null;
  return (
    <PageGroup>
      <PageRows>
        <PageRow
          label={t("settings.suggestions")}
          labelId={label}
          description={t("settings.suggestions.description")}
        >
          <Switch
            aria-labelledby={label}
            checked={preferences.promptSuggestions}
            onCheckedChange={(checked) =>
              void store.setPreferences({ promptSuggestions: checked === true })
            }
          >
            <SwitchThumb />
          </Switch>
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

/** Every location, how its connection stands, and what can be done with it. */
function LocationsSection(props: SettingsPageProps) {
  const store = useAppStore();
  const { t } = useI18n();
  return (
    <PageGroup
      lead={t("settings.locations.lead")}
      action={
        <Button data-variant="outline" onClick={props.onAddLocation}>
          {t("location.add")}
        </Button>
      }
    >
      <PageRows>
        {props.locations.map((location) => {
          const state = props.status[location.id];
          const connection = state?.state ?? "closed";
          const how = LOCATION_STATE[connection];
          const closed = connection === "closed";
          return (
            <PageRow
              key={location.id}
              label={location.name}
              before={<StatusDot tone={how.tone} shape={how.shape} />}
              description={
                <>
                  <span data-slot="location-word">{t(how.word)}</span>
                  {location.kind === "remote" ? (
                    <code data-slot="location-where" title={location.transport.host}>
                      {location.transport.host}
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
                  onClick={() => void store.connectLocation(location.id)}
                >
                  {t("location.connectAgain")}
                </Button>
              ) : null}
              {location.kind === "remote" ? (
                <Menu
                  onAction={(value) => {
                    if (value === "edit") props.onEditLocation(location.id);
                    else if (value === "remove") props.onRemoveLocation(location.id);
                  }}
                >
                  <Tip label={t("settings.locations.actions", { name: location.name })}>
                    <MenuTrigger data-variant="ghost">
                      <MoreIcon />
                    </MenuTrigger>
                  </Tip>
                  <MenuContent align="end">
                    <MenuItem value="edit">{t("settings.locations.edit")}</MenuItem>
                    <MenuItem value="remove" data-destructive>
                      {t("settings.locations.remove")}
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

export type AgentDefaultsFormProps = {
  /** For the words said when it has no agent. */
  locationName: string;
  agents: AgentInfo[];
  read: (agent: string) => Promise<Record<string, string> | undefined>;
  /** Answering `false` says it was not saved (what went wrong is shown elsewhere). */
  onSave: (agent: string, config: Record<string, string>) => Promise<boolean | undefined>;
  /**
   * Counts the times the location said its defaults changed, here or elsewhere: each is read again, in place. A save
   * made here comes back as one too, so the form must not start over for it.
   */
  revision?: number;
};

/** The defaults of one location's agents: which agent, when it has several, and that agent's settings. */
export function AgentDefaultsForm({
  locationName,
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
        title={t("blank.noAgent", { location: locationName })}
        body={t("blank.noAgentHint", { location: locationName })}
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
  // Read when shown, and again each time the location says its defaults changed. What is shown stays while the new
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
      { action: "settings.shortcuts.suggestion", keys: "Tab" },
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
