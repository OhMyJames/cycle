import { Button } from "@ui-sdk/react/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Translator } from "../i18n.ts";
import { type Conversation, isLive, streamsOf, type ToolItem, textOf } from "../model/index.ts";
import { startedAt } from "../started.ts";
import { useI18n } from "./i18n.tsx";
import { CheckIcon, ChevronRightIcon, ErrorCircleIcon, StopIcon, WarningIcon } from "./icons.tsx";
import { Elapsed } from "./inline-ai-status.tsx";
import { type LoaderState, loaderStateOfKind, MorphLoader } from "./loader/index.ts";
import { useLoaderClaim } from "./loader-claim.ts";
import { Markdown } from "./markdown.tsx";
import { useStartScope } from "./start-scope.ts";
import { useAppState, useAppStore } from "./store-context.tsx";
import { Copyable, clip, durationOf, toolDescription, toolName, useRevealOpen } from "./tool.tsx";

type Subagent = NonNullable<ToolItem["subagent"]>;

const inputText = (tool: ToolItem, key: string): string | undefined => {
  const input = tool.rawInput;
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
};

/** As much of an answer as the preview parses: far more than three lines' worth, far less than a long report. */
const PREVIEW_CHARS = 1_500;

/**
 * What the sub-agent came back with: the text of its call's result, once the call completed. Not while it goes, not from
 * a call that failed or was stopped (its text is an error, or part of one), and not for a sub-agent sent to the
 * background, whose call completes at once with only a line that says it was launched.
 */
const answerOf = (tool: ToolItem, out: string): string | undefined => {
  if (tool.status !== "completed" || tool.subagent?.background === true) return undefined;
  const text = tool.content.length > 0 ? out : tool.rawOutput;
  return typeof text === "string" && text.trim() !== "" ? text.trim() : undefined;
};

/**
 * What the sub-agent did on the way, as its card shows it: its conversation, less its last message when that is the
 * answer the card shows below it (a sub-agent's last words are what its call returns). Undefined when it said nothing.
 */
export const subagentWorkOf = (tool: ToolItem): Conversation | undefined => {
  const work = tool.subagent?.conversation;
  if (work === undefined) return undefined;
  const answer = answerOf(tool, streamsOf(tool).out);
  const last = work.items.at(-1);
  // The result may add a line of its own after the words (Claude's names the agent): the words are what repeat.
  const said = last?.kind === "agent" ? textOf(last.blocks).trim() : "";
  const items =
    answer !== undefined && said !== "" && answer.startsWith(said)
      ? work.items.slice(0, -1)
      : work.items;
  if (items.length === 0) return undefined;
  return items === work.items ? work : { ...work, items };
};

/** How a sub-agent's card stands, as its head says it in a word and a mark. */
export type SubagentState = "running" | "done" | "failed" | "stopped" | "unknown";

/**
 * At work while its agent says it runs and its call goes (or it was sent to the background, whose call ends at once);
 * failed when it or its call did; stopped when it was stopped, dismissed, or its call was cut short with the turn.
 */
export const subagentStateOf = (tool: ToolItem): SubagentState => {
  const sub = tool.subagent;
  if (tool.status === "failed" || sub?.state === "failed") return "failed";
  if (
    sub === undefined ? isLive(tool) : sub.state === "running" && (isLive(tool) || sub.background)
  )
    return "running";
  if (sub?.state === "unknown") return "unknown";
  if (tool.status === "cancelled" || sub?.state === "stopped" || sub?.state === "dismissed")
    return "stopped";
  return "done";
};

/** Added to a background sub-agent's rank: after any in the turn, whenever they started. */
const BACKGROUND_RANK = 1e15;

/** Tools that look things up, by the name a sub-agent's news gives its last one when no call of its is known. */
const LOOKUPS: ReadonlySet<string> = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "WebFetch",
  "WebSearch",
]);

/** What the loader shows of a sub-agent at work: the kind of the call it has going, else that it thinks. */
export const subagentLoaderState = (sub: Subagent | undefined): LoaderState => {
  const last = sub?.conversation?.items.at(-1);
  if (last?.kind === "tool" && isLive(last)) return loaderStateOfKind(last.toolKind);
  if (last === undefined && sub?.lastTool !== undefined)
    return LOOKUPS.has(sub.lastTool) ? "searching" : "executing";
  return "thinking";
};

