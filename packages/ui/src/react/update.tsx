import { Button } from "@ui-sdk/react/button";
import { useState } from "react";
import type { SessionSummary, UpdateState } from "../api.ts";
import type { Translator } from "../i18n.ts";
import { AppNotice } from "./app-notice.tsx";
import { ConfirmDialog } from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import { DownloadIcon, ErrorCircleIcon, RefreshIcon, SettingsIcon, WarningIcon } from "./icons.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";

/** Whole megabytes, and tenths while the whole is small (an update that changed a little). */
const megabytes = (bytes: number, total: number): string =>
  (bytes / 1e6).toFixed(total < 10e6 ? 1 : 0);

/** What the update is doing, in a few words, or nothing when there is nothing to say. */
export const updateLine = (update: UpdateState, t: Translator["t"]): string => {
  switch (update.kind) {
    case "checking":
      return t("update.checking");
    case "up-to-date":
      return t("update.upToDate");
    case "available":
      return t("update.available", { version: update.version });
    case "downloading":
      return t(update.how === "difference" ? "update.downloadingChanges" : "update.downloading", {
        version: update.version,
        received: megabytes(update.received, update.total),
        total: megabytes(update.total, update.total),
      });
    case "installing":
      return t("update.installing", { version: update.version });
    case "error":
      return update.message;
    case "disabled":
      return update.reason;
    case "idle":
      return "";
  }
};

/** In the sidebar's notices when there is something to do about the update, or it is under way. */
export function UpdateNotice() {
  const store = useAppStore();
  const { t } = useI18n();
  const update = useAppState((s) => s.update);
  const [confirming, setConfirming] = useState(false);
  const [dismissed, setDismissed] = useState<string | undefined>(undefined);
  if (update === undefined || !updateNoticed(update)) return null;
  const busy = update.kind === "downloading" || update.kind === "installing";
  const failedInstall = update.kind === "error";
  const version = versionOf(update);
  if (update.kind === "available" && dismissed === version) return null;
  let icon = <DownloadIcon />;
  if (busy) icon = <RefreshIcon />;
  if (failedInstall) icon = <ErrorCircleIcon />;
  return (
    <>
      <AppNotice
        tone={failedInstall ? "error" : "info"}
        busy={busy}
        icon={icon}
        text={
          failedInstall
            ? t("update.failed", { version, reason: updateLine(update, t) })
            : updateLine(update, t)
        }
        {...(update.kind === "available"
          ? { onDismiss: () => setDismissed(version), dismissLabel: t("update.dismiss") }
          : {})}
        actions={
          busy ? null : (
            <Button data-variant="outline" onClick={() => setConfirming(true)}>
              {t(failedInstall ? "update.tryAgain" : "update.install")}
            </Button>
          )
        }
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("update.confirmTitle", { version })}
        description={t("update.confirmDescription")}
        confirmLabel={t("update.install")}
        onConfirm={() => store.installUpdate()}
      />
    </>
  );
}

/** The version an update in the notices is about. */
const versionOf = (update: UpdateState): string =>
  "version" in update && typeof update.version === "string" ? update.version : "";

/** Whether the update has something to say in the notices: to install, under way, or an install that failed. */
export const updateNoticed = (update: UpdateState): boolean =>
  update.kind === "available" ||
  update.kind === "downloading" ||
  update.kind === "installing" ||
  (update.kind === "error" && update.version !== undefined);

/**
 * The sessions an update would interrupt: a turn running or waiting on the person, or background tasks (the same
 * test `cycle stop` makes, docs/daemon.md "停止和升级").
 */
export const workingSessions = (
  sessions: readonly SessionSummary[] | undefined,
): SessionSummary[] =>
  (sessions ?? []).filter(
    (s) => s.state === "running" || s.state === "requires_action" || (s.background ?? 0) > 0,
  );

/**
 * An environment whose daemon this app cannot use, or that is too old and can be updated over ssh. When that cannot be
 * done the card says why and the command is there to run by hand. When sessions there are working, the confirmation
 * names them first, and the person chooses to wait for them or to interrupt them.
 */
