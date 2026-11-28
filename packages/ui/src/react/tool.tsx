import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useState } from "react";
import {
  ANSI_COLORS,
  type AnsiColor,
  type AnsiRun,
  type AnsiStyle,
  ansiTail,
  plainText,
} from "../ansi.ts";
import { skippedLines } from "../diff-gaps.ts";
import { insideFolder, shownPath } from "../files-view.ts";
import type { Translator } from "../i18n.ts";
import {
  activityOf,
  commandLabelOf,
  commandOf,
  type DiffLine,
  editPathOf,
  isLive,
  streamsOf,
  type ToolFacts,
  type ToolItem,
  toolFacts,
} from "../model/index.ts";
import { reveal } from "../reveal.ts";
import { startedAt } from "../started.ts";
import { filesRootOf } from "../store/index.ts";
import { AgentLink } from "./agent-link.tsx";
import { CommandText } from "./command-text.tsx";
import { useI18n } from "./i18n.tsx";
import { ImageBlockView } from "./image.tsx";
import { Elapsed } from "./inline-ai-status.tsx";
import { isSafeLink, Markdown } from "./markdown.tsx";
import { useStartScope } from "./start-scope.ts";
import { useAppState, useAppStore } from "./store-context.tsx";

/** Opens a card when the Overview asks to show one of these items, and when it mounts while that is still asked. */
export function useRevealOpen(ids: readonly string[], setOpen: (open: boolean) => void) {
  const key = ids.join("\n");
  useEffect(() => {
    const held = new Set(key.split("\n"));
    const check = () => {
      const asked = reveal.get();
      if (asked !== undefined && held.has(asked.itemId)) setOpen(true);
    };
    check();
    return reveal.subscribe(check);
  }, [key, setOpen]);
}

