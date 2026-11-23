import { Button } from "@ui-sdk/react/button";
import type { ReactNode } from "react";
import { useI18n } from "./i18n.tsx";
import { CloseIcon } from "./icons.tsx";
import { Tip } from "./tip.tsx";

/**
 * Something about the whole app, not the page: an update, a daemon this app cannot use or that wants updating, the
 * account, what is counted. A small card at the foot of the sidebar, over its footer: the icon in its tone, what is the
 * matter in a few lines, then what can be done. What is about the open session is said under its title (notice-line.tsx).
 */
export function AppNotice({
  tone,
  icon,
  text,
  busy = false,
  command,
  commandLabel,
  actions,
  onDismiss,
  dismissLabel,
}: {
  tone: "info" | "warning" | "error";
  icon?: ReactNode;
  text: string;
  /** Under way (downloading, installing): the icon turns. */
  busy?: boolean;
  /** A command to run by hand, shown whole and selected with one click. */
  command?: string | undefined;
  /** What the command is for, as its title. */
  commandLabel?: string | undefined;
  /** Buttons, the one that does it last. */
  actions?: ReactNode;
  onDismiss?: (() => void) | undefined;
  /** The close button's name: "Dismiss" unless putting it off has a better word ("Later"). */
  dismissLabel?: string | undefined;
}) {
  const { t } = useI18n();
  return (
    <section
      data-slot="app-notice"
      data-tone={tone}
      data-busy={busy || undefined}
      role={tone === "error" ? "alert" : "status"}
    >
      <div data-slot="app-notice-head">
        {icon}
        <p data-slot="app-notice-text" title={text}>
          {text}
        </p>
        {onDismiss !== undefined ? (
          <Tip label={dismissLabel ?? t("banner.dismiss")} side="top">
            <Button data-variant="ghost" data-kind="notice-dismiss" onClick={onDismiss}>
              <CloseIcon />
            </Button>
          </Tip>
        ) : null}
      </div>
      {command !== undefined ? (
        <code data-slot="command" title={commandLabel}>
          {command}
        </code>
      ) : null}
      {actions !== undefined && actions !== null ? (
        <div data-slot="app-notice-actions">{actions}</div>
      ) : null}
    </section>
  );
}
