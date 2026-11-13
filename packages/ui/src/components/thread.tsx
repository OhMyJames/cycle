import type { SessionState, Turn } from "@cycle/protocol";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../client/store.ts";
import { useApp } from "../context.ts";
import { activityRow, activityStatus, isActivity } from "../lib/activity.ts";
import { type Block, blocksOf, gapBelow } from "../lib/blocks.ts";
import { diffStats } from "../lib/diff.ts";
import { duration, shortTime } from "../lib/format.ts";
import { type LoaderState, MorphLoader } from "../loader/morph-loader.tsx";
import { ApprovalCard } from "./approval.tsx";
import { Stats } from "./diff-view.tsx";
import { BackgroundDot, Icon } from "./icons.tsx";
import {
  ActivityCard,
  AgentBlock,
  Divider,
  PlanBlock,
  ReviewBlock,
  TextBlock,
  ThoughtBlock,
  ToolRow,
  TurnEnd,
  UserBlock,
} from "./items.tsx";
import { CopyButton, OpenFileContext } from "./markdown.tsx";

/**
 * How many turns are drawn at first, and how many more each time the top is
 * reached. Few at first, so opening a long session costs what its end costs.
 */
const FIRST_TURNS = 12;
const MORE_TURNS = 24;
const NEAR_BOTTOM = 48;

/** What floats under a turn's last reply: copy it, fork from it, how long it took, what it changed. */
function ReplyActions({ turn, sessionId, text }: { turn: Turn; sessionId: string; text: string }) {
  const app = useApp();
  const stats = useMemo(() => (turn.diff ? diffStats(turn.diff) : null), [turn.diff]);
  return (
    <>
      <CopyButton text={text} label="Copy reply" />
      <button
        type="button"
        className="icon-button"
        title="Fork from here"
        aria-label="Fork from here"
        onClick={() => void app.fork(sessionId, turn.id)}
      >
        <Icon name="git-branch" />
      </button>
      {turn.durationMs ? (
        <span className="caption muted tabular">{duration(turn.durationMs)}</span>
      ) : null}
      {stats && stats.additions + stats.deletions > 0 ? (
        <button
          type="button"
          className="ghost"
          title="Open Changes"
          onClick={() => app.setView({ panel: "changes" })}
        >
          <Stats {...stats} />
        </button>
      ) : null}
    </>
  );
}

function BlockView({
  block,
  turn,
  sessionId,
  streaming,
  askingId,
}: {
  block: Block;
  turn: Turn;
  sessionId: string;
  /** The block's item is the one being written. */
  streaming: boolean;
  askingId: string | undefined;
}) {
  const app = useApp();
  switch (block.kind) {
    case "user":
      return (
        <UserBlock
          item={block.item}
          steeredAfter={block.steeredAfter}
          time={
            block.steeredAfter === undefined && turn.startedAt
              ? shortTime(turn.startedAt, Date.now())
              : undefined
          }
        />
      );
    case "text":
      return (
        <TextBlock
          item={block.item}
          streaming={streaming}
          actions={
            block.final ? (
              <ReplyActions turn={turn} sessionId={sessionId} text={block.item.text} />
            ) : undefined
          }
        />
      );
    case "thought":
      return <ThoughtBlock item={block.item} streaming={streaming} />;
    case "plan":
      return <PlanBlock item={block.item} streaming={streaming} />;
    case "compaction":
      return <Divider>Context compacted</Divider>;
    case "agent":
      return <AgentBlock item={block.item} />;
    case "review":
      return <ReviewBlock item={block.item} />;
    case "activity":
      return (
        <ActivityCard
          items={block.items}
          asking={askingId !== undefined && block.items.some((item) => item.id === askingId)}
        />
      );
    case "single":
    case "failed":
      return <ToolRow item={block.item} standalone />;
    case "turnEnd": {
      const prompt = turn.items.find((item) => item.kind === "userMessage");
      return (
        <TurnEnd
          status={block.status}
          error={block.error}
          onRetry={
            prompt?.kind === "userMessage"
              ? () => void app.send(sessionId, prompt.text, prompt.images, "auto")
              : undefined
          }
        />
      );
    }
  }
}

