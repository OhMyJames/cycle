// The agent's thinking, in a session in detailed mode (Session settings → Display mode): its words where it thought them,
// shown as they are, not behind a row to open. Set as a markdown quote, in italics and the secondary colour, so it reads
// as an aside and not as the reply; the markdown goes through the same sanitized path as a reply. In normal mode the
// conversation leaves thoughts out, and this is not drawn.
import { useSyncExternalStore } from "react";
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

export function ThoughtText({ item, live }: { item: ThoughtItem; live: boolean }) {
  const { t } = useI18n();
  // One with no words (yet, or at all: older sessions, where Claude Code left them out) is not laid (`shownBlocks`).
  // Named, so a screen reader says where the thinking is and does not run it into the reply.
  return (
    <blockquote data-kind="thought" data-live={live || undefined} aria-label={t("thought.label")}>
      <div data-slot="message" data-role="thought">
        <Markdown text={textOf(item.blocks)} streaming={live} />
      </div>
    </blockquote>
  );
}
