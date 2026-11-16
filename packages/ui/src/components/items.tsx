import { type Item, type TurnOrigin, taskLive } from "@cycle/protocol";
import { type ReactNode, memo, useContext, useMemo, useState } from "react";
import {
  type ActivityItem,
  activityRow,
  activityStatus,
  activitySummary,
  failedCount,
  isActivity,
  loaderStateOf,
  plainCommand,
} from "../lib/activity.ts";
import { useApp } from "../context.ts";
import { parseDiff } from "../lib/diff.ts";
import { basename, duration } from "../lib/format.ts";
import { mentionParts, plainMentions } from "../lib/suggest.ts";
import { MorphLoader } from "../loader/morph-loader.tsx";
import { ConfirmDialog } from "./controls.tsx";
import { CodeDiff } from "./diff-view.tsx";
import { Icon } from "./icons.tsx";
import { CopyButton, Markdown, OpenFileContext } from "./markdown.tsx";

const MAX_OUTPUT = 40_000;

type Of<K extends Item["kind"]> = Extract<Item, { kind: K }>;

/**
 * A disclosure's arrow: one glyph, turned a quarter while closed. Beside a row's words it shows only
 * under the pointer, the focus, or while open (`reveal`).
 */
export function Chevron({
  open,
  small,
  reveal,
}: {
  open: boolean;
  small?: boolean;
  reveal?: boolean;
}) {
  return (
    <Icon
      name={small ? "chevron-down-sm" : "chevron-down"}
      className={reveal ? "chevron reveal" : "chevron"}
      data-open={open}
    />
  );
}

/** A prompt's text, with each session it mentions as a link to that session. */
export function MentionText({ text }: { text: string }) {
  const app = useApp();
  const parts = mentionParts(text);
  if (parts.length === 1 && typeof parts[0] === "string") return text;
  return parts.map((part, index) =>
    typeof part === "string" ? (
      part
    ) : (
      <button
        key={index}
        type="button"
        className="mention"
        title="Open this session"
        onClick={() => app.selectSession(part.id)}
      >
        <Icon name="message" size={12} />
        {part.title}
      </button>
    ),
  );
}

