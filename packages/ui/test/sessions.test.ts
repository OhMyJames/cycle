import { expect, test } from "bun:test";
import type { SessionSummary } from "../src/api.ts";
import {
  agentLabel,
  currentWorkspace,
  elsewhere,
  markOf,
  newest,
  PER_WORKSPACE,
  sessionKey,
  sessionList,
  workspacesOf,
} from "../src/sessions.ts";

const row = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  environmentId: "local",
  sessionId: id,
  cwd: "/work/app",
  archived: false,
  agent: "claude",
  state: "idle",
  lastSeq: 1,
  ...over,
});
const on = (environmentId: string, id: string, over: Partial<SessionSummary> = {}) =>
  row(id, { environmentId, ...over });

// Local noon on the 18th of November: the days are the local clock's, so the times are built from local parts.
const now = new Date(2026, 10, 18, 12, 0, 0);
const at = (day: number, hour = 9) => new Date(2026, 10, day, hour, 0, 0).toISOString();
const options = { showAll: false, now };
const ids = (list: ReturnType<typeof sessionList>) => list.order.map((s) => s.sessionId);
const environments = [
  { id: "local", name: "This computer", local: true },
  { id: "far", name: "Build box", local: false },
];

test("a row says one thing, the most urgent: waiting, working, background work, news", () => {
  const all = row("a", { state: "requires_action", unread: true, background: 2 });
  expect(markOf(all)).toBe("needs-you");
  expect(markOf(row("b", { state: "running", unread: true, background: 1 }))).toBe("running");
  expect(markOf(row("c", { background: 1, unread: true }))).toBe("background");
  expect(markOf(row("d", { unread: true }))).toBe("unread");
  expect(markOf(row("e"))).toBeUndefined();
  // A daemon that does not say has no news and no background work.
  expect(markOf(row("f", {}))).toBeUndefined();
});

test("an archived session, and a session of a host that is away, say nothing", () => {
  expect(markOf(row("a", { state: "running", archived: true }))).toBeUndefined();
  expect(markOf(on("far", "b", { state: "requires_action" }), new Set(["far"]))).toBeUndefined();
  expect(markOf(on("far", "b", { state: "requires_action" }), new Set(["other"]))).toBe(
    "needs-you",
  );
});

test("a workspace is a folder on one host: the same folder on two environments is two, and a trailing slash is nothing", () => {
  const list = workspacesOf(
    [
      row("a", { cwd: "/work/app/" }),
      row("b", { cwd: "/work/app" }),
      on("far", "c", { cwd: "/work/app" }),
    ],
    { environments },
  );
  expect(list.map((w) => [w.environmentId, w.cwd, w.sessions.length])).toEqual([
    ["local", "/work/app", 2],
    ["far", "/work/app", 1],
  ]);
});

test("workspaces are grouped by host, this computer first, and newest first inside a host", () => {
  const list = workspacesOf(
    [
      on("far", "f1", { cwd: "/srv/api", updatedAt: at(18, 11) }),
      row("l1", { cwd: "/work/old", updatedAt: at(10) }),
      row("l2", { cwd: "/work/new", updatedAt: at(17) }),
      on("far", "f2", { cwd: "/srv/web", updatedAt: at(1) }),
    ],
    {
      environments: [
        environments[1] as (typeof environments)[number],
        environments[0] as (typeof environments)[number],
      ],
    },
  );
  // The order the environments are given in does not put a remote one before this computer.
  expect(list.map((w) => w.cwd)).toEqual(["/work/new", "/work/old", "/srv/api", "/srv/web"]);
});

test("a workspace with only archived sessions is there only when they are asked for", () => {
  const sessions = [
    row("a", { cwd: "/work/gone", archived: true }),
    row("b", { cwd: "/work/app" }),
  ];
  expect(workspacesOf(sessions, { environments }).map((w) => w.cwd)).toEqual(["/work/app"]);
  expect(workspacesOf(sessions, { environments, showArchived: true })).toHaveLength(2);
});

test("a workspace is named by its folder, with more of the path only where two would be the same", () => {
  const list = workspacesOf(
    [row("a", { cwd: "/a/app" }), row("b", { cwd: "/b/app" }), row("c", { cwd: "/work/lib" })],
    { environments },
  );
  expect(list.map((w) => w.name).toSorted()).toEqual(["a/app", "b/app", "lib"]);
});

test("a workspace on another host is named after the host only where the name would clash", () => {
  const clash = workspacesOf(
    [row("a", { cwd: "/work/app" }), on("far", "b", { cwd: "/srv/app" })],
    {
      environments,
    },
  );
  expect(clash.map((w) => w.name).toSorted()).toEqual(["app · Build box", "app · This computer"]);
  const apart = workspacesOf(
    [row("a", { cwd: "/work/app" }), on("far", "b", { cwd: "/srv/api" })],
    {
      environments,
    },
  );
  expect(apart.map((w) => w.name).toSorted()).toEqual(["api", "app"]);
});

