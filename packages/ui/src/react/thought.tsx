// The agent's thinking, in a session in detailed mode (Session settings → Display mode): its words where it thought them,
// shown as they are, not behind a row to open. Set as a markdown quote, in italics and the secondary colour, so it reads
// as an aside and not as the reply; the markdown goes through the same sanitized path as a reply. At most eight lines
// tall, scrolled within (CYCL-132, the owner's call): a long thought does not bury the reply. In normal mode the
// conversation leaves thoughts out, and this is not drawn.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { type DisplayMode, displayMode } from "../display-mode.ts";
import { type ThoughtItem, textOf } from "../model/index.ts";
import { useI18n } from "./i18n.tsx";
import { Markdown } from "./markdown.tsx";

/** A session's display mode (by its view key), and the page drawn again when it changes. */
export const useDisplayMode = (sessionKey: string): DisplayMode =>
  useSyncExternalStore(
    displayMode.subscribe,
    () => displayMode.get(sessionKey),
    () => displayMode.get(sessionKey),
  );

/** Within this of its end, a thought's box counts as at its end: it follows what is written. */
const AT_END_PX = 8;

/** Whether a box has more to scroll to above what shows, and below it. */
const edgesOf = (element: HTMLElement): { above: boolean; below: boolean } => ({
  above: element.scrollTop > 1,
  below: element.scrollHeight - element.scrollTop - element.clientHeight > 1,
});

export function ThoughtText({ item, live }: { item: ThoughtItem; live: boolean }) {
  const { t } = useI18n();
  const box = useRef<HTMLQuoteElement>(null);
  // Whether the reader is at the end of the box, so it follows what is written; one who scrolled back is left there.
  const atEnd = useRef(true);
  // Taller than its box: a scroll region, which the keyboard can reach; and which of its edges have more beyond them.
  const [scrolls, setScrolls] = useState(false);
  const [more, setMore] = useState<{ above: boolean; below: boolean }>({
    above: false,
    below: false,
  });
  const text = textOf(item.blocks);
  useEffect(() => {
    const element = box.current;
    if (element === null) return undefined;
    const measure = () => {
      setScrolls(element.scrollHeight > element.clientHeight + 1);
      setMore(edgesOf(element));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild !== null) observer.observe(element.firstElementChild);
    measure();
    return () => observer.disconnect();
  }, []);
  // While it is written, the newest words stay in sight: each time they grow.
  useLayoutEffect(() => {
    const element = box.current;
    if (!live || text === "" || element === null || !atEnd.current) return;
    element.scrollTop = element.scrollHeight;
    setMore(edgesOf(element));
  }, [text, live]);
  // One with no words (yet, or at all: older sessions, where Claude Code left them out) is not laid (`shownBlocks`).
  // Named, so a screen reader says where the thinking is and does not run it into the reply.
  return (
    <blockquote
      ref={box}
      data-kind="thought"
      data-live={live || undefined}
      data-scrolls={scrolls || undefined}
      data-more-above={more.above || undefined}
      data-more-below={more.below || undefined}
      aria-label={t("thought.label")}
      // A box that scrolls is reached by the keyboard, to scroll it.
      tabIndex={scrolls ? 0 : undefined}
      onScroll={(event) => {
        const element = event.currentTarget;
        atEnd.current =
          element.scrollHeight - element.scrollTop - element.clientHeight <= AT_END_PX;
      }}
    >
      <div data-slot="message" data-role="thought">
        <Markdown text={text} streaming={live} />
      </div>
    </blockquote>
  );
}
