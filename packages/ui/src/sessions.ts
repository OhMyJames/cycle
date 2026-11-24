// How the sessions are put in front of the person: which workspace the sidebar shows, how its sessions are grouped and
// ordered, what each row says, and what the switcher says of the other workspaces. Pure, so the list on screen and the
// keyboard walking it (Cmd+[ and Cmd+]) are one thing and are tested without a page. `now` is given, never read.
//
// A workspace is a folder on one location: `(locationId, cwd)` (docs/desktop.md). The sidebar shows one at a time.
import type { AgentInfo, SessionSummary } from "./api.ts";
import { viewKey } from "./store/store.ts";

/** How many of a workspace's older sessions show before "Show more". */
export const PER_WORKSPACE = 20;

/** What is on a row, most urgent first: the one thing a row says of its session. */
export type Mark = "needs-you" | "running" | "background" | "unread";
export const URGENCY: readonly Mark[] = ["needs-you", "running", "background", "unread"];

export type Counts = Record<Mark, number>;

/** The most urgent class that has any, and how many sessions are in it. */
export const urgent = (counts: Counts): { mark: Mark; count: number } | undefined => {
  const mark = URGENCY.find((m) => counts[m] > 0);
  return mark === undefined ? undefined : { mark, count: counts[mark] };
};

export type SessionGroup = {
  /** Unique among the groups, and the same from one call to the next. */
  key: string;
  kind: "pinned" | "needs-you" | "running" | "today" | "yesterday" | "earlier";
  /** What is shown. */
  sessions: SessionSummary[];
};

export type SessionList = {
  groups: SessionGroup[];
  /** The sessions shown, in the order they are on screen. */
  order: SessionSummary[];
  /** How many sessions are not shown because of the limit. */
  hidden: number;
};

/** What the list needs to know of a location. */
export type LocationLabel = { id: string; name: string; local: boolean };

/** A session, among the sessions of every location: the pair (location, id) is what is unique. */
export const sessionKey = (session: SessionSummary): string =>
  viewKey(session.locationId, session.sessionId);

/** Where something runs: a session, or a blank conversation that has no session yet. */
export type Place = Pick<SessionSummary, "locationId" | "cwd"> & {
  /** A session in a worktree is listed under the main checkout it belongs to (docs/desktop.md "Worktree"). */
  worktree?: Pick<NonNullable<SessionSummary["worktree"]>, "root"> | undefined;
};

/** A workspace is a folder on one location (a location's id has no "|" in it, so the first one ends it). */
export const workspaceKey = (session: Place): string =>
  `${session.locationId}|${folderOf(session)}`;

/** The folder a session works in, without a trailing slash (`/a/app` and `/a/app/` are one). */
export const folderOf = (session: Place): string => {
  const folder = session.worktree?.root ?? session.cwd;
  const trimmed = folder.replace(/\/+$/, "");
  return trimmed === "" ? (folder.startsWith("/") ? "/" : "") : trimmed;
};

const before = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const timeOf = (session: SessionSummary): number =>
  session.updatedAt === undefined ? Number.NaN : Date.parse(session.updatedAt);

/**
 * Newest first. By `updatedAt`, which compares across locations. A session whose daemon does not say (an older one) comes
 * after those that have it, and those are ordered by `lastSeq`, which only compares within one daemon: so they stay
 * in their daemon's order, and are never mixed in with another's by a number that means something else.
 */
const younger = (a: SessionSummary, b: SessionSummary): number => {
  const left = timeOf(a);
  const right = timeOf(b);
  if (!Number.isNaN(left) && !Number.isNaN(right) && left !== right) return right - left;
  if (Number.isNaN(left) !== Number.isNaN(right)) return Number.isNaN(left) ? 1 : -1;
  // `lastSeq` only means something within one daemon: across daemons the tie stays a tie (group by location first).
  return before(a.locationId, b.locationId) || b.lastSeq - a.lastSeq;
};

export const newest = (a: SessionSummary, b: SessionSummary): number =>
  younger(a, b) || before(a.locationId, b.locationId) || before(a.sessionId, b.sessionId);

/**
 * What a row says of its session, one thing: waiting for the person, working, background work running, or news
 * the person has not seen. An archived session is put away and a session of a location that is away is the last list read:
 * neither waits for anyone nor works for anyone.
 */
export const markOf = (session: SessionSummary, away?: ReadonlySet<string>): Mark | undefined => {
  if (session.archived || away?.has(session.locationId) === true) return undefined;
  if (session.state === "requires_action") return "needs-you";
  if (session.state === "running") return "running";
  if ((session.background ?? 0) > 0) return "background";
  if (session.unread === true) return "unread";
  return undefined;
};

