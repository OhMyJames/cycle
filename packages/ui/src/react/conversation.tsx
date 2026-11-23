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
  earlierAnchor,
  type LaidBlock,
  type Resend,
  resendOf,
  shownBlocks,
  textOf,
  windowStart,
} from "../model/index.ts";
import { blockHolds, reveal } from "../reveal.ts";
import { filesRootOf } from "../store/index.ts";
import { CopyButton } from "./copy-button.tsx";
import { useI18n } from "./i18n.tsx";
import { ArrowDownIcon, AttachIcon, FileIcon, FolderIcon, MessageIcon } from "./icons.tsx";
import { ImageBlockView } from "./image.tsx";
import { type FileLinks, FileLinksContext, Markdown } from "./markdown.tsx";
import { MessageTime } from "./message-time.tsx";
import { PlanBlock } from "./plan.tsx";
import { ReviewCard } from "./review.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { SubagentCard } from "./subagent.tsx";
import { ThoughtText, useDisplayMode } from "./thought.tsx";
import { Tip } from "./tip.tsx";
import { ToolCard } from "./tool.tsx";
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
    return [
      {
        said,
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
            {said}
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
  const files = keyed.filter(({ block }) => block.type === "resource");
  return (
    <section data-slot="message-attachments" aria-label={t("message.attachments")}>
      {images.length > 0 ? (
        <ul data-slot="image-grid">
          {images.map(({ block, key }) => (
            <li key={key}>
              <ImageBlockView block={block} from="user" />
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
  return (
    <>
      {parts.map((part, at) =>
        part.image !== undefined ? (
          <ImageBlockView key={part.key} block={part.image} from="agent" />
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
    case "subagent":
      return <SubagentCard tool={block.tool} />;
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
  }
});

/**
 * Where the reader is in each session this page has shown, so going back finds them where they were: the first block that
 * was drawn (when they were not at the end) and the scroll offset, or "bottom". Kept in the page's memory, newest last,
 * and only the most recent few are kept.
 */
type Reading = { anchor: string | undefined; top: number | "bottom" };
const readings = new Map<string, Reading>();
const MAX_READINGS = 50;
const remember = (key: string, reading: Reading) => {
  readings.delete(key);
  readings.set(key, reading);
  const oldest = readings.keys().next();
  if (readings.size > MAX_READINGS && oldest.done !== true) readings.delete(oldest.value);
};

/** How near the top (in pixels) the first block shown may be before earlier ones are added. */
const LEAD_PX = 800;
/** Within this many pixels of the end, the reader counts as at the end and follows what arrives. */
const NEAR_END_PX = 48;
/** Growth this soon after the reader pressed a control in the conversation is theirs, not something arriving. */
const ACTED_MS = 600;
/** Further than this from the end, the reader is offered a way back to it. */
const AWAY_PX = 240;

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
  const laidOut = useMemo(() => blocksOf(conversation, cache.current), [conversation]);
  const blocks = useMemo(() => shownBlocks(laidOut, mode), [laidOut, mode]);
  // The last turn, when it failed: its end offers to send its message again.
  const resend = useMemo(() => resendOf(conversation), [conversation]);

  // A long conversation shows its end. While the reader is at the end the window is the last page, and slides as blocks
  // arrive; once they leave the end it is pinned to its first block (the anchor), so what arrives does not move the top.
  const saved = useRef(readings.get(sessionKey)).current;
  const ref = useRef<HTMLDivElement>(null);
  const anchor = useRef<string | undefined>(saved?.anchor);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const start = windowStart(blocks, anchor.current);
  // An anchor whose block is gone (a turn was laid again): back to the last page.
  if (anchor.current !== undefined && blocks[start]?.key !== anchor.current)
    anchor.current = undefined;
  const stuck = useRef(saved === undefined || saved.top === "bottom");
  const restored = useRef(false);
  const prepending = useRef<{ node: Element; top: number } | null>(null);
  const refocus = useRef(false);
  const seenFollow = useRef(follow);

  // Asked to show an item (from the Overview): the window moves to its block if it is above it, and once it is drawn
  // (its card opened) it is scrolled to the middle and marked for a moment.
  const revealing = useRef<{ id: string; serial: number } | undefined>(undefined);
  // Read through a ref, so that one subscription lasts the session instead of one per streamed chunk.
  const laid = useRef({ blocks, start });
  laid.current = { blocks, start };
  useEffect(
    () =>
      reveal.subscribe(() => {
        const asked = reveal.get();
        if (asked === undefined || asked.sessionKey !== sessionKey) return;
        const { blocks, start } = laid.current;
        const at = blocks.findIndex((block) => blockHolds(block as never, asked.itemId));
        if (at === -1) return reveal.done(asked.serial);
        if (at < start) anchor.current = blocks[at]?.key;
        stuck.current = false;
        revealing.current = { id: asked.itemId, serial: asked.serial };
        redraw();
      }),
    [sessionKey],
  );
  useEffect(() => {
    const asked = revealing.current;
    const el = ref.current;
    if (asked === undefined || el === null) return;
    const { id, serial } = asked;
    revealing.current = undefined;
    let frames = 0;
    // Not undone by the next render: a streamed chunk must not stop the search, nor leave the mark on.
    const find = () => {
      if (!el.isConnected) return reveal.done(serial);
      const node = el.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`);
      // The card that holds it opens on the next frame or two.
      if (node === null) {
        if (++frames < 10) requestAnimationFrame(find);
        else reveal.done(serial);
        return;
      }
      reveal.done(serial);
      node.scrollIntoView?.({ block: "center" });
      node.setAttribute("data-revealed", "");
      setTimeout(() => node.removeAttribute("data-revealed"), 1200);
    };
    find();
  });

  const showEarlier = () => {
    const el = ref.current;
    const node = el?.querySelector('[data-slot="block"]') ?? null;
    prepending.current =
      el !== null && node !== null ? { node, top: node.getBoundingClientRect().top } : null;
    // For the frame that adds blocks above the reader: the browser's own anchoring must not move the view as well, and a
    // screen reader must not be told of the whole page that was added.
    el?.setAttribute("data-prepending", "");
    el?.setAttribute("aria-live", "off");
    refocus.current = document.activeElement?.getAttribute("data-slot") === "earlier";
    anchor.current = earlierAnchor(blocks, start);
    redraw();
  };

  // Blocks added above the reader would push what they are reading down: the view is moved by how far that block moved.
  useLayoutEffect(() => {
    const el = ref.current;
    const before = prepending.current;
    if (el !== null && before !== null) {
      prepending.current = null;
      if (before.node.isConnected)
        el.scrollTop += before.node.getBoundingClientRect().top - before.top;
      requestAnimationFrame(() => {
        el.removeAttribute("data-prepending");
        el.removeAttribute("aria-live");
      });
    }
    // The button that was pressed is gone, there being nothing earlier: focus goes to the conversation, not to the page.
    if (el !== null && refocus.current) {
      refocus.current = false;
      if (el.querySelector('[data-slot="earlier"]') === null) el.focus();
    }
  });

  // Where the reader was comes back with the session, once it is loaded.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || loading || restored.current) return;
    restored.current = true;
    if (saved !== undefined && saved.top !== "bottom") {
      stuck.current = false;
      el.scrollTop = saved.top;
    }
  }, [loading, saved]);

  // What the person has just sent is shown, wherever they were reading.
  useEffect(() => {
    if (follow === seenFollow.current) return;
    seenFollow.current = follow;
    stuck.current = true;
    anchor.current = undefined;
  }, [follow]);

  // After every content growth while following the end: keep the end in view.
  useEffect(() => {
    const el = ref.current;
    if (el === null || loading || !stuck.current) return;
    if (blocks.length === 0 && conversation.status === "idle" && follow === 0) return;
    el.scrollTop = el.scrollHeight;
  }, [blocks, conversation.status, follow, loading]);

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
    if (el === null || typeof ResizeObserver === "undefined") return;
    const keep = new ResizeObserver(() => {
      if (!stuck.current || following.current.loading) return;
      if (performance.now() - acted.current < ACTED_MS) {
        stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END_PX;
        return;
      }
      el.scrollTop = el.scrollHeight;
    });
    for (const child of Array.from(el.children)) keep.observe(child);
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
    el.addEventListener("pointerdown", act, true);
    el.addEventListener("keydown", act, true);
    return () => {
      keep.disconnect();
      children.disconnect();
      el.removeEventListener("pointerdown", act, true);
      el.removeEventListener("keydown", act, true);
    };
  }, []);

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
      if (el.scrollHeight - el.scrollTop - el.clientHeight >= NEAR_END_PX)
        el.scrollTop = el.scrollHeight;
    };
    el.addEventListener("scrollend", ended);
    return () => el.removeEventListener("scrollend", ended);
  }, []);
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
    const fromEnd = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAway(fromEnd > AWAY_PX);
    if (fromEnd < NEAR_END_PX) setFresh(false);
    stuck.current = fromEnd < NEAR_END_PX;
    if (stuck.current) anchor.current = undefined;
    // Not a thought: one is left out when the session is set to normal, and the place would be lost with it.
    else if (anchor.current === undefined)
      anchor.current = blocks.slice(start).find((block) => block.kind !== "thought")?.key;
    remember(sessionKey, { anchor: anchor.current, top: stuck.current ? "bottom" : el.scrollTop });
    if (el.scrollTop < LEAD_PX && start > 0) showEarlier();
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
  return (
    <FileLinksContext.Provider value={fileLinks}>
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
        {start > 0 ? (
          <button type="button" data-slot="earlier" onClick={showEarlier}>
            {t("conversation.earlier")}
          </button>
        ) : null}
        {blocks.slice(start).map((block, at) => (
          <div key={block.key} data-slot="block" data-turn-start={block.startsTurn || undefined}>
            <BlockView
              block={block}
              streaming={
                working &&
                block.turn === conversation.turns &&
                (block.kind === "thought" ? block.item === lastItem : start + at === lastAgent)
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
          </div>
        ))}
        {!loading ? (
          <StepLine conversation={conversation} awaitingApproval={awaitingApproval} />
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
    </FileLinksContext.Provider>
  );
}