test("a workspace counts what is going on in it, but not in a host that is away", () => {
  const sessions = [
    row("a", { state: "requires_action" }),
    row("b", { state: "running" }),
    row("c", { background: 1 }),
    row("d", { unread: true }),
    row("e", { unread: true }),
    on("far", "f", { cwd: "/srv/api", state: "requires_action" }),
  ];
  const [app, api] = workspacesOf(sessions, { environments, away: new Set(["far"]) });
  expect(app?.counts).toEqual({ "needs-you": 1, running: 1, background: 1, unread: 2 });
  expect(api?.counts).toEqual({ "needs-you": 0, running: 0, background: 0, unread: 0 });
});

test("the workspace shown: the one chosen, else the one the open session is in, else the newest", () => {
  const sessions = [
    row("a", { cwd: "/work/old", updatedAt: at(1) }),
    row("b", { cwd: "/work/new", updatedAt: at(17) }),
    on("far", "c", { cwd: "/srv/api", updatedAt: at(5) }),
  ];
  const workspaces = workspacesOf(sessions, { environments });
  const name = (w: ReturnType<typeof currentWorkspace>) => w?.cwd;
  expect(name(currentWorkspace(workspaces, {}))).toBe("/work/new");
  expect(name(currentWorkspace(workspaces, { open: sessions[2] }))).toBe("/srv/api");
  const chosen = workspaces.find((w) => w.cwd === "/work/old")?.key;
  expect(name(currentWorkspace(workspaces, { chosen, open: sessions[2] }))).toBe("/work/old");
  // A choice that is gone (its sessions were deleted) is not a reason to show nothing.
  expect(name(currentWorkspace(workspaces, { chosen: "local|/gone" }))).toBe("/work/new");
  expect(currentWorkspace([], {})).toBeUndefined();
});

test("the switcher counts the most urgent class in the other workspaces, and says the rest in the counts", () => {
  const workspaces = workspacesOf(
    [
      row("a", { cwd: "/work/here", state: "requires_action" }),
      row("b", { cwd: "/work/there", state: "running" }),
      row("c", { cwd: "/work/there2", state: "running" }),
      row("d", { cwd: "/work/there2", unread: true }),
    ],
    { environments },
  );
  const here = workspaces.find((w) => w.cwd === "/work/here");
  const other = elsewhere(workspaces, here);
  // What waits in this workspace is on screen: it is not counted.
  expect(other.mark).toBe("running");
  expect(other.count).toBe(2);
  expect(other.counts).toEqual({ "needs-you": 0, running: 2, background: 0, unread: 1 });
  expect(elsewhere([], undefined)).toMatchObject({ mark: undefined, count: 0 });
});

test("what waits on the person comes first, then what is running, then the days", () => {
  const list = sessionList(
    [
      row("old", { updatedAt: at(5) }),
      row("run", { state: "running", updatedAt: at(18, 9) }),
      row("ask", { state: "requires_action", updatedAt: at(1) }),
      row("new", { updatedAt: at(18, 10) }),
      row("sub", { background: 1, updatedAt: at(2) }),
    ],
    options,
  );
  expect(list.groups.map((g) => g.kind)).toEqual(["needs-you", "running", "today", "earlier"]);
  // A session with a background sub-agent is running, as far as the list is concerned.
  expect(ids(list)).toEqual(["ask", "run", "sub", "new", "old"]);
});

test("what is pinned comes first and stays there, whatever it is doing; it does not use up the page", () => {
  const rows = [
    row("ask", { state: "requires_action", updatedAt: at(1) }),
    row("pin-old", { updatedAt: at(2) }),
    row("pin-run", { state: "running", updatedAt: at(18, 9) }),
    row("new", { updatedAt: at(18, 10) }),
  ];
  const [, pinOld, pinRun] = rows as [SessionSummary, SessionSummary, SessionSummary];
  const pinned = new Set([sessionKey(pinOld), sessionKey(pinRun)]);
  const list = sessionList(rows, { ...options, pinned });
  expect(list.groups.map((g) => g.kind)).toEqual(["pinned", "needs-you", "today"]);
  expect(ids(list)).toEqual(["pin-run", "pin-old", "ask", "new"]);
});

test("the days are the local clock's: today, yesterday, earlier; and a session with no time is earlier", () => {
  const list = sessionList(
    [
      row("t", { updatedAt: at(18, 0) }),
      row("y", { updatedAt: at(17, 23) }),
      row("e", { updatedAt: at(16, 23) }),
      row("n", { lastSeq: 7 }),
    ],
    options,
  );
  expect(list.groups.map((g) => [g.kind, g.sessions.map((s) => s.sessionId)])).toEqual([
    ["today", ["t"]],
    ["yesterday", ["y"]],
    ["earlier", ["e", "n"]],
  ]);
});

