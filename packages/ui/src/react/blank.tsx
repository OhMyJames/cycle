// A new session before its first message (docs/protocol.md §6): where it runs and with which agent are chosen here, the
// first message is written in the box below, and sending it is what makes the session. Until then nothing of it is in
// the daemon, and so nothing of it is in the sidebar.
import type { AgentWord } from "@cycle/analytics/events";
import { Button } from "@ui-sdk/react/button";
import {
  Dialog,
  DialogBackdrop,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import type { LocationConfig } from "../api.ts";
import { applyUpdate, emptyConversation } from "../model/index.ts";
import { BLANK_KEY, type BlankConversation } from "../store/index.ts";
import { AgentLogo } from "./agent-logos.tsx";
import { Composer, composerInput } from "./composer.tsx";
import { propertiesOf, withEffortFor } from "./config-form.tsx";
import { ConversationView } from "./conversation.tsx";
import { EnvironmentPicker } from "./environments.tsx";
import { FolderBrowser } from "./folder-browser.tsx";
import { useI18n } from "./i18n.tsx";
import { CheckIcon } from "./icons.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";
import { WorktreePicker } from "./worktrees.tsx";

const AGY_INSTALL_COMMAND = "curl -fsSL https://antigravity.google/cli/install.sh | bash";

const agentWord = (id: string): AgentWord =>
  id === "claude" || id === "codex" || id === "agy" || id === "pi" ? id : "other";

/** A folder offered on the blank page: one the location already has sessions in, newest first. */
export type RecentFolder = { cwd: string; name: string };

/** The last part of a path, which is what tells folders apart; the whole path is in the control's name and title. */
const baseName = (path: string): string => {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? path : trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
};

/**
 * What a new session starts with where nothing is set: the schema's `default` (docs/protocol.md §10). A session that
 * exists shows "Not set" for such a setting, since its agent's default may since have changed; one not yet made does not.
 */
type Settings = Record<string, string>;
const defaultsOf = (schema: Record<string, unknown>): Settings =>
  Object.fromEntries(
    propertiesOf(schema).flatMap(([key, property]) =>
      typeof property.default === "string" ? [[key, property.default]] : [],
    ),
  );

export function BlankConversationView({
  blank,
  locations,
  recent,
  connected,
  follow,
  sidebarToggle,
  notices,
  onSent,
  onOpenHarnessSettings,
}: {
  blank: BlankConversation;
  /** The locations a session can be started on: those that are connected. */
  locations: LocationConfig[];
  /** The folders the blank conversation's location has sessions in, newest first. */
  recent: readonly RecentFolder[];
  /** The blank conversation's location is connected. */
  connected: boolean;
  follow: number;
  sidebarToggle?: ReactNode;
  /** What is the matter with this page, under its title bar. */
  notices?: ReactNode;
  onSent: () => void;
  /** Navigates directly to Settings → Harness for this location & agent when `agentSetup` is supported. */
  onOpenHarnessSettings?: (locationId: string, agentId: string) => void;
}) {
  const { t, list } = useI18n();
  const store = useAppStore();
  const status = useAppState((s) => s.status[blank.locationId]);
  // Read here so that the page draws again when they come: which agent starts depends on them.
  const agents = useAppState((s) => s.agents[blank.locationId]);
  const allAgents = useMemo(() => agents ?? [], [agents]);
  const agent = store.blankAgent(blank);
  // An agent as the picker names it: one that cannot run says so beside its name.
  const agentChoice = (a: { name: string; available: boolean }) =>
    a.available ? a.name : t("blank.agent.unavailable", { name: a.name });
  const agentChipName = t("composer.setting", {
    setting: t("blank.agent"),
    value: agent === undefined ? t("config.notSet") : agentChoice(agent),
  });
  const [copiedCommand, setCopiedCommand] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  // The location of the blank conversation, connected or not: its name is said when it is away.
  const location =
    useAppState((s) => s.locations.find((h) => h.id === blank.locationId)) ??
    locations.find((h) => h.id === blank.locationId);
  const locationName = location?.name ?? blank.locationId;
  // Where it can be moved to: the connected locations, and its own even while that is away, so that a page whose
  // location dropped can go to another that is up.
  const choices =
    location === undefined || locations.some((h) => h.id === location.id)
      ? locations
      : [location, ...locations];
  const [browsing, setBrowsing] = useState(false);
  const [typing, setTyping] = useState(false);
  const [answering, setAnswering] = useState(false);
  const folderTrigger = useRef<HTMLButtonElement>(null);
  const trustId = useId();
  const agentsHeadingId = useId();
  const agentTrigger = useRef<HTMLButtonElement>(null);
  const [agentMenu, setAgentMenu] = useState(false);
  const answer = async (trusted: boolean | undefined) => {
    setAnswering(true);
    try {
      await store.answerTrust(trusted);
    } finally {
      setAnswering(false);
    }
  };
  const starting = blank.starting !== undefined;
  const noAgent =
    connected && agents !== undefined && agent === undefined && status?.state === "connected";
  const agentUnavailable =
    connected && agent !== undefined && !agent.available && status?.state === "connected";
  // The first message, shown as it will be in the session while the session is being made.
  const shown = useMemo(
    () =>
      blank.starting === undefined
        ? undefined
        : applyUpdate(emptyConversation(), {
            sessionUpdate: "user_message",
            messageId: "starting",
            content: blank.starting,
          } as never),
    [blank.starting],
  );
  const local = location?.kind === "local";
  const canBrowse = connected && (local || status?.capabilities?.folders === true);
  const cwd = blank.cwd.trim();
  // Where the focus goes when the menu or dialog the folder was chosen in closes: with where it runs settled, what is
  // left is the message, so the box; given up, back to the folder's button.
  const chosen = useRef(false);
  const afterChoosing = () => {
    const box = chosen.current ? composerInput() : null;
    chosen.current = false;
    return box ?? folderTrigger.current;
  };
  const choose = (path: string, via: "recent" | "browse" | "typed") => {
    store.changeBlank({ cwd: path });
    store.track("blank_folder_chosen", { via });
    chosen.current = true;
  };
  const browse = async () => {
    if (!local) return setBrowsing(true);
    const path = await store.chooseDirectory();
    if (path === undefined) return;
    // The system's chooser is a window of its own: nothing of the page closes after it to hand the focus on.
    choose(path, "browse");
    chosen.current = false;
    composerInput()?.focus();
  };

  // Where the page starts: the box when the folder is known, else the folder, which is what is missing. Only as the page
  // is opened (what it was opened with), not each time the folder changes.
  const opened = useRef(blank);
  useEffect(() => {
    if (opened.current.starting !== undefined) return;
    if (opened.current.cwd.trim() === "") folderTrigger.current?.focus();
    else composerInput()?.focus();
  }, []);

  // Why it cannot be sent yet, said above the box (once: the box itself keeps its usual words). Empty while what it starts
  // with is still being read, or when the page says why above (no agent or unavailable), which says nothing of its own there.
  const blocked = starting
    ? t("blank.starting")
    : noAgent || agentUnavailable
      ? ""
      : cwd === ""
        ? t("blank.chooseFolder")
        : agent === undefined || blank.config === undefined
          ? ""
          : undefined;
  const placeholder = t("composer.placeholder.idle");
  const folderName = cwd === "" ? t("blank.folder.choose") : baseName(cwd);
  const folderLabel =
    cwd === "" ? t("blank.folder.choose") : t("blank.folder.named", { path: cwd });
  const hero = t("blank.hero");
  // The location is named in the chip when it can be changed or is not this computer; the tip then names it too.
  const showLocation = choices.length > 1 || !local;
  const chipLabel = showLocation ? `${folderLabel} · ${locationName}` : folderLabel;

  // Before the first message the box sits in the middle with where it runs in one line just above it (old-cycle's new
  // session): what is chosen and what is written are one thing. Once it is sent, the message shows as the conversation and
  // the box goes to the foot, where it is in a session.
  const where = (
    <fieldset data-slot="blank-where" disabled={starting} aria-label={t("blank.where")}>
      {/* The agent first: it decides what the rest offers (the box's settings, what can be attached). It reads as the
          folder's and the box's chips do, with the logo the sidebar shows before a session of it. A menu of radio
          choices, as those chips' are. Only when there is a choice to make. */}
      {allAgents.length > 1 ? (
        // Shut while the session is being made: the menu is not in the fieldset, so its disabling does not reach it.
        <Menu
          modal={false}
          open={agentMenu && !starting}
          onOpenChange={(next) => setAgentMenu(next && !starting)}
        >
          <MenuTrigger
            ref={agentTrigger}
            data-variant="ghost"
            data-kind="blank-agent"
            disabled={starting}
            aria-label={agentChipName}
            title={agentChipName}
          >
            {agent !== undefined ? (
              <>
                <span data-slot="blank-agent-logo" aria-hidden="true">
                  <AgentLogo agentId={agent.id} name={agent.name} quiet />
                </span>
                <span data-slot="blank-agent-name">{agentChoice(agent)}</span>
              </>
            ) : (
              <span data-slot="blank-agent-name">{t("blank.agent")}</span>
            )}
          </MenuTrigger>
          <MenuContent
            align="start"
            sideOffset={6}
            collisionPadding={12}
            finalFocus={() => agentTrigger.current}
            aria-labelledby={agentsHeadingId}
            data-kind="setting"
          >
            <MenuRadioGroup
              value={agent?.id ?? null}
              onValueChange={(next) => {
                if (typeof next === "string") store.changeBlank({ agent: next });
              }}
            >
              <MenuGroupLabel id={agentsHeadingId}>{t("blank.agent")}</MenuGroupLabel>
              {allAgents.map((a) => (
                <MenuRadioItem
                  key={a.id}
                  value={a.id}
                  label={a.name}
                  closeOnSelect
                  data-kind="blank-agent"
                >
                  <span data-slot="blank-agent-logo" aria-hidden="true">
                    <AgentLogo agentId={a.id} name={a.name} quiet />
                  </span>
                  <span data-slot="option-name">{agentChoice(a)}</span>
                  <MenuItemIndicator>
                    <CheckIcon size={13} />
                  </MenuItemIndicator>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
      ) : null}
      <Menu
        modal={false}
        onAction={(value) => {
          if (value === "browse") void browse();
          else if (value === "type") setTyping(true);
          else if (typeof value === "string" && value.startsWith("location:"))
            store.changeBlank({ locationId: value.slice("location:".length) });
          else if (typeof value === "string" && value.startsWith("recent:"))
            choose(value.slice("recent:".length), "recent");
        }}
      >
        {/* The tip names it, with the whole path: the button shows only the folder's last part. */}
        <Tip label={chipLabel} shortcut="mod+o">
          <MenuTrigger
            ref={folderTrigger}
            data-variant="ghost"
            data-kind="blank-folder"
            data-unset={cwd === "" || undefined}
            disabled={starting}
            aria-describedby={blank.trust === "undecided" ? trustId : undefined}
          >
            {showLocation ? (
              <>
                <span data-slot="blank-location-name">{locationName}</span>
                <span data-slot="blank-where-dot" aria-hidden="true">
                  /
                </span>
              </>
            ) : null}
            <span data-slot="blank-folder-name">{folderName}</span>
          </MenuTrigger>
        </Tip>
        <MenuContent
          align="start"
          sideOffset={6}
          collisionPadding={12}
          finalFocus={afterChoosing}
          data-kind="blank-folders"
        >
          {choices.length > 1 ? (
            <>
              <MenuGroup>
                <MenuGroupLabel>{t("newSession.location")}</MenuGroupLabel>
                {choices.map((h) => (
                  <MenuItem
                    key={h.id}
                    value={`location:${h.id}`}
                    label={h.name}
                    data-current={h.id === blank.locationId || undefined}
                  >
                    <span data-slot="blank-recent-name">{h.name}</span>
                    {h.id === blank.locationId ? <CheckIcon size={13} aria-hidden="true" /> : null}
                  </MenuItem>
                ))}
              </MenuGroup>
              <MenuSeparator />
            </>
          ) : null}
          {recent.length > 0 ? (
            <MenuGroup>
              <MenuGroupLabel>{t("blank.folder.recent")}</MenuGroupLabel>
              {recent.map((folder) => (
                <MenuItem
                  key={folder.cwd}
                  value={`recent:${folder.cwd}`}
                  label={folder.name}
                  title={folder.cwd}
                  data-kind="blank-recent"
                  data-current={folder.cwd === cwd || undefined}
                >
                  <span data-slot="blank-recent-name">{folder.name}</span>
                  <span data-slot="blank-recent-path">
                    {/* Left to right inside, so that the slashes stay where they are when the start is cut. */}
                    <span dir="ltr">{folder.cwd}</span>
                  </span>
                  {folder.cwd === cwd ? <CheckIcon size={13} aria-hidden="true" /> : null}
                </MenuItem>
              ))}
            </MenuGroup>
          ) : null}
          {recent.length > 0 ? <MenuSeparator /> : null}
          {canBrowse ? <MenuItem value="browse">{t("newSession.browse")}</MenuItem> : null}
          <MenuItem value="type">{t("blank.folder.type")}</MenuItem>
        </MenuContent>
      </Menu>
      {/* Not a stop of its own: the folder's button is described by it, so it is heard with the folder. */}
      {blank.trust === "undecided" ? (
        <span data-slot="blank-trust" id={trustId} title={t("blank.untrusted.hint")}>
          {t("blank.untrusted")}
        </span>
      ) : null}
      <WorktreePicker blank={blank} agentId={agent?.id} disabled={starting || !connected} />
      <EnvironmentPicker
        blank={blank}
        agentId={agent?.id}
        locationName={locationName}
        disabled={starting || !connected}
      />
    </fieldset>
  );
  const box = (
    <Composer
      key={`composer:${BLANK_KEY}`}
      locationId={blank.locationId}
      sessionKey={BLANK_KEY}
      blank
      canAttach={agent?.promptCapabilities?.image != null}
      canAttachFiles={agent?.promptCapabilities?.embeddedContext != null}
      settings={
        agent !== undefined && blank.config !== undefined
          ? {
              schema: agent.configSchema,
              value: { ...defaultsOf(agent.configSchema), ...blank.config },
            }
          : undefined
      }
      onSetting={(key, value) =>
        agent !== undefined && blank.config !== undefined
          ? store.changeBlank({
              config: withEffortFor(
                agent.configSchema,
                { ...blank.config, [key]: value },
                defaultsOf(agent.configSchema),
              ),
            })
          : store.changeBlank({ setting: { key, value } })
      }
      enabled={!starting && !noAgent && !agentUnavailable}
      connected={connected}
      activity="idle"
      blocked={blocked}
      placeholder={placeholder}
      onSent={onSent}
    />
  );
  // What stands between the page and its first message, said once, with the one thing to do about it. Nothing when all
  // is ready: the page is the folder and the box.
  const state = (() => {
    if (status?.state === "reconnecting") return null; // The banner above says so, and it comes back by itself.
    if (status?.state === "connecting")
      return (
        <StateBlock
          tone="loading"
          align="start"
          size="inline"
          title={t("blank.connecting", { location: locationName })}
          body={starting ? undefined : t("blank.draftKept")}
        />
      );
    // That the draft stays is said here; the box does not say it again.
    if (!connected)
      return (
        <StateBlock
          tone="away"
          align="start"
          size="inline"
          title={t("blank.notConnected", { location: locationName })}
          // Only while the box takes words: not while the session is being started.
          body={starting ? undefined : t("blank.draftKept")}
          reason={status?.error}
          action={{
            label: t("location.connectAgain"),
            onAction: () => {
              store.track("blank_connect_pressed", {});
              void store.connectLocation(blank.locationId);
            },
          }}
        />
      );
    if (noAgent) {
      // The agents the location has, none of which can run: named, so it is known what to install or sign in to.
      const listed = (agents ?? []).map((a) => a.name);
      const firstAgent = (agents ?? [])[0];
      const canOpenSettings =
        firstAgent !== undefined &&
        status?.capabilities?.agentSetup === true &&
        onOpenHarnessSettings !== undefined;
      const noAgentHint = t(
        listed.length === 0
          ? "blank.noAgentHint"
          : listed.length === 1
            ? "blank.noAgentHint.one"
            : "blank.noAgentHint.several",
        { location: locationName, agents: list(listed) },
      );
      return (
        <StateBlock
          tone="away"
          align="start"
          size="inline"
          title={t("blank.noAgent", { location: locationName })}
          body={noAgentHint}
          action={{
            label: t("blank.retryAgents"),
            onAction: () => void store.reloadAgents(blank.locationId),
          }}
          secondaryAction={
            canOpenSettings
              ? {
                  label: t("settings.harness.open", { agent: firstAgent.name }),
                  onAction: () => onOpenHarnessSettings(blank.locationId, firstAgent.id),
                }
              : undefined
          }
        />
      );
    }
    if (agentUnavailable && agent !== undefined) {
      const canOpenSettings =
        status?.capabilities?.agentSetup === true && onOpenHarnessSettings !== undefined;
      return (
        <StateBlock
          tone="away"
          align="start"
          size="inline"
          title={t("blank.agentUnavailable", { agent: agent.name, location: locationName })}
          body={
            agent.id === "agy"
              ? t("blank.agentUnavailable.agy", { location: locationName })
              : t("blank.agentUnavailable.body", {
                  agent: agent.name,
                  location: locationName,
                })
          }
          reason={agent.id === "agy" ? AGY_INSTALL_COMMAND : undefined}
          action={{
            label: t("blank.retryAgents"),
            onAction: () => void store.reloadAgents(blank.locationId),
          }}
          secondaryAction={
            canOpenSettings
              ? {
                  label: t("settings.harness.open", { agent: agent.name }),
                  onAction: () => onOpenHarnessSettings(blank.locationId, agent.id),
                }
              : undefined
          }
        />
      );
    }
    if (blank.authRequired !== undefined) {
      const { agentId, agentName } = blank.authRequired;
      const command = `cycle login ${agentId}`;
      const canOpenSettings =
        status?.capabilities?.agentSetup === true && onOpenHarnessSettings !== undefined;
      return (
        <StateBlock
          tone="away"
          align="start"
          size="inline"
          title={t("blank.authRequired", { agent: agentName, location: locationName })}
          body={t("blank.authRequired.body", { location: locationName })}
          reason={command}
          action={{
            label: copiedCommand ? t("blank.copied") : t("blank.copyCommand"),
            onAction: () => {
              void store.copyText(command).then((done) => {
                if (!done) return;
                store.track("agent_setup_command_copied", {
                  agent: agentWord(agentId),
                  kind: "login",
                });
                setCopiedCommand(true);
                clearTimeout(copiedTimer.current);
                copiedTimer.current = setTimeout(() => setCopiedCommand(false), 1500);
              });
            },
          }}
          secondaryAction={
            canOpenSettings
              ? {
                  label: t("settings.harness.open", { agent: agentName }),
                  onAction: () => onOpenHarnessSettings(blank.locationId, agentId),
                }
              : undefined
          }
        />
      );
    }
    if (blank.unreadable === true)
      return (
        <StateBlock
          tone="error"
          align="start"
          size="inline"
          title={t("blank.unreadable")}
          action={{ label: t("blank.retry"), onAction: store.retryBlank }}
        />
      );
    return null;
  })();
  return (
    <>
      <header data-slot="session-header">
        {sidebarToggle}
        <div data-slot="session-heading">
          <h1>{t("blank.title")}</h1>
        </div>
      </header>
      {notices}
      {/* One tree before and after the first message is sent, so the box and the choices keep their focus and state when a
          start fails and they come back: only the stage's layout changes (data-starting). */}
      <div data-slot="blank-stage" data-starting={shown !== undefined || undefined}>
        {shown !== undefined ? (
          <ConversationView
            sessionKey={BLANK_KEY}
            follow={follow}
            conversation={shown}
            loading={false}
            awaitingApproval={false}
          />
        ) : state !== null ? (
          <div data-slot="blank-lead">{state}</div>
        ) : null}
        {shown === undefined ? <h2 data-slot="blank-hero">{hero}</h2> : null}
        {where}
        {box}
      </div>
      {/* A folder nobody has decided on: asked when the first message goes, before anything of the folder's own runs. */}
      <Dialog
        open={blank.asking !== undefined}
        onOpenChange={(open) => {
          if (!open && !answering) void answer(undefined);
        }}
      >
        <DialogBackdrop />
        <DialogContent>
          <DialogTitle>{t("trust.title")}</DialogTitle>
          <DialogDescription>
            {t("trust.description", { location: location?.name ?? "" })}
          </DialogDescription>
          {blank.asking !== undefined ? (
            <code data-slot="decision-path">{blank.asking.path}</code>
          ) : null}
          {blank.asking?.failed !== undefined ? (
            <p data-slot="hint" role="alert">
              {t("trust.failed", { reason: blank.asking.failed })}
            </p>
          ) : null}
          <div data-slot="row" data-dialog-footer="">
            <Button
              data-variant="ghost"
              disabled={answering}
              onClick={() => void answer(undefined)}
            >
              {t("trust.back")}
            </Button>
            <Button data-variant="outline" disabled={answering} onClick={() => void answer(false)}>
              {t("trust.startUntrusted")}
            </Button>
            <Button data-variant="solid" disabled={answering} onClick={() => void answer(true)}>
              {t("trust.startTrusted")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={typing} onOpenChange={setTyping}>
        <DialogBackdrop />
        <DialogContent finalFocus={afterChoosing}>
          <DialogTitle>{t("blank.folder.typeTitle")}</DialogTitle>
          <DialogDescription>
            {t("blank.folder.typeLead", { location: locationName })}
          </DialogDescription>
          {typing ? (
            <PathForm
              start={cwd}
              onCancel={() => setTyping(false)}
              onChoose={(path) => {
                setTyping(false);
                choose(path, "typed");
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog open={browsing} onOpenChange={setBrowsing}>
        <DialogBackdrop />
        <DialogContent finalFocus={afterChoosing}>
          <DialogTitle>{t("folders.title")}</DialogTitle>
          {browsing ? (
            <FolderBrowser
              start={cwd.startsWith("/") ? cwd : undefined}
              list={(path, hidden) => store.listFolders(blank.locationId, path, hidden)}
              onChoose={(path) => {
                setBrowsing(false);
                choose(path, "browse");
              }}
              onBack={() => setBrowsing(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A folder by its path, typed: a form, so Enter uses it, with the path field focused. */
function PathForm({
  start,
  onChoose,
  onCancel,
}: {
  start: string;
  onChoose: (path: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [path, setPath] = useState(start);
  const typed = path.trim();
  return (
    <form
      data-slot="form"
      onSubmit={(event) => {
        event.preventDefault();
        if (typed !== "") onChoose(typed);
      }}
    >
      <Field name="cwd">
        <FieldLabel>{t("blank.folder")}</FieldLabel>
        <Input
          autoFocus
          value={path}
          placeholder={t("blank.folder.placeholder")}
          spellCheck={false}
          onChange={(event) => setPath(event.currentTarget.value)}
        />
      </Field>
      <div data-slot="row" data-dialog-footer="">
        <Button type="button" data-variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" data-variant="solid" disabled={typed === ""}>
          {t("blank.folder.use")}
        </Button>
      </div>
    </form>
  );
}