export function DaemonNotice({ environmentId }: { environmentId: string }) {
  const store = useAppStore();
  const { t } = useI18n();
  const daemon = useAppState((s) => s.status[environmentId]?.daemon);
  const name = useAppState((s) => s.environments.find((e) => e.id === environmentId)?.name);
  const incompatible = useAppState((s) => s.status[environmentId]?.incompatible);
  const sessions = useAppState((s) => s.sessions[environmentId]);
  const [confirming, setConfirming] = useState(false);
  const upgrade = daemon?.upgrade;
  const environment = name ?? environmentId;
  if (incompatible !== undefined) {
    // The daemon speaks another protocol: nothing is connected, so there is no version to show, only why and what to do.
    const said = {
      environment,
      supported: incompatible.supported.join(", "),
      requested: incompatible.requested,
    };
    return (
      <AppNotice
        tone="error"
        icon={<ErrorCircleIcon />}
        text={t(
          incompatible.with === "daemon"
            ? "daemon.protocolOlder"
            : incompatible.with === "app"
              ? "daemon.protocolNewer"
              : "daemon.protocolOther",
          said,
        )}
        command={incompatible.command}
        commandLabel={t("daemon.byHand", { environment })}
      />
    );
  }
  if (daemon === undefined || upgrade === undefined) return null;
  const failed = upgrade.error !== undefined;
  const waiting = upgrade.waiting === true && !failed;
  const working = workingSessions(sessions);
  const named = working.map((s) => s.title || t("daemon.untitled")).join(", ");
  return (
    <>
      <AppNotice
        tone={failed ? "error" : "warning"}
        busy={upgrade.running === true}
        icon={
          failed ? (
            <ErrorCircleIcon />
          ) : upgrade.running === true ? (
            <RefreshIcon />
          ) : (
            <WarningIcon />
          )
        }
        text={
          failed
            ? t("daemon.failed", { environment, error: upgrade.error ?? "" })
            : waiting
              ? t("daemon.waiting", { environment, to: upgrade.to })
              : t("daemon.tooOld", { environment, version: daemon.version })
        }
        command={failed ? upgrade.command : undefined}
        commandLabel={t("daemon.byHand", { environment })}
        actions={
          <Button
            data-variant="outline"
            disabled={upgrade.running === true}
            onClick={() => setConfirming(true)}
          >
            {upgrade.running === true
              ? t("daemon.updating")
              : failed
                ? t("daemon.tryAgain")
                : waiting
                  ? t("daemon.updateNow")
                  : t("daemon.update", { to: upgrade.to })}
          </Button>
        }
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("daemon.confirmTitle", { environment, to: upgrade.to })}
        description={
          working.length > 0
            ? t("daemon.confirmBusy", { sessions: named })
            : t("daemon.confirmBody", { environment })
        }
        {...(working.length > 0
          ? waiting
            ? {
                // Already waiting for them: what is left to choose is to stop waiting.
                confirmLabel: t("daemon.confirmNow"),
                destructive: true,
                onConfirm: () => store.upgradeDaemon(environmentId, "now"),
              }
            : {
                confirmLabel: t("daemon.confirmLater"),
                onConfirm: () => store.upgradeDaemon(environmentId, "later"),
                alternative: {
                  label: t("daemon.confirmNow"),
                  destructive: true,
                  onConfirm: () => store.upgradeDaemon(environmentId, "now"),
                },
              }
          : {
              confirmLabel: t("daemon.confirm"),
              // Nothing working any more while it waited: an update now interrupts nothing.
              onConfirm: () => store.upgradeDaemon(environmentId, waiting ? "now" : undefined),
            })}
      />
    </>
  );
}

/**
 * The foot of the sidebar: which version this is, what the update is doing, and the way into Settings. One quiet row:
 * these are used rarely and must not take room from the list.
 */
export function UpdateFooter({ onSettings }: { onSettings: () => void }) {
  const { t } = useI18n();
  const update = useAppState((s) => s.update);
  // What the notice above already says is not said twice.
  const line = update === undefined || updateNoticed(update) ? "" : updateLine(update, t);
  return (
    <div data-slot="update-footer">
      <div data-slot="update-text">
        {update !== undefined ? (
          <span data-slot="hint">{t("update.current", { version: update.current })}</span>
        ) : null}
        {line !== "" ? (
          <span data-slot="hint" data-update={update?.kind} role="status" title={line}>
            {line}
          </span>
        ) : null}
      </div>
      <Tip label={t("settings.open")} shortcut="mod+,">
        <Button data-variant="ghost" data-kind="settings-open" onClick={onSettings}>
          <SettingsIcon />
        </Button>
      </Tip>
    </div>
  );
}
