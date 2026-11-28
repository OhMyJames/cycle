import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type {
  LoopBoardAnswer,
  LoopNotice,
  LoopProjectInfo,
  LoopTicket,
  LoopTicketDetail,
} from "../../src/api.ts";
import { fakeBridge, summary } from "../fake-bridge.ts";
import { openSettings } from "./account-menu.ts";
import { renderApp } from "./render-app.tsx";

afterEach(cleanup);

const cycle: LoopProjectInfo = {
  name: "Cycle",
  projectKey: "CYC",
  repo: { displayName: "clawdot/cycle", forge: "github" },
};
const docs: LoopProjectInfo = {
  name: "Docs",
  projectKey: "DOC",
  repo: { displayName: "team/docs", forge: "gitlab" },
};
const ticket = (n: number, column: string, extra: Partial<LoopTicket> = {}): LoopTicket => ({
  identifier: `CYC-${n}`,
  title: `Ticket ${n}`,
  priority: "high",
  column,
  ...extra,
});
const col = (id: number, name: string, stateType: string, tickets: LoopTicket[]) => ({
  id,
  name,
  stateType,
  tickets,
  more: false,
});
const boardOf = (
  tickets: { backlog?: LoopTicket[]; doing?: LoopTicket[] } = {},
): LoopBoardAnswer => ({
  kind: "ok",
  stale: false,
  columns: [
    col(1, "Backlog", "backlog", tickets.backlog ?? []),
    col(2, "Todo", "unstarted", []),
    col(3, "In Progress", "started", tickets.doing ?? []),
    col(4, "Done", "completed", []),
  ],
});
const notice = (
  kind: LoopNotice["kind"],
  n: number,
  session: LoopNotice["session"] = null,
  text = "",
): LoopNotice => ({ id: `CYC:${kind}:${n}`, kind, identifier: `CYC-${n}`, text, session });
const waiting = (n: number, priority: string, reason: string) =>
  ticket(n, "Backlog", { priority, pending: { reason } });
const detailOf = (base: LoopTicket): { kind: "ok"; ticket: LoopTicketDetail } => {
  const { graph: _graph, ...rest } = base;
  return {
    kind: "ok",
    ticket: { ...rest, actions: [], chat: "none", body: "text", acceptance: ["one"], links: [] },
  };
};
const tracked = (calls: [string, ...unknown[]][]) =>
  calls.filter(([name]) => name === "track").map(([, event, props]) => [event, props]);

type Options = NonNullable<Parameters<typeof fakeBridge>[0]>;
const mountConsole = async (options: Options = {}) => {
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    workspaceRepos: { "/work": cycle.repo.displayName },
    loopBoards: { CYC: boardOf() },
    ...options,
  });
  const store = await renderApp(fake.bridge);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Console" }));
  return { ...fake, store, user };
};
const crumbs = () => screen.getByRole("navigation", { name: "Where you are" }).textContent;

test("the sidebar lists Console first, and it opens on the Project's Console with its breadcrumb", async () => {
  await mountConsole();
  const names = Array.from(document.querySelectorAll('[data-slot="project-nav-item"]')).map(
    (b) => b.textContent,
  );
  expect(names).toEqual(["Console", "Kanban", "Timeline"]);
  await screen.findByRole("region", { name: "Running now" });
  expect(crumbs()).toBe("Cycle/Console");
  expect(screen.getByRole("button", { name: "Console" }).getAttribute("aria-current")).toBe("page");
});

test("the Overview opens a Project on its Console; switching workspace on Kanban stays on Kanban", async () => {
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle, docs] },
    loopBoards: { CYC: boardOf(), DOC: boardOf() },
    workspaceRepos: {
      "/work/cycle-v1": cycle.repo.displayName,
      "/work/docs": docs.repo.displayName,
    },
  });
  fake.bridge.sessions = async () => [
    {
      ...summary("s1"),
      cwd: "/work/cycle-v1",
      title: "Cycle chat",
      updatedAt: "2020-01-03T00:00:00Z",
    },
    { ...summary("s2"), cwd: "/work/docs", title: "Docs chat", updatedAt: "2020-01-02T00:00:00Z" },
  ];
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Loop" }));
  const projects = await screen.findByRole("region", { name: "Projects" });
  await user.click(within(projects).getByRole("button", { name: /\bDocs\b/ }));
  await screen.findByRole("region", { name: "Running now" });
  expect(crumbs()).toBe("Docs/Console");
  await user.click(screen.getByRole("button", { name: "Kanban" }));
  await user.click(screen.getByRole("button", { name: /Switch workspace/ }));
  await user.click(await screen.findByRole("menuitem", { name: /cycle-v1/ }));
  await waitFor(() => expect(crumbs()).toBe("Cycle/Kanban"));
});