/** How many steps it took: what its agent counted, else the calls it is known to have made. */
const stepsOf = (sub: Subagent | undefined): number => {
  const counted = sub?.usage?.toolUses ?? 0;
  if (counted > 0) return counted;
  return sub?.conversation?.items.filter((item) => item.kind === "tool").length ?? 0;
};

const firstLine = (text: string | undefined): string | undefined => {
  const line = text
    ?.split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  return line === undefined || line === "" ? undefined : line;
};

/** What a sub-agent at work is doing now, in a line: the SDK's own line, the tool it uses, or the last it said. */
const nowOf = (t: Translator["t"], sub: Subagent): string | undefined => {
  if (sub.summary !== undefined) return sub.summary;
  if (sub.lastTool !== undefined) return t("subagent.now", { tool: sub.lastTool });
  const said = sub.conversation?.items.findLast((item) => item.kind === "agent");
  return said?.kind === "agent" ? firstLine(textOf(said.blocks)) : undefined;
};

/** The mark at the start of the head: what state it is in, as a shape, never only a colour. */
function StateMark({
  state,
  loader,
  look,
}: {
  state: SubagentState;
  loader: boolean;
  look: LoaderState;
}) {
  return (
    <span data-slot="subagent-mark" data-state={state}>
      {state === "running" ? (
        loader ? (
          <MorphLoader state={look} />
        ) : (
          // At work, while the conversation's one loader is elsewhere (loader-claim.ts): a still ring.
          <span data-slot="subagent-still" aria-hidden="true" />
        )
      ) : state === "done" ? (
        <CheckIcon size={14} aria-hidden="true" />
      ) : state === "failed" ? (
        <ErrorCircleIcon size={14} aria-hidden="true" />
      ) : state === "stopped" ? (
        <StopIcon size={14} aria-hidden="true" />
      ) : (
        <WarningIcon size={14} aria-hidden="true" />
      )}
    </span>
  );
}

/**
 * The task it was given, three lines of it, and the rest on request: a long brief is not what the card is read for.
 * Plain text, as it came.
 */
function Task({ prompt }: { prompt: string }) {
  const { t } = useI18n();
  const store = useAppStore();
  const text = useRef<HTMLParagraphElement>(null);
  const [whole, setWhole] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const shown = text.current;
    if (shown === null || whole) return undefined;
    const measure = () => setLong(shown.scrollHeight > shown.clientHeight + 1);
    measure();
    if (typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(shown);
    return () => observer.disconnect();
  }, [whole]);
  return (
    <section data-slot="subagent-part" aria-label={t("subagent.prompt")}>
      <h4 data-slot="subagent-label">{t("subagent.prompt")}</h4>
      <p data-slot="subagent-prompt" data-whole={whole || undefined} ref={text}>
        {clip(prompt)}
      </p>
      {long || whole ? (
        <button
          type="button"
          data-slot="subagent-more"
          aria-expanded={whole}
          onClick={() => {
            if (!whole) store.track("subagent_task_expanded", {});
            setWhole(!whole);
          }}
        >
          {whole ? t("subagent.lessTask") : t("subagent.showTask")}
        </button>
      ) : null}
    </section>
  );
}

/**
 * A sub-agent the agent sent off (Claude's Agent tool), as a colleague's card (CYCL-217): its head says what it was sent
 * to do, what kind of agent, how it stands (in a word and a mark), how long it took and how many steps, with a Stop
 * button while it is at work. Closed, which it starts as, a line under the head says what it does now, why it failed,
 * or the start of its answer. Open: the task (three lines, the rest on request), what it did on the way as a compact
 * timeline (its own conversation, `work`, when the daemon told it: CYCL-134) and its answer last.
 *
 * The conversation has one loader (loader-claim.ts): the card of the sub-agent at work that started first draws it,
 * unless the status line at the end of the turn is speaking; any other at work has a still ring.
 */
