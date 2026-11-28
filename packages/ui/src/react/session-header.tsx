import { Button } from "@ui-sdk/react/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@ui-sdk/react/menu";
import type { SessionSummary } from "../api.ts";
import { sessionKey } from "../sessions.ts";
import type { SessionPanel } from "./app-layout.ts";
import { EnvironmentActions } from "./environments.tsx";
import { useI18n } from "./i18n.tsx";
import { DiffIcon, FolderIcon, MoreIcon, OverviewIcon, PanelIcon, TerminalIcon } from "./icons.tsx";
import { SessionHeading } from "./rename-field.tsx";
import { SessionCopyMenu } from "./session-copy-menu.tsx";
import { ShellTitle, ShellTools } from "./shell.tsx";
import { FIRST_SIZE } from "./side-panel.tsx";
import { sessionTitle } from "./sidebar.tsx";
import { useAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";

/**
 * The open session's title bar: its title (renamed in place), its menu, and the buttons of its right panel's tabs.
 */
export function SessionHeader({
  session,
  renaming,
  onRenaming,
  pinned,
  onPin,
  onSettings,
  onDelete,
  panel,
}: {
  session: SessionSummary;
  renaming: boolean;
  onRenaming: (renaming: boolean) => void;
  pinned: boolean;
  onPin: (pinned: boolean) => void;
  onSettings: () => void;
  onDelete: () => void;
  panel: SessionPanel;
}) {
  const store = useAppStore();
  const { t } = useI18n();
  const overviewShown = panel.shows("overview");
  const filesShown = panel.shows("files");
  const diffShown = panel.shows("diff");
  return (
    <>
      <ShellTitle>
        <SessionHeading
          key={sessionKey(session)}
          session={session}
          title={sessionTitle(session)}
          editing={renaming}
          onEditingChange={onRenaming}
        />
      </ShellTitle>
      <ShellTools>
        <div data-slot="row">
          <EnvironmentActions
            locationId={session.locationId}
            environment={session.environment}
            onRun={(actionId) =>
              void store.runEnvironmentAction(
                session.locationId,
                session.sessionId,
                actionId,
                FIRST_SIZE,
              )
            }
          />
          <Menu
            onAction={(value) => {
              if (value === "rename") onRenaming(true);
              else if (value === "pin" || value === "unpin") onPin(value === "pin");
              else if (value === "dismiss-background") void store.dismissBackground(session);
              else if (value === "settings") onSettings();
              else if (value === "archive")
                void store.archiveSession(session.sessionId, !session.archived);
              else if (value === "delete") onDelete();
            }}
          >
            <Tip label={t("session.actions")} side="bottom">
              <MenuTrigger data-variant="ghost" data-kind="session-more">
                <MoreIcon />
              </MenuTrigger>
            </Tip>
            <MenuContent>
              {session.unknownBackground?.length ? (
                <MenuItem value="dismiss-background">
                  {t("session.dismissBackground", {
                    count: session.unknownBackground.length,
                  })}
                </MenuItem>
              ) : null}
              <MenuItem value={pinned ? "unpin" : "pin"}>
                {t(pinned ? "session.unpin" : "session.pin")}
              </MenuItem>
              <MenuItem value="rename">{t("session.rename")}</MenuItem>
              <SessionCopyMenu session={session} />
              <MenuItem value="settings">{t("session.settings")}</MenuItem>
              <MenuItem value="archive">
                {t(session.archived ? "session.restore" : "session.archive")}
              </MenuItem>
              <MenuSeparator />
              <MenuItem value="delete" data-destructive>
                {t("session.delete")}
              </MenuItem>
            </MenuContent>
          </Menu>
          <Tip label={t(overviewShown ? "overview.hide" : "overview.show")} side="bottom">
            <Button
              data-variant="ghost"
              data-kind="panel-toggle"
              data-active={overviewShown || undefined}
              onClick={() => panel.toggleTab("overview")}
            >
              <OverviewIcon />
            </Button>
          </Tip>
          {panel.canShowFiles ? (
            <Tip label={t(filesShown ? "files.hide" : "files.show")} side="bottom">
              <Button
                data-variant="ghost"
                data-kind="panel-toggle"
                data-active={filesShown || undefined}
                onClick={() => panel.toggleTab("files")}
              >
                <FolderIcon />
              </Button>
            </Tip>
          ) : null}
          {/* Diff needs no daemon: this session's edits are in its conversation. */}
          <Tip label={t(diffShown ? "diff.hide" : "diff.show")} side="bottom">
            <Button
              data-variant="ghost"
              data-kind="panel-toggle"
              data-active={diffShown || undefined}
              onClick={() => panel.toggleTab("diff")}
            >
              <DiffIcon />
            </Button>
          </Tip>
          {panel.canOpenTerminals ? (
            <Tip label={t(panel.terminalShown ? "terminal.hide" : "terminal.show")} side="bottom">
              <Button
                data-variant="ghost"
                data-kind="panel-toggle"
                data-active={panel.terminalShown || undefined}
                disabled={!panel.terminalsConnected && !panel.hasTerminals}
                onClick={() => void panel.toggleTerminal()}
              >
                <TerminalIcon />
              </Button>
            </Tip>
          ) : null}
          <Tip
            label={t(panel.sidePanel?.open === true ? "panel.hide" : "panel.show")}
            shortcut="mod+\\"
            side="bottom"
          >
            <Button
              data-variant="ghost"
              data-kind="panel-toggle"
              onClick={() => panel.toggleSidePanel("click")}
            >
              <PanelIcon />
            </Button>
          </Tip>
        </div>
      </ShellTools>
    </>
  );
}