test("Needs you lists permission, blocked, stuck, intent_stuck, supervisor, review in order, then the approval queue; operator is only in its own group", async () => {
  await mountConsole({
    loopBoards: { CYC: boardOf({ backlog: [waiting(701, "high", "Reason 701")] }) },
    loopNotices: {
      CYC: {
        kind: "ok",
        notices: [
          notice("operator", 7, null, "Suggest splitting"),
          notice("review", 6),
          notice("supervisor", 5),
          notice("intent_stuck", 4),
          notice("stuck", 3),
          notice("blocked", 2),
          notice("permission", 1),
        ],
      },
    },
  });
  const needs = await screen.findByRole("region", { name: "Needs you" });
  const rows = Array.from(needs.querySelectorAll("li")).map((li) => li.textContent ?? "");
  expect(rows.map((r) => r.match(/CYC-\d+/)?.[0])).toEqual([
    "CYC-1",
    "CYC-2",
    "CYC-3",
    "CYC-4",
    "CYC-5",
    "CYC-6",
    "CYC-701",
  ]);
  expect(within(needs).queryByText("CYC-7")).toBeNull();
  const operator = screen.getByRole("region", { name: "Operator suggestions" });
  expect(within(operator).getByText("CYC-7")).toBeTruthy();
  expect(within(operator).getByText("Suggest splitting")).toBeTruthy();
});

test("sections with nothing in them are not there; Running now says Loop is idle", async () => {
  await mountConsole({ loopNotices: { CYC: { kind: "ok", notices: [] } } });
  await screen.findByRole("region", { name: "Running now" });
  expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Operator suggestions" })).toBeNull();
  expect(screen.getByText("Loop is not working on anything right now.")).toBeTruthy();
});

test("a review notice opens the drawer over the Console, and closing it comes back to the Console", async () => {
  const review = ticket(6, "In Review");
  await mountConsole({
    loopBoards: { CYC: boardOf({ doing: [review] }) },
    loopTickets: { "CYC-6": detailOf(review) },
    loopNotices: { CYC: { kind: "ok", notices: [notice("review", 6)] } },
  });
  const needs = await screen.findByRole("region", { name: "Needs you" });
  const user = userEvent.setup();
  await user.click(within(needs).getByRole("button", { name: /Review/ }));
  await screen.findByRole("complementary", { name: "CYC-6" });
  expect(crumbs()).toBe("Cycle/CYC-6");
  expect(screen.getByRole("region", { name: "Needs you" })).toBeTruthy();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(crumbs()).toBe("Cycle/Console"));
  expect(screen.getByRole("button", { name: "Console" }).getAttribute("aria-current")).toBe("page");
});

test("a blocked notice whose session is not here falls back to the drawer", async () => {
  const blocked = ticket(2, "Blocked");
  const { user } = await mountConsole({
    loopBoards: { CYC: boardOf({ doing: [blocked] }) },
    loopTickets: { "CYC-2": detailOf(blocked) },
    loopNotices: {
      CYC: { kind: "ok", notices: [notice("blocked", 2, { kind: "dev", id: "s-gone" })] },
    },
  });
  const needs = await screen.findByRole("region", { name: "Needs you" });
  expect(within(needs).getByText("Join session")).toBeTruthy();
  await user.click(within(needs).getByRole("button", { name: /Blocked/ }));
  await screen.findByRole("complementary", { name: "CYC-2" });
});

test("intent_stuck has a Retry write that calls the retry and says how many", async () => {
  const { user, calls } = await mountConsole({
    loopNotices: { CYC: { kind: "ok", notices: [notice("intent_stuck", 4)] } },
    loopRetryIntents: { kind: "ok", retried: 2 },
  });
  await user.click(await screen.findByRole("button", { name: "Retry write for CYC-4" }));
  await waitFor(() => expect(calls.some(([name]) => name === "loopRetryIntents")).toBe(true));
  expect(await screen.findByText("Queued 2 writes to retry.")).toBeTruthy();
});

