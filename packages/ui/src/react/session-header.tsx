import { Button } from "@ui-sdk/react/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@ui-sdk/react/menu";
import type { SessionSummary } from "../api.ts";
import { sessionKey } from "../sessions.ts";
import type { SessionPanel } from "./app-layout.ts";
import { EnvironmentActions } from "./environments.tsx";
import { useI18n } from "./i18n.tsx";
import { MoreIcon, PanelIcon } from "./icons.tsx";
import { SessionHeading } from "./rename-field.tsx";
import { SessionCopyMenu } from "./session-copy-menu.tsx";
import { ShellTitle, ShellTools } from "./shell.tsx";
import { FIRST_SIZE } from "./side-panel.tsx";
import { sessionTitle } from "./sidebar.tsx";
import { useAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";

/**
 * The open session's title bar: its title (renamed in place), its menu, and the button of its right panel. The
 * panel's tabs are in the panel's own strip, not here: one place to choose what it shows.
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
          <Tip
            label={t(panel.sidePanel?.open === true ? "panel.hide" : "panel.show")}
            shortcut="mod+\\"
            side="bottom"
          >
            <Button
              data-variant="ghost"
              data-kind="panel-toggle"
              data-active={panel.sidePanel?.open === true || undefined}
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
