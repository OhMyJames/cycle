import type { Item, SessionState, Turn } from "@cycle/protocol";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../client/store.ts";
import { useApp } from "../context.ts";
import { diffStats } from "../lib/diff.ts";
import { basename, duration } from "../lib/format.ts";
import { ApprovalCard } from "./approval.tsx";
import { Stats } from "./diff-view.tsx";
import { Icon, Spinner } from "./icons.tsx";
import { ItemView, isNarrative, plainCommand } from "./items.tsx";
import { CopyButton, OpenFileContext } from "./markdown.tsx";

/** How many turns are drawn at first, and how many more each time the top is reached. */
const WINDOW = 30;
/** Steps of a running stretch of work that stay visible: the rest fold away. */
const LIVE_STEPS = 6;
const NEAR_BOTTOM = 48;

type Segment = { type: "item"; item: Item } | { type: "work"; items: Item[] };

/** Splits a turn into what the agent said and the stretches of work between. */
export function segmentsOf(items: Item[]): Segment[] {
  const out: Segment[] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (isNarrative(item)) out.push({ type: "item", item });
    else if (last?.type === "work") last.items.push(item);
    else out.push({ type: "work", items: [item] });
  }
  return out;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One line for a stretch of work: "Read 2 files, ran 3 commands, edited 1 file". */
