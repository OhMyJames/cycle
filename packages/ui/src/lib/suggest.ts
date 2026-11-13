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
