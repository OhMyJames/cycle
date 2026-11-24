import { Button } from "@ui-sdk/react/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { useId, useState } from "react";
import type { Translator } from "../i18n.ts";
import {
  activityCounts,
  activityOf,
  type Conversation,
  isLive,
  isSubagentCall,
  type Resend,
  type Step,
  type StopReason,
  stepOf,
  type ToolItem,
} from "../model/index.ts";
import { startedAt } from "../started.ts";
import { ConfirmDialog } from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import { ErrorCircleIcon, WarningIcon } from "./icons.tsx";
import { Elapsed, InlineAiStatus } from "./inline-ai-status.tsx";
import { useLoaderClaim } from "./loader-claim.ts";
import { useStartScope } from "./start-scope.ts";
import { useSteady } from "./steady.ts";
import { useAppState, useAppStore } from "./store-context.tsx";
import {
  statusWord,
  ToolCard,
  toolDescription,
  toolName,
  toolSummary,
  toolVerb,
  useOpenOnFailure,
  useRevealOpen,
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
  const kinds = activityCounts(tools);
  const going = live ? tools.findLast(isLive) : undefined;
  const goingDescription = going !== undefined ? toolDescription(going) : undefined;
  const goingDetail =
    going !== undefined
      ? (goingDescription ?? `${toolVerb(t, going, true)} ${toolSummary(going)}`)
      : "";
  const goingTip = goingDetail || undefined;
  const scope = useStartScope();
  const [open, setOpen] = useOpenOnFailure(failed > 0);
  // Asked to show one of its calls (from the Overview): the card opens to it; also when it mounts while that is still
  // asked, since the request may be what moved the window to it.
  useRevealOpen(
    tools.map((tool) => tool.id),
    setOpen,
  );
  // The pieces are written to follow one another ("ran 2 commands"), and the line begins as a sentence does.
  const pieces = list(kinds.map(({ activity, count }) => t(`work.summary.${activity}`, { count })));
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
        <span data-slot="tool-verb">{summary}</span>{" "}
        {/* While one goes, the line says which, in its tense: that is also what a screen reader is told. */}
        <span
          data-slot="tool-summary"
          data-prose={goingDescription !== undefined || undefined}
          title={goingTip}
        >
          {goingDetail}
        </span>{" "}
        {/* No mark says the stretch is going: its detail does, by the tense of its verb; a description has none, so the word is written. */}
        {going !== undefined && goingDescription !== undefined ? (
          <span data-slot="tool-status">{statusWord(t, going.status ?? "pending")}</span>
        ) : null}{" "}
        {/* Closed, the line stands for the call's row: it says how long the call has been at work, as the row would. */}
        {going?.status === "in_progress" && !open ? (
          <Elapsed since={startedAt(`${scope}:tool:${going.id}`)} slot="tool-elapsed" />
        ) : null}{" "}
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
        ) : null}
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
 * location and for the agent to be free, and says which it waits for.
 */
function TurnAgain({ resend }: { resend: Resend }) {
  const { t, list } = useI18n();
  const store = useAppStore();
  const connected = useAppState(
    (s) => s.selectedLocation !== undefined && s.status[s.selectedLocation]?.state === "connected",
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

/**
 * A call whose row says it is at work, with its time (tool.tsx: in progress). One still waiting to start (its input
 * still streaming, say) has no time on its row yet, so the line speaks for it.
 */
const rowAtWork = (step: LineStep): boolean =>
  step.kind === "tool" && step.tool.status === "in_progress";

/**
 * What the line is held steady by: a call at work by no more than that, so one call after another is one quiet stretch,
 * not a change each time (and a screen reader is not told each one); a call waiting by its id; a retry by its attempt,
 * since its words count it; else the kind of step.
 */
const stepKeyOf = (step: LineStep): string =>
  rowAtWork(step)
    ? "tool"
    : step.kind === "tool"
      ? `tool:${step.tool.id}`
      : step.kind === "retrying"
        ? `retrying:${step.attempt ?? ""}`
        : step.kind;

/** A question for the person is said at once, and so is the end of the turn: nothing is held over either. */
const urgent = (key: string): boolean => key === "" || key === "approval";

/** What the line can be showing: a step, or the agent writing its reply. */
type LineStep = Step | { kind: "replying" };

/**
 * What the agent is doing, at the end of the turn that is going, so a hidden thought or a long wait is not a silence
 * (Cycle v2's StatusBar). It is there for the whole turn, on a line of fixed height, so nothing moves as steps change.
 * While a call is at work its row says so, with its own time: the line is quiet, so the conversation has one loader and
 * one clock. Its own time is the turn's, from when the page first saw the turn: an approval, a call or a remount does not
 * start it again.
 */
export function StepLine({
  conversation,
  awaitingApproval,
}: {
  conversation: Conversation;
  awaitingApproval: boolean;
}) {
  const { t } = useI18n();
  const session = useStartScope();
  const going = conversation.status !== "idle";
  const wanted: LineStep | undefined = awaitingApproval
    ? { kind: "approval" }
    : (stepOf(conversation) ?? (going ? { kind: "replying" } : undefined));
  // Asked as the turn begins, and on every draw after: it is the turn's, under the session's scope.
  const since = going ? startedAt(`${session}:turn:${conversation.turns}`) : 0;
  // Held steady, so a run of quick calls does not flicker between the quiet line and words.
  const [step] = useSteady(wanted, wanted === undefined ? "" : stepKeyOf(wanted), urgent);
  // Speaking, the line holds the conversation's one loader before any sub-agent's card (loader-claim.ts).
  useLoaderClaim("step-line", step !== undefined && !rowAtWork(step), Number.NEGATIVE_INFINITY);
  if (step === undefined) return null;
  const quiet = rowAtWork(step);
  const label = quiet
    ? t("step.working")
    : step.kind === "approval"
      ? t("step.approval")
      : step.kind === "thinking"
        ? t("step.thinking")
        : step.kind === "replying"
          ? t("step.replying")
          : step.kind === "review"
            ? t("step.review")
            : step.kind === "retrying"
              ? step.attempt !== undefined && step.maxRetries !== undefined
                ? t("step.retryingCount", { attempt: step.attempt, max: step.maxRetries })
                : t("step.retrying")
              : step.kind === "tool"
                ? toolStep(t, step.tool)
                : t("step.working");
  return (
    <InlineAiStatus
      // Trying again, or a call at work, is the agent at work, said in other words: nothing here for the person to do.
      kind={
        step.kind === "approval" || step.kind === "thinking" || step.kind === "replying"
          ? step.kind
          : "working"
      }
      label={label}
      since={since}
      quiet={quiet}
    />
  );
}

/** What the line says of a call that has not started its work yet. */
function toolStep(t: Translator["t"], tool: ToolItem): string {
  if (isSubagentCall(tool)) return t("step.subagent");
  const activity = activityOf(tool);
  return activity === "other"
    ? t("step.other", { name: toolName(t, tool) })
    : t(`step.${activity}`);
}