export function summarize(items: Item[]): string {
  let read = 0;
  let searched = 0;
  let listed = 0;
  let ran = 0;
  let edited = 0;
  let called = 0;
  let thoughts = 0;
  for (const item of items) {
    if (item.kind === "command") {
      const action = item.actions.length === 1 ? item.actions[0]?.type : undefined;
      if (action === "read") read++;
      else if (action === "search") searched++;
      else if (action === "list") listed++;
      else ran++;
    } else if (item.kind === "fileChange") edited += item.changes.length;
    else if (item.kind === "toolCall" || item.kind === "agentCall") called++;
    else if (item.kind === "webSearch") searched++;
    else if (item.kind === "reasoning") thoughts++;
  }
  const parts = [
    read ? `read ${plural(read, "file")}` : "",
    listed ? "listed files" : "",
    searched ? `searched ${plural(searched, "time")}` : "",
    ran ? `ran ${plural(ran, "command")}` : "",
    edited ? `edited ${plural(edited, "file")}` : "",
    called ? `called ${plural(called, "tool")}` : "",
  ].filter(Boolean);
  const text = parts.length ? parts.join(", ") : thoughts ? "thought it through" : "worked";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function WorkGroup({
  items,
  live,
  showReasoning,
}: {
  items: Item[];
  /** The turn is still adding to this stretch. */
  live: boolean;
  showReasoning: boolean;
}) {
  const [open, setOpen] = useState<boolean | null>(null);
  const visible = showReasoning ? items : items.filter((item) => item.kind !== "reasoning");
  if (!visible.length) return null;
  const expanded = open ?? (live || visible.length === 1);
  const shown = expanded ? (live && open === null ? visible.slice(-LIVE_STEPS) : visible) : [];
  const hidden = visible.length - shown.length;
  return (
    <div className="work">
      {visible.length > 1 && (!expanded || hidden > 0 || open !== null) ? (
        <button
          type="button"
          className="work-summary"
          aria-expanded={expanded && hidden === 0}
          onClick={() => setOpen(!(expanded && hidden === 0))}
        >
          <Icon name={expanded && hidden === 0 ? "chevron-down" : "chevron-right"} size={12} />
          {expanded && hidden > 0 ? `${hidden} earlier steps` : summarize(visible)}
        </button>
      ) : null}
      {shown.map((item) => (
        <ItemView
          key={item.id}
          item={item}
          streaming={live && item === visible.at(-1)}
          showReasoning={showReasoning}
        />
      ))}
    </div>
  );
}

function TurnFooter({ turn, sessionId }: { turn: Turn; sessionId: string }) {
  const app = useApp();
  const answer = turn.items.findLast((item) => item.kind === "agentMessage");
  const stats = useMemo(() => (turn.diff ? diffStats(turn.diff) : null), [turn.diff]);
  if (turn.status === "running") return null;
  return (
    <div className="turn-footer">
      {turn.status === "interrupted" ? <span className="muted meta">Stopped</span> : null}
      {answer && "text" in answer ? <CopyButton text={answer.text} label="Copy reply" /> : null}
      <button
        type="button"
        className="icon-button"
        title="Fork from here"
        aria-label="Fork from here"
        onClick={() => void app.fork(sessionId, turn.id)}
      >
        <Icon name="git-fork" />
      </button>
      {turn.durationMs ? (
        <span className="caption muted tabular">{duration(turn.durationMs)}</span>
      ) : null}
      {stats && stats.additions + stats.deletions > 0 ? (
        <button type="button" className="ghost" onClick={() => app.setView({ panel: "changes" })}>
          <Icon name="file-diff" /> Changes <Stats {...stats} />
        </button>
      ) : null}
    </div>
  );
}

const TurnView = memo(function TurnView({
  turn,
  sessionId,
  showReasoning,
}: {
  turn: Turn;
  sessionId: string;
  showReasoning: boolean;
}) {
  const app = useApp();
  const running = turn.status === "running";
  const segments = useMemo(() => segmentsOf(turn.items), [turn.items]);
  const lastItem = turn.items.at(-1);
  const prompt = turn.items.find((item) => item.kind === "userMessage");
  return (
    <article className="turn" data-running={running}>
      {segments.map((segment, index) =>
        segment.type === "item" ? (
          <ItemView
            key={segment.item.id}
            item={segment.item}
            streaming={running && segment.item === lastItem}
            showReasoning={showReasoning}
          />
        ) : (
          <WorkGroup
            key={segment.items[0]?.id ?? index}
            items={segment.items}
            live={running && index === segments.length - 1}
            showReasoning={showReasoning}
          />
        ),
      )}
      {turn.status === "failed" ? (
        <div className="error-box">
          <span className="grow">{turn.error ?? "The turn stopped with an error."}</span>
          {prompt?.kind === "userMessage" ? (
            <button
              type="button"
              className="button"
              onClick={() => void app.send(sessionId, prompt.text, prompt.images, "auto")}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      <TurnFooter turn={turn} sessionId={sessionId} />
    </article>
  );
});

function Elapsed({ since }: { since: number | null }) {
  const [start] = useState(() => since ?? Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="tabular muted">{duration(Math.max(0, now - start))}</span>;
}

/** What the agent is doing right now, in a few words. */
export function activityLabel(turn: Turn): string {
  const item = turn.items.at(-1);
  if (!item) return "Starting";
  switch (item.kind) {
    case "agentMessage":
    case "plan":
      return "Writing";
    case "command":
      return item.status === "running"
        ? `Running ${plainCommand(item.command).split("\n")[0]?.slice(0, 60)}`
        : "Thinking";
    case "fileChange":
      return item.status === "running"
        ? `Editing ${basename(item.changes[0]?.path ?? "files")}`
        : "Thinking";
    case "toolCall":
      return item.status === "running" ? `Calling ${item.tool}` : "Thinking";
    case "webSearch":
      return "Searching the web";
    case "agentCall":
      return "Working with other agents";
    default:
      return "Thinking";
  }
}

function Tail({ state }: { state: SessionState }) {
  const app = useApp();
  const sessionId = state.info.id;
  const turn = state.turns.at(-1);
  const running = turn?.status === "running";
  const notice = state.notices.at(-1);
  const [dismissed, setDismissed] = useState<string | null>(null);
  return (
    <div className="tail">
      {state.queue.map((queued) => (
        <div key={queued.id} className="user-message queued">
          <div className="bubble">{queued.text}</div>
          <span className="caption muted row">
            <Icon name="clock" size={12} /> Queued
            <button
              type="button"
              className="link"
              onClick={() => void app.request("session.unqueue", { sessionId, id: queued.id })}
            >
              Remove
            </button>
          </span>
        </div>
      ))}
      {notice && notice.level !== "info" && notice.message !== dismissed ? (
        <div className={`notice ${notice.level}`}>
          <Icon name="alert" />
          <span className="grow">{notice.message}</span>
          <button
            type="button"
            className="icon-button small"
            aria-label="Dismiss"
            onClick={() => setDismissed(notice.message)}
          >
            <Icon name="x" />
          </button>
        </div>
      ) : null}
      {state.approvals.map((approval) => (
        <ApprovalCard key={approval.id} sessionId={sessionId} approval={approval} />
      ))}
      <div className="status-line" aria-live="off">
        {(running && !state.approvals.length) || state.info.status === "running" ? (
          <>
            <Spinner />
            <span className="truncate">{turn && running ? activityLabel(turn) : "Starting"}</span>
            <Elapsed key={turn?.id ?? "start"} since={running ? (turn?.startedAt ?? null) : null} />
          </>
        ) : null}
      </div>
    </div>
  );
}

const positions = new Map<string, number | "bottom">();

export function Thread({ sessionId }: { sessionId: string }) {
  const app = useApp();
  const conversation = useStore(app.conversation(sessionId), (value) => value);
  const showReasoning = useStore(app.view, (view) => view.showReasoning);
  const cwd = conversation.state?.info.cwd;
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [away, setAway] = useState(false);
  const [count, setCount] = useState(WINDOW);
  const turns = conversation.state?.turns ?? [];
  const first = Math.max(0, turns.length - count);
  const visible = first ? turns.slice(first) : turns;
  const loaded = conversation.state !== null;

  const toBottom = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    stuck.current = true;
    node.scrollTop = node.scrollHeight;
    setAway(false);
  }, []);

  // Where the owner was reading comes back with the session.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node || !loaded) return;
    const saved = positions.get(sessionId) ?? "bottom";
    if (saved === "bottom") toBottom();
    else {
      stuck.current = false;
      node.scrollTop = saved;
    }
    return () => {
      positions.set(sessionId, stuck.current ? "bottom" : node.scrollTop);
    };
  }, [sessionId, loaded, toBottom]);

  // Growth below keeps the view at the bottom while it is there.
  useEffect(() => {
    const node = content.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      const scroll = scroller.current;
      if (scroll && stuck.current) scroll.scrollTop = scroll.scrollHeight;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [loaded]);

  // A prompt just sent is always shown, wherever the view was.
  const lastTurnId = turns.at(-1)?.id;
  useEffect(() => {
    if (lastTurnId) toBottom();
  }, [lastTurnId, toBottom]);

  // Earlier turns are drawn when the top comes near, holding the view still.
  const grew = useRef<number | null>(null);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node && grew.current !== null) {
      node.scrollTop += node.scrollHeight - grew.current;
      grew.current = null;
    }
  }, [count]);

  const openFile = useCallback(
    (path: string, line: number | null) =>
      app.openFile(path.startsWith("/") || !cwd ? path : `${cwd}/${path}`, line),
    [app, cwd],
  );

  if (conversation.error) {
    return (
      <div className="thread-empty">
        <div className="error-box">{conversation.error}</div>
      </div>
    );
  }
  if (!conversation.state) {
    return (
      <div className="thread-empty">
        <div className="skeleton thread-skeleton" role="status" aria-label="Reading the session">
          <span style={{ width: "42%", alignSelf: "flex-end" }} />
          <span style={{ width: "88%" }} />
          <span style={{ width: "76%" }} />
          <span style={{ width: "58%" }} />
        </div>
      </div>
    );
  }
  return (
    <OpenFileContext.Provider value={openFile}>
      <div
        className="thread-scroll"
        ref={scroller}
        onScroll={(event) => {
          const node = event.currentTarget;
          const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < NEAR_BOTTOM;
          stuck.current = atBottom;
          if (atBottom === away) setAway(!atBottom);
          if (node.scrollTop < 600 && first > 0 && grew.current === null) {
            grew.current = node.scrollHeight;
            setCount((value) => value + WINDOW);
          }
        }}
      >
        <div className="thread-content" ref={content}>
          {first > 0 ? <div className="divider-note">{first} earlier turns</div> : null}
          {visible.map((turn) => (
            <TurnView
              key={turn.id}
              turn={turn}
              sessionId={sessionId}
              showReasoning={showReasoning}
            />
          ))}
          <Tail state={conversation.state} />
        </div>
      </div>
      {away ? (
        <button
          type="button"
          className="to-bottom"
          title="Scroll to the bottom"
          aria-label="Scroll to the bottom"
          onClick={toBottom}
        >
          <Icon name="arrow-down" />
        </button>
      ) : null}
    </OpenFileContext.Provider>
  );
}
