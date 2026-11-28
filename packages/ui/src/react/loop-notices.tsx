// What needs a person, most urgent first, as the Loop server lists it. A Notice that names a session opens that
// session; the others take the person to the ticket. `intent_stuck` offers an inline Retry write action.
import { Button } from "@ui-sdk/react/button";
import { useEffect, useRef, useState } from "react";
import type { LoopNotice } from "../api.ts";
import { useI18n } from "./i18n.tsx";
import {
  CheckIcon,
  ChevronRightIcon,
  CloseIcon,
  ErrorCircleIcon,
  RefreshIcon,
  ShieldAlertIcon,
  WarningIcon,
} from "./icons.tsx";
import { Tip } from "./tip.tsx";

/** Most urgent first across all Loop Notice kinds. */
const URGENCY: Record<string, number> = {
  permission: 0,
  blocked: 1,
  stuck: 2,
  intent_stuck: 3,
  supervisor: 4,
  review: 5,
  operator: 6,
};
/** A Notice about the Project itself has no ticket; it can be opened only through a session it names. */
const isOpenable = (n: LoopNotice): boolean => n.identifier !== null || n.session !== null;

export const noticeUrgency = (n: LoopNotice): number => URGENCY[n.kind] ?? 7;

const isDestructiveNotice = (kind: LoopNotice["kind"]): boolean =>
  kind === "blocked" || kind === "intent_stuck";

const NoticeIcon = ({ kind, size = 16 }: { kind: LoopNotice["kind"]; size?: number }) =>
  kind === "permission" ? (
    <ShieldAlertIcon size={size} />
  ) : isDestructiveNotice(kind) ? (
    <ErrorCircleIcon size={size} />
  ) : (
    <WarningIcon size={size} />
  );

export type RetryIntents = (
  projectKey: string,
  identifier: string,
) => Promise<{ ok: boolean; message: string }>;

export function RetryFeedback({
  feedback,
  onDismiss,
}: {
  feedback: { ok: boolean; message: string };
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      data-slot="loop-board-notice"
      data-tone={feedback.ok ? "info" : "error"}
      role={feedback.ok ? "status" : "alert"}
    >
      {feedback.ok ? <CheckIcon size={14} /> : <ErrorCircleIcon size={14} />}
      <span>{feedback.message}</span>
      <Tip label={t("notice.dismiss")}>
        <Button data-variant="ghost" data-kind="loop-notice-dismiss" onClick={onDismiss}>
          <CloseIcon size={12} />
        </Button>
      </Tip>
    </div>
  );
}

/** The words of a row's one main action: join the session it names (permission, blocked), or look at the ticket. */
export const joinsSession = (n: LoopNotice): boolean =>
  n.session !== null && (n.kind === "permission" || n.kind === "blocked" || n.identifier === null);

/**
 * The rows of Notices, in the order given (the caller sorts), each one button with one main action named on its right.
 * `intent_stuck` also has an inline Retry write. The group's title is the caller's.
 */
