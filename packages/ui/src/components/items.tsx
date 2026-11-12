import type { Item } from "@cycle/protocol";
import { type ReactNode, memo, useContext, useMemo, useState } from "react";
import { parseDiff } from "../lib/diff.ts";
import { basename, duration } from "../lib/format.ts";
import { DiffLines, Stats } from "./diff-view.tsx";
import { Icon, type IconName, Spinner } from "./icons.tsx";
import { CodeBlock, CopyButton, Markdown, OpenFileContext } from "./markdown.tsx";

const MAX_OUTPUT = 40_000;

type Running = { status: "running" | "completed" | "failed" | "declined" };

function StateIcon({ item, icon }: { item: Running; icon: IconName }) {
  if (item.status === "running") return <Spinner size={13} />;
  if (item.status === "failed") return <Icon name="x-circle" className="tone-error" />;
  if (item.status === "declined") return <Icon name="x-circle" className="muted" />;
  return <Icon name={icon} />;
}

/** A row that opens to show more. Closed, it mounts none of its content. */
function Disclosure({
  icon,
  summary,
  trailing,
  children,
  defaultOpen = false,
}: {
  icon: ReactNode;
  summary: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="tool" data-open={open}>
      <button
        type="button"
        className="tool-row"
        aria-expanded={open}
        disabled={!children}
        onClick={() => setOpen(!open)}
      >
        {icon}
        <span className="truncate grow">{summary}</span>
        {trailing}
        {children ? <Icon name={open ? "chevron-down" : "chevron-right"} size={12} /> : null}
      </button>
      {open && children ? <div className="tool-body">{children}</div> : null}
    </div>
  );
}