const noCounts = (): Counts => ({ "needs-you": 0, running: 0, background: 0, unread: 0 });

export type Workspace = {
  key: string;
  locationId: string;
  cwd: string;
  /** The folder's name; more of the path where two on one location would be the same, and the location's name where two locations would. */
  name: string;
  /** Its sessions, newest first (those that are archived only when asked for). */
  sessions: SessionSummary[];
  counts: Counts;
};

/**
 * Every workspace: grouped by location (this computer first, then in the order the locations are listed), and inside a location the
 * one with the newest session first. A workspace with only archived sessions is there only when they are asked for.
 */
export const workspacesOf = (
  sessions: readonly SessionSummary[],
  {
    locations = [],
    away,
    showArchived = false,
  }: {
    locations?: readonly LocationLabel[] | undefined;
    away?: ReadonlySet<string> | undefined;
    showArchived?: boolean | undefined;
  } = {},
): Workspace[] => {
  const byKey = new Map<string, SessionSummary[]>();
  for (const session of sessions.toSorted(newest)) {
    if (session.archived && !showArchived) continue;
    const list = byKey.get(workspaceKey(session));
    if (list === undefined) byKey.set(workspaceKey(session), [session]);
    else list.push(session);
  }
  const known = [...byKey].map(([key, list]) => ({
    key,
    locationId: list[0]?.locationId ?? "",
    cwd: list[0] !== undefined ? folderOf(list[0]) : "",
    sessions: list,
  }));
  const names = namesOf(known, locations);
  const rank = (locationId: string): number => {
    const at = locations.findIndex((h) => h.id === locationId);
    const local = locations[at]?.local === true;
    return local ? -1 : at === -1 ? locations.length : at;
  };
  return known
    .map((w): Workspace => {
      const counts = noCounts();
      for (const session of w.sessions) {
        const mark = markOf(session, away);
        if (mark !== undefined) counts[mark] += 1;
      }
      return { ...w, name: names.get(w.key) ?? "", counts };
    })
    .toSorted((a, b) => {
      const left = a.sessions[0];
      const right = b.sessions[0];
      return (
        rank(a.locationId) - rank(b.locationId) ||
        (left !== undefined && right !== undefined ? younger(left, right) : 0) ||
        before(a.key, b.key)
      );
    });
};

const parts = (folder: string): string[] => folder.split("/").filter(Boolean);

/**
 * The names of the workspaces: the last part of the folder, with more of it only where two on the same location would be
 * the same. Two on different locations may share a name: the switcher groups them by location and marks each with an icon.
 */
const namesOf = (
  workspaces: readonly { key: string; locationId: string; cwd: string }[],
  locations: readonly LocationLabel[],
): Map<string, string> => {
  const segments = new Map(workspaces.map((w) => [w.key, parts(w.cwd)]));
  const depth = new Map(workspaces.map((w) => [w.key, 1]));
  const label = (w: { key: string; cwd: string }): string => {
    const all = segments.get(w.key) ?? [];
    const take = depth.get(w.key) ?? 1;
    // At most the whole path, which no other folder has.
    return all.length === 0 ? w.cwd : all.slice(-take).join("/");
  };
  for (let round = 0; round < 64; round += 1) {
    const byLabel = new Map<string, typeof workspaces>();
    for (const w of workspaces) {
      const same = `${w.locationId}|${label(w)}`;
      byLabel.set(same, [...(byLabel.get(same) ?? []), w]);
    }
    let grew = false;
    for (const same of byLabel.values()) {
      if (same.length < 2) continue;
      for (const w of same) {
        if ((depth.get(w.key) ?? 1) < (segments.get(w.key)?.length ?? 0)) {
          depth.set(w.key, (depth.get(w.key) ?? 1) + 1);
          grew = true;
        }
      }
    }
    if (!grew) break;
  }
  return new Map(
    workspaces.map((w) => {
      const name = label(w);
      const location = locations.find((h) => h.id === w.locationId);
      return [w.key, name === "" ? (location?.name ?? "") : name];
    }),
  );
};

/**
 * The workspace the sidebar shows: the one the person chose in the switcher (until they open something else), then the
 * one the open session is in, then the one that had something happen most recently.
 */
export const currentWorkspace = (
  workspaces: readonly Workspace[],
  { chosen, open }: { chosen?: string | undefined; open?: Place | undefined },
): Workspace | undefined => {
  const named = (key: string | undefined) =>
    key === undefined ? undefined : workspaces.find((w) => w.key === key);
  const recent = workspaces
    .map((w) => w.sessions[0])
    .filter((s): s is SessionSummary => s !== undefined)
    .toSorted(newest)[0];
  return (
    named(chosen) ?? (open && named(workspaceKey(open))) ?? named(recent && workspaceKey(recent))
  );
};