test("the same input in another order is the same list", () => {
  const rows = [
    row("a", { updatedAt: at(18, 9), lastSeq: 1 }),
    row("b", { updatedAt: at(18, 9), lastSeq: 1 }),
    row("c", { lastSeq: 2 }),
    row("d", { lastSeq: 2 }),
  ];
  expect(ids(sessionList(rows, options))).toEqual(ids(sessionList([...rows].reverse(), options)));
});

test("older sessions show a page and the rest on request; what has something to say, and the open one, always show", () => {
  const many = Array.from({ length: PER_WORKSPACE + 5 }, (_, n) =>
    row(`s${n}`, { updatedAt: at(1, 1 + (n % 20)), lastSeq: n }),
  );
  // Five of them are far down and none is marked: they are hidden, unless asked for.
  const shown = sessionList(many, options);
  expect(shown.order).toHaveLength(PER_WORKSPACE);
  expect(shown.hidden).toBe(5);
  expect(sessionList(many, { ...options, showAll: true }).hidden).toBe(0);
  const last = shown.order.at(-1);
  const hiddenOne = many.find((s) => !shown.order.includes(s));
  expect(last).toBeDefined();
  expect(hiddenOne).toBeDefined();
  if (hiddenOne === undefined) return;
  // Open, it is shown wherever it falls; with news, too.
  const open = sessionList(many, { ...options, selected: `local:${hiddenOne.sessionId}` });
  expect(open.order).toContain(hiddenOne);
  const news = many.map((s) => (s === hiddenOne ? { ...s, unread: true } : s));
  const withNews = sessionList(news, options);
  expect(withNews.order.map((s) => s.sessionId)).toContain(hiddenOne.sessionId);
  // It does not use the page up: the page is still full of the others.
  expect(withNews.order).toHaveLength(PER_WORKSPACE + 1);
});

test("a session of a host that is away is in its day, not in what needs you or is running", () => {
  const list = sessionList(
    [
      on("far", "a", { state: "requires_action", updatedAt: at(18, 9) }),
      row("b", { updatedAt: at(18, 8) }),
    ],
    { ...options, away: new Set(["far"]) },
  );
  expect(list.groups.map((g) => g.kind)).toEqual(["today"]);
  expect(ids(list)).toEqual(["a", "b"]);
});

test("sessions of two daemons that give no time are not mixed by numbers that mean different things", () => {
  const rows = [
    on("a", "a1", { lastSeq: 500 }),
    on("b", "b1", { lastSeq: 3 }),
    on("a", "a2", { lastSeq: 400 }),
    on("b", "b2", { lastSeq: 2 }),
  ];
  const sorted = (list: SessionSummary[]) => list.toSorted(newest).map((s) => s.sessionId);
  expect(sorted(rows)).toEqual(["a1", "a2", "b1", "b2"]);
  expect(sorted([...rows].reverse())).toEqual(sorted(rows));
});

test("a session that has a time comes before one that has none, across environments", () => {
  const rows = [
    on("old", "x", { lastSeq: 50 }),
    on("new", "z", { updatedAt: "2020-01-01T00:00:00.000Z", lastSeq: 1 }),
    on("old", "y", { lastSeq: 70 }),
  ];
  expect(rows.toSorted(newest).map((s) => s.sessionId)).toEqual(["z", "y", "x"]);
});

// ---- which agent a session is of (CYCL-155) ----

const info = (id: string, name: string, available = true) => ({
  id,
  name,
  available,
  configSchema: {},
});

test("a session's agent is named only where it tells sessions apart", () => {
  const claude = info("claude", "Claude");
  const codex = info("codex", "Codex");
  // One agent, and the session is its: the same word on every row would say nothing.
  expect(agentLabel([claude], "claude")).toBeUndefined();
  // Several to choose from: each session says which.
  expect(agentLabel([claude, codex], "claude")).toBe("Claude");
  expect(agentLabel([claude, codex], "codex")).toBe("Codex");
  // A second agent that cannot run is no choice, as on the new session page; a session of it is still named.
  const away = info("codex", "Codex", false);
  expect(agentLabel([claude, away], "claude")).toBeUndefined();
  expect(agentLabel([claude, away], "codex")).toBe("Codex");
  // An agent the environment no longer lists is named by its id; agents not read yet name nothing.
  expect(agentLabel([claude], "gone")).toBe("gone");
  expect(agentLabel(undefined, "claude")).toBeUndefined();
  expect(agentLabel([], "claude")).toBeUndefined();
  // None can run: the one listed is still the only one there is.
  expect(agentLabel([info("claude", "Claude", false)], "claude")).toBeUndefined();
});
