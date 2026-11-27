import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { resourceName } from "../attachments.ts";
import { MENTION_META, wordAt } from "../draft.ts";
import { insideFolder } from "../files-view.ts";
import { SESSION_URI_PREFIX } from "../mention.ts";
import {
  type Block,
  type BlockCache,
  blocksOf,
  type Conversation,
  type FoldCache,
  foldedBlocks,
  type LaidBlock,
  offsetOf,
  type Resend,
  resendOf,
  type Slice,
  shownBlocks,
  sliceOf,
  spaceOf,
  textOf,
} from "../model/index.ts";
import { blockHolds, heldIds, reveal } from "../reveal.ts";
import { BLANK_KEY, filesRootOf } from "../store/index.ts";
import { CopyButton } from "./copy-button.tsx";
import { useI18n } from "./i18n.tsx";
import {
  ArrowDownIcon,
  AttachIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  MessageIcon,
} from "./icons.tsx";
import { ImageBlockView } from "./image.tsx";
import { LoaderClaims, LoaderClaimsProvider } from "./loader-claim.ts";
import { type FileLinks, FileLinksContext, Markdown } from "./markdown.tsx";
import { MessageTime } from "./message-time.tsx";
import { PlanBlock } from "./plan.tsx";
import { ReviewCard } from "./review.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { SubagentCard, subagentWorkOf } from "./subagent.tsx";
import { ThoughtText, useDisplayMode } from "./thought.tsx";
import { Tip } from "./tip.tsx";
import { durationOf, ToolCard, useRevealOpen } from "./tool.tsx";
import { EndBlock, Notice, StepLine, WorkBlock } from "./turn.tsx";

export { toolSummary } from "./tool.tsx";

/** A file or folder the person named with @: the text already says "@path", so the link is not drawn a second time. */
const isMention = (block: Block, text: string): boolean => {
  if (block.type !== "resource_link") return false;
  const path = (block._meta as Record<string, unknown> | undefined)?.[MENTION_META];
  // Only when the words still name it: a link the text no longer shows is drawn, so a file sent is never invisible.
  return typeof path === "string" && text.includes(`@${path}`);
};

const hasWords = (block: Block): boolean =>
  block.type === "text" && String(block.text).trim() !== "";

/** The sessions a message names with @: what its text says of each, and the session's title. */
const sessionMentionsOf = (blocks: readonly Block[]): { said: string; name: string }[] =>
  blocks.flatMap((block) => {
    const said = (block._meta as Record<string, unknown> | undefined)?.[MENTION_META];
    return block.type === "resource_link" &&
      typeof block.uri === "string" &&
      block.uri.startsWith(SESSION_URI_PREFIX) &&
      typeof said === "string" &&
      said !== ""
      ? [{ said, name: typeof block.name === "string" && block.name !== "" ? block.name : said }]
      : [];
  });

/** A session named with @, as a sent message shows it: a chip with its name, not what the agent was given of it. */
const SessionChip = ({ said, name }: { said: string; name: string }) => (
  <span data-slot="mention-chip" data-kind="session" title={name}>
    <MessageIcon size={12} />
    {said}
  </span>
);

/** What a message's words name with @ and draw as a chip: what the words say, and the chip. */
type Chip = { said: string; chip: (key: string) => ReactNode };

/**
 * The files and folders a message names with @ that the Files tab can show (inside the open session's folder): each a
 * chip that shows it there. One it cannot show stays words, as it was.
 */
const fileChipsOf = (
  blocks: readonly Block[],
  inSession: (where: string) => string | undefined,
  show: (path: string, folder: boolean) => void,
  label: string,
): Chip[] =>
  blocks.flatMap((block) => {
    const said = (block._meta as Record<string, unknown> | undefined)?.[MENTION_META];
    if (block.type !== "resource_link" || typeof block.uri !== "string") return [];
    if (!block.uri.startsWith("file://") || typeof said !== "string" || said === "") return [];
    const path = inSession(block.uri);
    if (path === undefined) return [];
    const folder = block.uri.endsWith("/");
    // The link names a folder without its slash; the words, and the box's block, say it with one.
    const words = folder && !said.endsWith("/") ? `${said}/` : said;
    return [
      {
        said: words,
        chip: (key: string) => (
          <button
            type="button"
            key={key}
            data-slot="mention-chip"
            data-kind={folder ? "folder" : "file"}
            title={label}
            onClick={() => show(path, folder)}
          >
            {folder ? <FolderIcon size={12} /> : <FileIcon size={12} />}
            {words}
          </button>
        ),
      },
    ];
  });

