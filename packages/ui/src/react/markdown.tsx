import { createCodePlugin } from "@streamdown/code";
import { useReducedMotion } from "motion/react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type AnimateOptions,
  defaultRehypePlugins,
  defaultRemarkPlugins,
  Streamdown,
  useIsCodeFenceIncomplete,
} from "streamdown";
import { type CodeThemeId, codeTheme, themesOf } from "../code-theme.ts";
import {
  codeReference,
  FILE_LINK_SCHEME,
  type FileReference,
  isPathLink,
  linkReference,
  pathLinkUrl,
} from "../file-reference.ts";
import { mendStreaming } from "../markdown-mend.ts";
import { AgentLink } from "./agent-link.tsx";
import { CopyButton } from "./copy-button.tsx";
import { Diagram } from "./diagram.tsx";
import { useI18n } from "./i18n.tsx";
import { useOptionalAppStore } from "./store-context.tsx";

/**
 * Markdown from an agent. It is untrusted: it can hold raw HTML, links and images the agent chose.
 * - Raw HTML is dropped (`skipHtml`), not rendered.
 * - Only http, https and mailto links are links; the rest is text. A click asks before it opens (`AgentLink`).
 * - An image is never fetched, so reading a message cannot make a request. It shows as text.
 * Streamdown's own defaults allow every image and link prefix, so none of this is left to them.
 */

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export const isSafeLink = (href: string | undefined): boolean => {
  if (href === undefined) return false;
  try {
    return SAFE_PROTOCOLS.has(new URL(href).protocol);
  } catch {
    return false;
  }
};

/**
 * What lets a reply open the files it names in the Files tab: the session's folder, which a relative path is read from
 * and outside which nothing is opened, and how to open one. Given by the conversation; without it (a document previewed
 * in Files, a test) a path stays text.
 */
export type FileLinks = { root: string; open: (file: FileReference) => void };
export const FileLinksContext = createContext<FileLinks | undefined>(undefined);

/** The words are a link's already: code in them is not a link of its own. */
const InLink = createContext(false);

/** A press that ended a drag selecting these words is not a request to open them; text selected elsewhere does not count. */
const selectingIn = (element: Element): boolean => {
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed && selection.containsNode(element, true);
};

/**
 * Words of a reply that name a file of the session's folder: a press shows it in Files. A link, not a `<button>`, whose
 * words cannot be selected: a path can still be copied out of a reply. It cannot be dragged, so a drag selects it.
 */
function FileLink({ file, children }: { file: FileReference; children: ReactNode }) {
  const { t } = useI18n();
  const links = useContext(FileLinksContext);
  return (
    <InLink.Provider value={true}>
      <a
        href={`${FILE_LINK_SCHEME}${encodeURI(file.path)}`}
        draggable={false}
        data-slot="file-link"
        title={`${t("files.showInFiles")}: ${file.path}`}
        onClick={(event) => {
          event.preventDefault();
          // A key press is never a selection's end.
          if (event.detail === 0 || !selectingIn(event.currentTarget)) links?.open(file);
        }}
      >
        {children}
      </a>
    </InLink.Provider>
  );
}

/** The words of a hast node, however the fade-in split them into spans. */
const nodeText = (node: unknown): string => {
  if (typeof node !== "object" || node === null) return "";
  if ("value" in node && typeof node.value === "string") return node.value;
  return "children" in node && Array.isArray(node.children)
    ? node.children.map(nodeText).join("")
    : "";
};

/**
 * Inline code. One that names a file of the session's folder opens it in Files, once the reply is written: while it is,
 * `src/app.t` would be a link to a file that is not there, and the code would be drawn again at every letter.
 */
