// The Files tab of the right panel (CYCL-92): the open session's folder as a tree read one folder at a time, and a file
// shown in its place. Read-only, and read by the daemon where the files are (docs/protocol.md §8 "浏览和预览文件"), so
// it is the same for a remote location. What the agent wrote is shown through the conversation's Markdown, which is
// already made safe: no HTML, no image or link loaded from elsewhere (.agents/notes/2026-11-22-files-and-diff-sources.md).
import { Button } from "@ui-sdk/react/button";
import {
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { FileContent, FileEntry, FileListing } from "../api.ts";
import type { FilesState, LineTarget } from "../files-view.ts";
import type { Translator } from "../i18n.ts";
import { viewKey } from "../store/index.ts";
import { useI18n } from "./i18n.tsx";
import { ChevronLeftIcon, ChevronRightIcon, FileIcon, FolderIcon, RefreshIcon } from "./icons.tsx";
import { Markdown } from "./markdown.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";

/** Text past this many characters is shown plain: colouring a whole large file would hold the page up. */
const COLOURED = 200_000;

const MARKDOWN = new Set(["md", "markdown", "mdx"]);

/** The language a fence names for a file, from its extension; one Shiki does not know is drawn plain. */
const LANGUAGES: Record<string, string> = {
  mjs: "js",
  cjs: "js",
  mts: "ts",
  cts: "ts",
  yml: "yaml",
  h: "c",
  hpp: "cpp",
  cc: "cpp",
  rs: "rust",
  py: "python",
  rb: "ruby",
  kt: "kotlin",
  zsh: "bash",
  sh: "bash",
};

const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** A file's text as a Markdown code block, with a fence longer than any run of backticks inside it. */
export const fenced = (text: string, language: string): string => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
};

/** A size in bytes, as people read it. */
export const sizeOf = (bytes: number, number: Translator["number"]): string =>
  bytes < 1024
    ? number(bytes, { style: "unit", unit: "byte", unitDisplay: "narrow" })
    : bytes < 1024 * 1024
      ? number(bytes / 1024, { style: "unit", unit: "kilobyte", maximumFractionDigits: 1 })
      : number(bytes / (1024 * 1024), {
          style: "unit",
          unit: "megabyte",
          maximumFractionDigits: 1,
        });

/** What a preview was, for the count of what people open (never which file). */
export type PreviewKind = "text" | "markdown" | "image" | "binary" | "too_large";

const kindOf = (content: FileContent): PreviewKind =>
  content.kind === "text"
    ? MARKDOWN.has(extensionOf(content.path))
      ? "markdown"
      : "text"
    : content.kind === "image"
      ? content.data === undefined
        ? "too_large"
        : "image"
      : "binary";

type Load<T> =
  | { state: "loading" }
  | { state: "ok"; value: T }
  | { state: "error"; reason: string };

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function Files() {
  const { t } = useI18n();
  const store = useAppStore();
  const locationId = useAppState((s) => s.selectedLocation);
  const sessionId = useAppState((s) => s.selectedSession);
  const status = useAppState((s) => (locationId !== undefined ? s.status[locationId] : undefined));
  const session = useAppState((s) =>
    locationId !== undefined
      ? s.sessions[locationId]?.find((x) => x.sessionId === sessionId)
      : undefined,
  );
  const key =
    locationId !== undefined && sessionId !== undefined
      ? viewKey(locationId, sessionId)
      : undefined;
  const views = store.filesViews;
  const read = useCallback(() => (key !== undefined ? views.get(key) : undefined), [key, views]);
  const view = useSyncExternalStore(views.subscribe, read, read);
  // Working, as opposed to stopped for a question: what it changed so far is on disk when it asks.
  const running = session?.state === "running";

  if (
    key === undefined ||
    locationId === undefined ||
    sessionId === undefined ||
    view === undefined
  )
    return (
      <div data-slot="files">
        <StateBlock tone="empty" size="inline" title={t("overview.noSession")} />
      </div>
    );
  if (status?.state !== "connected")
    return (
      <div data-slot="files">
        <StateBlock tone="away" size="inline" title={t("files.away")} />
      </div>
    );
  if (status.capabilities?.fs !== true)
    return (
      <div data-slot="files">
        <StateBlock
          tone="empty"
          size="inline"
          title={t("files.tooOld")}
          body={t("files.tooOld.body")}
        />
      </div>
    );
  // One per session: another session's tree, file and turns are its own, nothing of this one carries over.
  return (
    <SessionFiles key={key} where={{ locationId, sessionId, key }} view={view} running={running} />
  );
}

