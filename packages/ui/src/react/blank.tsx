// A new session before its first message (docs/protocol.md §6): where it runs and with which agent are chosen here, the
// first message is written in the box below, and sending it is what makes the session. Until then nothing of it is in
// the daemon, and so nothing of it is in the sidebar.
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
  MenuSeparator,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import type { EnvironmentConfig } from "../api.ts";
import { applyUpdate, emptyConversation } from "../model/index.ts";
import { BLANK_KEY, type BlankConversation } from "../store/index.ts";
import { Composer, composerInput } from "./composer.tsx";
import { propertiesOf, withEffortFor } from "./config-form.tsx";
import { ConversationView } from "./conversation.tsx";
import { FolderBrowser } from "./folder-browser.tsx";
import { useI18n } from "./i18n.tsx";
import { CheckIcon } from "./icons.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";

/** A folder offered on the blank page: one the environment already has sessions in, newest first. */
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
  environments,
  recent,
  connected,
  follow,
  sidebarToggle,
  onSent,
}: {
  blank: BlankConversation;
  /** The environments a session can be started on: those that are connected. */
  environments: EnvironmentConfig[];
  /** The folders the blank conversation's environment has sessions in, newest first. */
  recent: readonly RecentFolder[];
  /** The blank conversation's environment is connected. */
  connected: boolean;
  follow: number;
  sidebarToggle?: ReactNode;
  onSent: () => void;
}) {
  const { t, list } = useI18n();
  const store = useAppStore();
  const status = useAppState((s) => s.status[blank.environmentId]);
  // Read here so that the page draws again when they come: which agent starts depends on them.
  const agents = useAppState((s) => s.agents[blank.environmentId]);
  const available = useMemo(() => (agents ?? []).filter((a) => a.available), [agents]);
  const agent = store.blankAgent(blank);
  // The environment of the blank conversation, connected or not: its name is said when it is away.
  const environment =
    useAppState((s) => s.environments.find((h) => h.id === blank.environmentId)) ??
    environments.find((h) => h.id === blank.environmentId);
  const environmentName = environment?.name ?? blank.environmentId;
  // Where it can be moved to: the connected environments, and its own even while that is away, so that a page whose
  // environment dropped can go to another that is up.
  const choices =
    environment === undefined || environments.some((h) => h.id === environment.id)
      ? environments
      : [environment, ...environments];
  const [browsing, setBrowsing] = useState(false);
  const [typing, setTyping] = useState(false);
  const [answering, setAnswering] = useState(false);
  const folderTrigger = useRef<HTMLButtonElement>(null);
  const trustId = useId();
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
  const local = environment?.kind === "local";
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
  // with is still being read, or when the page says why above (no agent), which says nothing of its own there.
  const blocked = starting
    ? t("blank.starting")
    : noAgent
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
  // The environment is named in the chip when it can be changed or is not this computer; the tip then names it too.
  const showEnvironment = choices.length > 1 || !local;
  const chipLabel = showEnvironment ? `${folderLabel} · ${environmentName}` : folderLabel;

  // Before the first message the box sits in the middle with where it runs in one line just above it (old-cycle's new
  // session): what is chosen and what is written are one thing. Once it is sent, the message shows as the conversation and
  // the box goes to the foot, where it is in a session.
  const where = (
    <fieldset data-slot="blank-where" disabled={starting} aria-label={t("blank.where")}>
      <Menu
        modal={false}
        onAction={(value) => {
          if (value === "browse") void browse();
          else if (value === "type") setTyping(true);
          else if (typeof value === "string" && value.startsWith("environment:"))
            store.changeBlank({ environmentId: value.slice("environment:".length) });
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
            {showEnvironment ? (
              <>
                <span data-slot="blank-environment-name">{environmentName}</span>
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
                <MenuGroupLabel>{t("newSession.environment")}</MenuGroupLabel>
                {choices.map((h) => (
                  <MenuItem
                    key={h.id}
                    value={`environment:${h.id}`}
                    label={h.name}
                    data-current={h.id === blank.environmentId || undefined}
                  >
                    <span data-slot="blank-recent-name">{h.name}</span>
                    {h.id === blank.environmentId ? (
                      <CheckIcon size={13} aria-hidden="true" />
                    ) : null}
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
      {available.length > 1 ? (
        <Select
          items={available.map((a) => ({ value: a.id, label: a.name }))}
          value={agent?.id ?? null}
          onValueChange={(next) => {
            if (typeof next === "string") store.changeBlank({ agent: next });
          }}
        >
          <SelectTrigger data-kind="blank-agent" aria-label={t("blank.agent")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {available.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </fieldset>
  );
  const box = (
    <Composer
      key={`composer:${BLANK_KEY}`}
      environmentId={blank.environmentId}
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
      enabled={!starting && !noAgent}
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
          title={t("blank.connecting", { environment: environmentName })}
        />
      );
    // That the draft stays is said once, by the box (composer.offline).
    if (!connected)
      return (
        <StateBlock
          tone="away"
          align="start"
          size="inline"
          title={t("blank.notConnected", { environment: environmentName })}
          reason={status?.error}
          action={{
            label: t("environment.connectAgain"),
            onAction: () => {
              store.track("blank_connect_pressed", {});
              void store.connectEnvironment(blank.environmentId);
            },
          }}
        />
      );
    if (noAgent) {
      // The agents the environment has, none of which can run: named, so it is known what to install or sign in to.
      const listed = (agents ?? []).map((a) => a.name);
      const noAgentHint = t(
        listed.length === 0
          ? "blank.noAgentHint"
          : listed.length === 1
            ? "blank.noAgentHint.one"
            : "blank.noAgentHint.several",
        { environment: environmentName, agents: list(listed) },
      );
      return (
        <StateBlock
          tone="away"
          align="start"
          size="inline"
          title={t("blank.noAgent", { environment: environmentName })}
          body={noAgentHint}
          action={{
            label: t("blank.retryAgents"),
            onAction: () => void store.reloadAgents(blank.environmentId),
          }}
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
            {t("trust.description", { environment: environment?.name ?? "" })}
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
            {t("blank.folder.typeLead", { environment: environmentName })}
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
              list={(path, hidden) => store.listFolders(blank.environmentId, path, hidden)}
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