function InlineCode({
  node,
  className,
  children,
  ...rest
}: ComponentProps<"code"> & { node?: unknown }) {
  const links = useContext(FileLinksContext);
  const inLink = useContext(InLink);
  const streaming = useContext(Streaming);
  // Streamdown's own classes, which the Files preview's markdown is drawn with.
  const classes = ["rounded bg-muted px-1.5 py-0.5 font-mono text-sm", className]
    .filter(Boolean)
    .join(" ");
  const code = (
    <code {...rest} className={classes} data-streamdown="inline-code">
      {children}
    </code>
  );
  const file =
    links !== undefined && !inLink && !streaming
      ? codeReference(nodeText(node), links.root)
      : undefined;
  return file !== undefined ? <FileLink file={file}>{code}</FileLink> : code;
}

function SafeLink({ href, children }: { href?: string | undefined; children?: ReactNode }) {
  const store = useOptionalAppStore();
  const links = useContext(FileLinksContext);
  const streaming = useContext(Streaming);
  // A path in the session's folder (relative, absolute or `file:`) opens in Files, once the reply is written; any other
  // one is its words.
  const file = links !== undefined && !streaming ? linkReference(href, links.root) : undefined;
  if (file !== undefined) return <FileLink file={file}>{children}</FileLink>;
  if (href === undefined || !isSafeLink(href))
    return <span data-slot="unsafe-link">{children}</span>;
  // That a link in a message was opened, never which.
  return (
    <InLink.Provider value={true}>
      <AgentLink href={href} onOpened={() => store?.track("message_link_opened", {})}>
        {children}
      </AgentLink>
    </InLink.Provider>
  );
}

function BlockedImage({ alt }: { alt?: string | undefined }) {
  return (
    <span data-slot="blocked-image">
      {alt ? `[image not loaded: ${alt}]` : "[image not loaded]"}
    </span>
  );
}

/**
 * A code block longer than this many lines is shown in part when it is first drawn whole. How many lines show (12) is the
 * stylesheet's (`[data-slot="code-fold"][data-folded]`), in lines of the block's own height.
 */
export const FOLD_OVER = 30;

/** The reply this block is in is still being written. */
const Streaming = createContext(false);

/** Each time this goes up, every code block is shown whole: a file in Files is shown at a line (`Markdown`'s `unfold`). */
const Unfold = createContext(0);

const textOf = (code: ReactElement): string => {
  const text = (code.props as { children?: unknown }).children;
  return typeof text === "string" ? text : Array.isArray(text) ? text.join("") : "";
};

const lineCount = (code: ReactElement): number =>
  textOf(code).replace(/\n$/, "").split("\n").length;

/** A ```mermaid fence: drawn as a diagram (diagram.tsx) once it is closed. */
const isMermaid = (code: ReactElement): boolean =>
  /(?:^|\s)language-mermaid(?:\s|$)/i.test(
    String((code.props as { className?: unknown }).className ?? ""),
  );

/**
 * A code block, and when it is long, a way to show all of it or part. A block that arrived whole (an answer read again, a
 * session opened) starts in part; one that was written on screen stays whole, so the end of a reply never shrinks under
 * the reader. Copy copies all of it either way. Folding is the block's own: Streamdown's height cap, which scrolled the
 * block inside the conversation's scroll, is off. Copy is ours too: Streamdown's wrote to the page's own clipboard, which
 * the app gives the page no permission for, so it went through main like every other copy.
 */