/**
 * One turn, as its blocks. Memoised on the turn's identity, which the shared reducer keeps for every
 * turn a streamed chunk does not touch; its blocks are laid out once per turn object.
 */
const TurnView = memo(function TurnView({
  turn,
  sessionId,
  showThinking,
  askingId,
}: {
  turn: Turn;
  sessionId: string;
  showThinking: boolean;
  askingId: string | undefined;
}) {
  const running = turn.status === "running";
  const blocks = blocksOf(turn, { showThinking });
  const lastItem = turn.items.at(-1);
  return (
    <article className="turn" data-running={running}>
      {blocks.map((block) => (
        <div
          key={block.key}
          className="block"
          data-kind={block.kind}
          style={{ marginTop: block.gap }}
        >
          <BlockView
            block={block}
            turn={turn}
            sessionId={sessionId}
            streaming={running && "item" in block && block.item === lastItem}
            askingId={askingId}
          />
        </div>
      ))}
    </article>
  );
});

/** How long the work has taken: "8s", then "1m 5s". */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="tabular muted">{duration(Math.max(1000, now - since))}</span>;
}

/** What the agent is doing right now, in a few words. */
export function currentStep(turn: Turn | undefined): string {
  const item = turn?.items.at(-1);
  if (!item) return "Working";
  if (item.kind === "reasoning") return "Thinking";
  if (item.kind === "agentMessage" || item.kind === "plan") return "Writing";
  if (item.kind === "agentCall") {
    return item.status === "running" ? "Waiting for a subagent" : "Working";
  }
  if (isActivity(item) && activityStatus(item) === "running") {
    const row = activityRow(item);
    return `${row.action} ${row.detail.split("\n")[0]?.slice(0, 80) ?? ""}`.trim();
  }
  return "Working";
}

function loaderState(turn: Turn | undefined): LoaderState {
  const kind = turn?.items.at(-1)?.kind;
  if (kind === "agentMessage" || kind === "plan") return "responding";
  return kind === "agentCall" ? "executing" : "thinking";
}

/** A piece of the turn's work is running, which its own row, or its card's line, says. */
function workAtWork(turn: Turn | undefined): boolean {
  const item = turn?.items.at(-1);
  return item !== undefined && isActivity(item) && activityStatus(item) === "running";
}

/** How long a wording stays before another replaces it, and how long a new one waits to show. */
const MIN_SHOWN_MS = 650;

/**
 * `wanted`, held so that words do not flicker: what shows stays at least 650ms, however quickly the
 * agent moves from one thing to the next.
 */
function useSteadyText(wanted: string): string {
  const [shown, setShown] = useState(wanted);
  const since = useRef(0);
  useEffect(() => {
    if (wanted === shown) return;
    const wait = Math.max(0, MIN_SHOWN_MS - (performance.now() - since.current));
    const timer = setTimeout(() => {
      since.current = performance.now();
      setShown(wanted);
    }, wait);
    return () => clearTimeout(timer);
  }, [wanted, shown]);
  return shown;
}

/**
 * What the agent is doing and for how long. While a piece of work runs its row says so, with its own
 * loader, so this shows nothing but keeps its line, and the thread does not jump.
 */
function StatusLine({ turn, since }: { turn: Turn | undefined; since: number }) {
  const step = useSteadyText(currentStep(turn));
  const quiet = useSteadyText(workAtWork(turn) ? "quiet" : "full") === "quiet";
  if (quiet) {
    return (
      <p className="status-line">
        <span className="sr-only">Agent is working</span>
      </p>
    );
  }
  return (
    <p className="status-line" aria-label="Agent is working">
      <MorphLoader state={loaderState(turn)} />
      <span className="fade-x">{step}</span>
      <Elapsed since={since} />
    </p>
  );
}

/**
 * The end of the conversation: what is about to happen, rather than what has. Prompts on their way,
 * notices, then the one request waiting for the owner, or else what the agent is doing.
 */
