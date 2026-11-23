import { Button } from "@ui-sdk/react/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { useEffect, useId, useState } from "react";
import {
  activityCounts,
  activityOf,
  type Conversation,
  isLive,
  isSubagentCall,
  type Resend,
  type StopReason,
  stepOf,
  type ToolItem,
} from "../model/index.ts";
import { reveal } from "../reveal.ts";
import { ConfirmDialog } from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import { ChevronRightIcon, ErrorCircleIcon, WarningIcon } from "./icons.tsx";
import { InlineAiStatus } from "./inline-ai-status.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import {
  Lead,
  ToolCard,
  toolDescription,
  toolName,
  toolSummary,
  toolVerb,
  useOpenOnFailure,
} from "./tool.tsx";

/** A notice from the daemon or the agent, in the conversation. */
export function Notice({ severity, title }: { severity: string; title: string }) {
  return (
    <div role="status" data-slot="notice" data-severity={severity}>
      {severity === "error" ? <ErrorCircleIcon size={14} /> : null}
      {title}
    </div>
  );
}

/**
 * The tool calls of one stretch. One call is a row of its own; two or more are a card that says what they were in a line
 * (and, while one is going, which), and opens to the rows. A card with a failure is open: that is what the person came to read.
 */
export function WorkBlock({ tools, live }: { tools: readonly ToolItem[]; live: boolean }) {
  const only = tools[0];
  if (tools.length === 1 && only !== undefined) return <ToolCard tool={only} />;
  return <WorkCard tools={tools} live={live} />;
}

function WorkCard({ tools, live }: { tools: readonly ToolItem[]; live: boolean }) {
  const { t, list, locale } = useI18n();
  const failed = tools.filter((tool) => tool.status === "failed").length;
  const going = live ? tools.findLast(isLive) : undefined;
  const goingDescription = going !== undefined ? toolDescription(going) : undefined;
  const goingDetail =
    going !== undefined
      ? (goingDescription ?? `${toolVerb(t, going, true)} ${toolSummary(going)}`)
      : "";
  const goingTip = goingDetail || undefined;
  const [open, setOpen] = useOpenOnFailure(failed > 0);
  // Asked to show one of its calls (from the Overview): the card opens to it.
  // Also when it mounts while a request is still being answered: the request may be what moved the window to it.
  useEffect(() => {
    const check = () => {
      const asked = reveal.get();
      if (asked !== undefined && tools.some((tool) => tool.id === asked.itemId)) setOpen(true);
    };
    check();
    return reveal.subscribe(check);
  }, [tools, setOpen]);
  // The pieces are written to follow one another ("ran 2 commands"), and the line begins as a sentence does.
  const pieces = list(
    activityCounts(tools).map(({ activity, count }) => t(`work.summary.${activity}`, { count })),
  );
  const summary = pieces.charAt(0).toLocaleUpperCase(locale) + pieces.slice(1);
  // What is going on now comes first; a call that never ended (the turn stopped, or did not wait for it) is not "done".
  const mark =
    going !== undefined
      ? "in_progress"
      : failed > 0
        ? "failed"
        : tools.some((tool) => isLive(tool) || tool.status === "cancelled")
          ? "pending"
          : "completed";
  return (
    <Collapsible
      data-kind="work"
      data-status={failed > 0 ? "failed" : mark}
      open={open}
      onOpenChange={setOpen}
    >
      <CollapsibleTrigger>
        <Lead mark={going !== undefined ? "going" : failed > 0 ? "failed" : "other"} />{" "}
        <span data-slot="tool-verb">{summary}</span>{" "}
        {/* While one goes, the line says which, in its tense: that is also what a screen reader is told. */}
        <span
          data-slot="tool-summary"
          data-prose={goingDescription !== undefined || undefined}
          title={goingTip}
        >
          {goingDetail}
        </span>{" "}
        {failed > 0 ? (
          <span data-slot="tool-status" data-tone="danger">
            {t("work.failed", { count: failed })}
          </span>
        ) : null}{" "}
        {going === undefined && failed === 0 ? (
          mark === "pending" ? (
            <span data-slot="tool-status">{t("work.unfinished")}</span>
          ) : (
            <span data-slot="visually-hidden">{t("work.done")}</span>
          )
        ) : null}{" "}
        <ChevronRightIcon size={12} data-slot="tool-chevron" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        {tools.map((tool) => (
          <ToolCard key={tool.id} tool={tool} />
        ))}
      </CollapsiblePanel>
    </Collapsible>
  );
}

const ENDS: Record<string, string> = {
  cancelled: "turn.end.cancelled",
  max_tokens: "turn.end.maxTokens",
  max_turn_requests: "turn.end.maxTurnRequests",
  refusal: "turn.end.refusal",
};

/** How a turn that did not end normally ended: a colour, a shape and a sentence. */
export function EndBlock({ stop, resend }: { stop: StopReason; resend?: Resend | undefined }) {
  const { t } = useI18n();
  if (stop.stopReason === "error") {
    const message = stop.error?.message;
    return (
      <div data-slot="notice" data-kind="turn-end" data-severity="error" role="alert">
        <ErrorCircleIcon size={14} />
        <span>{message ? t("turn.end.errorWith", { message }) : t("turn.end.error")}</span>
        {resend !== undefined ? <TurnAgain resend={resend} /> : null}
      </div>
    );
  }
  const key = ENDS[stop.stopReason];
  return (
    <div data-slot="notice" data-kind="turn-end" data-severity="warning" role="status">
      <WarningIcon size={14} />
      <span>{key !== undefined ? t(key) : t("turn.end.other", { reason: stop.stopReason })}</span>
    </div>
  );
}

