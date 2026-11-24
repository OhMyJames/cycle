// What the Subscriptions page (subscriptions.tsx) says about one agent's account: the sign-in dialog and the words for
// its state and its failures.

import { Button } from "@ui-sdk/react/button";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { useEffect, useRef, useState } from "react";
import type { AgentAuthMode, AgentAuthProblemReason, AgentSetupSnapshot } from "../api.ts";
import { useI18n } from "./i18n.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppStore } from "./store-context.tsx";

export type Translate = ReturnType<typeof useI18n>["t"];
export type FormatDate = ReturnType<typeof useI18n>["date"];

export type SignInModalState =
  | { kind: "starting" }
  | {
      kind: "active";
      flowId: string;
      mode: AgentAuthMode;
      hasUrl: boolean;
      host?: string | undefined;
      userCode?: string | undefined;
    }
  | { kind: "error"; reason: AgentAuthProblemReason };

export const authErrorText = (reason: AgentAuthProblemReason, t: Translate): string => {
  switch (reason) {
    case "binary_unavailable":
      return t("settings.harness.auth.error.binary_unavailable");
    case "auth_in_progress":
      return t("settings.harness.auth.error.auth_in_progress");
    case "parse_failed":
      return t("settings.harness.auth.error.parse_failed");
    case "invalid_code":
      return t("settings.harness.auth.error.invalid_code");
    case "expired":
      return t("settings.harness.auth.error.expired");
    case "cancelled":
      return t("settings.harness.auth.error.cancelled");
    case "process_failed":
      return t("settings.harness.auth.error.process_failed");
    case "timeout":
      return t("settings.harness.auth.error.timeout");
    case "unsupported_mode":
      return t("settings.harness.auth.error.unsupported_mode");
    case "untrusted_url":
      return t("settings.harness.auth.error.untrusted_url");
    case "disconnected":
      return t("settings.harness.auth.error.disconnected");
    default:
      return t("settings.harness.auth.error.failed");
  }
};

