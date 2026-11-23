import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  ANSI_COLORS,
  type AnsiColor,
  type AnsiRun,
  type AnsiStyle,
  ansiLines,
  ansiTail,
  parseAnsi,
  plainText,
} from "../ansi.ts";
import { insideFolder } from "../files-view.ts";
import type { Translator } from "../i18n.ts";
import type { Activity, Block, DiffLine, ToolFacts, ToolItem } from "../model/index.ts";
import { activityOf, isLive, streamsOf, toolFacts } from "../model/index.ts";
import { reveal } from "../reveal.ts";
import { startedAt } from "../started.ts";
import { filesRootOf } from "../store/index.ts";
import { AgentLink } from "./agent-link.tsx";
import { useI18n } from "./i18n.tsx";
import {
  AgentIcon,
  CheckIcon,
  ChevronRightIcon,
  CloseIcon,
  FileIcon,
  GlobeIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
} from "./icons.tsx";
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

/**
 * Whether a card or row is open: it starts open when it holds a failure (that is what the person came to read), opens by
 * itself when a failure arrives while it is on screen, and after that follows the person's own clicks.
 */
export function useOpenOnFailure(failed: boolean): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(failed);
  const was = useRef(failed);
  useEffect(() => {
    if (failed && !was.current) setOpen(true);
    was.current = failed;
  }, [failed]);
  return [open, setOpen];
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

