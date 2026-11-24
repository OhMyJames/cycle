import type { ConnectionState, PermissionRequest } from "../api.ts";
import { type Conversation, subagentCallOf } from "../model/conversation.ts";
import { FormCard } from "./form.tsx";
import { useI18n } from "./i18n.tsx";
import { PermissionCard } from "./permission.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppStore } from "./store-context.tsx";
import { toolDescription } from "./tool.tsx";

/** What the sub-agent that asks was sent to do, as its own card titles it; undefined when that is not known. */
const askerOf = (conversation: Conversation, subagentId: string): string | undefined => {
  const call = subagentCallOf(conversation, subagentId);
  return call !== undefined ? toolDescription(call) : undefined;
};

/**
 * What the main column shows with no session open: a way to start one, or why the environment cannot, and what to do
 * about it.
 */
export function NoSession({
  environmentId,
  state,
  error,
  incompatible,
  onNewSession,
}: {
  environmentId: string | undefined;
  state: ConnectionState | undefined;
  error: string | undefined;
  incompatible: boolean;
  /** Undefined when no environment can have a session started. */
  onNewSession: (() => void) | undefined;
}) {
  const store = useAppStore();
  const { t } = useI18n();
  return (
    <div data-slot="empty">
      {state === "connected" ? (
        <StateBlock
          tone="empty"
          title={t("empty.chooseOrStart")}
          action={
            onNewSession !== undefined
              ? { label: t("empty.startSession"), onAction: onNewSession }
              : undefined
          }
        />
      ) : incompatible ? (
        // Connecting again would not change it: why, and where it says what to update.
        <StateBlock
          tone="away"
          title={t("environment.notConnected")}
          body={t("environment.incompatible")}
        />
      ) : state === "connecting" || state === "reconnecting" ? (
        <StateBlock tone="loading" title={t("environment.connecting")} />
      ) : (
        <StateBlock
          tone="error"
          title={t("environment.notConnected")}
          reason={error}
          action={
            environmentId !== undefined
              ? {
                  label: t("environment.connectAgain"),
                  onAction: () => void store.connectEnvironment(environmentId),
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

/** One request at a time, in the order they came: the one to answer, and how many wait behind it. */
export function PendingRequest({
  permissions,
  conversation,
  connected,
}: {
  permissions: readonly PermissionRequest[];
  conversation: Conversation | undefined;
  connected: boolean;
}) {
  const store = useAppStore();
  const request = permissions[0];
  return (
    <div data-slot="permissions">
      {request === undefined ? null : request.form !== undefined ? (
        <FormCard
          key={request.key}
          request={{ ...request, form: request.form }}
          disabled={!connected}
          onAnswer={store.answerForm}
        />
      ) : (
        <PermissionCard
          key={request.key}
          request={request}
          asker={
            request.subagentId !== undefined && conversation !== undefined
              ? (askerOf(conversation, request.subagentId) ?? "")
              : undefined
          }
          disabled={!connected}
          onAnswer={store.answerPermission}
          waiting={permissions.length - 1}
        />
      )}
    </div>
  );
}