test("the approval queue sorts by priority, confirms before approving and counts the outcome", async () => {
  const { user, calls } = await mountConsole({
    loopBoards: {
      CYC: boardOf({
        backlog: [
          waiting(701, "low", "Reason low"),
          waiting(702, "urgent", "Reason urgent"),
          ticket(703, "Backlog"),
        ],
      }),
    },
    loopActMany: {
      kind: "done",
      results: [
        { identifier: "CYC-702", outcome: "ok" },
        { identifier: "CYC-701", outcome: "skipped" },
      ],
    },
  });
  const queue = await screen.findByRole("region", { name: "Awaiting approval" });
  const rows = within(queue).getAllByRole("listitem");
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain("CYC-702");
  expect(rows[0]?.textContent).toContain("Reason urgent");
  expect(within(queue).queryByRole("button", { name: "Approve selected" })).toBeNull();
  await user.click(within(queue).getByRole("checkbox", { name: "Select all" }));
  await user.click(within(queue).getByRole("button", { name: "Approve selected" }));
  expect(calls.some(([name]) => name === "loopActMany")).toBe(false);
  // Cancelling writes nothing.
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog.textContent).toContain("CYC-702 Ticket 702");
  expect(dialog.textContent).toContain("CYC-701 Ticket 701");
  await user.click(within(dialog).getByRole("button", { name: /Cancel/ }));
  expect(calls.some(([name]) => name === "loopActMany")).toBe(false);
  await user.click(within(queue).getByRole("button", { name: "Approve selected" }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Approve selected",
    }),
  );
  expect(await screen.findByText(/1 succeeded, 1 skipped, 0 failed/)).toBeTruthy();
  expect(calls.filter(([name]) => name === "loopActMany")).toEqual([
    ["loopActMany", "CYC", "approve_many", ["CYC-702", "CYC-701"], true, undefined],
  ]);
});

test("returning from the queue asks nothing and carries the reason; a row opens the drawer; Escape clears", async () => {
  const one = waiting(701, "high", "Reason");
  const { user, calls } = await mountConsole({
    loopBoards: { CYC: boardOf({ backlog: [one, waiting(702, "low", "Other")] }) },
    loopTickets: { "CYC-701": detailOf(one) },
  });
  const queue = await screen.findByRole("region", { name: "Awaiting approval" });
  await user.click(within(queue).getByRole("checkbox", { name: "Select CYC-701" }));
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(within(queue).queryByRole("button", { name: "Return selected" })).toBeNull(),
  );
  await user.click(within(queue).getByRole("checkbox", { name: "Select CYC-701" }));
  await user.type(within(queue).getByRole("textbox"), "not now");
  await user.click(within(queue).getByRole("button", { name: "Return selected" }));
  await waitFor(() =>
    expect(calls.filter(([name]) => name === "loopActMany")).toEqual([
      ["loopActMany", "CYC", "return_many", ["CYC-701"], true, "not now"],
    ]),
  );
  await user.click(within(queue).getByRole("button", { name: /CYC-701/ }));
  await screen.findByRole("complementary", { name: "CYC-701" });
});

test("a failed batch says why and keeps the selection", async () => {
  const { user } = await mountConsole({
    loopBoards: { CYC: boardOf({ backlog: [waiting(701, "high", "Reason")] }) },
    loopActMany: { kind: "failed", reason: "no_server" },
  });
  const queue = await screen.findByRole("region", { name: "Awaiting approval" });
  await user.click(within(queue).getByRole("checkbox", { name: "Select CYC-701" }));
  await user.click(within(queue).getByRole("button", { name: "Return selected" }));
  await screen.findAllByRole("alert");
  expect(
    (within(queue).getByRole("checkbox", { name: "Select CYC-701" }) as HTMLInputElement).checked,
  ).toBe(true);
});

test("Running now lists this Project's running tickets by when the stage began, and follows pushed run state", async () => {
  const a = ticket(11, "In Progress", { phase: { name: "dev", since: "2026-11-28T01:00:00Z" } });
  const b = ticket(12, "In Progress", {
    phase: { name: "qa", since: "2026-11-28T00:00:00Z" },
    graph: {
      source: "plan_doc",
      total: 4,
      passed: 1,
      failed: 0,
      blocked: 0,
      running: 1,
      currentNodeId: "n2",
      currentNodeTitle: "Wire the bridge",
    },
  });
  const idle = ticket(13, "In Progress");
  const { user, emit } = await mountConsole({
    loopBoards: { CYC: boardOf({ doing: [a, b, idle] }) },
    loopTickets: { "CYC-12": detailOf(b) },
    loopRuns: { kind: "ok", running: { CYC: ["CYC-11", "CYC-12"], DOC: ["DOC-1"] } },
  });
  const running = await screen.findByRole("region", { name: "Running now" });
  const ids = () =>
    within(running)
      .getAllByRole("listitem")
      .map((li) => li.textContent?.match(/CYC-\d+/)?.[0]);
  expect(ids()).toEqual(["CYC-12", "CYC-11"]);
  expect(within(running).getByText(/Wire the bridge/)).toBeTruthy();
  expect(within(running).queryByText(/DOC-1/)).toBeNull();
  act(() => emit({ type: "loop-runs", runs: { kind: "ok", running: { CYC: ["CYC-13"] } } }));
  await waitFor(() => expect(ids()).toEqual(["CYC-13"]));
  await user.click(within(running).getByRole("button", { name: /CYC-13/ }));
  await screen.findByRole("complementary", { name: "CYC-13" });
});