function Tail({ state, gap }: { state: SessionState; gap: number }) {
  const app = useApp();
  const sessionId = state.info.id;
  const turn = state.turns.at(-1);
  const running = turn?.status === "running";
  const working = running || state.info.status === "running";
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  // When the work began. The tail stays mounted, so an approval does not start the count again.
  const [start, setStart] = useState<number | null>(null);
  if (working && start === null)
    setStart(turn && running ? (turn.startedAt ?? Date.now()) : Date.now());
  if (!working && start !== null) setStart(null);
  const [approval] = state.approvals;
  const notices = state.notices.filter(
    (notice) => notice.level !== "info" && !dismissed.includes(notice.message),
  );
  const others = running
    ? turn.items.filter((item) => item.kind === "agentCall" && item.status === "running").length
    : 0;
  return (
    <div className="tail" style={{ marginTop: gap }}>
      {state.queue.map((queued) => (
        <div key={queued.id} className="user-message queued">
          <div className="bubble">{queued.text}</div>
          <span className="queued-label">
            <Icon name="clock" size={12} />
            Queued
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
      {approval ? (
        <ApprovalCard
          key={approval.id}
          sessionId={sessionId}
          approval={approval}
          waiting={state.approvals.length - 1}
        />
      ) : start !== null ? (
        <StatusLine turn={running ? turn : undefined} since={start} />
      ) : others > 0 ? (
        <p className="status-line muted">
          <BackgroundDot />
          {others === 1 ? "A subagent is still working" : `${others} subagents are still working`}
        </p>
      ) : null}
      {notices.slice(-1).map((notice) => (
        <div key={notice.message} className="notice" data-level={notice.level}>
          <p className="grow">{notice.message}</p>
          <button
            type="button"
            className="icon-button small"
            title="Dismiss"
            aria-label="Dismiss"
            onClick={() => setDismissed((list) => [...list, notice.message])}
          >
            <Icon name="x" />
          </button>
        </div>
      ))}
    </div>
  );
}

const positions = new Map<string, number | "bottom">();

export function Thread({ sessionId }: { sessionId: string }) {
  const app = useApp();
  const conversation = useStore(app.conversation(sessionId), (value) => value);
  const showThinking = useStore(app.view, (view) => view.showReasoning);
  const cwd = conversation.state?.info.cwd;
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [away, setAway] = useState(false);
  const [count, setCount] = useState(FIRST_TURNS);
  const turns = conversation.state?.turns ?? [];
  const first = Math.max(0, turns.length - count);
  const visible = first ? turns.slice(first) : turns;
  const loaded = conversation.state !== null;
  const askingId = conversation.state?.approvals[0]?.itemId;
  const lastTurn = turns.at(-1);
  const tailGap = lastTurn ? gapBelow(blocksOf(lastTurn, { showThinking })) : 0;

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
        <div className="notice" data-level="error" role="alert">
          {conversation.error}
        </div>
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
        className="thread-scroll fade-y"
        ref={scroller}
        onScroll={(event) => {
          const node = event.currentTarget;
          const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < NEAR_BOTTOM;
          stuck.current = atBottom;
          if (atBottom === away) setAway(!atBottom);
          if (node.scrollTop < 600 && first > 0 && grew.current === null) {
            grew.current = node.scrollHeight;
            setCount((value) => value + MORE_TURNS);
          }
        }}
      >
        <div className="thread-content" ref={content}>
          {first > 0 ? <Divider>{first} earlier turns</Divider> : null}
          {visible.map((turn, index) => (
            <TurnView
              key={turn.id}
              turn={turn}
              sessionId={sessionId}
              showThinking={showThinking}
              askingId={index === visible.length - 1 ? askingId : undefined}
            />
          ))}
          <Tail state={conversation.state} gap={tailGap} />
        </div>
      </div>
      {away ? (
        <div className="to-bottom-anchor">
          <button
            type="button"
            className="to-bottom"
            title="Scroll to bottom"
            aria-label="Scroll to bottom"
            onClick={toBottom}
          >
            <Icon name="arrow-down" />
          </button>
        </div>
      ) : null}
    </OpenFileContext.Provider>
  );
}