/** The words of a message, each `@name` it names drawn as its chip. */
const withChips = (text: string, mentions: readonly Chip[]): ReactNode => {
  if (mentions.length === 0) return text;
  // The longest first, so that a title that starts another does not take part of it. Only as a whole word, as the box
  // sent it (`wordAt`): `@Fix` is not in `@Fixtures`.
  const words = [...mentions].sort((a, b) => b.said.length - a.said.length);
  const parts: ReactNode[] = [];
  let from = 0;
  let at = 0;
  while (from < text.length) {
    let found: { index: number; mention: Chip } | undefined;
    for (const mention of words) {
      const index = wordAt(text, `@${mention.said}`, from);
      if (index !== -1 && (found === undefined || index < found.index)) found = { index, mention };
    }
    if (found === undefined) break;
    if (found.index > from) parts.push(text.slice(from, found.index));
    parts.push(found.mention.chip(`chip-${at}`));
    from = found.index + found.mention.said.length + 1;
    at += 1;
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
};

const linkName = (block: Block): string =>
  typeof block.name === "string" && block.name !== ""
    ? block.name
    : typeof block.uri === "string"
      ? block.uri
      : block.type;

/** The words of a sent message, with the chips of what they name; its attachments are drawn above it. */
function Blocks({ blocks }: { blocks: Block[] }) {
  const { t } = useI18n();
  const store = useAppStore();
  const filesRoot = useAppState(filesRootOf);
  const words = blocks.map((b) => (b.type === "text" ? String(b.text) : "")).join("");
  const chips: Chip[] = [
    ...sessionMentionsOf(blocks).map((mention) => ({
      said: mention.said,
      chip: (key: string) => <SessionChip key={key} {...mention} />,
    })),
    ...fileChipsOf(
      blocks,
      (where) => (filesRoot !== undefined ? insideFolder(where, filesRoot) : undefined),
      (path, folder) => {
        store.showInFiles(path, { folder });
        store.track("file_shown_from_conversation", {
          target: folder ? "folder" : "file",
          from: "mention",
          line: false,
        });
      },
      t("files.showInFiles"),
    ),
  ];
  return (
    <>
      {blocks
        .map((block, index) => ({ block, key: `${block.type}-${index}` }))
        .map(({ block, key }) =>
          block.type === "text" ? (
            <span key={key}>{withChips(String(block.text), chips)}</span>
          ) : isMention(block, words) ? null : sessionMentionsOf([block])[0] !== undefined ? (
            // A session the words no longer name: still its chip, so what the agent was given is never invisible.
            <SessionChip
              key={key}
              {...(sessionMentionsOf([block])[0] as { said: string; name: string })}
            />
          ) : block.type === "resource_link" ? (
            // A link that is not a mention in the text: its name, marked off, so it reads as what was attached.
            <span data-slot="block-note" key={key}>
              [{linkName(block)}]
            </span>
          ) : (
            <span data-slot="block-note" key={key}>
              [{block.type}]
            </span>
          ),
        )}
    </>
  );
}

/** What a person attached to a message, rather than wrote in it: its pictures, and the files it carries whole. */
const isAttached = (block: Block): boolean => block.type === "image" || block.type === "resource";

/**
 * What was attached to a sent message, above its words (CYCL-141): the pictures as a grid of thumbnails, three to five
 * to a row as the column allows, each opening large; then the files, by name. The words are no longer cut by them.
 */
function Attached({ blocks }: { blocks: Block[] }) {
  const { t } = useI18n();
  // The blocks of a sent message never change: their place is who they are.
  const keyed = blocks.map((block, index) => ({ block, key: `${block.type}-${index}` }));
  const images = keyed.filter(({ block }) => block.type === "image");
  const set = images.map(({ block }) => block);
  const files = keyed.filter(({ block }) => block.type === "resource");
  return (
    <section data-slot="message-attachments" aria-label={t("message.attachments")}>
      {images.length > 0 ? (
        <ul data-slot="image-grid">
          {images.map(({ block, key }) => (
            <li key={key}>
              <ImageBlockView block={block} from="user" set={set} />
            </li>
          ))}
        </ul>
      ) : null}
      {files.map(({ block, key }) => (
        <FileChip key={key} block={block} />
      ))}
    </section>
  );
}

/** A file in a sent message: its name on a chip. What is in it is never drawn (it is the person's, and may be HTML). */
function FileChip({ block }: { block: Block }) {
  return (
    <span data-slot="file-chip" title={resourceName(block)}>
      <AttachIcon size={12} />
      <span data-slot="attachment-name">{resourceName(block) ?? block.type}</span>
    </span>
  );
}

/** An agent's message: its text as markdown, and its images where they came, in order. */
function AgentBlocks({ blocks, streaming }: { blocks: Block[]; streaming: boolean }) {
  const parts: { key: string; text?: string; image?: Block }[] = [];
  for (const [index, block] of blocks.entries()) {
    if (block.type === "image") parts.push({ key: `image-${index}`, image: block });
    else {
      const last = parts.at(-1);
      if (last?.text !== undefined) last.text += textOf([block]);
      else parts.push({ key: `text-${index}`, text: textOf([block]) });
    }
  }
  const set = blocks.filter((block) => block.type === "image");
  return (
    <>
      {parts.map((part, at) =>
        part.image !== undefined ? (
          <ImageBlockView key={part.key} block={part.image} from="agent" set={set} />
        ) : (
          <Markdown
            key={part.key}
            text={part.text ?? ""}
            streaming={streaming && at === parts.length - 1}
          />
        ),
      )}
    </>
  );
}

/**
 * The row under a message: Copy, when it has words, and when it was sent or its turn's reply finished, when that is
 * known; the time sits on the side away from the edge the message keeps to. Seen when the pointer is over the message or
 * the focus is in it; it takes its room whether seen or not, so coming and going it moves nothing. A copy is reported as
 * which kind of message, never what it said.
 */
function MessageActions({
  kind,
  text,
  at,
}: {
  kind: "agent" | "user";
  text: (() => string) | undefined;
  at: number | undefined;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  if (text === undefined && at === undefined) return null;
  const time = <MessageTime at={at} kind={kind === "user" ? "sent" : "finished"} />;
  return (
    <div data-slot="message-actions" data-role={kind}>
      {kind === "user" ? time : null}
      {text !== undefined ? (
        <CopyButton
          slot="message-copy"
          label={t(`message.copy.${kind}`)}
          text={text}
          onCopied={() => store.track("message_copied", { kind })}
        />
      ) : null}
      {kind === "agent" ? time : null}
    </div>
  );
}

/**
 * What a sub-agent said and called (docs/protocol.md §9, CYCL-134), laid out as a turn of the conversation is: its words,
 * its stretches of work, its own sub-agents' cards. Drawn only while its card is open.
 */
function SubagentWork({ conversation, live }: { conversation: Conversation; live: boolean }) {
  const blocks = useMemo(() => blocksOf(conversation), [conversation]);
  return (
    <>
      {blocks.map((block) => (
        <BlockView key={block.key} block={block} streaming={false} live={live} />
      ))}
    </>
  );
}

/**
 * The work of a turn that ended normally, before its answer: one line that says how long it took, open on request. It
 * opens by itself when something in it is asked to be shown (from the Overview). What it holds is drawn only while open.
 */
function FoldBlock({ block }: { block: Extract<LaidBlock, { kind: "fold" }> }) {
  const i18n = useI18n();
  const { t } = i18n;
  const store = useAppStore();
  const [open, setOpen] = useState(false);
  // Opened for an item asked to be shown is not the person opening it: only their own press is told.
  useRevealOpen(heldIds(block), setOpen);
  const toggle = (next: boolean) => {
    if (next) store.track("turn_work_opened", {});
    setOpen(next);
  };
  return (
    <Collapsible data-kind="fold" open={open} onOpenChange={toggle}>
      <CollapsibleTrigger>
        <span data-slot="fold-label">
          {block.ms !== undefined
            ? t("turn.worked", { duration: durationOf(i18n, block.ms) })
            : t("turn.workedPlain")}
        </span>
        <ChevronRightIcon size={12} data-slot="tool-chevron" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        {block.blocks.map((inner) => (
          <div key={inner.key} data-slot="block">
            <BlockView block={inner} streaming={false} live={false} ended />
          </div>
        ))}
        <div data-slot="fold-rule">{t("turn.result")}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

const BlockView = memo(function BlockView({
  block,
  streaming,
  live,
  resend,
  replyOf,
  ended,
}: {
  block: LaidBlock;
  /** This is the agent message, or the thought, that is still arriving. */
  streaming: boolean;
  /** This block is in the turn that is going. */
  live: boolean;
  /** The end of a turn that failed, whose message can be sent again. */
  resend?: Resend | undefined;
  /** On the last message of a turn that is over: what the agent wrote in that turn, to copy. */
  replyOf?: ((turn: number) => string) | undefined;
  /** Its turn is over: a reply's row may say when it finished. */
  ended?: boolean | undefined;
}) {
  const { t } = useI18n();
  switch (block.kind) {
    case "user": {
      const blocks = block.item.blocks;
      const attached = blocks.filter(isAttached);
      const said = blocks.filter((b) => !isAttached(b));
      return (
        <>
          {attached.length > 0 ? <Attached blocks={attached} /> : null}
          {said.length > 0 ? (
            <div data-slot="message" data-role="user">
              <Blocks blocks={said} />
            </div>
          ) : null}
          <MessageActions
            kind="user"
            text={blocks.some(hasWords) ? () => textOf(blocks) : undefined}
            at={block.item.at}
          />
        </>
      );
    }
    case "agent":
      return (
        <>
          <div data-slot="message" data-role="agent">
            <AgentBlocks blocks={block.item.blocks} streaming={streaming} />
          </div>
          {replyOf !== undefined ? (
            <MessageActions
              kind="agent"
              text={() => replyOf(block.turn)}
              at={ended === true ? (block.item.lastAt ?? block.item.at) : undefined}
            />
          ) : null}
        </>
      );
    case "thought":
      return <ThoughtText item={block.item} live={streaming} />;
    case "work":
      return <WorkBlock tools={block.tools} live={live} />;
    case "subagent": {
      const sub = block.tool.subagent;
      const work = subagentWorkOf(block.tool);
      // At work while it runs: in the turn that goes, or after it when it was sent to the background.
      const going = sub?.state === "running" && (live || sub.background);
      return (
        <SubagentCard
          tool={block.tool}
          work={work !== undefined ? <SubagentWork conversation={work} live={going} /> : undefined}
        />
      );
    }
    case "review":
      return <ReviewCard tool={block.tool} review={block.review} />;
    case "failed":
      return <ToolCard tool={block.tool} />;
    case "end":
      return <EndBlock stop={block.stop} resend={resend} />;
    case "plan":
      return <PlanBlock item={block.item} />;
    case "compaction":
      return (
        <Notice
          severity={block.item.status === "failed" ? "error" : "info"}
          title={t(`compaction.${block.item.status}`)}
        />
      );
    case "notice":
      return <Notice severity={block.item.severity} title={block.item.title} />;
    case "fold":
      return <FoldBlock block={block} />;
  }
});

/**
 * Where the reader is in each session this page has shown, so going back finds them where they were: the scroll offset, or
 * "bottom", and how tall each block was, which that offset was counted in. Kept in the page's memory, newest last, and only
 * the most recent few are kept.
 */
type Reading = {
  top: number | "bottom";
  heights: Map<string, number>;
  /** The blocks kept drawn for what the reader opened in them. */
  pinned: Set<string>;
  /** How wide the column was: heights are only good for that width. */
  width: number;
};
const readings = new Map<string, Reading>();
const MAX_READINGS = 50;
/** Drops remembered per-session scroll positions and block heights (for test isolation between cases reusing a key). */
export const clearReadings = () => readings.clear();
const remember = (key: string, reading: Reading) => {
  // The blank page is one place for every conversation started there: nothing of one is the next one's.
  if (key === BLANK_KEY) return;
  readings.delete(key);
  readings.set(key, reading);
  const oldest = readings.keys().next();
  if (readings.size > MAX_READINGS && oldest.done !== true) readings.delete(oldest.value);
};

/** Blocks this near the view (in pixels), above and below it, are drawn too, so a scroll finds them ready. */
const LEAD_PX = 800;
/** What a block not yet drawn is taken to be tall, until one has been. */
const GUESS_PX = 96;
/** Until the view is measured. */
const VIEW_PX = 800;
/** Within this many pixels of the end, the reader counts as at the end and follows what arrives. */
const NEAR_END_PX = 48;
/** Growth this soon after the reader pressed a control in the conversation is theirs, not something arriving. */
const ACTED_MS = 600;
/** Further than this from the end, the reader is offered a way back to it. */
const AWAY_PX = 240;

type Plan = {
  sizes: number[];
  slice: Slice;
  /** What is drawn: the blocks near the view, and those the reader has pressed a control in, which keep what they opened. */
  kept: number[];
  /** How tall what is not drawn is, in all. */
  hidden: number;
};

/** What to draw of these blocks, for a view where it is. At the end (`stuck`) the last blocks. */
const planOf = (
  blocks: readonly LaidBlock[],
  heights: ReadonlyMap<string, number>,
  pinned: ReadonlySet<string>,
  view: { top: number; height: number; gap: number },
  stuck: boolean,
): Plan => {
  let known = 0;
  let count = 0;
  for (const block of blocks) {
    const height = heights.get(block.key);
    if (height !== undefined) {
      known += height;
      count += 1;
    }
  }
  const guess = count > 0 ? known / count : GUESS_PX;
  const sizes = blocks.map((block) => heights.get(block.key) ?? guess);
  const slice = sliceOf(
    sizes,
    view.gap,
    stuck ? Number.POSITIVE_INFINITY : view.top,
    view.height,
    LEAD_PX,
  );
  const near = new Set<number>();
  for (let i = slice.start; i < slice.end; i++) near.add(i);
  if (pinned.size > 0)
    blocks.forEach((block, i) => {
      if (pinned.has(block.key)) near.add(i);
    });
  const kept = [...near].sort((a, b) => a - b);
  let hidden = 0;
  for (let i = 0; i < sizes.length; i++) if (!near.has(i)) hidden += sizes[i] ?? 0;
  return { sizes, slice, kept, hidden };
};

const reducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function ConversationView({
  conversation,
  loading,
  awaitingApproval,
  sessionKey,
  follow,
}: {
  conversation: Conversation;
  loading: boolean;
  awaitingApproval: boolean;
  /** Names the session, to remember where it was being read. */
  sessionKey: string;
  /** Changes each time the person sends a message: it is shown, wherever they were reading. */
  follow: number;
}) {
  const { t } = useI18n();
  // Turns that have not changed give back the same blocks, so only the turn that is going is drawn again.
  const cache = useRef<BlockCache>(new Map());
  // In normal mode (Session settings → Display mode) the agent's thinking is left out; detailed shows it.
  const mode = useDisplayMode(sessionKey);
  // Who draws the one loader of this conversation: the status line, or a sub-agent at work (CYCL-217).
  const [claims] = useState(() => new LoaderClaims());
  const laidOut = useMemo(() => blocksOf(conversation, cache.current), [conversation]);
  // A turn that ended normally is read by its answer: the work before it folds into one line.
  const folds = useRef<FoldCache>(new Map());
  const blocks = useMemo(
    () => foldedBlocks(shownBlocks(laidOut, mode), conversation.stops, folds.current),
    [laidOut, mode, conversation.stops],
  );
  // The last turn, when it failed: its end offers to send its message again.
  const resend = useMemo(() => resendOf(conversation), [conversation]);

  // Only the blocks near the view are drawn, and a gap as tall as the rest stands in for them (CYC-464). How tall a block
  // is, is learned as it is drawn; until then it is taken to be as tall as the others have been.
  const saved = useRef(sessionKey === BLANK_KEY ? undefined : readings.get(sessionKey)).current;
  const ref = useRef<HTMLDivElement>(null);
  const heights = useRef(saved?.heights ?? new Map<string, number>()).current;
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const stuck = useRef(saved === undefined || saved.top === "bottom");
  // The view as last seen: where it is scrolled to, how tall it is, and the gap between blocks.
  const view = useRef({
    top: saved === undefined || saved.top === "bottom" ? 0 : saved.top,
    height: VIEW_PX,
    gap: 12,
  });
  // Blocks the reader pressed a control in are kept drawn: what they opened would be lost, and their height with it.
  const pinned = useRef(saved?.pinned ?? new Set<string>()).current;
  const width = useRef(saved?.width ?? 0);
  // A conversation put in the place of another (the blank page's): what was measured of the other is not of this one.
  const firstKey = useRef(blocks[0]?.key);
  if (blocks[0] !== undefined && firstKey.current !== blocks[0].key) {
    if (firstKey.current !== undefined) {
      heights.clear();
      pinned.clear();
    }
    firstKey.current = blocks[0].key;
  }
  const plan = planOf(blocks, heights, pinned, view.current, stuck.current);
  const { sizes } = plan;
  // The view's height and place when last seen. A scroll that comes with a change of height and does not go up (a line
  // under the title bar, the box growing) is the layout's, not the reader's: it does not stop following the end.
  const lastSeen = useRef({ height: 0, top: 0 });
  const restored = useRef(false);
  const seenFollow = useRef(follow);

  // Read through a ref, so that what listens to the view lasts the session instead of one per streamed chunk.
  const laid = useRef({ blocks, plan });
  laid.current = { blocks, plan };
  // The view moved or changed height, or what is drawn was measured: if other blocks are now near it, or what stands for the
  // rest is another height, they are drawn again. A screen reader is not told of blocks that come and go as the reader
  // scrolls past them (`quiet`), but is of those that arrive at the end being followed.
  const refit = useCallback(
    (quiet = false) => {
      const el = ref.current;
      if (el === null) return;
      view.current.top = el.scrollTop;
      view.current.height = el.clientHeight > 0 ? el.clientHeight : VIEW_PX;
      if (el.clientWidth > 0) width.current = el.clientWidth;
      const now = laid.current.plan;
      const next = planOf(laid.current.blocks, heights, pinned, view.current, stuck.current);
      if (
        next.slice.start === now.slice.start &&
        next.slice.end === now.slice.end &&
        next.kept.length === now.kept.length &&
        Math.abs(next.hidden - now.hidden) < 1
      )
        return;
      if (quiet) el.setAttribute("aria-live", "off");
      redraw();
    },
    [heights, pinned],
  );
  // How tall each block drawn is, with the room its turn's start gives it above.
  const measure = useRef<ResizeObserver | undefined>(undefined);
  const measured = useRef(0);
  const keyOf = useRef(sessionKey);
  keyOf.current = sessionKey;
  const observeBlock = useCallback(
    (node: HTMLDivElement | null) => {
      if (node === null || typeof ResizeObserver === "undefined") return;
      measure.current ??= new ResizeObserver((entries) => {
        let changed = false;
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.blockKey;
          if (key === undefined) continue;
          // Not what a hidden or collapsed view makes of it: zero is nothing measured.
          const box = entry.target.getBoundingClientRect();
          if (box.height === 0 || ref.current === null || ref.current.clientHeight === 0) continue;
          const margin = Number.parseFloat(getComputedStyle(entry.target).marginTop) || 0;
          const height = box.height + margin;
          if (Math.abs((heights.get(key) ?? -1) - height) > 0.5) changed = true;
          heights.set(key, height);
        }
        // What is now known of how tall blocks are moves what stands for the rest, and how many the view holds: once a frame.
        if (changed && measured.current === 0)
          measured.current = requestAnimationFrame(() => {
            measured.current = 0;
            refit();
            const el = ref.current;
            if (el !== null)
              remember(keyOf.current, {
                top: stuck.current ? "bottom" : el.scrollTop,
                heights,
                pinned,
                width: width.current,
              });
          });
      });
      measure.current.observe(node);
      return () => measure.current?.unobserve(node);
    },
    [heights, refit, pinned],
  );
  useLayoutEffect(() => {
    const el = ref.current;
    if (el?.getAttribute("aria-live") === "off")
      requestAnimationFrame(() => el.removeAttribute("aria-live"));
  });
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const gap = Number.parseFloat(getComputedStyle(el).rowGap);
    if (Number.isFinite(gap)) view.current.gap = gap;
    refit();
    return () => {
      cancelAnimationFrame(measured.current);
      measured.current = 0;
      // Back to this session, the reader finds the blocks as tall as they were.
      remember(keyOf.current, {
        top: stuck.current ? "bottom" : view.current.top,
        heights,
        pinned,
        width: width.current,
      });
    };
  }, [refit, heights, pinned]);

  // Asked to show an item (from the Overview): if its block is not drawn, the view goes to where it is, and once it is
  // drawn (its card opened) it is scrolled to the middle and marked for a moment.
  const revealing = useRef<{ id: string; serial: number } | undefined>(undefined);
  useEffect(
    () =>
      reveal.subscribe(() => {
        const asked = reveal.get();
        if (asked === undefined || asked.sessionKey !== sessionKey) return;
        const { blocks, plan } = laid.current;
        const { sizes, slice } = plan;
        const at = blocks.findIndex((block) => blockHolds(block as never, asked.itemId));
        if (at === -1) return reveal.done(asked.serial);
        const el = ref.current;
        stuck.current = false;
        if (el !== null && (at < slice.start || at >= slice.end)) {
          const middle = offsetOf(sizes, view.current.gap, at) + (sizes[at] ?? 0) / 2;
          el.scrollTop = Math.max(0, middle - el.clientHeight / 2);
          view.current.top = el.scrollTop;
        }
        // Its block keeps what the card opens for it, whichever way the reader scrolls after.
        const held = blocks[at];
        if (held !== undefined) pinned.add(held.key);
        revealing.current = { id: asked.itemId, serial: asked.serial };
        redraw();
      }),
    [sessionKey, pinned],
  );
  useEffect(() => {
    const asked = revealing.current;
    const el = ref.current;
    if (asked === undefined || el === null) return;
    const { id, serial } = asked;
    revealing.current = undefined;
    let settling = 0;
    let frames = 0;
    // Not undone by the next render: a streamed chunk must not stop the search, nor leave the mark on. It goes on until the
    // item is drawn (its block was found, so it will be), or the view is gone or another item is asked for.
    const find = () => {
      const now = reveal.get();
      if (!el.isConnected || (now !== undefined && now.serial !== serial))
        return reveal.done(serial);
      const node = el.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`);
      // The card that holds it opens on the next frame or two; its block may be drawn where it was guessed to be, not yet
      // where it is.
      if (node === null) {
        const { blocks, plan } = laid.current;
        const at = blocks.findIndex((block) => blockHolds(block as never, id));
        if (at === -1) return reveal.done(serial);
        if (frames === 0 && (at < plan.slice.start || at >= plan.slice.end)) {
          const middle = offsetOf(plan.sizes, view.current.gap, at) + (plan.sizes[at] ?? 0) / 2;
          el.scrollTop = Math.max(0, middle - el.clientHeight / 2);
        }
        // The block is there to be drawn, so it is within a few frames; if not, it is given up, not looked for for ever.
        if (++frames >= 30) return reveal.done(serial);
        requestAnimationFrame(find);
        return;
      }
      node.scrollIntoView?.({ block: "center" });
      // Heights found on the way move it: once more when they have settled.
      if (settling++ < 2) return void requestAnimationFrame(find);
      reveal.done(serial);
      node.setAttribute("data-revealed", "");
      setTimeout(() => node.removeAttribute("data-revealed"), 1200);
    };
    find();
  });

  // Where the reader was comes back with the session, once it is loaded.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || loading || restored.current) return;
    restored.current = true;
    if (saved !== undefined && saved.width !== el.clientWidth) {
      // Wider or narrower than when it was read: the heights, and the place counted in them, are not this column's. The
      // end is shown, and the blocks are measured again as they are drawn.
      heights.clear();
      stuck.current = true;
      redraw();
    } else if (saved !== undefined && saved.top !== "bottom") {
      stuck.current = false;
      el.scrollTop = saved.top;
    }
  }, [loading, saved, heights]);

  // What the person has just sent is shown, wherever they were reading.
  useEffect(() => {
    if (follow === seenFollow.current) return;
    seenFollow.current = follow;
    stuck.current = true;
    redraw();
  }, [follow]);

  // Keeps the reader's view pinned to the end and records the new scrollTop so a delayed scroll event from this
  // programmatic move is never mistaken for the reader scrolling away when more content arrives in the meantime.
  const stickToEnd = useCallback((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
    lastSeen.current.top = el.scrollTop;
    view.current.top = el.scrollTop;
  }, []);

  // After every content growth while following the end: keep the end in view.
  useEffect(() => {
    const el = ref.current;
    if (el === null || loading || !stuck.current) return;
    if (blocks.length === 0 && conversation.status === "idle" && follow === 0) return;
    stickToEnd(el);
  }, [blocks, conversation.status, follow, loading, stickToEnd]);

  // What is drawn can grow after it is laid out: code is coloured when its highlighter loads, a code block off screen is
  // measured when it comes near. While following the end, the end is kept in view through that too; when reading above
  // it, nothing is moved. Growth the reader caused (showing a code block whole, opening a tool) is theirs to read: the view
  // stays, and it follows the end again only once they are back at it. One observer for the view's life; blocks added or
  // removed are watched or let go as they come.
  const acted = useRef(0);
  const following = useRef({ loading });
  following.current.loading = loading;
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    lastSeen.current = { height: el.clientHeight, top: el.scrollTop };
    if (typeof ResizeObserver === "undefined") return;
    const keep = new ResizeObserver(() => {
      lastSeen.current.height = el.clientHeight;
      refit();
      if (!stuck.current || following.current.loading) return;
      if (performance.now() - acted.current < ACTED_MS) {
        stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END_PX;
        return;
      }
      stickToEnd(el);
    });
    for (const child of Array.from(el.children)) keep.observe(child);
    // The view itself too: a line that comes under the title bar takes its height from it, and the end stays in view.
    keep.observe(el);
    const children = new MutationObserver((changes) => {
      for (const change of changes) {
        for (const node of Array.from(change.addedNodes))
          if (node instanceof Element) keep.observe(node);
        for (const node of Array.from(change.removedNodes))
          if (node instanceof Element) keep.unobserve(node);
      }
    });
    children.observe(el, { childList: true });
    // Only a control: a click that selects words, while a reply streams, is no reason to stop following it.
    const act = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest("button, summary, [role='button']")
      )
        acted.current = performance.now();
    };
    // A block with something open in it is kept drawn, so that what was opened is there when the reader comes back; one
    // closed again is let go.
    const pin = (event: Event) => {
      const block =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-slot="block"]')
          : null;
      const key = block?.dataset.blockKey;
      if (block === null || key === undefined) return;
      // After the card has taken the press.
      requestAnimationFrame(() => {
        if (block.querySelector('[aria-expanded="true"]') !== null) pinned.add(key);
        else pinned.delete(key);
      });
    };
    el.addEventListener("click", pin);
    el.addEventListener("pointerdown", act, true);
    el.addEventListener("keydown", act, true);
    return () => {
      keep.disconnect();
      children.disconnect();
      el.removeEventListener("pointerdown", act, true);
      el.removeEventListener("keydown", act, true);
      el.removeEventListener("click", pin);
    };
  }, [refit, pinned, stickToEnd]);

  // Away from the end, a button takes the reader back to it, and says when something arrived there meanwhile.
  const store = useAppStore();
  const [away, setAway] = useState(false);
  const [fresh, setFresh] = useState(false);
  const returning = useRef(false);
  const seen = useRef(conversation.items);
  useEffect(() => {
    if (seen.current === conversation.items) return;
    seen.current = conversation.items;
    const el = ref.current;
    if (el === null || loading || stuck.current) return;
    // Not scrolled, and yet further from the end: what arrived pushed it away.
    const far = el.scrollHeight - el.scrollTop - el.clientHeight > AWAY_PX;
    setAway(far);
    if (far) setFresh(true);
  }, [conversation.items, loading]);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    // A smooth scroll aims at where the end was when it began: what arrived on the way is gone to as well, at once.
    const ended = () => {
      if (!returning.current) return;
      returning.current = false;
      // Blocks drawn on the way were measured, and the end moved: it is gone to again, however near it was.
      if (el.scrollHeight - el.scrollTop - el.clientHeight > 1) stickToEnd(el);
    };
    el.addEventListener("scrollend", ended);
    return () => el.removeEventListener("scrollend", ended);
  }, [stickToEnd]);
  const toEnd = () => {
    const el = ref.current;
    if (el === null) return;
    store.track("back_to_bottom_used", { fresh });
    // The button goes when the end is reached: the focus stays in the conversation, not on the page.
    if (el.contains(document.activeElement)) el.focus({ preventScroll: true });
    const reduced = reducedMotion();
    returning.current = !reduced;
    el.scrollTo({ top: el.scrollHeight, behavior: reduced ? "instant" : "smooth" });
  };

  const onScroll = () => {
    const el = ref.current;
    if (el === null) return;
    const was = lastSeen.current;
    view.current.top = el.scrollTop;
    lastSeen.current = { height: el.clientHeight, top: el.scrollTop };
    const fromEnd = el.scrollHeight - el.scrollTop - el.clientHeight;
    // The layout or content growing under a programmatic follow-the-end scroll moved it, not the reader: the end that
    // was followed is kept in view. A scroll up (`el.scrollTop < was.top`) or a control the reader just opened is theirs.
    if (
      stuck.current &&
      !following.current.loading &&
      el.scrollTop >= was.top &&
      performance.now() - acted.current >= ACTED_MS &&
      (el.clientHeight !== was.height || fromEnd >= NEAR_END_PX)
    ) {
      stickToEnd(el);
      refit();
      return;
    }
    setAway(fromEnd > AWAY_PX);
    if (fromEnd < NEAR_END_PX) setFresh(false);
    stuck.current = fromEnd < NEAR_END_PX;
    remember(sessionKey, {
      top: stuck.current ? "bottom" : el.scrollTop,
      heights,
      pinned,
      width: width.current,
    });
    refit(!stuck.current);
  };

  const working = conversation.status !== "idle";
  const lastAgent = blocks.findLastIndex((block) => block.kind === "agent");
  // The last message of each turn that has words: a turn's reply is copied from under it, all it wrote, as markdown.
  const replyEnds = useMemo(() => {
    const ends = new Map<number, string>();
    for (const block of blocks)
      if (block.kind === "agent" && block.item.blocks.some(hasWords))
        ends.set(block.turn, block.key);
    return new Set(ends.values());
  }, [blocks]);
  // Read at the press, from what is laid then: one function for the view's life, so a block that did not change is not
  // drawn again.
  const replyOf = useCallback(
    (turn: number) =>
      laid.current.blocks
        .flatMap((block) => (block.kind === "fold" ? block.blocks : [block]))
        .flatMap((block) =>
          block.kind === "agent" && block.turn === turn ? [textOf(block.item.blocks)] : [],
        )
        .filter((text) => text.trim() !== "")
        .join("\n\n"),
    [],
  );

  // The thought still arriving: the last thing the turn that is going has said.
  const lastItem = conversation.items.at(-1);
  // A file a reply names, in the session's folder, opens in the Files tab.
  const filesRoot = useAppState(filesRootOf);
  const fileLinks = useMemo<FileLinks | undefined>(
    () =>
      filesRoot === undefined
        ? undefined
        : {
            root: filesRoot,
            open: (file) => {
              const folder = file.folder === true;
              store.showInFiles(file.path, { folder, line: file.line, end: file.end });
              store.track("file_shown_from_conversation", {
                target: folder ? "folder" : "file",
                from: "message",
                line: file.line !== undefined,
              });
            },
          },
    [filesRoot, store],
  );
  // What is drawn, with a gap as tall as each stretch not drawn between.
  const rows: ReactNode[] = [];
  const gapOf = (from: number, to: number) => (
    <div
      key={`\0gap-${from}`}
      data-slot="spacer"
      aria-hidden="true"
      style={{ height: spaceOf(sizes, view.current.gap, from, to) }}
    />
  );
  let prev = -1;
  for (const index of plan.kept) {
    const block = blocks[index];
    if (block === undefined) continue;
    if (index > prev + 1) rows.push(gapOf(prev + 1, index));
    prev = index;
    rows.push(
      <div
        key={block.key}
        ref={observeBlock}
        data-slot="block"
        data-block-key={block.key}
        data-turn-start={(block.startsTurn && index > 0) || undefined}
      >
        <BlockView
          block={block}
          streaming={
            working &&
            block.turn === conversation.turns &&
            (block.kind === "thought" ? block.item === lastItem : index === lastAgent)
          }
          live={working && block.turn === conversation.turns}
          resend={block.kind === "end" && resend?.turn === block.turn ? resend : undefined}
          replyOf={
            replyEnds.has(block.key) && !(working && block.turn === conversation.turns)
              ? replyOf
              : undefined
          }
          ended={block.turn < conversation.turns}
        />
      </div>,
    );
  }
  if (prev < blocks.length - 1) rows.push(gapOf(prev + 1, blocks.length));
  return (
    <FileLinksContext.Provider value={fileLinks}>
      <LoaderClaimsProvider value={claims}>
        <div
          data-slot="conversation"
          ref={ref}
          onScroll={onScroll}
          role="log"
          tabIndex={-1}
          aria-label={t("conversation.label")}
          aria-busy={loading}
        >
          {loading ? (
            <div data-slot="loading">
              <StateBlock tone="loading" title={t("conversation.loading")} />
            </div>
          ) : null}
          {!loading && conversation.items.length === 0 ? (
            <div data-slot="conversation-empty">
              <StateBlock tone="empty" title={t("conversation.empty")} />
            </div>
          ) : null}
          {rows}
          {!loading ? (
            <StepLine
              conversation={conversation}
              awaitingApproval={awaitingApproval}
              sessionKey={sessionKey}
            />
          ) : null}
          {/* Held to the bottom of the view while the end is below it, and taking no room, so it moves nothing it floats over. */}
          <div data-slot="to-end">
            {away && !loading ? (
              <Tip label={fresh ? t("conversation.toEndFresh") : t("conversation.toEnd")}>
                <button
                  type="button"
                  data-slot="to-end-button"
                  data-fresh={fresh || undefined}
                  onClick={toEnd}
                >
                  <ArrowDownIcon size={16} />
                </button>
              </Tip>
            ) : null}
          </div>
        </div>
      </LoaderClaimsProvider>
    </FileLinksContext.Provider>
  );
}