function SessionFiles({
  where,
  view,
  running,
}: {
  where: Where;
  view: FilesState;
  running: boolean;
}) {
  // Read again when a turn of this session ends: what the agent did is in the folder now.
  const [turnsEnded, setTurnsEnded] = useState(0);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) setTurnsEnded((n) => n + 1);
    wasRunning.current = running;
  }, [running]);
  return (
    <div data-slot="files">
      {/* The tree stays while a file is shown, only hidden: going back finds it as it was, scrolled where it was. */}
      <Tree where={where} view={view} turnsEnded={turnsEnded} hidden={view.file !== undefined} />
      {view.file !== undefined ? (
        <Preview
          key={view.file}
          where={where}
          path={view.file}
          lines={view.lines}
          turnsEnded={turnsEnded}
        />
      ) : null}
    </div>
  );
}

type Where = { locationId: string; sessionId: string; key: string };

function Tree({
  where,
  view,
  turnsEnded,
  hidden,
}: {
  where: Where;
  view: FilesState;
  turnsEnded: number;
  hidden: boolean;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const [folders, setFolders] = useState<ReadonlyMap<string, Load<FileListing>>>(new Map());
  const asked = useRef(new Map<string, number>());
  const load = useCallback(
    (path: string) => {
      const serial = (asked.current.get(path) ?? 0) + 1;
      asked.current.set(path, serial);
      setFolders((old) =>
        old.get(path)?.state === "ok" ? old : new Map(old).set(path, { state: "loading" }),
      );
      store.listFiles(where.locationId, where.sessionId, path).then(
        (value) => {
          if (asked.current.get(path) === serial)
            setFolders((old) => new Map(old).set(path, { state: "ok", value }));
        },
        (error: unknown) => {
          if (asked.current.get(path) === serial)
            setFolders((old) =>
              new Map(old).set(path, { state: "error", reason: reasonOf(error) }),
            );
        },
      );
    },
    [store, where.locationId, where.sessionId],
  );
  // The top, and each open folder, read when first shown, and again in each new round: Refresh, or a turn that ended.
  const [refreshed, setRefreshed] = useState(0);
  const round = refreshed + turnsEnded;
  const readIn = useRef(new Map<string, number>());
  const openKey = ["", ...view.expanded].join("\0");
  useEffect(() => {
    // Behind a file it waits: what it would read is read when it is shown again.
    if (hidden) return;
    for (const path of openKey.split("\0")) {
      if (readIn.current.get(path) === round) continue;
      readIn.current.set(path, round);
      load(path);
    }
  }, [openKey, round, load, hidden]);
  const top = folders.get("");
  const root = top?.state === "ok" ? top.value.root : undefined;
  return (
    <div data-slot="files-tree" hidden={hidden}>
      <div data-slot="files-head">
        <span data-slot="files-root" title={root}>
          {root !== undefined ? nameOf(root) || root : t("files.title")}
        </span>
        <Tip label={t("files.refresh")} side="bottom">
          <Button
            data-variant="ghost"
            data-kind="files-action"
            onClick={() => setRefreshed((n) => n + 1)}
          >
            <RefreshIcon />
          </Button>
        </Tip>
      </div>
      <Folder path="" folders={folders} where={where} view={view} retry={load} />
    </div>
  );
}

function Folder({
  path,
  folders,
  where,
  view,
  retry,
}: {
  path: string;
  folders: ReadonlyMap<string, Load<FileListing>>;
  where: Where;
  view: FilesState;
  retry: (path: string) => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const listing = folders.get(path);
  if (listing === undefined || listing.state === "loading")
    return <StateBlock tone="loading" size="inline" align="start" title={t("files.loading")} />;
  if (listing.state === "error")
    return (
      <StateBlock
        tone="error"
        size="inline"
        align="start"
        title={t("files.listFailed")}
        reason={listing.reason}
        action={{ label: t("files.retry"), onAction: () => retry(path) }}
      />
    );
  const { entries, truncated } = listing.value;
  if (entries.length === 0 && path === "")
    return <StateBlock tone="empty" size="inline" title={t("files.empty")} />;
  if (entries.length === 0) return <p data-slot="files-quiet">{t("files.emptyFolder")}</p>;
  return (
    <ul data-slot="files-list" role={path === "" ? "list" : undefined}>
      {entries.map((entry) => {
        const full = path === "" ? entry.name : `${path}/${entry.name}`;
        return (
          <li key={entry.name}>
            <Row
              entry={entry}
              open={view.expanded.has(full)}
              onOpen={() => {
                if (entry.kind === "folder") store.filesViews.toggle(where.key, full);
                else if (entry.kind === "file") store.filesViews.show(where.key, full);
              }}
            />
            {entry.kind === "folder" && view.expanded.has(full) ? (
              <div data-slot="files-nest">
                <Folder path={full} folders={folders} where={where} view={view} retry={retry} />
              </div>
            ) : null}
          </li>
        );
      })}
      {truncated ? (
        <li data-slot="files-quiet">{t("files.truncated", { count: entries.length })}</li>
      ) : null}
    </ul>
  );
}

function Row({ entry, open, onOpen }: { entry: FileEntry; open: boolean; onOpen: () => void }) {
  const { t } = useI18n();
  const lead =
    entry.kind === "folder" ? (
      <>
        <ChevronRightIcon size={12} data-slot="files-chevron" aria-hidden="true" />
        <FolderIcon size={14} />
      </>
    ) : (
      <>
        <span data-slot="files-chevron" aria-hidden="true" />
        <FileIcon size={14} />
      </>
    );
  const name = (
    <span data-slot="files-name" title={entry.name}>
      {entry.name}
    </span>
  );
  if (entry.kind === "other")
    // A link out of the folder, or to nothing, or a device: there, but nothing to open.
    return (
      <span data-slot="files-row" data-kind="other" title={t("files.cannotOpen")}>
        {lead}
        {name}
      </span>
    );
  return (
    <button
      type="button"
      data-slot="files-row"
      data-kind={entry.kind}
      data-ignored={entry.ignored === true || undefined}
      aria-expanded={entry.kind === "folder" ? open : undefined}
      onClick={onOpen}
    >
      {lead}
      {name}
      {entry.ignored === true ? (
        <span data-slot="visually-hidden">{t("files.ignored")}</span>
      ) : null}
    </button>
  );
}

/** How long lines gone to stay marked, the fade at the end included (the stylesheet's `files-line-mark`). */
const MARK_MS = 1600;

/** How long to wait for a file's text to be drawn before the lines asked for in it are given up on. */
const DRAW_MS = 1000;

/** Where lines of a file are drawn, in its shown text's box. */
type Box = { top: number; left: number; width: number; height: number };

/** The lines of a file shown marked: where, and which request for them (a new one marks them again). */
type Mark = Box & { serial: number };

const lineCountOf = (text: string): number => text.replace(/\n$/, "").split("\n").length;

/**
 * Where lines `start` to `end` of a file are drawn in `box`, its shown text: Shiki's lines are an element each; plain
 * text is one line box a line, since it never wraps. Undefined while they are not drawn yet.
 */
const measure = (box: HTMLElement, start: number, end: number): Box | undefined => {
  const outer = box.getBoundingClientRect();
  const body = box.querySelector('[data-streamdown="code-block-body"]');
  if (body !== null) {
    const code = body.querySelector("pre > code");
    // What is drawn, not what the text counts: trailing blank lines are not drawn.
    const drawn = code?.children.length ?? 0;
    if (start > drawn) return undefined;
    const first = code?.children[start - 1];
    const last = code?.children[Math.min(end, drawn) - 1];
    if (first === undefined || last === undefined) return undefined;
    // Not drawn yet: the block is skipped while it is out of sight, as in a panel still sliding open, and the box around
    // it has a stand-in's height, so what scrolls to the lines cannot reach them.
    if (first.checkVisibility?.({ contentVisibilityAuto: true }) === false) return undefined;
    const from = first.getBoundingClientRect();
    const across = body.getBoundingClientRect();
    return {
      top: from.top - outer.top,
      height: last.getBoundingClientRect().bottom - from.top,
      left: across.left - outer.left,
      width: across.width,
    };
  }
  const plain = box.querySelector<HTMLElement>('[data-slot="files-plain"]');
  if (plain === null) return undefined;
  const style = getComputedStyle(plain);
  const line = Number.parseFloat(style.lineHeight);
  if (!(line > 0)) return undefined;
  const across = plain.getBoundingClientRect();
  return {
    top:
      across.top -
      outer.top +
      plain.clientTop +
      Number.parseFloat(style.paddingTop) +
      (start - 1) * line,
    height: (end - start + 1) * line,
    left: across.left - outer.left,
    width: across.width,
  };
};

/**
 * What scrolls the file: the panel's body, the first box around it made to scroll. Whether it has anything to scroll
 * now does not matter: a box further out is never scrolled for the file.
 */
const scrollerOf = (from: HTMLElement): HTMLElement | undefined => {
  for (let at = from.parentElement; at !== null; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if (overflowY === "auto" || overflowY === "scroll") return at;
  }
  return undefined;
};

/**
 * Scrolls the lines into the middle of what is seen under the file's head, or their first line to just under it when they
 * are taller than that. At once when motion is reduced.
 */
const scrollTo = (box: HTMLElement, lines: Box): void => {
  const scroller = scrollerOf(box);
  if (scroller === undefined) return;
  const seen = scroller.getBoundingClientRect();
  const head =
    box.parentElement?.querySelector(':scope > [data-slot="files-head"]')?.getBoundingClientRect()
      .height ?? 0;
  const room = seen.height - head;
  const under = lines.height >= room ? head : head + (room - lines.height) / 2;
  const top = box.getBoundingClientRect().top + lines.top - seen.top;
  // Asked when it scrolls, not once: the setting can change while the app is open.
  const reduced =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  scroller.scrollTo({
    top: scroller.scrollTop + top - under,
    behavior: reduced ? "instant" : "smooth",
  });
};

function Preview({
  where,
  path,
  lines,
  turnsEnded,
}: {
  where: Where;
  path: string;
  lines: LineTarget | undefined;
  turnsEnded: number;
}) {
  const { t, number } = useI18n();
  const store = useAppStore();
  const [content, setContent] = useState<Load<FileContent>>({ state: "loading" });
  const box = useRef<HTMLDivElement>(null);
  const [mark, setMark] = useState<Mark>();
  const [more, setMore] = useState<"idle" | "loading" | "failed">("idle");
  const [refreshed, setRefreshed] = useState(0);
  const tracked = useRef(false);
  // Read when shown, and again in each new round (Refresh, a turn that ended) over what is shown, not in its place.
  const round = refreshed + turnsEnded;
  // Which read is current: a piece asked for under an older one (before a Refresh, or after the preview went) is dropped.
  const reading = useRef(0);
  useEffect(() => {
    reading.current += 1;
    const serial = reading.current;
    let current = true;
    setMore("idle");
    // A new round reads over what is shown, so the page does not jump; a failure shown is replaced by the reading.
    setContent((old) => (round > 0 && old.state === "ok" ? old : { state: "loading" }));
    store.readFile(where.locationId, where.sessionId, path).then(
      (value) => {
        if (!current) return;
        setContent({ state: "ok", value });
        // Counted once a file is shown, not again each round it is read.
        if (!tracked.current) {
          tracked.current = true;
          store.track("file_previewed", { kind: kindOf(value) });
        }
      },
      (error: unknown) => {
        if (current) setContent({ state: "error", reason: reasonOf(error) });
      },
    );
    return () => {
      current = false;
      if (reading.current === serial) reading.current += 1;
    };
  }, [store, where.locationId, where.sessionId, path, round]);

  // Lines asked for (a reply's `app.tsx:12`), once the file is drawn: scrolled to and marked, then let go, so that showing
  // the file again later does not go there again. Asked for again, the file already shown, they are gone to again.
  useEffect(() => {
    if (lines === undefined || content.state !== "ok") return;
    const shown = content.value;
    const land = () => store.filesViews.landed(where.key, lines.serial);
    // Only text drawn as text has lines: a document is drawn as what it reads as, a picture as a picture.
    if (shown.kind !== "text" || shown.text === "" || MARKDOWN.has(extensionOf(shown.path))) {
      land();
      return;
    }
    // Past what is read of the file (or past its end): shown from the top, as without a line.
    const count = lineCountOf(shown.text);
    if (lines.start > count) {
      land();
      return;
    }
    const end = Math.min(lines.end, count);
    let frame = 0;
    const until = performance.now() + DRAW_MS;
    let last: (Box & { whole: number }) | undefined;
    // Gone to once they, and the text around them, stay as they are for a frame: the block takes its full height only once
    // the browser has drawn it (Streamdown's code blocks are `content-visibility: auto`), and its colours come after.
    const seek = () => {
      const drawn = box.current === null ? undefined : measure(box.current, lines.start, end);
      const at =
        drawn === undefined ? undefined : { ...drawn, whole: box.current?.offsetHeight ?? 0 };
      const still =
        at !== undefined &&
        last !== undefined &&
        Math.abs(at.top - last.top) < 0.5 &&
        Math.abs(at.height - last.height) < 0.5 &&
        at.whole === last.whole;
      last = at;
      if (!still && performance.now() < until) {
        frame = requestAnimationFrame(seek);
        return;
      }
      if (drawn !== undefined && box.current !== null) {
        setMark({ ...drawn, serial: lines.serial });
        scrollTo(box.current, drawn);
      }
      land();
    };
    frame = requestAnimationFrame(seek);
    return () => cancelAnimationFrame(frame);
  }, [content, lines, store, where.key]);
  // The mark goes after a moment: it shows where the lines are, it is not a selection.
  useEffect(() => {
    if (mark === undefined) return;
    const timer = setTimeout(() => setMark(undefined), MARK_MS);
    return () => clearTimeout(timer);
  }, [mark]);

  const readMore = () => {
    if (content.state !== "ok" || content.value.kind !== "text" || content.value.next === null)
      return;
    const shown = content.value;
    const serial = reading.current;
    setMore("loading");
    store.readFile(where.locationId, where.sessionId, path, shown.next ?? 0).then(
      (piece) => {
        if (reading.current !== serial) return;
        // The file changed between the pieces: what was shown no longer fits with the rest, so start again.
        if (piece.kind !== "text" || piece.mtimeMs !== shown.mtimeMs) {
          setRefreshed((n) => n + 1);
          return;
        }
        setContent({
          state: "ok",
          value: { ...shown, text: shown.text + piece.text, next: piece.next },
        });
        setMore("idle");
      },
      () => {
        if (reading.current === serial) setMore("failed");
      },
    );
  };

  return (
    <>
      <div data-slot="files-head">
        <Tip label={t("files.back")} side="bottom">
          <Button
            data-variant="ghost"
            data-kind="files-action"
            onClick={() => store.filesViews.back(where.key)}
          >
            <ChevronLeftIcon />
          </Button>
        </Tip>
        <span data-slot="files-path" title={path}>
          <bdi>{path}</bdi>
        </span>
        <Tip label={t("files.refresh")} side="bottom">
          <Button
            data-variant="ghost"
            data-kind="files-action"
            onClick={() => setRefreshed((n) => n + 1)}
          >
            <RefreshIcon />
          </Button>
        </Tip>
      </div>
      {content.state === "loading" ? (
        <StateBlock tone="loading" size="inline" title={t("files.reading")} />
      ) : content.state === "error" ? (
        <StateBlock
          tone="error"
          size="inline"
          title={t("files.readFailed")}
          reason={content.reason}
          action={{ label: t("files.retry"), onAction: () => setRefreshed((n) => n + 1) }}
        />
      ) : (
        <Shown
          content={content.value}
          size={sizeOf(content.value.size, number)}
          unfold={lines?.serial ?? 0}
          box={box}
          mark={
            mark === undefined ? null : (
              <div
                key={mark.serial}
                data-slot="files-line-mark"
                aria-hidden="true"
                style={{ top: mark.top, left: mark.left, width: mark.width, height: mark.height }}
              />
            )
          }
        />
      )}
      {content.state === "ok" && content.value.kind === "text" && content.value.next !== null ? (
        <div data-slot="files-more">
          <span>
            {t("files.partShown", {
              shown: sizeOf(content.value.next, number),
              size: sizeOf(content.value.size, number),
            })}
          </span>
          <Button data-variant="outline" disabled={more === "loading"} onClick={readMore}>
            {more === "failed" ? t("files.retry") : t("files.readMore")}
          </Button>
        </div>
      ) : null}
    </>
  );
}

/**
 * A file as it is shown. Text drawn as text is in `box`, with `mark` over the lines gone to; `unfold` shows its code whole
 * when it goes up (`Markdown`).
 */
function Shown({
  content,
  size,
  unfold,
  box,
  mark,
}: {
  content: FileContent;
  size: string;
  unfold: number;
  box: RefObject<HTMLDivElement | null>;
  mark: ReactNode;
}) {
  const { t } = useI18n();
  if (content.kind === "binary")
    return <StateBlock tone="empty" size="inline" title={t("files.binary")} body={size} />;
  if (content.kind === "image")
    return content.data === undefined ? (
      <StateBlock tone="empty" size="inline" title={t("files.imageTooLarge")} body={size} />
    ) : (
      <div data-slot="files-image">
        <img src={`data:${content.mimeType};base64,${content.data}`} alt={nameOf(content.path)} />
      </div>
    );
  if (content.text === "")
    return <StateBlock tone="empty" size="inline" title={t("files.emptyFile")} />;
  const extension = extensionOf(content.path);
  if (MARKDOWN.has(extension))
    return (
      <div data-slot="files-markdown">
        <Markdown text={content.text} />
      </div>
    );
  const plain = content.text.length >= COLOURED;
  return (
    <div data-slot="files-text" ref={box}>
      {plain ? (
        <pre data-slot="files-plain">{content.text}</pre>
      ) : (
        <Code text={content.text} language={LANGUAGES[extension] ?? extension} unfold={unfold} />
      )}
      {mark}
    </div>
  );
}

/** A file's text coloured: drawn again only when it or `unfold` changes, not when the mark over it comes or goes. */
const Code = memo(function Code({
  text,
  language,
  unfold,
}: {
  text: string;
  language: string;
  unfold: number;
}) {
  return (
    <div data-slot="files-code">
      <Markdown text={fenced(text, language)} unfold={unfold} />
    </div>
  );
});