/**
 * What can be done at the end of the turn that failed (DESIGN.md 4.4). "Try again" sends what was said in it again, as it
 * was; "Edit message" puts it back in the box, for the person to read, change and send. When the turn had already run a
 * command or changed a file, either one asks first: sending it again may do that again. "Try again" waits for the
 * environment and for the agent to be free, and says which it waits for.
 */
function TurnAgain({ resend }: { resend: Resend }) {
  const { t, list } = useI18n();
  const store = useAppStore();
  const connected = useAppState(
    (s) =>
      s.selectedEnvironment !== undefined && s.status[s.selectedEnvironment]?.state === "connected",
  );
  const [asking, setAsking] = useState<"retry" | "edit" | undefined>();
  const [sending, setSending] = useState(false);
  const changed = resend.changed.length > 0;
  const names = [...new Set(resend.changed.map((tool) => toolName(t, tool)))];
  const shown =
    names.length > 4
      ? [...names.slice(0, 3), t("turn.resend.more", { count: names.length - 3 })]
      : names;
  const why = !connected ? "turn.retry.offline" : resend.busy ? "turn.retry.busy" : undefined;
  const whyId = useId();
  const retry = async () => {
    if (sending) return;
    setSending(true);
    // Once it went, the button stays off: the new turn may not have reached the conversation yet, and a second press
    // then would send the message twice. It goes away when the turn it ends is no longer the last.
    let sent = false;
    try {
      sent = await store.retry(resend);
    } finally {
      if (!sent) setSending(false);
    }
  };
  return (
    <div data-slot="turn-again">
      <div data-slot="row">
        <Button
          type="button"
          data-variant="ghost"
          data-size="sm"
          onClick={() => (changed ? setAsking("edit") : store.resend(resend))}
        >
          {t("turn.resend")}
        </Button>
        <Button
          type="button"
          data-variant="outline"
          data-size="sm"
          disabled={why !== undefined || sending}
          aria-describedby={why !== undefined ? whyId : undefined}
          onClick={() => (changed ? setAsking("retry") : void retry())}
        >
          {t("turn.retry")}
        </Button>
      </div>
      {why !== undefined ? (
        <span id={whyId} data-slot="turn-again-why">
          {t(why)}
        </span>
      ) : null}
      {changed ? (
        <ConfirmDialog
          open={asking !== undefined}
          onOpenChange={(open) => !open && setAsking(undefined)}
          title={t("turn.resend.changedTitle")}
          description={
            asking === "retry"
              ? t("turn.retry.changedBody", { tools: list(shown) })
              : t("turn.resend.changedBody", { tools: list(shown) })
          }
          confirmLabel={asking === "retry" ? t("turn.retry") : t("turn.resend.changedConfirm")}
          onConfirm={() => (asking === "retry" ? retry() : store.resend(resend))}
        />
      ) : null}
    </div>
  );
}

/** What the agent is doing, at the end of the turn that is going, so a hidden thought or a long tool is not a silence. */
export function StepLine({
  conversation,
  awaitingApproval,
}: {
  conversation: Conversation;
  awaitingApproval: boolean;
}) {
  const { t } = useI18n();
  const step = awaitingApproval ? ({ kind: "approval" } as const) : stepOf(conversation);
  if (step === undefined) return null;
  const activity = step.kind === "tool" ? activityOf(step.tool) : undefined;
  // A sub-agent at work has its own card that says what it does: the line only says the agent waits for it.
  const subagent = step.kind === "tool" && isSubagentCall(step.tool);
  const words =
    step.kind === "approval"
      ? t("step.approval")
      : step.kind === "thinking"
        ? t("step.thinking")
        : step.kind === "working"
          ? t("step.working")
          : step.kind === "retrying"
            ? step.attempt !== undefined && step.maxRetries !== undefined
              ? t("step.retryingCount", { attempt: step.attempt, max: step.maxRetries })
              : t("step.retrying")
            : subagent
              ? t("step.subagent")
              : activity === "other"
                ? t("step.other", { name: toolName(t, step.tool) })
                : t(`step.${activity}`);
  // Each attempt is a new state: its own key, so the line says it afresh.
  const stepKey = `${conversation.turns}:${
    step.kind === "tool"
      ? `tool:${step.tool.id}`
      : step.kind === "retrying"
        ? `retrying:${step.attempt ?? ""}`
        : step.kind
  }`;
  return (
    <InlineAiStatus
      // Trying again is the agent at work, said in other words: nothing here for the person to do.
      kind={step.kind === "retrying" ? "working" : step.kind}
      activity={activity}
      label={words}
      stepKey={stepKey}
      detail={step.kind === "tool" && !subagent ? <StepDetail tool={step.tool} /> : undefined}
    />
  );
}

/** What the step line says of the call that is going: the agent's sentence for it, or what it acts on. */
function StepDetail({ tool }: { tool: ToolItem }) {
  const description = toolDescription(tool);
  const text = description ?? toolSummary(tool);
  const tip = text || undefined;
  return (
    <span data-slot="step-detail" data-prose={description !== undefined || undefined} title={tip}>
      {text}
    </span>
  );
}