function CodeFold({ children }: { children?: ReactNode }) {
  const { t } = useI18n();
  const store = useOptionalAppStore();
  const incomplete = useIsCodeFenceIncomplete();
  const streaming = useContext(Streaming);
  const unfold = useContext(Unfold);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const code = isValidElement(children) ? children : null;
  const lines = code === null ? 0 : lineCount(code);
  // Not while the reply is written, even when the block came whole in one batch or was drawn again (a session reopened).
  const [folded, setFolded] = useState(
    () => unfold === 0 && !streaming && !incomplete && lines > FOLD_OVER,
  );
  // Before the block is drawn, so that a line asked for is measured where it is in the whole block.
  useLayoutEffect(() => {
    if (unfold > 0) setFolded(false);
  }, [unfold]);
  const block = code === null ? children : cloneElement(code, { "data-block": "true" } as never);
  const diagram = code !== null && isMermaid(code);
  // A diagram's source is shown whole when asked for: it is what the person wants to read or copy.
  const foldable = !diagram && !incomplete && lines > FOLD_OVER;
  const toggle = () => {
    if (folded) store?.track("code_block_expanded", {});
    setFolded(!folded);
    // Shown in part again, the block is shorter: the button stays where the reader is.
    if (!folded) requestAnimationFrame(() => button.current?.scrollIntoView({ block: "nearest" }));
  };
  // The same element around the block whether it can fold or not, so a fence that closes while it streams keeps its block.
  return (
    <div data-slot="code-fold" data-folded={(foldable && folded) || undefined} id={id}>
      {diagram && code !== null ? (
        <Diagram source={textOf(code).replace(/\n$/, "")} complete={!incomplete} code={block} />
      ) : (
        block
      )}
      {code !== null ? (
        <CopyButton
          slot="code-copy"
          label={t("code.copy")}
          text={() => textOf(code).replace(/\n$/, "")}
        />
      ) : null}
      {foldable ? (
        <button
          ref={button}
          type="button"
          data-slot="code-fold-toggle"
          aria-expanded={!folded}
          aria-controls={id}
          onClick={toggle}
        >
          {folded ? t("code.showAll", { count: lines }) : t("code.showFewer")}
        </button>
      ) : null}
    </div>
  );
}

type HastNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

/**
 * A link to a path (what an agent writes for a file) is given a scheme of its own before Streamdown's link check, which
 * cannot resolve a relative address and would drop it. `SafeLink` opens it in Files when it is in the session's folder,
 * and shows its words otherwise; it never reaches the page as an address.
 */
