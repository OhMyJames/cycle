import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { useEffect } from "react";
import { isLive, streamsOf, type ToolItem } from "../model/index.ts";
import { reveal } from "../reveal.ts";
import { useI18n } from "./i18n.tsx";
import { ChevronRightIcon } from "./icons.tsx";
import { Markdown } from "./markdown.tsx";
import { Copyable, Lead, SubagentFacts, statusWord, toolName, useOpenOnFailure } from "./tool.tsx";

const inputText = (tool: ToolItem, key: string): string | undefined => {
  const input = tool.rawInput;
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
};

/** What the sub-agent came back with: the text of its call's result. */
const answerOf = (tool: ToolItem): string | undefined => {
  const out = tool.content.length > 0 ? streamsOf(tool).out : tool.rawOutput;
  return typeof out === "string" && out.trim() !== "" ? out.trim() : undefined;
};

/**
 * A sub-agent the agent sent off (Claude's Agent tool), as a card of its own: what it was asked to do, what kind of agent,
 * how it is going (what it uses now, or how many steps and how long it took), and once it is back, the start of its
 * answer, which is what the agent goes on from. Open, it shows the whole task it was given and the whole answer. What it
 * did on the way is not shown: the session is told only how it goes, not its conversation (decision 0014).
 */
export function SubagentCard({ tool }: { tool: ToolItem }) {
  const { t } = useI18n();
  const status = tool.status ?? "pending";
  const failed = status === "failed" || status === "cancelled" || tool.subagent?.state === "failed";
  const going = isLive(tool);
  const working = going && (tool.subagent?.state ?? "running") === "running";
  const [open, setOpen] = useOpenOnFailure(status === "failed");
  // Asked to show it (from the Overview): it opens.
  useEffect(() => {
    const check = () => {
      if (reveal.get()?.itemId === tool.id) setOpen(true);
    };
    check();
    return reveal.subscribe(check);
  }, [tool.id, setOpen]);
  const title = inputText(tool, "description") ?? toolName(t, tool);
  const kind = inputText(tool, "subagent_type");
  const prompt = inputText(tool, "prompt");
  const answer = going ? undefined : answerOf(tool);
  const errors = streamsOf(tool).err;
  return (
    <Collapsible
      data-kind="subagent"
      data-status={failed ? "failed" : status}
      data-item-id={tool.id}
      open={open}
      onOpenChange={setOpen}
    >
      <CollapsibleTrigger>
        <Lead mark={working ? "going" : failed ? "failed" : "other"} />{" "}
        <span data-slot="visually-hidden">{t("subagent.label")}</span>{" "}
        <span data-slot="tool-verb" data-prose title={title}>
          {title}
        </span>{" "}
        {kind !== undefined ? <span data-slot="subagent-type">{kind}</span> : null}{" "}
        {tool.subagent !== undefined ? <SubagentFacts subagent={tool.subagent} /> : null}{" "}
        <span data-slot={failed ? "tool-status" : "visually-hidden"}>{statusWord(t, status)}</span>{" "}
        <ChevronRightIcon size={12} data-slot="tool-chevron" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        {prompt !== undefined ? (
          <section data-slot="subagent-part" aria-label={t("subagent.prompt")}>
            <h4 data-slot="tool-block-label">{t("subagent.prompt")}</h4>
            <p data-slot="subagent-prompt">{prompt}</p>
          </section>
        ) : null}
        {answer !== undefined ? (
          <section data-slot="subagent-part" aria-label={t("subagent.answer")}>
            <h4 data-slot="tool-block-label">{t("subagent.answer")}</h4>
            <div data-slot="message" data-role="agent">
              <Markdown text={answer} />
            </div>
          </section>
        ) : null}
        {errors !== "" ? <Copyable kind="stderr" text={errors} /> : null}
      </CollapsiblePanel>
      {/* Closed, the start of its answer: what the agent goes on from, without opening the card. */}
      {!open && answer !== undefined ? (
        <div data-slot="subagent-answer">
          <div data-slot="message" data-role="agent">
            <Markdown text={answer} />
          </div>
          <button type="button" data-slot="subagent-more" onClick={() => setOpen(true)}>
            {t("subagent.showAnswer")}
          </button>
        </div>
      ) : null}
    </Collapsible>
  );
}