export function AgentSignInDialog({
  state,
  agentName,
  locationName,
  loginCommand,
  copiedLogin,
  onCopyLogin,
  onOpenBrowser,
  onSubmitCode,
  onRetry,
  onClose,
}: {
  state: SignInModalState | undefined;
  agentName: string;
  locationName: string;
  loginCommand: string;
  copiedLogin: boolean;
  onCopyLogin: () => void;
  /** False when main had nothing to open for the flow (it ended, or was never verified): the dialog says so. */
  onOpenBrowser: (flowId: string) => Promise<boolean>;
  onSubmitCode: (
    flowId: string,
    code: string,
  ) => Promise<{ ok: true } | { ok: false; reason: AgentAuthProblemReason }>;
  onRetry: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<AgentAuthProblemReason | undefined>(undefined);
  const [copiedDeviceCode, setCopiedDeviceCode] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);

  const flowId = state?.kind === "active" ? state.flowId : undefined;
  const flowIdRef = useRef(flowId);
  flowIdRef.current = flowId;
  const stateKind = state?.kind;
  useEffect(() => {
    void flowId;
    void stateKind;
    setCode("");
    setSubmitting(false);
    setSubmitError(undefined);
    setCopiedDeviceCode(false);
    setOpenFailed(false);
  }, [flowId, stateKind]);

  const submit = async () => {
    if (state?.kind !== "active" || submitting) return;
    const trimmed = code.trim();
    if (trimmed === "") return;
    const targetFlowId = state.flowId;
    setSubmitting(true);
    setSubmitError(undefined);
    const answer = await onSubmitCode(targetFlowId, trimmed);
    if (flowIdRef.current !== targetFlowId) return;
    setSubmitting(false);
    if (!answer.ok) setSubmitError(answer.reason);
  };

  return (
    <Dialog
      open={state !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogBackdrop />
      <DialogContent>
        <div data-slot="stack">
          <DialogTitle>{t("settings.harness.auth.title", { agent: agentName })}</DialogTitle>

          {state?.kind === "starting" ? (
            <DialogDescription>
              {t("settings.harness.auth.starting", { location: locationName })}
            </DialogDescription>
          ) : state?.kind === "error" ? (
            <StateBlock
              size="inline"
              align="start"
              tone="error"
              title={authErrorText(state.reason, t)}
              action={{ label: t("settings.harness.auth.retry"), onAction: onRetry }}
            />
          ) : state?.kind === "active" ? (
            <>
              {state.hasUrl && state.host !== undefined ? (
                <DialogDescription>
                  {t("settings.harness.auth.openHost", { host: state.host })}
                </DialogDescription>
              ) : null}

              {state.mode === "device_code" && state.userCode !== undefined ? (
                <Field name="device-code">
                  <FieldLabel>{t("settings.harness.auth.deviceCodeLabel")}</FieldLabel>
                  <div data-slot="harness-command-row">
                    <code data-slot="harness-device-code">{state.userCode}</code>
                    <Button
                      type="button"
                      data-variant="outline"
                      onClick={() => {
                        void store.copyText(state.userCode ?? "").then((ok) => {
                          if (ok) setCopiedDeviceCode(true);
                        });
                      }}
                    >
                      {copiedDeviceCode
                        ? t("settings.harness.account.copied")
                        : t("settings.harness.auth.copyCode")}
                    </Button>
                  </div>
                  {state.host !== undefined ? (
                    <FieldDescription>
                      {t("settings.harness.auth.waitingDevice", { host: state.host })}
                    </FieldDescription>
                  ) : null}
                </Field>
              ) : null}

              {state.hasUrl ? (
                <div data-slot="row">
                  <Button
                    type="button"
                    data-variant="solid"
                    onClick={() => {
                      const target = state.flowId;
                      setOpenFailed(false);
                      void onOpenBrowser(target).then((opened) => {
                        if (flowIdRef.current === target) setOpenFailed(!opened);
                      });
                    }}
                  >
                    {t("settings.harness.auth.openBrowser")}
                  </Button>
                </div>
              ) : null}
              {openFailed ? (
                <p data-slot="hint" role="alert">
                  {t("settings.harness.auth.openFailed")}
                </p>
              ) : null}

              {state.mode === "browser" ? (
                <p data-slot="hint" role="status">
                  {t("settings.harness.auth.waitingBrowser")}
                </p>
              ) : null}

              {state.mode === "code" ? (
                <form
                  data-slot="stack"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submit();
                  }}
                >
                  <Field name="auth-code">
                    <FieldLabel>{t("settings.harness.auth.codeLabel")}</FieldLabel>
                    <Input
                      value={code}
                      placeholder={t("settings.harness.auth.codePlaceholder")}
                      autoComplete="off"
                      disabled={submitting}
                      onChange={(event) => setCode(event.currentTarget.value)}
                    />
                    <FieldDescription>{t("settings.harness.auth.codeHint")}</FieldDescription>
                  </Field>
                  {submitError !== undefined ? (
                    <p data-slot="hint" role="alert">
                      {authErrorText(submitError, t)}
                    </p>
                  ) : null}
                  <div data-slot="row">
                    <Button
                      type="submit"
                      data-variant="solid"
                      disabled={submitting || code.trim() === ""}
                    >
                      {submitting
                        ? t("settings.harness.auth.submitting")
                        : t("settings.harness.auth.submit")}
                    </Button>
                  </div>
                </form>
              ) : null}
            </>
          ) : null}

          <div data-slot="harness-auth-fallback">
            <p data-slot="hint">
              {t("settings.harness.auth.fallbackLabel", { location: locationName })}
            </p>
            <div data-slot="harness-command-row">
              <code data-slot="reason">{loginCommand}</code>
              <Button type="button" data-variant="outline" onClick={onCopyLogin}>
                {copiedLogin
                  ? t("settings.harness.account.copied")
                  : t("settings.harness.account.copyLogin")}
              </Button>
            </div>
          </div>
        </div>
        <div data-slot="row" data-dialog-footer="">
          <DialogClose>{t("dialog.cancel")}</DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export const accountPrimaryLabel = (snapshot: AgentSetupSnapshot, t: Translate): string => {
  const { auth } = snapshot;
  if (auth.state === "signed_in") {
    return auth.account?.email ?? t("settings.harness.account.signedIn");
  }
  if (auth.state === "signed_out") return t("settings.harness.account.signedOut");
  if (auth.state === "signing_in") return t("settings.harness.account.signingIn");
  if (auth.state === "signing_out") return t("settings.harness.account.signingOut");
  if (auth.state === "binary_unavailable") return t("settings.harness.account.unavailable");
  return t("settings.harness.account.unknown");
};

export const accountSubtitle = (
  snapshot: AgentSetupSnapshot,
  t: Translate,
  date: FormatDate,
): string => {
  const { auth } = snapshot;
  const parts: string[] = [];
  if (auth.state === "auth_unknown" && auth.unknownReason !== undefined) {
    parts.push(t(`settings.harness.account.unknownReason.${auth.unknownReason}`));
  } else {
    parts.push(t(`settings.harness.account.method.${auth.method}`));
  }
  if (auth.account?.plan !== undefined) parts.push(auth.account.plan);
  if (auth.account?.organization !== undefined) parts.push(auth.account.organization);
  if (auth.account?.expiresAt !== undefined) {
    parts.push(
      t("settings.harness.account.expires", {
        when: date(auth.account.expiresAt, { dateStyle: "medium" }),
      }),
    );
  }
  if (auth.account?.tierObservedAt !== undefined) {
    parts.push(
      t("settings.harness.account.tierObserved", {
        when: date(auth.account.tierObservedAt, { dateStyle: "short", timeStyle: "short" }),
      }),
    );
  }
  if (auth.viaEnv !== undefined) {
    parts.push(t("settings.harness.account.viaEnv", { name: auth.viaEnv }));
  }
  return parts.join(" · ");
};
