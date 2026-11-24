import { Button } from "@ui-sdk/react/button";
import type { ReactNode } from "react";
import type { AppState } from "../store/index.ts";
import { useI18n } from "./i18n.tsx";
import { CloseIcon, ErrorCircleIcon, RefreshIcon, WarningIcon } from "./icons.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";

/**
 * One line under a title bar about what that page shows: an icon, what is the matter, and what can be done about it.
 * Amber for what is in the way but passes or can be fixed from here, red for what failed. What concerns the whole app
 * (an update, a daemon too old) is not said here.
 */
export function NoticeLine({
  tone,
  icon,
  text,
  busy = false,
  action,
  onDismiss,
}: {
  tone: "warning" | "error";
  icon: ReactNode;
  text: string;
  /** Something is under way (connecting): the icon turns, and nothing is to be pressed. */
  busy?: boolean;
  action?: { label: string; onAction: () => void } | undefined;
  onDismiss?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  return (
    <div
      data-slot="notice-line"
      data-tone={tone}
      data-busy={busy || undefined}
      role={tone === "error" ? "alert" : "status"}
    >
      {icon}
      {/* One line, fading out where it does not fit: its own words in full on hover. */}
      <span data-slot="notice-text" title={text}>
        {text}
      </span>
      {action !== undefined ? (
        <Button data-variant="ghost" data-kind="notice-action" onClick={action.onAction}>
          {action.label}
        </Button>
      ) : null}
      {onDismiss !== undefined ? (
        <Tip label={t("banner.dismiss")} side="bottom">
          <Button data-variant="ghost" data-kind="notice-dismiss" onClick={onDismiss}>
            <CloseIcon />
          </Button>
        </Tip>
      ) : null}
    </div>
  );
}

/** What the store says failed, in words: its own, or the app's. */
export const errorText = (
  error: NonNullable<AppState["error"]>,
  t: ReturnType<typeof useI18n>["t"],
): string => (typeof error === "string" ? error : t(error.key, error.params));

/**
 * What is the matter with the page under this title bar: what was just done failed (`error`, when this page is where
 * it is said), or the location the open session runs on is reconnecting or not connected. Nothing when all is well.
 */
export function SessionNotices({
  locationId,
  shows,
  errors = true,
}: {
  /** The location of what the page shows. */
  locationId: string | undefined;
  /**
   * What the page shows. A session's conversation is what it had when its location went away, so that is said; with
   * nothing open, the page itself says how the location's connection stands, and the line does not say it again.
   */
  shows: "session" | "blank" | "nothing";
  /** Whether what failed is said here; not while a page over the app says it itself. */
  errors?: boolean;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const error = useAppState((s) => s.error);
  const status = useAppState((s) => (locationId === undefined ? undefined : s.status[locationId]));
  const name = useAppState(
    (s) => s.locations.find((e) => e.id === locationId)?.name ?? locationId ?? "",
  );
  // A location with no status yet is not connected, as the sidebar has it.
  const state = status?.state ?? "closed";
  const reason = status?.error;
  // A daemon that speaks another protocol says so itself, and connecting again would not change it.
  const incompatible = status?.incompatible !== undefined;
  const lines: ReactNode[] = [];
  // The box under the page says nothing of it: that the draft is kept is said once, here, whatever the reason.
  // A reason in the system's own words may end without a stop: one goes before the next sentence.
  const kept = (said: string): string =>
    `${/[.。…!?！？]$/.test(said) ? said : `${said}.`} ${t("notice.draftKept")}`;
  if (errors && error !== undefined)
    lines.push(
      <NoticeLine
        key="error"
        tone="error"
        icon={<ErrorCircleIcon />}
        text={errorText(error, t)}
        onDismiss={store.dismissError}
      />,
    );
  const open = shows === "session";
  if (shows !== "nothing" && state === "reconnecting" && !incompatible)
    lines.push(
      <NoticeLine
        key="location"
        tone="warning"
        busy
        icon={<RefreshIcon />}
        text={kept(t("location.reconnectingBanner"))}
      />,
    );
  else if (open && state === "connecting" && !incompatible)
    lines.push(
      <NoticeLine
        key="location"
        tone="warning"
        busy
        icon={<RefreshIcon />}
        text={kept(t("notice.connecting", { location: name }))}
      />,
    );
  else if (
    open &&
    locationId !== undefined &&
    (state === "closed" || (incompatible && state !== "connected"))
  )
    lines.push(
      <NoticeLine
        key="location"
        tone="warning"
        icon={<WarningIcon />}
        text={kept(
          incompatible
            ? t("session.awayIncompatible", { location: name })
            : reason !== undefined
              ? t("session.awayBecause", { location: name, reason })
              : t("session.awayBanner", { location: name }),
        )}
        action={
          incompatible
            ? undefined
            : {
                label: t("location.connectAgain"),
                onAction: () => {
                  store.track("session_connect_pressed", {});
                  void store.connectLocation(locationId);
                },
              }
        }
      />,
    );
  if (lines.length === 0) return null;
  return <div data-slot="notice-stack">{lines}</div>;
}