export function SubagentCard({ tool, work }: { tool: ToolItem; work?: ReactNode }) {
  const i18n = useI18n();
  const { t } = i18n;
  const state = subagentStateOf(tool);
  const running = state === "running";
  const [open, setOpen] = useState(false);
  useRevealOpen([tool.id], setOpen);
  const title = toolDescription(tool) ?? toolName(t, tool);
  const kind = inputText(tool, "subagent_type");
  const prompt = inputText(tool, "prompt");
  const streams = useMemo(() => streamsOf(tool), [tool]);
  const answer = answerOf(tool, streams.out);
  const sub = tool.subagent;
  const background = sub?.background === true;
  const scope = useStartScope();
  // Asked only while it runs: the starts kept are few, and a finished card says how long it took from its news.
  const since = running ? startedAt(`${scope}:tool:${tool.id}`) : 0;
  // A sub-agent in the background comes after those in the turn: its end may never come, and it must not keep the
  // loader from them for good.
  const loader = useLoaderClaim(
    `subagent:${tool.id}`,
    running,
    background ? since + BACKGROUND_RANK : since,
  );
  // What the head and the closed line say of its own conversation: read again only when its news changes, not with
  // each update of its call.
  const steps = useMemo(() => stepsOf(sub), [sub]);
  const now = useMemo(
    () => (running && sub !== undefined ? nowOf(t, sub) : undefined),
    [running, sub, t],
  );
  const look = useMemo(() => subagentLoaderState(sub), [sub]);
  // Why it failed: what its call said on its error stream, or the text of a call that failed by itself (one whose
  // sub-agent failed but whose call completed returned an answer, which is not a reason).
  const reason =
    state === "failed"
      ? firstLine(streams.err || (tool.status === "failed" ? streams.out : ""))
      : undefined;
  const store = useAppStore();
  // It can be stopped alone (CYCL-143): its agent said so, it is at work (in the turn or in the background), and the
  // environment's daemon can pass a stop on. Asked once: the card says it is stopping until its end comes. If the
  // daemon says there is nothing to stop (it ended while this card was behind), the button goes; if the ask fails, the
  // error is shown and it can be asked again.
  const environmentCan = useAppState((s) =>
    s.selectedEnvironment !== undefined
      ? s.status[s.selectedEnvironment]?.capabilities?.stopSubagent === true
      : false,
  );
  const [asked, setAsked] = useState<"no" | "stopping" | "nothing">("no");
  const stopping = asked === "stopping" && running;
  const canStop =
    environmentCan &&
    asked !== "nothing" &&
    sub?.stoppable === true &&
    running &&
    sub.state === "running" &&
    sub.id !== undefined;
  const card = useRef<HTMLDivElement>(null);
  const stopFocused = useRef(false);
  const stop = () => {
    if (sub?.id === undefined || stopping) return;
    setAsked("stopping");
    void store
      .stopSubagent(sub.id, sub.background)
      .then((taken) => setAsked(taken === true ? "stopping" : taken === false ? "nothing" : "no"));
  };
  // The button goes when its sub-agent ends: focus that was on it stays on the card, not lost to the page.
  useLayoutEffect(() => {
    if (canStop || !stopFocused.current) return;
    stopFocused.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body)
      card.current?.querySelector<HTMLElement>(":scope > button")?.focus();
  }, [canStop]);
  // Opened by the person (not by a jump to it): whether they look at what it did.
  const opened = (next: boolean) => {
    if (next && !open) store.track("subagent_opened", { work: work !== undefined, running });
    setOpen(next);
  };
  const word = stopping
    ? t("subagent.stopping")
    : sub?.state === "dismissed"
      ? t("subagent.dismissed")
      : state === "unknown"
        ? t("subagent.unknown")
        : t(`subagent.state.${state}`);
  const took = !running && sub?.usage !== undefined && sub.usage.durationMs > 0;
  return (
    <Collapsible
      data-kind="subagent"
      data-status={state}
      data-background={sub?.background === true || undefined}
      data-item-id={tool.id}
      ref={card}
      open={open}
      onOpenChange={opened}
    >
      <CollapsibleTrigger>
        <StateMark state={state} loader={loader} look={look} />
        <span data-slot="visually-hidden">{t("subagent.label")}</span>{" "}
        <span data-slot="subagent-title" title={title}>
          {title}
        </span>{" "}
        {kind !== undefined ? (
          <span data-slot="subagent-tag" title={kind}>
            {kind}
          </span>
        ) : null}{" "}
        {sub?.background === true ? (
          <span data-slot="subagent-tag" data-background>
            {t("subagent.background")}
          </span>
        ) : null}{" "}
        <span data-slot="subagent-meta">
          <span data-slot="subagent-status">{word}</span>{" "}
          {running && !background ? (
            <Elapsed since={since} slot="subagent-elapsed" />
          ) : took ? (
            <span>{durationOf(i18n, sub.usage?.durationMs ?? 0)}</span>
          ) : null}{" "}
          {steps > 0 ? <span>{t("subagent.steps", { count: steps })}</span> : null}
        </span>
        <ChevronRightIcon size={12} data-slot="tool-chevron" aria-hidden="true" />
      </CollapsibleTrigger>
      {/* Stops this sub-agent only; the turn and the rest go on. Out of the trigger, so it is a button of its own, on the
          right of the head. */}
      {canStop ? (
        <div data-slot="subagent-actions">
          <Button
            type="button"
            data-variant="outline"
            data-size="sm"
            aria-label={t(stopping ? "subagent.stoppingNamed" : "subagent.stopNamed", {
              name: title,
            })}
            // Not `disabled`: a disabled button drops the keyboard's focus to the page.
            aria-disabled={stopping || undefined}
            onClick={stop}
            onFocus={() => {
              stopFocused.current = true;
            }}
            onBlur={() => {
              stopFocused.current = false;
            }}
          >
            <StopIcon size={12} aria-hidden="true" />
            {/* In a span: ui-sdk squares a named button whose only element is its icon. */}
            <span>{stopping ? t("subagent.stopping") : t("subagent.stop")}</span>
          </Button>
        </div>
      ) : null}
      {/* Closed, one line of what it does now, or why it failed. */}
      {!open && (now ?? reason) !== undefined ? (
        <p data-slot="subagent-glimpse" data-tone={reason !== undefined ? "danger" : undefined}>
          {now ?? reason}
        </p>
      ) : null}
      {/* Closed, the start of its answer: what the agent goes on from, without opening the card. Only a glimpse, so it
          is out of the keyboard's and a screen reader's way; the button opens the whole of it. */}
      {!open && answer !== undefined ? (
        <div data-slot="subagent-answer">
          <div data-slot="message" data-role="agent" inert aria-hidden="true">
            <Markdown text={answer.slice(0, PREVIEW_CHARS)} />
          </div>
          <button type="button" data-slot="subagent-more" onClick={() => opened(true)}>
            {t("subagent.showAnswer")}
          </button>
        </div>
      ) : null}
      <CollapsiblePanel>
        {/* Keyed by the task: one that changes (still streaming in) is measured afresh. */}
        {prompt !== undefined ? <Task key={prompt} prompt={prompt} /> : null}
        {/* Drawn only while open: a long one is many rows, and closed it is out of the way. */}
        {open && work !== undefined ? (
          <section data-slot="subagent-part" data-part="work" aria-label={t("subagent.work")}>
            <h4 data-slot="subagent-label">{t("subagent.work")}</h4>
            <div data-slot="subagent-work">{work}</div>
          </section>
        ) : null}
        {answer !== undefined ? (
          <section data-slot="subagent-part" data-part="answer" aria-label={t("subagent.answer")}>
            <h4 data-slot="subagent-label">{t("subagent.answer")}</h4>
            <div data-slot="message" data-role="agent">
              <Markdown text={clip(answer)} />
            </div>
          </section>
        ) : null}
        {streams.err !== "" ? (
          <Copyable kind="stderr" text={streams.err} failed={state === "failed"} />
        ) : null}
        {/* A call that failed by itself says why in its text, which is no answer: shown as what it is. */}
        {state === "failed" && sub?.state !== "failed" && streams.out.trim() !== "" ? (
          <Copyable kind="output" text={streams.out} />
        ) : null}
      </CollapsiblePanel>
    </Collapsible>
  );
}