export type Elsewhere = {
  /** The most urgent thing going on in the other workspaces, and how many sessions it is. */
  mark: Mark | undefined;
  count: number;
  counts: Counts;
};

/** What the switcher says of the workspaces that are not shown. */
export const elsewhere = (
  workspaces: readonly Workspace[],
  current: Workspace | undefined,
): Elsewhere => {
  const counts = noCounts();
  for (const w of workspaces) {
    if (w.key === current?.key) continue;
    for (const mark of URGENCY) counts[mark] += w.counts[mark];
  }
  const top = urgent(counts);
  return { mark: top?.mark, count: top?.count ?? 0, counts };
};

/** The day a time is in, by the local clock: 0 today, 1 yesterday, more before. */
const daysAgo = (time: number, now: Date): number => {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const then = new Date(time);
  const a = new Date(day(now));
  const b = new Date(day(then));
  // Whole days between two local midnights, whatever the length of the days in between.
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
};

export type SessionListOptions = {
  /** Lifts the limit. */
  showAll: boolean;
  /** The open session, by its `sessionKey`: shown however far down it is. */
  selected?: string | undefined;
  /** Locations that are not connected: their sessions are the last list read, and wait for no one. */
  away?: ReadonlySet<string> | undefined;
  /** The sessions the person pinned, by `sessionKey` (pins.ts). */
  pinned?: ReadonlySet<string> | undefined;
  now: Date;
};

/**
 * One workspace's sessions: what the person pinned, which stays where they put it whatever it is doing (its mark still
 * says that), then what waits on the person, what is working (and what has a sub-agent working), then the
 * rest by the day they last had something happen. Only the older ones are limited: a session with something to say, and
 * the open one, are always shown.
 */
export const sessionList = (
  sessions: readonly SessionSummary[],
  { showAll, selected, away, pinned, now }: SessionListOptions,
): SessionList => {
  const groups: SessionGroup[] = [];
  const top: SessionSummary[] = [];
  const sorted: SessionSummary[] = [];
  for (const s of sessions.toSorted(newest))
    (pinned?.has(sessionKey(s)) === true ? top : sorted).push(s);
  if (top.length > 0) groups.push({ key: "pinned", kind: "pinned", sessions: top });
  const needs = sorted.filter((s) => markOf(s, away) === "needs-you");
  const busy = sorted.filter((s) => {
    const mark = markOf(s, away);
    return mark === "running" || mark === "background";
  });
  const apart = new Set([...needs, ...busy]);
  if (needs.length > 0) groups.push({ key: "needs-you", kind: "needs-you", sessions: needs });
  if (busy.length > 0) groups.push({ key: "running", kind: "running", sessions: busy });
  const rest = sorted.filter((s) => !apart.has(s));
  let shown = 0;
  let hidden = 0;
  for (const kind of ["today", "yesterday", "earlier"] as const) {
    const day = rest.filter((s) => {
      const time = timeOf(s);
      const ago = Number.isNaN(time) ? 2 : Math.min(2, Math.max(0, daysAgo(time, now)));
      return (ago === 0 ? "today" : ago === 1 ? "yesterday" : "earlier") === kind;
    });
    const list = day.filter((s) => {
      // What has something to say, and the open one, are shown whatever the page holds, and do not use it up.
      if (markOf(s, away) !== undefined || sessionKey(s) === selected) return true;
      const keep = showAll || shown < PER_WORKSPACE;
      if (keep) shown += 1;
      else hidden += 1;
      return keep;
    });
    if (list.length > 0) groups.push({ key: kind, kind, sessions: list });
  }
  return { groups, order: groups.flatMap((g) => g.sessions), hidden };
};

/**
 * The name of a session's agent, where saying it tells sessions apart: when its location has more than one agent
 * to choose from, or the session is of one that is not the location's only choice (an agent since removed).
 * Nothing while the location's agents are not known, and nothing where there is one agent and this is its
 * session: a word on every row that is the same on every row says nothing. An agent the location no longer lists
 * is named by its id.
 */
export const agentLabel = (
  agents: readonly AgentInfo[] | undefined,
  agentId: string,
): string | undefined => {
  if (agents === undefined) return undefined;
  // The choice a new session has: the agents that can run, as the blank conversation offers them.
  const available = agents.filter((a) => a.available);
  const choice = available.length > 0 ? available : agents;
  // No agent at all is no choice either: there is nothing for the word to tell this session from.
  if (choice.length === 0 || (choice.length === 1 && choice[0]?.id === agentId)) return undefined;
  return agents.find((a) => a.id === agentId)?.name ?? agentId;
};
