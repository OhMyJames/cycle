// The person's Cycle account in the page (.agents/notes/2026-11-23-sso-login-desktop-must-sign-in.md): the sign-in page that is all there is until
// they sign in, the notice in the sidebar when the login cannot be renewed, and the account's group in Settings. The
// page is told how the login stands and who it is; never a token.
import { Button } from "@ui-sdk/react/button";
import { useState } from "react";
import type { AccountStatus } from "../api.ts";
import type { MessageKey } from "../messages/en-US.ts";
import { AppNotice } from "./app-notice.tsx";
import { ConfirmDialog } from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import { CheckIcon, ErrorCircleIcon, RefreshIcon, WarningIcon } from "./icons.tsx";
import { PageGroup, PageRow, PageRows } from "./page-layout.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";

/** Why the page says what it says, before the button: an ended login, or what went wrong the last time. */
const noteOf = (account: AccountStatus): MessageKey | undefined => {
  if (account.problem === "unreachable") return "account.unreachable";
  if (account.problem === "failed") return "account.failed";
  if (account.reason === "expired") return "account.expired";
  if (account.reason === "revoked") return "account.revoked";
  return undefined;
};

/** The whole window while nobody is signed in: one action, what it does, and what it leaves as it is. */
export function SignInPage({ account }: { account: AccountStatus }) {
  const store = useAppStore();
  const { t } = useI18n();
  const note = noteOf(account);
  const failed = account.problem !== undefined;
  return (
    <div data-slot="sign-in">
      <div data-slot="titlebar" />
      <section data-slot="sign-in-card" aria-labelledby="sign-in-title">
        <h1 id="sign-in-title" data-slot="sign-in-title">
          {t("account.title")}
        </h1>
        <p data-slot="sign-in-body">{t("account.body")}</p>
        {note !== undefined && !account.signingIn ? (
          <p data-slot="sign-in-note" data-tone={failed ? "error" : "warning"} role="alert">
            {failed ? <ErrorCircleIcon aria-hidden="true" /> : <WarningIcon aria-hidden="true" />}
            <span>{t(note)}</span>
          </p>
        ) : null}
        {account.signingIn ? (
          <div data-slot="sign-in-waiting" role="status">
            <span data-slot="spinner" aria-hidden="true" />
            <span>{t("account.waiting")}</span>
            <Button data-variant="ghost" onClick={() => void store.cancelSignIn()}>
              {t("account.stopWaiting")}
            </Button>
          </div>
        ) : (
          // The one thing to do here: it has the focus when the page opens.
          <Button data-variant="solid" autoFocus onClick={() => void store.signIn()}>
            {t("account.signIn")}
          </Button>
        )}
        <p data-slot="sign-in-kept">{t("account.kept")}</p>
      </section>
    </div>
  );
}

/**
 * In the sidebar's notices, while the app is open: the provider cannot be reached (offline, within the grace), it
 * refused the login (sign in again, nothing stops), or someone else has just signed in.
 */
export function AccountNotice() {
  const store = useAppStore();
  const { t } = useI18n();
  const account = useAppState((s) => s.account);
  const seen = useAppState((s) => s.switchNoticeSeen);
  if (account === undefined || !account.open) return null;
  if (account.state === "reauth")
    return (
      <AppNotice
        tone="warning"
        busy={account.signingIn}
        icon={account.signingIn ? <RefreshIcon /> : <WarningIcon />}
        text={
          account.signingIn
            ? t("account.waiting")
            : account.problem !== undefined
              ? t(noteOf(account) ?? "account.failed")
              : t("account.reauthBanner")
        }
        actions={
          account.signingIn ? (
            <Button data-variant="ghost" onClick={() => void store.cancelSignIn()}>
              {t("account.stopWaiting")}
            </Button>
          ) : (
            <Button data-variant="outline" onClick={() => void store.signIn()}>
              {t("account.signInAgain")}
            </Button>
          )
        }
      />
    );
  if (account.state === "offline")
    return <AppNotice tone="warning" icon={<WarningIcon />} text={t("account.offlineBanner")} />;
  if (account.switched === true && !seen && account.user !== undefined)
    return (
      <AppNotice
        tone="info"
        icon={<CheckIcon />}
        text={t("account.switched", { name: account.user.name || account.user.email })}
        onDismiss={store.dismissSwitchNotice}
      />
    );
  return null;
}

/** Who is signed in, and the way out: in Settings → General. */
export function AccountGroup() {
  const store = useAppStore();
  const { t } = useI18n();
  const account = useAppState((s) => s.account);
  const [confirming, setConfirming] = useState(false);
  if (account?.user === undefined) return null;
  const state =
    account.state === "offline"
      ? t("account.state.offline")
      : account.state === "reauth"
        ? t("account.state.reauth")
        : undefined;
  const description = [account.user.email, state].filter(
    (part) => part !== undefined && part !== "",
  );
  return (
    <PageGroup title={t("account.group")}>
      <PageRows>
        <PageRow
          label={account.user.name || account.user.email}
          description={description.length > 0 ? description.join(" · ") : undefined}
        >
          <Button data-variant="outline" onClick={() => setConfirming(true)}>
            {t("account.signOut")}
          </Button>
        </PageRow>
      </PageRows>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("account.signOutTitle")}
        description={t("account.signOutDescription")}
        confirmLabel={t("account.signOut")}
        onConfirm={() => store.signOut()}
      />
    </PageGroup>
  );
}
