// What an @ in the message may be the start of. Pure TypeScript.

/**
 * The query of a file or folder being named after an @, or undefined. The @ starts the text or follows a space, so that an
 * address like a@b.c is not one; the query runs to the caret and has no space in it. `before` is the text of the caret's
 * block up to the caret.
 */
export const mentionQuery = (before: string): string | undefined =>
  /(?:^|\s)@([^\s@]{0,80})$/.exec(before)?.[1];

/** The name a file or folder is shown by, and the folder it is in. A folder's name ends with a slash. */
export const mentionRow = (
  path: string,
  kind: "file" | "folder",
): { name: string; folder: string } => {
  const at = path.lastIndexOf("/");
  return {
    name: `${path.slice(at + 1)}${kind === "folder" ? "/" : ""}`,
    folder: at < 0 ? "" : path.slice(0, at),
  };
};

/**
 * The address of a session of the same daemon, as a mention names it (docs/protocol.md §8 "提及(@)另一个 session"). The
 * page may not import `@cycle/protocol`: this mirrors its `sessionUri`, and a test holds the two together.
 */
export const SESSION_URI_PREFIX = "cycle://session/";

export const sessionUri = (sessionId: string): string =>
  `${SESSION_URI_PREFIX}${encodeURIComponent(sessionId)}`;

/** At most this many sessions in the @ menu: the most recent first, the rest are found by typing. */
export const SESSION_ROWS = 6;

/**
 * What the text says of a session after the @: its title on one line, without the marks Markdown would read as
 * formatting (the box's text is Markdown), and short enough to read.
 */
export const sessionLabel = (title: string): string => {
  const plain = title
    .replace(/[\\`*_[\]<>#~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const short = plain.length > 60 ? plain.slice(0, 60).trimEnd() : plain;
  return short === "" ? "session" : short;
};

/** What the @ menu needs of a session. */
export type MentionableSession = {
  locationId: string;
  sessionId: string;
  archived: boolean;
  updatedAt?: string | undefined;
  lastSeq: number;
};

/**
 * The sessions an @ may name: on the same location, not the one being written in, not archived; those whose title
 * has every word typed, the most recent first.
 */
export const mentionableSessions = <S extends MentionableSession>(
  sessions: readonly S[],
  query: string,
  here: { locationId: string; sessionId?: string | undefined },
  titleOf: (session: S) => string,
): S[] => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const when = (s: S) => (s.updatedAt !== undefined ? Date.parse(s.updatedAt) || 0 : 0);
  return sessions
    .filter(
      (s) =>
        s.locationId === here.locationId &&
        s.sessionId !== here.sessionId &&
        !s.archived &&
        words.every((w) => titleOf(s).toLowerCase().includes(w)),
    )
    .sort((a, b) => when(b) - when(a) || b.lastSeq - a.lastSeq)
    .slice(0, SESSION_ROWS);
};