/** What the user said: a bubble at the right, with what can be done to it floating under it. */
export const UserBlock = memo(function UserBlock({
  item,
  steeredAfter,
  time,
  onRewind,
}: {
  item: Of<"userMessage">;
  /** How much work the turn had done when this joined it. */
  steeredAfter?: number | undefined;
  time?: string | undefined;
  /** Takes the conversation back to before this message. Only a turn's first has it. */
  onRewind?: (() => void) | undefined;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="user-message">
      {item.images.length ? (
        <div className="attachments">
          {item.images.map((src, index) =>
            /^(data:image\/|https:)/.test(src) ? (
              <img key={index} src={src} alt="" />
            ) : (
              <span key={index} className="chip">
                {basename(src)}
              </span>
            ),
          )}
        </div>
      ) : null}
      {item.text ? (
        <div className="bubble">
          <MentionText text={item.text} />
        </div>
      ) : null}
      <div className="block-actions end">
        {steeredAfter !== undefined ? (
          <span className="caption muted">
            Joined the turn after {steeredAfter} tool {steeredAfter === 1 ? "call" : "calls"}
          </span>
        ) : null}
        {time ? <time className="caption muted tabular">{time}</time> : null}
        {item.text ? <CopyButton text={plainMentions(item.text)} label="Copy message" /> : null}
        {onRewind ? (
          <button
            type="button"
            className="icon-button"
            title="Go back to here"
            aria-label="Go back to here"
            onClick={() => setConfirming(true)}
          >
            <Icon name="undo" />
          </button>
        ) : null}
      </div>
      {confirming && onRewind ? (
        <ConfirmDialog
          title="Go back to before this message?"
          text="This message and everything after it leave the conversation for good. Files the agent changed stay as they are. The message returns to the composer, to change and send again."
          action="Go back"
          onConfirm={onRewind}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </div>
  );
});

/**
 * What the agent said. Only a turn's last reply has actions under it, which the turn passes in. The
 * questions it leaves for later are under it, and an answer picked goes to the composer to be sent.
 */
export const TextBlock = memo(function TextBlock({
  item,
  streaming,
  actions,
  onAnswer,
}: {
  item: Of<"agentMessage">;
  streaming: boolean;
  actions?: ReactNode;
  onAnswer?: (answer: string) => void;
}) {
  return (
    <div className="agent-message">
      <Markdown text={item.text} streaming={streaming} />
      {item.questions?.length ? (
        <div className="reply-questions">
          {item.questions.map((question, index) => (
            <div key={index} className="reply-question">
              <span className="text">{question.title}</span>
              {question.options.length && onAnswer ? (
                <div className="reply-options">
                  {question.options.map((option) => (
                    <button
                      key={option}
                      type="button"
                      className="button"
                      onClick={() => onAnswer(`${question.title} ${option}`)}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {actions ? <div className="block-actions">{actions}</div> : null}
    </div>
  );
});

/** The agent's thinking, shown only when the owner asks for it: a line that opens to the thought. */
export const ThoughtBlock = memo(function ThoughtBlock({
  item,
  streaming,
}: {
  item: Of<"reasoning">;
  streaming: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thought" data-open={open}>
      <button
        type="button"
        className="thought-trigger"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="lightbulb" />
        <span className={streaming ? "shimmer" : undefined}>
          {streaming ? "Thinking" : "Thought"}
        </span>
        <Chevron open={open} />
      </button>
      {open ? (
        <div className="thought-body">
          <Markdown text={item.text} streaming={streaming} />
        </div>
      ) : null}
    </div>
  );
});

/** A plan the agent proposed, as it wrote it. */
export const PlanBlock = memo(function PlanBlock({
  item,
  streaming,
}: {
  item: Of<"plan">;
  streaming: boolean;
}) {
  return (
    <div className="plan-card paper">
      <div className="card-title">Proposed plan</div>
      <Markdown text={item.text} streaming={streaming} />
    </div>
  );
});

/** A mark in the conversation, between two rules: nothing to open, only that it happened. */
export function Divider({ children }: { children: ReactNode }) {
  return (
    <div className="divider-note">
      <span>{children}</span>
    </div>
  );
}

const AGENT_VERBS: Record<string, string> = {
  spawnAgent: "Started an agent",
  sendInput: "Messaged an agent",
  sendMessage: "Messaged an agent",
  wait: "Waited for agents",
  closeAgent: "Closed an agent",
  resumeAgent: "Resumed an agent",
};

/** Work handed to another agent: a block of its own, which opens to what was asked. */
export const AgentBlock = memo(function AgentBlock({ item }: { item: Of<"agentCall"> }) {
  const [open, setOpen] = useState(false);
  const running = item.status === "running";
  return (
    <div className="tool standalone" data-open={open}>
      <button
        type="button"
        className="tool-trigger"
        aria-expanded={open}
        disabled={!item.prompt}
        onClick={() => setOpen(!open)}
      >
        {running ? <MorphLoader state="executing" /> : null}
        <span className="fade-x">
          <span className={item.status === "failed" ? "action failed" : "action"}>
            {AGENT_VERBS[item.tool] ?? item.tool}
          </span>
        </span>
        {item.prompt ? <Chevron open={open} reveal /> : null}
      </button>
      {open && item.prompt ? (
        <div className="tool-body">
          <pre className="tool-text no-scrollbar">{item.prompt}</pre>
        </div>
      ) : null}
    </div>
  );
});

/** What each kind of task is called, in a row and in the list of what runs in the background. */
export const TASK_WORDS: Record<Of<"task">["task"], string> = {
  agent: "Agent",
  command: "Background command",
  workflow: "Workflow",
  other: "Task",
};

const TASK_ENDS: Partial<Record<Of<"task">["status"], string>> = {
  pending: "Waiting",
  paused: "Paused",
  failed: "Failed",
  stopped: "Stopped",
};

/** One piece of what a task did, as it shows inside the task. */
function NestedItem({
  item,
  nested,
}: {
  item: Item;
  nested: ReadonlyMap<string, readonly Item[]>;
}) {
  if (item.kind === "task") return <TaskBlock item={item} nested={nested} />;
  if (item.kind === "agentMessage" && item.text.trim()) {
    return (
      <div className="task-said">
        <Markdown text={item.text} />
      </div>
    );
  }
  return isActivity(item) ? <ToolRow item={item} /> : null;
}

/**
 * Work the agent handed off: a helper agent, a command in the background, a workflow. One line, which
 * opens to what it was asked and what it did, each piece as a row, a helper's helpers nested in turn.
 * Closed, it mounts none of them.
 */
export const TaskBlock = memo(function TaskBlock({
  item,
  nested,
}: {
  item: Of<"task">;
  nested: ReadonlyMap<string, readonly Item[]>;
}) {
  const [open, setOpen] = useState(false);
  const inside = nested.get(item.id) ?? [];
  const live = taskLive(item.status);
  const failed = item.status === "failed";
  const said = live ? (item.summary ?? item.description) : item.description;
  const ended = !live && item.summary && item.summary !== item.description ? item.summary : null;
  const openable = Boolean(item.prompt || item.error || ended || inside.length > 0);
  const time = item.usage && item.usage.durationMs >= 1000 ? duration(item.usage.durationMs) : null;
  const word = TASK_ENDS[item.status];
  return (
    <div className="tool standalone task" data-open={open}>
      <button
        type="button"
        className="tool-trigger"
        aria-expanded={open}
        disabled={!openable}
        onClick={() => setOpen(!open)}
      >
        {item.status === "running" ? <MorphLoader state="executing" /> : null}
        <span className="fade-x">
          <span className={failed ? "action failed" : "action"}>{TASK_WORDS[item.task]}</span>{" "}
          <span className={item.status === "running" ? "detail shimmer" : "detail"}>
            {said.split("\n")[0]}
            {item.agent ? ` · ${item.agent}` : ""}
          </span>
        </span>
        {openable ? <Chevron open={open} reveal /> : null}
        <span className="grow" />
        {word ? (
          <span className={failed ? "caption tone-error" : "caption muted"}>{word}</span>
        ) : null}
        {time ? <span className="caption muted tabular">{time}</span> : null}
      </button>
      {open ? (
        <div className="tool-body">
          {item.prompt ? <pre className="tool-text no-scrollbar">{item.prompt}</pre> : null}
          {inside.length > 0 ? (
            <div className="activity-rows task-rows">
              {inside.map((each) => (
                <NestedItem key={each.id} item={each} nested={nested} />
              ))}
            </div>
          ) : null}
          {ended ? <pre className="tool-text result no-scrollbar">{ended}</pre> : null}
          {item.error ? <pre className="tool-text failed no-scrollbar">{item.error}</pre> : null}
        </div>
      ) : null}
    </div>
  );
});

const ORIGIN_WORDS: Record<Exclude<TurnOrigin, { kind: "owner" }>["kind"], string> = {
  schedule: "Started by a schedule",
  task: "The agent took up a task that ended",
  peer: "Sent from another session",
  agent: "The agent began this turn by itself",
};

/** Who began a turn the owner did not: one muted line at its start. */
export function OriginLine({ origin }: { origin: Exclude<TurnOrigin, { kind: "owner" }> }) {
  return (
    <p className="turn-origin">
      <Icon name={origin.kind === "schedule" ? "automation" : "sparkle"} size={14} />
      {ORIGIN_WORDS[origin.kind]}
    </p>
  );
}

const ACTIVITY_WORDS: Record<Of<"agentActivity">["activity"], string> = {
  started: "Agent started",
  interacted: "Agent messaged",
  interrupted: "Agent stopped",
  completed: "Agent finished",
};

/**
 * Something that happened beside the conversation: what a hook added, or news of a helper agent. One
 * line, which opens to a hook's text.
 */
export const NoteBlock = memo(function NoteBlock({ item }: { item: Of<"hook" | "agentActivity"> }) {
  const [open, setOpen] = useState(false);
  const text = item.kind === "hook" ? item.text.trim() : "";
  const action = item.kind === "hook" ? "A hook added" : ACTIVITY_WORDS[item.activity];
  const detail =
    item.kind === "hook"
      ? (text.split("\n")[0] ?? "")
      : [item.agent, item.model].filter(Boolean).join(" · ");
  return (
    <div className="tool standalone" data-open={open}>
      <button
        type="button"
        className="tool-trigger"
        aria-expanded={open}
        disabled={!text}
        onClick={() => setOpen(!open)}
      >
        <span className="fade-x">
          <span className="action">{action}</span> <span className="detail">{detail}</span>
        </span>
        {text ? <Chevron open={open} reveal /> : null}
      </button>
      {open && text ? (
        <div className="tool-body">
          <pre className="tool-text no-scrollbar">{text}</pre>
        </div>
      ) : null}
    </div>
  );
});

export const ReviewBlock = memo(function ReviewBlock({ item }: { item: Of<"review"> }) {
  return item.phase === "exited" && item.text ? (
    <div className="plan-card paper">
      <div className="card-title">Review</div>
      <Markdown text={item.text} />
    </div>
  ) : (
    <div className="tool standalone">
      <div className="tool-trigger static">
        <span className="fade-x">
          <span className="action">Reviewing</span> <span className="detail">{item.text}</span>
        </span>
      </div>
    </div>
  );
});

/** A command as a terminal shows it: where and what, how it ended, then what it printed. */
function TerminalBlock({ item }: { item: Of<"command"> }) {
  const command = plainCommand(item.command);
  const output =
    item.output.length > MAX_OUTPUT ? item.output.slice(-MAX_OUTPUT) : item.output.trimEnd();
  const lines = output ? output.split("\n") : [];
  const done = item.status !== "running";
  const failed = item.status === "failed" || (item.exitCode !== null && item.exitCode !== 0);
  return (
    <div className="terminal-block paper">
      <div className="terminal-head">
        <div className="terminal-command">
          <span className="muted">{basename(item.cwd)} $ </span>
          {command}
        </div>
        <div className="terminal-status">
          {done ? (
            <>
              <Icon
                name={failed ? "x" : "check"}
                size={12}
                className={failed ? "tone-error" : "tone-success"}
              />
              {item.exitCode !== null && item.exitCode !== 0 ? (
                <span className="tone-error">exit {item.exitCode}</span>
              ) : null}
              {item.durationMs !== null && item.durationMs >= 1000 ? (
                <span className="muted tabular">{duration(item.durationMs)}</span>
              ) : null}
            </>
          ) : (
            <MorphLoader state="executing" className="quiet" />
          )}
          {output ? (
            <CopyButton
              text={output}
              label="Copy output"
              className="icon-button small round"
              size={14}
            />
          ) : null}
        </div>
      </div>
      {lines.length ? (
        <div className="terminal-output no-scrollbar">
          {item.output.length > MAX_OUTPUT ? (
            <div className="truncated">output truncated</div>
          ) : null}
          {lines.map((line, index) => (
            <div key={index} className={index === lines.length - 1 ? "line last" : "line"}>
              {line || " "}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ChangeBody({ item }: { item: Of<"fileChange"> }) {
  const openFile = useContext(OpenFileContext);
  const files = useMemo(
    () =>
      item.changes.map(
        (change) =>
          parseDiff(change.diff, change.movePath ?? change.path)[0] ?? {
            path: change.movePath ?? change.path,
            additions: 0,
            deletions: 0,
            lines: [],
          },
      ),
    [item.changes],
  );
  return files.map((file) => (
    <CodeDiff
      key={file.path}
      file={file}
      onOpen={openFile ? () => openFile(file.path, null) : undefined}
    />
  ));
}

function CallBody({ item }: { item: Of<"toolCall"> }) {
  return (
    <>
      {item.args && item.args !== "{}" ? (
        <pre className="tool-text no-scrollbar">{item.args}</pre>
      ) : null}
      {item.error ? <pre className="tool-text failed no-scrollbar">{item.error}</pre> : null}
      {item.result ? (
        <pre className="tool-text result no-scrollbar">
          {item.result.length > MAX_OUTPUT ? `${item.result.slice(0, MAX_OUTPUT)}\n…` : item.result}
        </pre>
      ) : null}
    </>
  );
}

function bodyOf(item: ActivityItem): ReactNode {
  switch (item.kind) {
    case "command":
      return <TerminalBlock item={item} />;
    case "fileChange":
      return item.changes.length ? <ChangeBody item={item} /> : null;
    case "toolCall":
      return (item.args && item.args !== "{}") || item.error || item.result ? (
        <CallBody item={item} />
      ) : null;
    case "webSearch":
    case "image":
    case "wait":
      return null;
  }
}

/** A change of a few lines is read at a glance, so alone in the conversation it starts open. */
const startsOpen = (item: ActivityItem): boolean =>
  item.kind === "fileChange" &&
  item.changes.length === 1 &&
  (item.changes[0]?.diff.split("\n").length ?? 0) <= 40;

/**
 * One piece of work: what was done and to what, opening to its output. In a card it has its kind's
 * icon, which a failure or the loader of dots replaces; alone in the conversation it has none, only
 * the loader while it runs.
 */
export const ToolRow = memo(function ToolRow({
  item,
  standalone = false,
}: {
  item: ActivityItem;
  standalone?: boolean;
}) {
  const [open, setOpen] = useState<boolean | null>(null);
  const row = activityRow(item);
  const status = activityStatus(item);
  const running = status === "running";
  const failed = status === "failed";
  const body = bodyOf(item);
  const shown = body !== null && (open ?? (standalone && startsOpen(item)));
  const time =
    "durationMs" in item && item.durationMs !== null && item.durationMs >= 1000
      ? duration(item.durationMs)
      : null;
  return (
    <div className={standalone ? "tool standalone" : "tool"} data-open={shown}>
      <button
        type="button"
        className="tool-trigger"
        aria-expanded={shown}
        disabled={body === null}
        onClick={() => setOpen(!shown)}
      >
        {running ? (
          <MorphLoader state={loaderStateOf(row.kind)} />
        ) : standalone ? null : (
          <span className="tool-icon">
            <Icon
              name={failed ? "x-circle" : row.icon}
              size={14}
              className={failed ? "tone-error" : undefined}
            />
          </span>
        )}
        <span className="fade-x">
          <span className={failed ? "action failed" : "action"}>{row.action}</span>{" "}
          <span
            className={
              running ? "detail shimmer" : status === "declined" ? "detail declined" : "detail"
            }
          >
            {row.detail.split("\n")[0]}
          </span>
        </span>
        {body !== null ? <Chevron open={shown} reveal /> : null}
        <span className="grow" />
        {time ? <span className="caption muted tabular">{time}</span> : null}
      </button>
      {shown ? <div className="tool-body">{body}</div> : null}
    </div>
  );
});

/**
 * The work of one stretch of a turn, folded into one line that says what it came to. Closed, it
 * mounts none of its rows; while a piece of it runs, the line says which.
 */
export const ActivityCard = memo(function ActivityCard({
  items,
  asking,
}: {
  items: readonly ActivityItem[];
  /** One of its items waits for the owner, so it stays open for them to see which. */
  asking: boolean;
}) {
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? asking;
  const running = items.findLast((item) => activityStatus(item) === "running");
  const failed = failedCount(items);
  const now = running ? activityRow(running) : null;
  return (
    <div className="activity" data-open={open}>
      <button
        type="button"
        className="activity-trigger"
        aria-expanded={open}
        onClick={() => setToggled(!open)}
      >
        {now && !open ? (
          <>
            <MorphLoader state={loaderStateOf(now.kind)} />
            <span className="fade-x">
              <span className="action">{now.action}</span>{" "}
              <span className="detail shimmer">{now.detail.split("\n")[0]}</span>
            </span>
          </>
        ) : (
          <span className="fade-x summary">
            {activitySummary(items)}
            {failed > 0 ? <span className="tone-error"> · {failed} failed</span> : null}
          </span>
        )}
        <Chevron open={open} reveal />
      </button>
      {open ? (
        <div className="activity-rows">
          {items.map((item) => (
            <ToolRow key={item.id} item={item} />
          ))}
        </div>
      ) : null}
    </div>
  );
});

/** How a turn that did not finish ended: stopped by the owner, or failed, with a way to try again. */
export function TurnEnd({
  status,
  error,
  onRetry,
}: {
  status: "interrupted" | "failed";
  error: string | null;
  onRetry?: (() => void) | undefined;
}) {
  if (status === "interrupted") return <div className="turn-stopped">Stopped</div>;
  return (
    <div className="turn-failed" role="alert">
      <Icon name="warning" />
      <span className="grow text">{error ?? "The turn did not finish."}</span>
      {onRetry ? (
        <button type="button" className="button" onClick={onRetry}>
          <Icon name="refresh" size={14} /> Retry
        </button>
      ) : null}
    </div>
  );
}
