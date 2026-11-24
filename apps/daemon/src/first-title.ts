// A session's name while the agent has not given it one (CYCL-224): the start of the person's first message, so the
// list and the title bar have something to show as soon as it is sent. Kept as the agent's (`titleFromAgent`), so the
// agent's own title replaces it when it comes; a name the person gave is never touched.

/** How long the name may be, in characters as a person counts them; longer is cut and ends with an ellipsis. */
export const FIRST_TITLE_LIMIT = 60;

/**
 * How much of the line is looked at: the name is short, and a message can be megabytes on one line (pasted minified
 * code, say). This is read while the prompt is taken, so it is not made to read the whole of it.
 */
const SCAN = FIRST_TITLE_LIMIT * 32;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Control characters (an escape sequence pasted from a terminal) and the marks that reorder text are not shown in a
// name: the list draws it, and `cycle stop` prints it to a terminal.
const HIDDEN = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu;

/**
 * The name a first message gives a session: its first line with words in it, trimmed, its runs of whitespace made one
 * space, cut at `FIRST_TITLE_LIMIT` with an ellipsis. Undefined when the message has no words (only images or files).
 */
export const firstTitle = (prompt: readonly unknown[]): string | undefined => {
  for (const block of prompt) {
    const b = block as { type?: unknown; text?: unknown } | null;
    if (b === null || typeof b !== "object" || b.type !== "text" || typeof b.text !== "string")
      continue;
    const title = titleOf(b.text);
    if (title !== undefined) return title;
  }
  return undefined;
};

const titleOf = (text: string): string | undefined => {
  const start = text.search(/[^\s\p{Cc}]/u);
  if (start < 0) return undefined;
  const ends = /\r|\n/g;
  ends.lastIndex = start;
  const end = ends.exec(text)?.index ?? text.length;
  const cut = end - start > SCAN;
  const line = text
    .slice(start, Math.min(end, start + SCAN))
    .replace(HIDDEN, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (line === "") return undefined;
  const kept: string[] = [];
  for (const { segment } of graphemes.segment(line)) {
    if (kept.length === FIRST_TITLE_LIMIT) return ellipsis(kept.slice(0, -1));
    kept.push(segment);
  }
  // What was not looked at is more of the line, so the name says it goes on.
  return cut
    ? ellipsis(kept.length === FIRST_TITLE_LIMIT ? kept.slice(0, -1) : kept)
    : kept.join("");
};

const ellipsis = (kept: readonly string[]): string => `${kept.join("").trimEnd()}…`;