test("a notification opens the Console with the ticket's drawer, once", async () => {
  const mine = ticket(21, "In Progress");
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    workspaceRepos: { "/work": cycle.repo.displayName },
    loopBoards: { CYC: boardOf({ doing: [mine] }) },
    loopTickets: { "CYC-21": detailOf(mine) },
  });
  await renderApp(fake.bridge);
  const user = userEvent.setup();
  await screen.findByRole("button", { name: "Kanban" });
  await act(() => {
    fake.emit({ type: "open-loop-ticket", projectKey: "CYC", identifier: "CYC-21" });
  });
  await screen.findByRole("complementary", { name: "CYC-21" });
  expect(screen.getByRole("region", { name: "Running now" })).toBeTruthy();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(crumbs()).toBe("Cycle/Console"));
  await waitFor(() => expect(screen.queryByRole("complementary", { name: "CYC-21" })).toBeNull());
  expect(
    tracked(fake.calls).filter(([event]) => event === "loop_project_view_opened"),
  ).toContainEqual(["loop_project_view_opened", { view: "console", from: "notification" }]);
});

test("a board that cannot be read shows why and a retry, and no empty sections", async () => {
  const { user, calls } = await mountConsole({
    loopBoards: { CYC: { kind: "unreachable" } },
    loopNotices: { CYC: { kind: "ok", notices: [] } },
  });
  await screen.findByText("Could not read the board");
  expect(screen.queryByRole("region", { name: "Running now" })).toBeNull();
  const reads = calls.filter(([name]) => name === "loopBoard").length;
  await user.click(screen.getByRole("button", { name: "Read again" }));
  await waitFor(() =>
    expect(calls.filter(([name]) => name === "loopBoard").length).toBeGreaterThan(reads),
  );
});

test("opening the Console reports the counts once, and a notice press reports where it came from", async () => {
  const { user, calls } = await mountConsole({
    loopBoards: {
      CYC: boardOf({ backlog: [waiting(701, "high", "R")], doing: [ticket(31, "In Progress")] }),
    },
    loopTickets: { "CYC-31": detailOf(ticket(31, "In Progress")) },
    loopRuns: { kind: "ok", running: { CYC: ["CYC-31"] } },
    loopNotices: {
      CYC: { kind: "ok", notices: [notice("stuck", 31), notice("operator", 31, null, "hint")] },
    },
  });
  const needs = await screen.findByRole("region", { name: "Needs you" });
  await waitFor(() =>
    expect(tracked(calls)).toContainEqual([
      "loop_console_shown",
      { needs_you: 1, pending: 1, operator: 1, running: 1 },
    ]),
  );
  await user.click(within(needs).getByRole("button", { name: /No progress/ }));
  expect(tracked(calls)).toContainEqual(["loop_notice_opened", { kind: "stuck", from: "console" }]);
  expect(tracked(calls).filter(([event]) => event === "loop_console_shown")).toHaveLength(1);
});

// The queue's Escape clears its picks only while the Console is shown: over it, Escape is the page's.
test("Escape leaves a page opened over the Console, and the picks stay", async () => {
  const { user } = await mountConsole({
    loopBoards: { CYC: boardOf({ backlog: [waiting(740, "high", "Why")] }) },
  });
  const queue = await screen.findByRole("region", { name: "Awaiting approval" });
  await user.click(within(queue).getByRole("checkbox", { name: "Select CYC-740" }));
  await openSettings(user);
  await screen.findByRole("heading", { name: "General", level: 2 });
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: "General", level: 2 })).toBeNull(),
  );
  expect(
    (
      within(screen.getByRole("region", { name: "Awaiting approval" })).getByRole("checkbox", {
        name: "Select CYC-740",
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
});