const markPathLinks = () => (tree: HastNode) => {
  const visit = (node: HastNode) => {
    const href = node.properties?.href;
    if (node.tagName === "a" && typeof href === "string" && isPathLink(href) && node.properties)
      node.properties.href = `${FILE_LINK_SCHEME}${href}`;
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
};

/**
 * Streamdown's own HTML steps, in their order, with two changes: links to paths are marked first (`markPathLinks`), and a
 * link it will not make is its words, not its words and " [blocked]".
 */
const rehypePlugins = Object.entries(defaultRehypePlugins).flatMap(([name, plugin]) => {
  if (name !== "harden" || !Array.isArray(plugin)) return [plugin];
  const [harden, options] = plugin as [unknown, Record<string, unknown>];
  return [markPathLinks, [harden, { ...options, linkBlockPolicy: "text-only" }]];
}) as ComponentProps<typeof Streamdown>["rehypePlugins"];

type MdastNode = { type?: string; url?: string; children?: MdastNode[] };

/** A link's address made one the checks keep, when it is a path (`pathLinkUrl`), as the markdown is read. */
const pathLinkUrls = () => (tree: MdastNode) => {
  const visit = (node: MdastNode) => {
    if ((node.type === "link" || node.type === "definition") && typeof node.url === "string")
      node.url = pathLinkUrl(node.url);
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
};

const remarkPlugins = [...Object.values(defaultRemarkPlugins), pathLinkUrls] as ComponentProps<
  typeof Streamdown
>["remarkPlugins"];

const components: ComponentProps<typeof Streamdown>["components"] = {
  a: SafeLink as never,
  inlineCode: InlineCode as never,
  img: BlockedImage as never,
  pre: CodeFold as never,
};

/**
 * Code is coloured by Shiki through Streamdown's code plugin (Streamdown has no highlighting of its own: without the
 * plugin a code block is plain text). Which themes is the person's choice (`code-theme.ts`). The plugin uses Shiki's
 * JavaScript regex engine, so it needs no WebAssembly and the page's CSP stays as it is.
 */
const plugins = new Map<CodeThemeId, ReturnType<typeof createCodePlugin>>();
const pluginFor = (id: CodeThemeId) => {
  let plugin = plugins.get(id);
  if (plugin === undefined) {
    plugin = createCodePlugin({ themes: [...themesOf(id)] as never });
    plugins.set(id, plugin);
  }
  return plugin;
};

/**
 * Code keeps one control, Copy, shown when the block is hovered or focused; it is drawn by `CodeFold`, not by
 * Streamdown. Tables keep none: the full-screen view and the
 * CSV download were a toolbar over every table, louder than the table. Streamdown's mermaid plugin is not used: a
 * ```mermaid fence is a code block that `CodeFold` hands to our own `Diagram`, which draws it as a picture (diagram.ts).
 */
const CONTROLS = {
  code: { copy: false, download: false },
  table: false,
  mermaid: false,
  image: false,
};

/**
 * New words fade in a character at a time, so a batch of a few or a few dozen reads as flowing rather than jumping in.
 * Characters, not words, since Chinese has no spaces. What waits to fade is never more than 200ms behind, so a fast
 * model is not held back by it.
 */
const FADE: AnimateOptions = {
  animation: "fadeIn",
  sep: "char",
  duration: 160,
  stagger: 6,
  maxBacklogMs: 200,
};

/** How long the last words of a reply take to fade in at most: the backlog, then one fade. */
const FADE_TAIL_MS = 400;

/** `on`, and still true for `ms` after it turns false. */
const useLinger = (on: boolean, ms: number): boolean => {
  const [lingering, setLingering] = useState(on);
  useEffect(() => {
    if (on) {
      setLingering(true);
      return;
    }
    const timer = setTimeout(() => setLingering(false), ms);
    return () => clearTimeout(timer);
  }, [on, ms]);
  return on || (ms > 0 && lingering);
};

/** At most this much text when it is first drawn, and a reply is one just begun: a batch is far less. */
const FIRST_BATCH = 200;

/**
 * `unfold`: when it goes up, a long code block shown in part is shown whole (a file in Files shown at a line past its
 * first ones). Zero, the default, leaves the blocks as they are.
 */
export function Markdown({
  text,
  streaming = false,
  unfold = 0,
}: {
  text: string;
  streaming?: boolean;
  unfold?: number;
}) {
  const theme = useSyncExternalStore(codeTheme.subscribe, codeTheme.get, codeTheme.get);
  const reduced = Boolean(useReducedMotion());
  // Only a reply seen from its start fades in. One drawn again mid-way (the session opened again, the window scrolled
  // back to it) shows what it has at once: Streamdown would count all of it as new and fade it all in. Decided once, so
  // the end of the reply changes nothing in how its blocks are drawn.
  const [fresh] = useState(() => streaming && text.length <= FIRST_BATCH);
  const fading = fresh && !reduced;
  // The last words fade in after the reply is done: Streamdown animates only while it is told the reply is going.
  const animating = useLinger(streaming, fading ? FADE_TAIL_MS : 0);
  return (
    <Streaming.Provider value={streaming}>
      <Unfold.Provider value={unfold}>
        <Streamdown
          // The root of a reply's blocks, for the stylesheet's one rhythm between them (`[data-markdown]`).
          data-markdown=""
          mode="streaming"
          isAnimating={animating}
          animated={fading ? FADE : false}
          parseIncompleteMarkdown={streaming}
          codeBlockMaxHeight="none"
          tableMaxHeight="none"
          skipHtml
          rehypePlugins={rehypePlugins}
          remarkPlugins={remarkPlugins}
          components={components}
          plugins={{ code: pluginFor(theme) }}
          controls={CONTROLS}
          lineNumbers={false}
          shikiTheme={[...themesOf(theme)] as never}
        >
          {streaming ? mendStreaming(text) : text}
        </Streamdown>
      </Unfold.Provider>
    </Streaming.Provider>
  );
}
