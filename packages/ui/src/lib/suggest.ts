/*
 * What the composer offers while a `/` or an `@` is typed, and in what order. The rules are
 * old-cycle's: commands before skills, a name that starts with the query before one that holds it,
 * a plugin's skills as one row, and paths by how well their name matches.
 */

/** A row with a name to match against. */
export interface Named {
  name: string;
}

/** Rows whose name starts with the query, then those that hold it. */
export function matchNames<Row extends Named>(rows: readonly Row[], query: string): Row[] {
  const lower = query.toLowerCase();
  const name = (row: Row) => row.name.toLowerCase();
  return [
    ...rows.filter((row) => name(row).startsWith(lower)),
    ...rows.filter((row) => !name(row).startsWith(lower) && name(row).includes(lower)),
  ];
}

export interface SkillRow extends Named {
  description: string;
  /** The plugin's skills this row stands for, when it is a plugin's. */
  members?: readonly SkillRow[];
}

const pluginOf = (name: string): string | undefined => /^([^:]+):./.exec(name)?.[1];

/**
 * The skills the composer lists. A plugin's skills, two or more named `<plugin>:<skill>`, are one
 * row, and the agent picks which of them fits, unless a skill already has the plugin's name.
 */
export function skillRows(skills: readonly SkillRow[]): SkillRow[] {
  const names = new Set(skills.map((skill) => skill.name));
  const plugins = Map.groupBy(
    skills.filter((skill) => pluginOf(skill.name) !== undefined),
    (skill) => pluginOf(skill.name) ?? "",
  );
  const shown = new Set<string>();
  return skills.flatMap((skill): SkillRow[] => {
    const plugin = pluginOf(skill.name);
    const members = plugin === undefined ? undefined : plugins.get(plugin);
    if (plugin === undefined || !members || members.length < 2 || names.has(plugin)) {
      return [skill];
    }
    if (shown.has(plugin)) return [];
    shown.add(plugin);
    return [{ name: plugin, description: `${members.length} skills · the agent picks`, members }];
  });
}

/** The skills for a query. One with a colon looks among a plugin's own skills. */
export function matchSkills(rows: readonly SkillRow[], query: string): SkillRow[] {
  const all = query.includes(":") ? rows.flatMap((row) => row.members ?? [row]) : rows;
  return matchNames(all, query);
}

/** What choosing a plugin's row puts in the prompt, ahead of what the owner then writes. */
export const pluginPrompt = (plugin: string): string =>
  `Use the ${plugin} plugin for this, with whichever of its skills and tools fit: `;

export interface PathRow {
  path: string;
  directory: boolean;
}

const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const hidden = (path: string): boolean => path.split("/").some((part) => part.startsWith("."));

/** How many paths the list shows. */
export const MAX_PATHS = 8;

/**
 * How well a path matches, lower first, or undefined for none: its name starting with the query,
 * its name holding it, then its path holding it. A query with a `/` is looked for in the path only.
 */
function pathRank(path: string, query: string): number | undefined {
  const lower = path.toLowerCase();
  if (query.includes("/")) return lower.includes(query) ? 2 : undefined;
  const name = nameOf(lower);
  if (name.startsWith(query)) return 0;
  if (name.includes(query)) return 1;
  return lower.includes(query) ? 2 : undefined;
}

/**
 * The paths for an `@`. With nothing typed, what the folder holds, folders first; otherwise the
 * best matches, shortest first. Hidden files only when the query asks for one.
 */
export function matchPaths(rows: readonly PathRow[], typed: string): PathRow[] {
  const query = typed.toLowerCase();
  const shown = query.includes(".") ? rows : rows.filter((row) => !hidden(row.path));
  const ranked =
    query === ""
      ? shown.map((row) => ({ row, rank: row.directory ? 0 : 1 }))
      : shown.flatMap((row) => {
          const rank = pathRank(row.path, query);
          return rank === undefined ? [] : [{ row, rank }];
        });
  return ranked
    .toSorted(
      (left, right) =>
        left.rank - right.rank ||
        left.row.path.length - right.row.path.length ||
        left.row.path.localeCompare(right.row.path),
    )
    .slice(0, MAX_PATHS)
    .map(({ row }) => row);
}

/** Rows under a heading each, when there is more than one kind of them. */
export function sectioned<Row extends { group: string }>(
  rows: readonly Row[],
): (Row | { heading: string })[] {
  const groups = new Set(rows.map((row) => row.group));
  if (groups.size < 2) return [...rows];
  return [...groups].flatMap((group) => [
    { heading: group },
    ...rows.filter((row) => row.group === group),
  ]);
}

/*
 * A mention of another session. The composer shows `@title`; what is sent is a link the agent
 * reads the session from with Cycle's own tools, and a message draws the link as the title again.
 */

const SESSION_LINK = "cycle://session/";
const MENTION = /\[@([^\]\n]*)\]\(cycle:\/\/session\/([\w-]+)\)/g;
const MAX_SESSIONS = 4;

export interface SessionRow {
  id: string;
  title: string;
}

/** A title as a mention shows it: one line, no brackets, not long. */
export function mentionTitle(title: string): string {
  return title
    .replaceAll(/[[\]()\s]+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
}

/** Sessions whose title holds the query, those that start with it first. Given newest first. */
export function matchSessions(rows: readonly SessionRow[], query: string): SessionRow[] {
  const named = rows.map((row) => ({ ...row, name: row.title }));
  return matchNames(named, query)
    .slice(0, MAX_SESSIONS)
    .map(({ id, title }) => ({ id, title }));
}

/** The text to send: every `@title` that was picked becomes its session's link. */
export function expandMentions(text: string, picked: ReadonlyMap<string, string>): string {
  // One pass, the longest title first, so a title that starts another is not taken for it.
  const titles = [...picked.keys()].toSorted((a, b) => b.length - a.length);
  if (!titles.length) return text;
  const escaped = titles.map((title) => title.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return text.replaceAll(
    new RegExp(`@(${escaped.join("|")})`, "g"),
    (_whole, title: string) => `[@${title}](${SESSION_LINK}${picked.get(title)})`,
  );
}

/** The session a link in a reply points to, when it is one. */
export function sessionOfLink(href: string): string | null {
  return href.startsWith(SESSION_LINK) && /^[\w-]+$/.test(href.slice(SESSION_LINK.length))
    ? href.slice(SESSION_LINK.length)
    : null;
}

export type MentionPart = string | SessionRow;

/** A message's text, with each session link apart from the text around it. */
export function mentionParts(text: string): MentionPart[] {
  const parts: MentionPart[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push({ title: match[1] ?? "", id: match[2] ?? "" });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** A message's text as the composer shows it: `@title` where a link was. */
export function plainMentions(text: string): string {
  return text.replaceAll(MENTION, "@$1");
}