/** What a call acted on: its command, path, pattern, address or query. Shown, never run. */
export const toolSummary = (tool: ToolItem): string => {
  const key = summaryKey(tool);
  if (key !== undefined) return String((tool.rawInput as Record<string, unknown>)[key]);
  return questionsOf(tool)[0] ?? firstShortText(tool) ?? "";
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

const SUMMARY_KEYS = ["command", "file_path", "notebook_path", "path", "pattern", "url", "query"];

/** Which field of the input the line shows. */
const summaryKey = (tool: ToolItem): string | undefined => {
  const input = (tool.rawInput ?? {}) as Record<string, unknown>;
  return SUMMARY_KEYS.find((key) => typeof input[key] === "string");
};

/** The command a call ran, when its input has one: shown as a command, to read and copy, not as a field of JSON. */
const commandOf = (tool: ToolItem): string | undefined => {
  const input = tool.rawInput;
  if (typeof input !== "object" || input === null) return undefined;
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" && command !== "" ? command : undefined;
};

/** Fields of a command's input the panel or the line already says: the command, what it is for, where it runs. */
const COMMAND_SAID = new Set(["command", "description", "run_in_background", "timeout"]);
const saidByCommand = (tool: ToolItem): boolean =>
  Object.keys(tool.rawInput as Record<string, unknown>).every((key) => COMMAND_SAID.has(key));

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

/** What a finished call or stretch was, as a mark: a sub-agent, or one of the activities; else none. */
export type LeadKind = Activity | "subagent";

const KIND_ICONS: Partial<Record<LeadKind, (props: { size?: number }) => ReactNode>> = {
  read: FileIcon,
  edit: PencilIcon,
  search: SearchIcon,
  run: TerminalIcon,
  fetch: GlobeIcon,
  subagent: AgentIcon,
};

/**
 * What leads a line, for a call or a stretch of them: the spinner while it goes, a cross when it failed; once done, what
 * kind of thing it was (a file read, an edit, a search, a command, a page, a sub-agent), quiet, so a turn's work can be
 * read down the left edge. Anything else (waiting, never finished, stopped) and a kind without an icon: a small dot
 * (decision 2026-11-23-finished-calls-lead-with-their-kind).
 */
export function Lead({
  mark,
  kind,
}: {
  mark: "going" | "failed" | "done" | "other";
  kind?: LeadKind | undefined;
}) {
  const Icon = mark === "done" && kind !== undefined ? KIND_ICONS[kind] : undefined;
  return (
    <span data-slot="tool-lead">
      {mark === "going" ? (
        <span data-slot="spinner" aria-hidden="true" />
      ) : mark === "failed" ? (
        <CloseIcon size={14} data-slot="tool-mark" data-tone="danger" />
      ) : Icon !== undefined ? (
        <span data-slot="tool-kind" data-lead-kind={kind} aria-hidden="true">
          <Icon size={14} />
        </span>
      ) : (
        <span data-slot="tool-dot" aria-hidden="true" />
      )}
    </span>
  );
}

/**
 * One call, as one quiet line: what it did and on what. The verb's tense says whether it is going; a failure says so in
 * a word as well as in red. It opens to what it was given and what came back.
 */
export function ToolCard({ tool }: { tool: ToolItem }) {
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
  const [open, setOpen] = useOpenOnFailure(status === "failed");
  const streams = streamsOf(tool);
  const output = tool.content.length > 0 ? streams.out : stringify(tool.rawOutput);
  const command = commandOf(tool);
  const plan = planOf(tool);
  const questions = questionsOf(tool);
  const subagent = tool.subagent;
  // The mark spins only while the call goes. A sub-agent that runs on in the background says so in words: its end may
  // never come (the agent's process went with the daemon), and a mark that spins for good would say it is working.
  const working = going && status === "in_progress";
  const summary = toolSummary(tool);
  const description = toolDescription(tool);
  const facts = toolFacts(tool);
  // An edit's diff says what its input said (old and new strings, a whole file), and says it better.
  const diff = facts.edit?.lines;
  const input =
    facts.edit === undefined &&
    tool.rawInput !== undefined &&
    !saidByLine(tool) &&
    !(command !== undefined && saidByCommand(tool)) &&
    plan === undefined &&
    questions.length === 0
      ? tool.rawInput
      : undefined;
  // The tooltip names the tool, and holds the whole sentence when the line cuts it.
  const tip =
    description !== undefined ? [toolName(t, tool), description].join(": ") : toolName(t, tool);
  const summaryTip = summary || undefined;
  return (
    // A failure is what the person came to read: it starts open.
    <Collapsible
      data-kind="tool"
      data-status={status}
      data-item-id={tool.id}
      open={open}
      onOpenChange={setOpen}
    >
      <CollapsibleTrigger>
        <Lead
          mark={working ? "going" : failed ? "failed" : status === "completed" ? "done" : "other"}
          // A file removed or moved is no edit, whatever the agent files it under: no pencil for it.
          kind={tool.toolKind === "delete" || tool.toolKind === "move" ? undefined : activity}
        />{" "}
        {/* Which tool it was is for a screen reader and the tooltip of the line; the words say what it did. With a
            description, that is the line (what it is for), and what it ran follows it, muted; else the verb in its tense. */}
        <span data-slot="visually-hidden">{toolName(t, tool)}</span>{" "}
        <span data-slot="tool-verb" data-prose={description !== undefined || undefined} title={tip}>
          {description ?? toolVerb(t, tool, going, facts)}
        </span>{" "}
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
        <span data-slot={failed ? "tool-status" : "visually-hidden"}>{statusWord(t, status)}</span>{" "}
        <ChevronRightIcon size={12} data-slot="tool-chevron" aria-hidden="true" />
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
        {input !== undefined ? <pre data-slot="tool-input">{clip(stringify(input))}</pre> : null}
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
              store.track("file_shown_from_conversation", { target: "file", from: "tool" });
            }}
          >
            <FileIcon size={12} />
            {t("files.showInFiles")}
          </button>
        ) : null}
        {output !== "" ? <Copyable kind="output" text={output} /> : null}
        {streams.err !== "" ? <Copyable kind="stderr" text={streams.err} failed={failed} /> : null}
        {facts.links.length > 0 ? <LinkList links={facts.links} /> : null}
        {facts.images.map((image) => (
          <ImageBlockView key={image.key} block={image.block} from="agent" />
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
      : exitCode !== undefined
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

/** One call's change, line by line: removed and added lines marked, and numbered as in the file. */
export function DiffView({ lines }: { lines: DiffLine[] }) {
  const { t } = useI18n();
  // The first hunk's marker says only that the change starts somewhere: its numbers say where. Between hunks it marks the gap.
  const shown = (lines[0]?.kind === "hunk" ? lines.slice(1) : lines).slice(0, MAX_DIFF_LINES);
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
          <span data-slot="diff-text">{line.kind === "hunk" ? "" : line.text}</span>
        </div>
      ))}
      {rest > 0 ? <p data-slot="tool-note">{t("tool.diff.more", { count: rest })}</p> : null}
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
  const [whole, setWhole] = useState(false);
  // What the button says after a press: copied, or why not.
  const [copied, setCopied] = useState<"done" | "failed" | undefined>(undefined);
  // Until it is opened whole, only the lines shown are read into runs: a long log that grows is not parsed whole each time.
  const read = useMemo(() => {
    if (kind === "command") return { lines: [], total: 0 };
    if (!whole) return ansiTail(text, TAIL_LINES);
    const lines = ansiLines(parseAnsi(text));
    return { lines, total: lines.length };
  }, [kind, text, whole]);
  const hidden = read.total - read.lines.length;
  const shown = useMemo(
    () => (whole ? { lines: read.lines, dropped: 0 } : clipLines(read.lines, MAX_SHOWN)),
    [read, whole],
  );
  const label = t(`tool.copy.${kind}`);
  return (
    <div data-slot="tool-block" data-kind={kind} data-failed={failed || undefined}>
      <div data-slot="tool-block-head">
        <span data-slot="tool-block-label">{t(`tool.block.${kind}`)}</span>
        {ended !== undefined ? (
          <span data-slot="tool-end" data-tone={ended.ok ? "ok" : "danger"}>
            {ended.ok ? (
              <CheckIcon size={12} aria-hidden="true" />
            ) : (
              <CloseIcon size={12} aria-hidden="true" />
            )}
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
      {hidden > 0 ? (
        <button
          type="button"
          data-slot="tool-more"
          onClick={() => {
            setWhole(true);
            store.track("tool_output_expanded", {});
          }}
        >
          {t("tool.more", { count: hidden })}
        </button>
      ) : null}
      {kind === "command" ? (
        <pre data-slot="tool-command">{clip(text)}</pre>
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