/** The status words a tool call has in the catalog; any other is shown as it came. */
const STATUS_WORDS = new Set([
  "pending",
  "in_progress",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
export const statusWord = (t: (key: string) => string, status: string): string =>
  STATUS_WORDS.has(status) ? t(`tool.status.${status}`) : status.replace("_", " ");

const MAX_SHOWN = 20_000;

export const clip = (text: string): string =>
  text.length > MAX_SHOWN
    ? `${text.slice(0, MAX_SHOWN)}\n… (${text.length - MAX_SHOWN} more characters not shown)`
    : text;

/** A text drawn up to the limit, with a button that draws the next page of it, until all of it is. */
function PagedText({
  text,
  render = (shown) => shown,
}: {
  text: string;
  render?: (shown: string) => ReactNode;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const [pages, setPages] = useState(1);
  const end = MAX_SHOWN * pages;
  const left = text.length - end;
  return (
    <>
      {render(left > 0 ? text.slice(0, end) : text)}
      {left > 0 ? (
        <button
          type="button"
          data-slot="tool-more"
          onClick={() => {
            setPages(pages + 1);
            store.track("tool_output_expanded", {});
          }}
        >
          {t("tool.moreCharacters", { count: left })}
        </button>
      ) : null}
    </>
  );
}

/** A call's locations as one short summary (`a.ts`, or `a.ts +2` when it touched several). */
const locationsSummary = (tool: ToolItem): string | undefined => {
  const paths = (tool.locations ?? [])
    .map((loc) => loc.path)
    .filter((p): p is string => typeof p === "string" && p !== "");
  if (paths.length === 0) return undefined;
  const unique = [...new Set(paths)];
  return unique.length > 1 ? `${unique[0]} +${unique.length - 1}` : unique[0];
};

/** What a call acted on: its command, path, pattern, address or query. Shown, never run. */
export const toolSummary = (tool: ToolItem): string => {
  // A command that only searches, reads or lists, with no sentence of the agent's for it: what it searched or read,
  // after its verb ("Searched 'foo' in src"); else the command itself. A row with the agent's sentence does not show it
  // on the line (only in its tooltip, and to a screen reader).
  const label = commandLabelOf(tool);
  if (label !== undefined) return label.detail;
  const key = summaryKey(tool);
  if (key !== undefined) return String((tool.rawInput as Record<string, unknown>)[key]);
  const command = commandOf(tool);
  if (command !== undefined) return command;
  const located = locationsSummary(tool);
  if (located !== undefined) return located;
  const fallback = questionsOf(tool)[0] ?? firstShortText(tool);
  if (fallback !== undefined) return fallback;
  // When the verb is a generic activity ("Ran", "Read", "Searched", ...), fall back to ACP's title if it says more
  // than the bare tool name. For `other`, the verb already shows `toolName` (which is `tool.title`), so never repeat it.
  if (
    activityOf(tool) !== "other" &&
    typeof tool.title === "string" &&
    tool.title.trim() !== "" &&
    tool.title !== tool.name &&
    tool.title !== "Tool"
  )
    return tool.title;
  return "";
};

/**
 * For a tool this page knows nothing of (an MCP tool, a new built-in one): the first short line of text in its input
 * ("Fix the login bug" of an issue to create). A long text, a list or an object says too much for a line.
 */
const firstShortText = (tool: ToolItem): string | undefined => {
  const input = tool.rawInput;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  // The sentence that already is the line (an Agent's description) is not said again after it.
  const said = toolDescription(tool);
  for (const value of Object.values(input)) {
    if (typeof value !== "string") continue;
    const line = value.trim();
    if (line === said) continue;
    if (line !== "" && line.length <= SHORT_TEXT && !line.includes("\n")) return line;
  }
  return undefined;
};

/** The first line of `text`, cut to what a tooltip or a spoken name can carry. */
const hint = (text: string): string => {
  const line = text.trim().split("\n")[0] ?? "";
  const cut = line.length > HINT_CHARS || text.trim().includes("\n");
  return cut ? `${line.slice(0, HINT_CHARS).trimEnd()}…` : line;
};

const HINT_CHARS = 200;

/** The longest input text that is still a line's summary. */
const SHORT_TEXT = 120;

/** What a call is called for people: its title when the agent gave one ("linear · create_issue"), else its name. */
export const toolName = (t: (key: string) => string, tool: ToolItem): string =>
  tool.title ?? tool.name ?? t("tool.unnamed");

/** The questions a call put to the person (Claude's AskUserQuestion), when its input has them. */
const questionsOf = (tool: ToolItem): string[] => {
  const questions = ((tool.rawInput ?? {}) as Record<string, unknown>).questions;
  return Array.isArray(questions)
    ? questions.flatMap((q) =>
        typeof (q as { question?: unknown })?.question === "string" ? [String(q.question)] : [],
      )
    : [];
};

/** A plan a call proposes (Claude's ExitPlanMode), when its input has one: shown as the document it is. */
const planOf = (tool: ToolItem): string | undefined => {
  const plan = ((tool.rawInput ?? {}) as Record<string, unknown>).plan;
  return typeof plan === "string" && plan.trim() !== "" ? plan : undefined;
};

const SUMMARY_KEYS = [
  "command",
  "CommandLine",
  "file_path",
  "notebook_path",
  "path",
  "Path",
  "pattern",
  "url",
  "query",
];

/** Which field of the input the line shows. */
const summaryKey = (tool: ToolItem): string | undefined => {
  const input = (tool.rawInput ?? {}) as Record<string, unknown>;
  return SUMMARY_KEYS.find((key) => typeof input[key] === "string" && input[key] !== "");
};

/** Fields of a command's input the panel or the line already says: the command, what it is for, where it runs. */
const COMMAND_SAID = new Set([
  "command",
  "CommandLine",
  "description",
  "cwd",
  "run_in_background",
  "timeout",
]);
const saidByCommand = (tool: ToolItem): boolean =>
  typeof tool.rawInput === "object" &&
  tool.rawInput !== null &&
  !Array.isArray(tool.rawInput) &&
  Object.keys(tool.rawInput as Record<string, unknown>).every((key) => COMMAND_SAID.has(key));

/** Extra fields of a command call beyond what the command block already shows, so the command text is never duplicated. */
const extraCommandInput = (rawInput: unknown): Record<string, unknown> | undefined => {
  if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput))
    return undefined;
  const rest = Object.fromEntries(
    Object.entries(rawInput as Record<string, unknown>).filter(([key]) => !COMMAND_SAID.has(key)),
  );
  return Object.keys(rest).length > 0 ? rest : undefined;
};

/** An input with nothing in it the line does not already say (a Read of a path): not shown again when opened. */
const saidByLine = (tool: ToolItem): boolean => {
  const input = tool.rawInput;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const key = summaryKey(tool);
  return Object.keys(input).every((k) => k === key);
};

/**
 * What the agent said the call is for, when it said ("Run the daemon tests"): a sentence of its own, easier to read than
 * the command it explains. Bash, Monitor and Agent take one.
 */
export const toolDescription = (tool: ToolItem): string | undefined => {
  // Only where the field is that sentence: an MCP tool's `description` is often content (an issue's body), not a purpose.
  if (!PURPOSE_TOOLS.has(tool.name ?? "")) return undefined;
  const description = ((tool.rawInput ?? {}) as Record<string, unknown>).description;
  if (typeof description !== "string") return undefined;
  const line = description.trim();
  // A sentence, not a document: one line, of a length a line can hold.
  return line !== "" && !line.includes("\n") && line.length <= 160 ? line : undefined;
};

/** The tools whose `description` is the agent's sentence for what the call is for. */
const PURPOSE_TOOLS: ReadonlySet<string> = new Set(["Bash", "Monitor", "Agent", "Task"]);

const stringify = (value: unknown): string => {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

/**
 * What a call did, as a verb in its tense: "Running" while it goes, "Ran" once it has. A tool with no verb of its own is
 * named instead.
 */
export const toolVerb = (
  t: (key: string) => string,
  tool: ToolItem,
  going: boolean,
  facts?: ToolFacts,
): string => {
  const activity = activityOf(tool);
  if (!going && (facts ?? toolFacts(tool)).edit?.created === true)
    return t("tool.verb.create.done");
  // Said by what the input holds, not by the tool's name: a question put, a plan proposed.
  if (activity === "other" && questionsOf(tool).length > 0)
    return t(`tool.verb.ask.${going ? "live" : "done"}`);
  if (activity === "other" && planOf(tool) !== undefined)
    return t(`tool.verb.plan.${going ? "live" : "done"}`);
  if (activity === "other") return toolName(t, tool);
  return t(`tool.verb.${activity}.${going ? "live" : "done"}`);
};

/** A call to Claude's advisor (the API's server tool), as Claude's adapter names it. */
const isAdvisor = (tool: ToolItem): boolean => tool.name === "advisor";

/**
 * Claude asking its advisor: one line, the verb in its tense and how long it has been asking (the API answers whole,
 * after a pause), or that it could not answer. It opens to the advice when the API gives it in the clear, else to why
 * there is none to read: encrypted (newer advisor models), or the error's code.
 */
function AdvisorCard({ tool, openState }: { tool: ToolItem; openState?: OpenState | undefined }) {
  const { t } = useI18n();
  const scope = useStartScope();
  const [open, setOpen] = useRowOpen(openState);
  const status = tool.status ?? "pending";
  const going = isLive(tool);
  const failed = status === "failed" || status === "cancelled";
  const raw = (tool.rawOutput ?? {}) as { type?: unknown; error_code?: unknown };
  const code = typeof raw.error_code === "string" ? raw.error_code : undefined;
  const advice = streamsOf(tool).out;
  return (
    <Collapsible
      data-kind="tool"
      data-status={status}
      data-item-id={tool.id}
      data-advisor=""
      open={open}
      onOpenChange={setOpen}
    >
      <CollapsibleTrigger>
        <span data-slot="tool-verb">
          {status === "failed"
            ? t("tool.advisor.failed")
            : toolVerb(t, tool, going, toolFacts(tool))}
        </span>{" "}
        {going && status === "in_progress" ? (
          <Elapsed since={startedAt(`${scope}:tool:${tool.id}`)} slot="tool-elapsed" />
        ) : null}{" "}
        <span data-slot={failed ? "tool-status" : "visually-hidden"}>{statusWord(t, status)}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        {advice !== "" ? (
          <div data-slot="tool-plan">
            <Markdown text={advice} />
          </div>
        ) : going ? null : (
          <p data-slot="tool-note">
            {code !== undefined
              ? t("tool.advisor.error", { code })
              : status === "completed"
                ? t("tool.advisor.encrypted")
                : statusWord(t, status)}
          </p>
        )}
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** One call as its row: the advisor's own, or any other's. */
export function ToolCard({ tool, openState }: { tool: ToolItem; openState?: OpenState }) {
  return isAdvisor(tool) ? (
    <AdvisorCard tool={tool} openState={openState} />
  ) : (
    <CallCard tool={tool} openState={openState} />
  );
}

/** An open flag held by a parent, so it outlives the row when the parent draws it in another place. */
export type OpenState = readonly [boolean, (open: boolean) => void];

function useRowOpen(held: OpenState | undefined): OpenState {
  const own = useState(false);
  return held ?? own;
}

/**
 * One call, as one quiet line: what it did and on what. The verb's tense says whether it is going; a failure says so in
 * a word as well as in red. It opens to what it was given and what came back.
 */
function CallCard({ tool, openState }: { tool: ToolItem; openState?: OpenState | undefined }) {
  const { t } = useI18n();
  const store = useAppStore();
  // A file it read or changed, inside the session's folder: it can be shown in the Files tab. Not one it deleted or moved
  // away, and not from a call that failed: there may be nothing there to show.
  const activity = activityOf(tool);
  const where = tool.locations?.[0]?.path;
  const filesRoot = useAppState(filesRootOf);
  const inFiles =
    tool.status === "completed" &&
    (activity === "read" || activity === "edit") &&
    tool.toolKind !== "delete" &&
    tool.toolKind !== "move" &&
    typeof where === "string" &&
    filesRoot !== undefined
      ? insideFolder(where, filesRoot)
      : undefined;
  const scope = useStartScope();
  const status = tool.status ?? "pending";
  const failed = status === "failed" || status === "cancelled";
  // The model ends a turn's calls when the turn ends (cancelled), so one that is live is going.
  const going = isLive(tool);
  // Every row starts closed, whatever its state: the head says in red words how one ended badly, and opening it is the
  // person's choice.
  const [open, setOpen] = useRowOpen(openState);
  const streams = streamsOf(tool);
  const output = tool.content.length > 0 ? streams.out : stringify(tool.rawOutput);
  const command = commandOf(tool);
  const plan = planOf(tool);
  const questions = questionsOf(tool);
  const subagent = tool.subagent;
  // The clock runs only while the call goes. A sub-agent that runs on in the background says so in words: its end may
  // never come (the agent's process went with the daemon), and a clock that runs for good would say it is working.
  const working = going && status === "in_progress";
  const description = toolDescription(tool);
  // No mark says a call is going (CYCL-139): words do. The verb's tense says so ("Running"), but not the agent's
  // sentence, and not a call still waiting ("pending"): then the state is written out.
  const stateShown = failed || (going && (description !== undefined || status !== "in_progress"));
  // With the agent's sentence, the line is that sentence alone (CYCL-137): what it acted on is in the panel, and, as its
  // first line, in the tooltip and the row's name, so a screen reader still hears what ran.
  const acted = toolSummary(tool);
  const summary = description === undefined ? acted : "";
  const actedLine = hint(acted);
  const facts = toolFacts(tool);
  // The file an edit changed, named as the Diff tab names it (from the session's folder).
  const editPath = facts.edit !== undefined ? editPathOf(tool) : undefined;
  const cwd = useAppState((state) =>
    state.selectedLocation !== undefined
      ? state.sessions[state.selectedLocation]?.find((x) => x.sessionId === state.selectedSession)
          ?.cwd
      : undefined,
  );
  // An edit's diff says what its input said (old and new strings, a whole file), and says it better.
  const diff = facts.edit?.lines;
  const input =
    facts.edit === undefined &&
    tool.rawInput !== undefined &&
    !saidByLine(tool) &&
    !(command !== undefined && saidByCommand(tool)) &&
    plan === undefined &&
    questions.length === 0
      ? command !== undefined
        ? extraCommandInput(tool.rawInput)
        : tool.rawInput
      : undefined;
  // The tooltip names the tool, holds the whole sentence when the line cuts it, and what the call acted on.
  const tip =
    description !== undefined
      ? [[toolName(t, tool), description].join(": "), actedLine].filter(Boolean).join("\n")
      : toolName(t, tool);
  const summaryTip = summary || undefined;
  return (
    <Collapsible
      data-kind="tool"
      data-status={status}
      data-item-id={tool.id}
      open={open}
      onOpenChange={setOpen}
    >
      <CollapsibleTrigger>
        {/* Which tool it was is for a screen reader and the tooltip of the line; the words say what it did. With a
            description, that is the whole line (what it is for); else the verb in its tense, then what it acted on. */}
        <span data-slot="visually-hidden">{toolName(t, tool)}</span>{" "}
        <span data-slot="tool-verb" data-prose={description !== undefined || undefined} title={tip}>
          {description ?? toolVerb(t, tool, going, facts)}
        </span>{" "}
        {description !== undefined && actedLine !== "" ? (
          <span data-slot="visually-hidden">{actedLine}</span>
        ) : null}{" "}
        <span
          data-slot="tool-summary"
          data-prose={questions.length > 0 || undefined}
          title={summaryTip}
        >
          {summary}
        </span>{" "}
        {subagent !== undefined ? <SubagentFacts subagent={subagent} /> : <Facts facts={facts} />}{" "}
        {/* How long it has been at work, counted from when the page first saw it: the row drawn again goes on. */}
        {working ? (
          <Elapsed since={startedAt(`${scope}:tool:${tool.id}`)} slot="tool-elapsed" />
        ) : null}{" "}
        <span data-slot={stateShown ? "tool-status" : "visually-hidden"}>
          {statusWord(t, status)}
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        {command !== undefined ? (
          <Copyable
            kind="command"
            text={command}
            ended={going ? undefined : endOf(status, facts)}
          />
        ) : null}
        {plan !== undefined ? (
          <div data-slot="tool-plan">
            <Markdown text={plan} />
          </div>
        ) : null}
        {questions.length > 1 ? (
          <ol data-slot="tool-questions">
            {questions
              .map((question, index) => ({ question, key: `${index}:${question}` }))
              .map(({ question, key }) => (
                <li key={key}>{question}</li>
              ))}
          </ol>
        ) : null}
        {input !== undefined ? (
          <PagedText
            text={stringify(input)}
            render={(shown) => <pre data-slot="tool-input">{shown}</pre>}
          />
        ) : null}
        {facts.edit !== undefined && editPath !== undefined && status === "completed" ? (
          <DiffHead
            path={shownPath(editPath, cwd)}
            additions={facts.edit.additions}
            deletions={facts.edit.deletions}
            status={
              facts.edit.staged
                ? t("tool.facts.staged")
                : facts.edit.created
                  ? t("diff.status.created")
                  : undefined
            }
            // Joined to what is under it: the change, or the note that it is too large to draw.
            joined={diff !== undefined || facts.edit.additions + facts.edit.deletions > 0}
            onOpen={() => {
              if (store.showInDiff(tool.id)) store.track("diff_shown_from_conversation", {});
            }}
          />
        ) : null}
        {diff !== undefined ? <DiffView lines={diff} /> : null}
        {facts.edit !== undefined &&
        diff === undefined &&
        facts.edit.additions + facts.edit.deletions > 0 ? (
          <p data-slot="tool-note">{t("tool.diff.tooLarge")}</p>
        ) : null}
        {inFiles !== undefined ? (
          <button
            type="button"
            data-slot="tool-files-link"
            onClick={() => {
              store.showInFiles(inFiles);
              store.track("file_shown_from_conversation", {
                target: "file",
                from: "tool",
                line: false,
              });
            }}
          >
            {t("files.showInFiles")}
          </button>
        ) : null}
        {output !== "" ? <Copyable kind="output" text={output} /> : null}
        {streams.err !== "" ? <Copyable kind="stderr" text={streams.err} failed={failed} /> : null}
        {facts.links.length > 0 ? <LinkList links={facts.links} /> : null}
        {facts.images.map((image) => (
          <ImageBlockView
            key={image.key}
            block={image.block}
            from="agent"
            set={facts.images.map((each) => each.block)}
          />
        ))}
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** The numbers after a call's summary: what an edit changed, which lines a read read, what a search found. */
function Facts({ facts }: { facts: ToolFacts }) {
  const i18n = useI18n();
  const { t } = i18n;
  const { edit, read, search } = facts;
  if (edit !== undefined) {
    const label = t("tool.facts.diff", { added: edit.additions, removed: edit.deletions });
    const counted = edit.additions + edit.deletions > 0;
    const empty = edit.created && edit.additions === 0;
    const tip = counted ? label : undefined;
    return (
      <span data-slot="tool-facts" title={tip}>
        {empty ? t("tool.facts.empty") : null}
        {counted ? (
          <>
            {edit.additions > 0 ? (
              <span data-tone="add">{t("tool.facts.added", { count: edit.additions })}</span>
            ) : null}
            {edit.additions > 0 && edit.deletions > 0 ? " " : null}
            {edit.deletions > 0 ? (
              <span data-tone="del">{t("tool.facts.removed", { count: edit.deletions })}</span>
            ) : null}
            <span data-slot="visually-hidden">{label}</span>
          </>
        ) : null}
        {/* Held for review: the file is as it was, whatever the counts say. */}
        {edit.staged ? (
          <>
            {empty || counted ? " " : null}
            <span>{t("tool.facts.staged")}</span>
          </>
        ) : null}
      </span>
    );
  }
  if (facts.run !== undefined) {
    const { interrupted, timedOutMs, background, exitCode } = facts.run;
    const text = interrupted
      ? t("tool.facts.interrupted")
      : exitCode !== undefined && exitCode !== 0
        ? t("tool.facts.exitCode", { code: exitCode })
        : timedOutMs !== undefined
          ? t("tool.facts.timedOut", { duration: durationOf(i18n, timedOutMs) })
          : background
            ? t("tool.facts.background")
            : undefined;
    return text === undefined ? null : <span data-slot="tool-facts">{text}</span>;
  }
  if (read !== undefined) {
    // Past the end of the file (or an empty one): no lines were read, and there is no range to give.
    if (read.count === 0)
      return <span data-slot="tool-facts">{t("tool.facts.lines", { count: 0 })}</span>;
    const whole = read.start === 1 && read.total !== undefined && read.count >= read.total;
    const end = read.start + Math.max(0, read.count - 1);
    const text = whole
      ? t("tool.facts.lines", { count: read.count })
      : read.total !== undefined
        ? t("tool.facts.rangeOf", { start: read.start, end, total: read.total })
        : t("tool.facts.range", { start: read.start, end });
    return <span data-slot="tool-facts">{text}</span>;
  }
  if (facts.fetch !== undefined) {
    const { status, bytes } = facts.fetch;
    const text =
      bytes !== undefined
        ? t("tool.facts.fetched", { status: String(status), size: sizeOf(i18n, bytes) })
        : t("tool.facts.status", { status: String(status) });
    return (
      <span data-slot="tool-facts" data-tone={status >= 400 ? "danger" : undefined}>
        {text}
      </span>
    );
  }
  if (search !== undefined) {
    const files = search.more
      ? t("tool.facts.filesMore", { count: search.files })
      : t("tool.facts.files", { count: search.files });
    const text =
      search.matches !== undefined
        ? t("tool.facts.matchesIn", { count: search.matches, files })
        : search.lines !== undefined
          ? t("tool.facts.lines", { count: search.lines })
          : files;
    return <span data-slot="tool-facts">{text}</span>;
  }
  return null;
}

/** The most lines of one diff drawn; the rest are counted. */
const MAX_DIFF_LINES = 400;

/** How much an edit changed, in green and red signs, and in words for a screen reader. Shared with the Diff tab. */
export function Counts({
  additions,
  deletions,
}: {
  additions: number | undefined;
  deletions: number | undefined;
}) {
  const { t } = useI18n();
  if (additions === undefined || deletions === undefined) return null;
  return (
    <span
      data-slot="diff-counts"
      title={t("tool.facts.diff", { added: additions, removed: deletions })}
    >
      <span data-slot="diff-added" aria-hidden="true">
        +{additions}
      </span>
      <span data-slot="diff-removed" aria-hidden="true">
        −{deletions}
      </span>
      <span data-slot="visually-hidden">
        {t("tool.facts.diff", { added: additions, removed: deletions })}
      </span>
    </span>
  );
}

/**
 * Above a call's change: the file it changed, and how much, as the Diff tab lists it. A press opens it there, among the
 * session's other edits (CYCL-133). Its name says so, not only its tooltip.
 */
function DiffHead({
  path,
  additions,
  deletions,
  status,
  joined,
  onOpen,
}: {
  path: string;
  additions: number;
  deletions: number;
  status: string | undefined;
  joined: boolean;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      data-slot="tool-diff-head"
      data-joined={joined || undefined}
      title={`${t("diff.showInDiff")}: ${path}`}
      onClick={onOpen}
    >
      <span data-slot="visually-hidden">{t("diff.showInDiff")}: </span>
      <span data-slot="tool-diff-path">
        <bdi>{path}</bdi>
      </span>
      {status !== undefined ? <span data-slot="diff-status">{status}</span> : null}
      <Counts additions={additions} deletions={deletions} />
    </button>
  );
}

/** One call's change, line by line: removed and added lines marked, and numbered as in the file. */
export function DiffView({ lines }: { lines: DiffLine[] }) {
  const { t } = useI18n();
  const store = useAppStore();
  const [limit, setLimit] = useState(MAX_DIFF_LINES);
  const skipped = useMemo(() => skippedLines(lines), [lines]);
  // The first hunk's marker says only that the change starts somewhere: its numbers say where. Between hunks it marks the gap.
  const shown = (lines[0]?.kind === "hunk" ? lines.slice(1) : lines).slice(0, limit);
  const rest =
    lines.filter((line) => line.kind !== "hunk").length -
    shown.filter((line) => line.kind !== "hunk").length;
  return (
    <div data-slot="tool-diff">
      {shown.map((line) => (
        <div key={line.id} data-line={line.kind}>
          <span data-slot="diff-number" aria-hidden="true">
            {line.line ?? ""}
          </span>
          <span data-slot="diff-sign" aria-hidden="true">
            {SIGNS[line.kind]}
          </span>
          {line.kind !== "hunk" ? (
            <span data-slot="visually-hidden">{t(`tool.diff.${line.kind}`)}</span>
          ) : null}
          <span data-slot="diff-text">
            {line.kind !== "hunk"
              ? line.text
              : skipped.has(line.id)
                ? t("tool.diff.skipped", { count: skipped.get(line.id) ?? 0 })
                : ""}
          </span>
        </div>
      ))}
      {rest > 0 ? (
        <button
          type="button"
          data-slot="tool-more"
          onClick={() => {
            setLimit(limit + MAX_DIFF_LINES);
            store.track("tool_output_expanded", {});
          }}
        >
          {t("tool.diff.more", { count: rest })}
        </button>
      ) : null}
    </div>
  );
}

const SIGNS: Record<DiffLine["kind"], string> = { add: "+", del: "−", context: "", hunk: "⋯" };

/**
 * A length of time as people say it, each part a unit `Intl` writes in the person's language: "45 sec", "2 min",
 * "1 min, 30 sec".
 */
export const durationOf = (
  { number, locale }: Pick<Translator, "number" | "locale">,
  ms: number,
): string => {
  const seconds = Math.round(ms / 1000);
  const unit = (value: number, of: "minute" | "second") =>
    number(value, { style: "unit", unit: of, unitDisplay: "short" });
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return unit(seconds, "second");
  const parts =
    rest === 0 ? [unit(minutes, "minute")] : [unit(minutes, "minute"), unit(rest, "second")];
  return new Intl.ListFormat(locale, { style: "narrow", type: "unit" }).format(parts);
};

/** How a command ended, on its block's head: it ran through, or it failed, and with which code when it said one. */
export type CommandEnd = { ok: true } | { ok: false; code?: number };

/**
 * How a command ended, once it has: through, when it completed and nothing said otherwise; failed, with its code when the
 * agent gave one. A command cut short, sent to the background or timed out says so on its line, and has no end here.
 */
export const endOf = (status: string, facts: ToolFacts): CommandEnd | undefined => {
  const run = facts.run;
  if (run?.interrupted || run?.background || run?.timedOutMs !== undefined) return undefined;
  if (run?.exitCode !== undefined && run.exitCode !== 0) return { ok: false, code: run.exitCode };
  if (status === "failed") return { ok: false };
  return status === "completed" && run !== undefined ? { ok: true } : undefined;
};

/** How many lines of a long output are shown before it is opened whole: its end, where a command says how it went. */
const TAIL_LINES = 40;
/** Earlier lines drawn per click. */
const PAGE_LINES = 200;

/**
 * An output too long to draw keeps its end, where a command says how it went: the lines from the last one back, for as
 * many characters as are drawn; how many earlier ones are left out is said.
 */
const clipLines = (lines: AnsiRun[][], max: number): { lines: AnsiRun[][]; dropped: number } => {
  const lengths = lines.map((line) => line.reduce((n, run) => n + run.text.length, 0));
  const total = lengths.reduce((sum, n) => sum + n + 1, -1);
  if (total <= max) return { lines, dropped: 0 };
  const dropped = total - max;
  // Where the kept text starts: whole lines (and their line breaks) first, then into the line it starts in.
  let left = dropped;
  let line = 0;
  while (line < lines.length && left > (lengths[line] as number)) {
    left -= (lengths[line] as number) + 1;
    line += 1;
  }
  const first = lines[line] ?? [];
  let run = 0;
  while (run < first.length && left >= (first[run] as AnsiRun).text.length) {
    left -= (first[run] as AnsiRun).text.length;
    run += 1;
  }
  const partial = first[run];
  const head =
    partial === undefined
      ? first.slice(run)
      : [{ text: partial.text.slice(left), style: partial.style }, ...first.slice(run + 1)];
  return { lines: [head, ...lines.slice(line + 1)], dropped };
};

/** A colour a command asked for: one of the 16, as the terminal draws it made readable here, or the one it gave. */
const colorOf = (color: AnsiColor): string =>
  "named" in color ? (ANSI_COLORS[color.named] ?? "inherit") : color.rgb;

const styleOf = (style: AnsiStyle): CSSProperties | undefined => {
  if (Object.keys(style).length === 0) return undefined;
  return {
    ...(style.fg !== undefined ? { color: colorOf(style.fg) } : {}),
    ...(style.bg !== undefined ? { backgroundColor: colorOf(style.bg) } : {}),
    ...(style.bold ? { fontWeight: 600 } : {}),
    ...(style.dim ? { opacity: 0.65 } : {}),
    ...(style.italic ? { fontStyle: "italic" } : {}),
    ...(style.underline ? { textDecoration: "underline" } : {}),
  };
};

/** Lines of what a command printed, in the colours it printed them in. A run is known by where it starts in the text. */
function AnsiText({ lines }: { lines: AnsiRun[][] }) {
  const nodes: ReactNode[] = [];
  let offset = 0;
  lines.forEach((line, index) => {
    if (index > 0) {
      nodes.push("\n");
      offset += 1;
    }
    for (const run of line) {
      const style = styleOf(run.style);
      nodes.push(
        style === undefined ? (
          run.text
        ) : (
          <span key={offset} style={style}>
            {run.text}
          </span>
        ),
      );
      offset += run.text.length;
    }
  });
  return nodes;
}

/**
 * A command, an output or an output's errors: sunken, with a button to copy all of it. A long output shows its last
 * lines, and says how many more there are; one click shows the rest. An output is drawn in the colours the command
 * printed it in, and copied without them. A command's head says how it ended, once it has.
 */
export function Copyable({
  kind,
  text,
  ended,
  failed = false,
}: {
  kind: "command" | "output" | "stderr";
  text: string;
  ended?: CommandEnd | undefined;
  /** The call failed: its errors are why, and are drawn in the danger colour. Else they may be a warning, or progress. */
  failed?: boolean;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  // How many pages of earlier lines are drawn: each click adds one, so a huge log is never drawn at once.
  const [pages, setPages] = useState(0);
  // What the button says after a press: copied, or why not.
  const [copied, setCopied] = useState<"done" | "failed" | undefined>(undefined);
  // Until it is opened whole, only the lines shown are read into runs: a long log that grows is not parsed whole each time.
  const read = useMemo(() => {
    if (kind === "command") return { lines: [], total: 0 };
    return ansiTail(text, TAIL_LINES + pages * PAGE_LINES);
  }, [kind, text, pages]);
  const hidden = read.total - read.lines.length;
  const shown = useMemo(() => clipLines(read.lines, MAX_SHOWN * (pages + 1)), [read, pages]);
  const label = t(`tool.copy.${kind}`);
  return (
    <div data-slot="tool-block" data-kind={kind} data-failed={failed || undefined}>
      <div data-slot="tool-block-head">
        <span data-slot="tool-block-label">{t(`tool.block.${kind}`)}</span>
        {ended !== undefined ? (
          <span data-slot="tool-end" data-tone={ended.ok ? "ok" : "danger"}>
            {ended.ok
              ? t("tool.end.ok")
              : ended.code !== undefined
                ? t("tool.facts.exitCode", { code: ended.code })
                : t("tool.end.failed")}
          </span>
        ) : null}
        <button
          type="button"
          data-slot="tool-copy"
          aria-label={label}
          title={label}
          onClick={() => {
            void store.copyText(kind === "command" ? text : plainText(text)).then((done) => {
              setCopied(done ? "done" : "failed");
              if (done)
                store.track("tool_copied", { part: kind === "command" ? "command" : "output" });
            });
          }}
          onBlur={() => setCopied(undefined)}
        >
          {copied === "done"
            ? t("tool.copied")
            : copied === "failed"
              ? t("tool.copyFailed")
              : t("tool.copy")}
        </button>
      </div>
      {hidden > 0 || shown.dropped > 0 ? (
        <button
          type="button"
          data-slot="tool-more"
          onClick={() => {
            setPages(pages + 1);
            store.track("tool_output_expanded", {});
          }}
        >
          {hidden > 0
            ? t("tool.more", { count: Math.min(hidden, PAGE_LINES) })
            : t("tool.moreCharacters", { count: shown.dropped })}
        </button>
      ) : null}
      {kind === "command" ? (
        <pre data-slot="tool-command">
          <PagedText text={text} render={(shown) => <CommandText text={shown} />} />
        </pre>
      ) : (
        <pre data-slot="tool-output">
          {shown.dropped > 0 ? `${t("tool.earlierCharacters", { count: shown.dropped })}\n` : null}
          <AnsiText lines={shown.lines} />
        </pre>
      )}
    </div>
  );
}

/**
 * What a sub-agent is doing, on the line of the call that started it: what it uses now (or the SDK's line on what it is
 * doing) while it runs, and how much it did when it is done.
 */
export function SubagentFacts({ subagent }: { subagent: NonNullable<ToolItem["subagent"]> }) {
  const i18n = useI18n();
  const { t } = i18n;
  const parts: string[] = [];
  if (subagent.state === "running") {
    if (subagent.background) parts.push(t("tool.facts.background"));
    if (subagent.summary !== undefined) parts.push(subagent.summary);
    else if (subagent.lastTool !== undefined)
      parts.push(t("subagent.using", { tool: subagent.lastTool }));
  } else {
    parts.push(t(`subagent.${subagent.state}`));
    if (subagent.usage !== undefined && subagent.usage.toolUses > 0) {
      parts.push(t("subagent.steps", { count: subagent.usage.toolUses }));
    }
    if (subagent.usage !== undefined && subagent.usage.durationMs > 0) {
      parts.push(durationOf(i18n, subagent.usage.durationMs));
    }
  }
  const text = parts.join(" · ");
  return text === "" ? null : (
    <span data-slot="tool-facts" data-tone={subagent.state === "failed" ? "danger" : undefined}>
      {text}
    </span>
  );
}

/** A size in bytes as people read it: "820 byte", "1.5 kB", "120 kB", "1.4 MB", in the person's language. */
const sizeOf = ({ number }: Pick<Translator, "number">, bytes: number): string => {
  if (bytes < 1000) return number(bytes, { style: "unit", unit: "byte", unitDisplay: "short" });
  // The unit is chosen after rounding: 999,600 bytes is 1 MB, not "1,000 kB".
  if (bytes < 999_500)
    return number(bytes / 1000, {
      style: "unit",
      unit: "kilobyte",
      unitDisplay: "short",
      // A tenth where it is a fair part of the whole: 1.5 kB, but 120 kB.
      maximumFractionDigits: bytes < 10_000 ? 1 : 0,
    });
  return number(bytes / 1_000_000, {
    style: "unit",
    unit: "megabyte",
    unitDisplay: "short",
    maximumFractionDigits: 1,
  });
};

/**
 * Addresses a call gave back (a web search's hits): the title as a link, and its site beside it, so where it goes is
 * seen before it is opened. Only web addresses are links; the system browser opens them (main), the page never loads
 * one. Anything else is shown as text.
 */
function LinkList({ links }: { links: ToolFacts["links"] }) {
  const store = useAppStore();
  return (
    <ul data-slot="tool-links">
      {links.map((link) => {
        const safe = isSafeLink(link.uri);
        const site = siteOf(link.uri);
        return (
          <li key={link.key}>
            {safe ? (
              <AgentLink
                href={link.uri}
                title={link.uri}
                // That one was opened, never which.
                onOpened={() => store.track("tool_link_opened", {})}
              >
                {link.name}
              </AgentLink>
            ) : (
              <span data-slot="unsafe-link">{link.name}</span>
            )}
            {site !== undefined ? <span data-slot="tool-link-site">{site}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The site of an address ("bun.sh"), or nothing when it is not one. */
const siteOf = (uri: string): string | undefined => {
  try {
    const host = new URL(uri).hostname;
    return host === "" ? undefined : host.replace(/^www\./, "");
  } catch {
    return undefined;
  }
};