export function Notices({
  projectKey,
  notices,
  onOpen,
  onRetryIntents,
}: {
  projectKey: string;
  notices: LoopNotice[];
  onOpen: (notice: LoopNotice) => void;
  onRetryIntents?: RetryIntents | undefined;
}) {
  const { t } = useI18n();
  const [retrying, setRetrying] = useState<string | undefined>();
  if (notices.length === 0) return null;

  const retry = async (identifier: string) => {
    if (!onRetryIntents) return;
    setRetrying(identifier);
    try {
      await onRetryIntents(projectKey, identifier);
    } finally {
      setRetrying(undefined);
    }
  };

  return (
    <>
      <ul data-slot="loop-notice-list" data-kind="loop-notices">
        {notices.map((notice) => {
          const identifier = notice.identifier;
          const openable = isOpenable(notice);
          const Body = openable ? "button" : "div";
          return (
            <li
              key={notice.id}
              data-slot="loop-notice"
              data-notice={notice.kind}
              data-id={identifier ?? undefined}
            >
              <Body
                {...(openable ? { type: "button" as const, onClick: () => onOpen(notice) } : {})}
                data-slot="loop-notice-open"
              >
                <span data-slot="loop-notice-icon" aria-hidden="true">
                  <NoticeIcon kind={notice.kind} />
                </span>
                <span data-slot="loop-notice-body">
                  <span data-slot="loop-notice-head">
                    {identifier !== null ? (
                      <span data-slot="loop-ticket-id">{identifier}</span>
                    ) : null}
                    <span data-slot="loop-notice-kind" data-notice={notice.kind}>
                      {t(`loop.notice.${notice.kind}`)}
                    </span>
                  </span>
                  {notice.text !== "" ? (
                    <span data-slot="loop-notice-detail">{notice.text}</span>
                  ) : null}
                </span>
                {openable ? (
                  <span data-slot="loop-notice-go">
                    {t(joinsSession(notice) ? "loop.console.join" : "loop.console.view")}
                  </span>
                ) : null}
                {openable ? <ChevronRightIcon size={14} /> : null}
              </Body>
              {notice.kind === "intent_stuck" &&
              identifier !== null &&
              onRetryIntents !== undefined ? (
                <div data-slot="loop-notice-action">
                  <Button
                    data-variant="outline"
                    data-kind="loop-intent-retry"
                    data-busy={retrying === identifier ? "" : undefined}
                    disabled={retrying !== undefined}
                    aria-label={t("loop.notices.retryWriteLabel", { id: identifier })}
                    onClick={() => void retry(identifier)}
                  >
                    <RefreshIcon size={12} />
                    <span>{t("loop.notices.retryWrite")}</span>
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}

const BOARD_ALERT_LIMIT = 3;

/**
 * Compact strip at the top of a Project's board when this Project has urgent Notices, so a single-project user who
 * lands straight on Kanban sees Blocked / Permission / Review / Stuck items immediately without leaving the board.
 */
export function BoardAlerts({
  projectKey,
  notices,
  onOpen,
  onRetryIntents,
  onOpenConsole,
}: {
  projectKey: string;
  notices: LoopNotice[];
  onOpen: (notice: LoopNotice) => void;
  onRetryIntents?: RetryIntents | undefined;
  onOpenConsole?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const [retrying, setRetrying] = useState<string | undefined>();
  const [feedback, setFeedback] = useState<
    { projectKey: string; ok: boolean; message: string } | undefined
  >();
  const projectRef = useRef(projectKey);
  projectRef.current = projectKey;

  useEffect(() => {
    setRetrying(undefined);
    setFeedback((prev) => (prev?.projectKey === projectKey ? prev : undefined));
  }, [projectKey]);

  const activeFeedback = feedback?.projectKey === projectKey ? feedback : undefined;
  if (notices.length === 0 && activeFeedback === undefined) return null;

  const sorted = [...notices].sort((a, b) => noticeUrgency(a) - noticeUrgency(b));
  const shown = sorted.slice(0, BOARD_ALERT_LIMIT);
  const rest = sorted.length - shown.length;
  const urgentTone = sorted.some((n) => isDestructiveNotice(n.kind)) ? "error" : "warning";

  const retry = async (identifier: string) => {
    if (!onRetryIntents) return;
    const requestedFor = projectKey;
    setRetrying(identifier);
    setFeedback(undefined);
    try {
      const result = await onRetryIntents(requestedFor, identifier);
      if (projectRef.current === requestedFor) setFeedback({ projectKey: requestedFor, ...result });
    } finally {
      if (projectRef.current === requestedFor) setRetrying(undefined);
    }
  };

  return (
    <>
      {sorted.length > 0 ? (
        <div data-slot="loop-board-alerts" data-tone={urgentTone}>
          <span data-slot="loop-board-alerts-lead">
            {urgentTone === "error" ? <ErrorCircleIcon size={14} /> : <WarningIcon size={14} />}
            <span>{t("loop.notices.count", { count: sorted.length })}</span>
          </span>
          <div data-slot="loop-board-alerts-items">
            {shown.map((notice) => {
              const identifier = notice.identifier;
              const openable = isOpenable(notice);
              const Chip = openable ? "button" : "span";
              return (
                <span key={notice.id} data-slot="loop-board-alert-group">
                  <Chip
                    {...(openable
                      ? {
                          type: "button" as const,
                          onClick: () => onOpen(notice),
                        }
                      : {})}
                    data-slot="loop-board-alert-chip"
                    data-notice={notice.kind}
                    // Without a ticket number the kind alone says little: the text is the message.
                    title={identifier === null && notice.text !== "" ? notice.text : undefined}
                  >
                    {identifier !== null ? (
                      <span data-slot="loop-ticket-id">{identifier}</span>
                    ) : null}
                    <span>{t(`loop.notice.${notice.kind}`)}</span>
                  </Chip>
                  {notice.kind === "intent_stuck" &&
                  identifier !== null &&
                  onRetryIntents !== undefined ? (
                    <Button
                      data-variant="outline"
                      data-kind="loop-intent-retry"
                      data-busy={retrying === identifier ? "" : undefined}
                      disabled={retrying !== undefined}
                      aria-label={t("loop.notices.retryWriteLabel", {
                        id: identifier,
                      })}
                      onClick={() => void retry(identifier)}
                    >
                      <RefreshIcon size={12} />
                      <span>{t("loop.notices.retryWrite")}</span>
                    </Button>
                  ) : null}
                </span>
              );
            })}
            {rest > 0 && onOpenConsole !== undefined ? (
              <Button data-variant="ghost" data-kind="loop-alerts-more" onClick={onOpenConsole}>
                {t("loop.notices.more", { count: rest })}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {activeFeedback !== undefined ? (
        <RetryFeedback feedback={activeFeedback} onDismiss={() => setFeedback(undefined)} />
      ) : null}
    </>
  );
}
