import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { type ReactNode, useMemo } from "react";
import { type Conversation, isLive, streamsOf, type ToolItem, textOf } from "../model/index.ts";
import { useI18n } from "./i18n.tsx";
import { ChevronRightIcon } from "./icons.tsx";
import { Markdown } from "./markdown.tsx";
import { useAppStore } from "./store-context.tsx";
import {
  Copyable,
  clip,
  Lead,
  SubagentFacts,
  statusWord,
  toolDescription,
  toolName,
  useOpenOnFailure,
  useRevealOpen,
} from "./tool.tsx";

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

/**
 * A sub-agent the agent sent off (Claude's Agent tool), as a card of its own: what it was asked to do, what kind of agent,
 * how it is going (what it uses now, or how many steps and how long it took), and once it is back, the start of its
 * answer, which is what the agent goes on from. Open, it shows the whole task it was given, what it did on the way (its
 * own conversation, `work`, when the daemon told it: CYCL-134) and the whole answer.
 */
export function SubagentCard({ tool, work }: { tool: ToolItem; work?: ReactNode }) {
  const { t } = useI18n();
  const status = tool.status ?? "pending";
  const subagentFailed = tool.subagent?.state === "failed";
  const failed = status === "failed" || status === "cancelled" || subagentFailed;
  const going = isLive(tool);
  const working = going && (tool.subagent?.state ?? "running") === "running";
  // A failure is what the person came to read: the card opens to it.
  const [open, setOpen] = useOpenOnFailure(status === "failed" || subagentFailed);
  useRevealOpen([tool.id], setOpen);
  const title = toolDescription(tool) ?? toolName(t, tool);
  const kind = inputText(tool, "subagent_type");
  const prompt = inputText(tool, "prompt");
  const streams = useMemo(() => streamsOf(tool), [tool]);
  const answer = answerOf(tool, streams.out);
  const said = subagentFailed ? t("subagent.failed") : statusWord(t, status);
  const store = useAppStore();
  // Opened by the person (not by a failure, nor by a jump to it): whether they look at what it did.
  const opened = (next: boolean) => {
    if (next && !open)
      store.track("subagent_opened", { work: work !== undefined, running: working });
    setOpen(next);
  };
  return (
    <Collapsible
      data-kind="subagent"
      data-status={failed ? "failed" : status}
      data-item-id={tool.id}
      open={open}
      onOpenChange={opened}
    >
      <CollapsibleTrigger>
        <Lead
          mark={
            working
              ? "going"
              : failed
                ? "failed"
                : status === "completed" && (tool.subagent?.state ?? "done") === "done"
                  ? "done"
                  : "other"
          }
          kind="subagent"
        />{" "}
        <span data-slot="visually-hidden">{t("subagent.label")}</span>{" "}
        <span data-slot="tool-verb" data-prose title={title}>
          {title}
        </span>{" "}
        {kind !== undefined ? <span data-slot="subagent-type">{kind}</span> : null}{" "}
        {tool.subagent !== undefined ? <SubagentFacts subagent={tool.subagent} /> : null}{" "}
        {/* The facts already say a sub-agent failed; the word is for a call that failed by itself, and a screen reader. */}
        <span data-slot={failed && !subagentFailed ? "tool-status" : "visually-hidden"}>
          {said}
        </span>{" "}
        <ChevronRightIcon size={12} data-slot="tool-chevron" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        {prompt !== undefined ? (
          <section data-slot="subagent-part" aria-label={t("subagent.prompt")}>
            <h4 data-slot="tool-block-label">{t("subagent.prompt")}</h4>
            <p data-slot="subagent-prompt">{clip(prompt)}</p>
          </section>
        ) : null}
        {/* Drawn only while open: a long one is many rows, and closed it is out of the way. */}
        {open && work !== undefined ? (
          <section data-slot="subagent-part" data-part="work" aria-label={t("subagent.work")}>
            <h4 data-slot="tool-block-label">{t("subagent.work")}</h4>
            <div data-slot="subagent-work">{work}</div>
          </section>
        ) : null}
        {answer !== undefined ? (
          <section data-slot="subagent-part" aria-label={t("subagent.answer")}>
            <h4 data-slot="tool-block-label">{t("subagent.answer")}</h4>
            <div data-slot="message" data-role="agent">
              <Markdown text={clip(answer)} />
            </div>
          </section>
        ) : null}
        {streams.err !== "" ? <Copyable kind="stderr" text={streams.err} failed={failed} /> : null}
        {/* A call that failed by itself says why in its text, which is no answer: shown as what it is. */}
        {failed && !subagentFailed && streams.out.trim() !== "" ? (
          <Copyable kind="output" text={streams.out} />
        ) : null}
      </CollapsiblePanel>
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
    </Collapsible>
  );
}