/** The command a shell wrapper was given, without the wrapper. */
export function plainCommand(command: string): string {
  const single = /^(?:\/\S+\/)?(?:ba|z)?sh -l?c '([\s\S]*)'$/.exec(command);
  if (single?.[1] !== undefined) return single[1].replaceAll("'\\''", "'");
  const double = /^(?:\/\S+\/)?(?:ba|z)?sh -l?c "([\s\S]*)"$/.exec(command);
  if (double?.[1] !== undefined) return double[1].replace(/\\(["$`\\])/g, "$1");
  return command;
}

function commandVerb(item: Extract<Item, { kind: "command" }>): { verb: string; detail: string } {
  const action = item.actions.length === 1 ? item.actions[0] : undefined;
  const running = item.status === "running";
  if (action?.type === "read") {
    return { verb: running ? "Reading" : "Read", detail: basename(action.path) };
  }
  if (action?.type === "search") {
    return { verb: running ? "Searching" : "Searched", detail: action.query ?? action.path ?? "" };
  }
  if (action?.type === "list") {
    return { verb: running ? "Listing" : "Listed", detail: action.path ?? "files" };
  }
  return { verb: running ? "Running" : "Ran", detail: plainCommand(item.command) };
}

function CommandItem({ item }: { item: Extract<Item, { kind: "command" }> }) {
  const { verb, detail } = commandVerb(item);
  const output =
    item.output.length > MAX_OUTPUT
      ? `… ${item.output.length - MAX_OUTPUT} earlier characters hidden …\n${item.output.slice(-MAX_OUTPUT)}`
      : item.output;
  const failed = item.exitCode !== null && item.exitCode !== 0;
  return (
    <Disclosure
      icon={<StateIcon item={item} icon="terminal" />}
      summary={
        <>
          <span className="verb">{verb}</span> <code>{detail}</code>
        </>
      }
      trailing={
        <>
          {failed ? <span className="caption tone-error">exit {item.exitCode}</span> : null}
          {item.durationMs && item.durationMs >= 1000 ? (
            <span className="caption muted tabular">{duration(item.durationMs)}</span>
          ) : null}
        </>
      }
    >
      <div className="terminal-block">
        <div className="terminal-command">
          <span className="prompt">$</span>
          <code>{plainCommand(item.command)}</code>
          <CopyButton text={plainCommand(item.command)} label="Copy command" />
        </div>
        {output ? <pre>{output}</pre> : <div className="note">No output.</div>}
      </div>
    </Disclosure>
  );
}

function FileChangeItem({ item }: { item: Extract<Item, { kind: "fileChange" }> }) {
  const openFile = useContext(OpenFileContext);
  const files = useMemo(
    () =>
      item.changes.map((change) => ({
        change,
        diff: parseDiff(change.diff, change.path)[0] ?? {
          path: change.path,
          additions: 0,
          deletions: 0,
          lines: [],
        },
      })),
    [item.changes],
  );
  return files.map(({ change, diff }) => (
    <Disclosure
      key={change.path}
      defaultOpen={item.status !== "completed" || diff.lines.length <= 40}
      icon={<StateIcon item={item} icon="file-diff" />}
      summary={
        <>
          <span className="verb">
            {change.change === "add"
              ? "Created"
              : change.change === "delete"
                ? "Deleted"
                : "Edited"}
          </span>{" "}
          <code
            className={openFile ? "file-link" : undefined}
            onClick={(event) => {
              if (!openFile) return;
              event.stopPropagation();
              openFile(change.path, null);
            }}
          >
            {basename(change.movePath ?? change.path)}
          </code>
        </>
      }
      trailing={<Stats additions={diff.additions} deletions={diff.deletions} />}
    >
      {diff.lines.length ? <DiffLines file={diff} /> : undefined}
    </Disclosure>
  ));
}

function ToolCallItem({ item }: { item: Extract<Item, { kind: "toolCall" }> }) {
  return (
    <Disclosure
      icon={<StateIcon item={item} icon="wrench" />}
      summary={
        <>
          <span className="verb">{item.status === "running" ? "Calling" : "Called"}</span>{" "}
          <code>{item.server ? `${item.server}.${item.tool}` : item.tool}</code>
        </>
      }
      trailing={
        item.durationMs && item.durationMs >= 1000 ? (
          <span className="caption muted tabular">{duration(item.durationMs)}</span>
        ) : null
      }
    >
      {item.args ? <CodeBlock code={item.args} language="json" /> : null}
      {item.error ? <div className="error-box">{item.error}</div> : null}
      {item.result ? (
        <pre className="tool-result">
          {item.result.length > MAX_OUTPUT ? `${item.result.slice(0, MAX_OUTPUT)}\n…` : item.result}
        </pre>
      ) : null}
    </Disclosure>
  );
}

function Row({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="tool">
      <div className="tool-row static">
        {icon}
        <span className="truncate grow">{children}</span>
      </div>
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

/** Whether an item is the agent's own words rather than work it did. */
export function isNarrative(item: Item): boolean {
  return item.kind === "agentMessage" || item.kind === "userMessage" || item.kind === "plan";
}

export const ItemView = memo(function ItemView({
  item,
  streaming,
  showReasoning,
}: {
  item: Item;
  /** The item is still being written. */
  streaming: boolean;
  showReasoning: boolean;
}) {
  switch (item.kind) {
    case "userMessage":
      return (
        <div className="user-message">
          {item.images.length ? (
            <div className="attachments">
              {item.images.map((src, index) =>
                /^(data:image\/|https:)/.test(src) ? (
                  <img key={index} src={src} alt="" />
                ) : (
                  <span key={index} className="chip">
                    <Icon name="image" /> {basename(src)}
                  </span>
                ),
              )}
            </div>
          ) : null}
          {item.text ? <div className="bubble">{item.text}</div> : null}
        </div>
      );
    case "agentMessage":
      return item.text ? <Markdown text={item.text} streaming={streaming} /> : null;
    case "plan":
      return (
        <div className="plan-card">
          <div className="card-title">
            <Icon name="list" /> Proposed plan
          </div>
          <Markdown text={item.text} streaming={streaming} />
        </div>
      );
    case "reasoning":
      if (!showReasoning || !item.text.trim()) return null;
      return (
        <Disclosure
          icon={streaming ? <Spinner size={13} /> : <Icon name="lightbulb" />}
          summary={
            <span className="muted">
              {streaming ? "Thinking" : "Thought"}
              {": "}
              {item.text
                .replace(/[*_`#]/g, "")
                .trim()
                .split("\n")[0]
                ?.slice(0, 120)}
            </span>
          }
        >
          <div className="reasoning">
            <Markdown text={item.text} streaming={streaming} />
          </div>
        </Disclosure>
      );
    case "command":
      return <CommandItem item={item} />;
    case "fileChange":
      return <FileChangeItem item={item} />;
    case "toolCall":
      return <ToolCallItem item={item} />;
    case "webSearch":
      return (
        <Row icon={<Icon name="globe" />}>
          <span className="verb">Searched the web</span> <code>{item.query}</code>
        </Row>
      );
    case "agentCall":
      return (
        <Disclosure
          icon={<StateIcon item={item} icon="sparkle" />}
          summary={<span className="verb">{AGENT_VERBS[item.tool] ?? item.tool}</span>}
        >
          {item.prompt ? <div className="reasoning">{item.prompt}</div> : undefined}
        </Disclosure>
      );
    case "image":
      return (
        <Row icon={<Icon name="image" />}>
          <span className="verb">Viewed</span> <code>{basename(item.path)}</code>
        </Row>
      );
    case "review":
      return item.phase === "exited" && item.text ? (
        <div className="plan-card">
          <div className="card-title">
            <Icon name="eye" /> Review
          </div>
          <Markdown text={item.text} />
        </div>
      ) : (
        <Row icon={<Icon name="eye" />}>
          <span className="verb">Reviewing</span> {item.text}
        </Row>
      );
    case "compaction":
      return <div className="divider-note">Context compacted</div>;
    case "other":
      return null;
  }
});
