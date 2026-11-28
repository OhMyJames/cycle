import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import type {
  LoopBoardAnswer,
  LoopGraph,
  LoopGraphNode,
  LoopProjectInfo,
  LoopProjectsAnswer,
  LoopTicket,
  LoopTicketDetail,
} from "../../src/api.ts";
import { fakeBridge, summary } from "../fake-bridge.ts";
import { openSettings } from "./account-menu.ts";
import { type FakeOptions, mountLoop } from "./mount.tsx";
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
const ticket = (n: number, column: string): LoopTicket => ({
  identifier: `CYC-${n}`,
  title: `Ticket ${n}`,
  priority: "high",
  column,
});
const col = (id: number, name: string, stateType: string, tickets: LoopTicket[]) => ({
  id,
  name,
  stateType,
  tickets,
  more: false,
});
const board: LoopBoardAnswer = {
  kind: "ok",
  stale: false,
  columns: [
    col(1, "Backlog", "backlog", []),
    col(2, "Todo", "unstarted", [ticket(388, "Todo")]),
    col(3, "In Progress", "started", [ticket(386, "In Progress")]),
    col(4, "Done", "completed", [ticket(300, "Done")]),
    col(5, "In Review", "started", [ticket(387, "In Review")]),
    col(6, "Blocked", "started", []),
  ],
};
/** The board with the tickets of the named columns replaced. */
const withTickets = (tickets: Record<string, LoopTicket[]>): LoopBoardAnswer => ({
  kind: "ok",
  stale: false,
  columns: (board.kind === "ok" ? board.columns : []).map((c) => ({
    ...c,
    tickets: tickets[c.name] ?? c.tickets,
  })),
});

const mount = (script: FakeOptions) =>
  mountLoop({ workspaceRepos: { "/work": cycle.repo.displayName }, ...script });

const openOverviewProject = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  const overview = await screen.findByRole("region", { name: "Projects" });
  await user.click(within(overview).getByRole("button", { name: new RegExp(`\\b${name}\\b`) }));
};

const mountBoard = (script: FakeOptions) =>
  mountLoop({ workspaceRepos: { "/work": cycle.repo.displayName }, ...script }, "board");

test("the Loop page shows a full-width board as a row of columns, with Done open at the end", async () => {
  const { user, calls } = await mount({
    loopProjects: { kind: "ok", projects: [cycle, docs] },
    loopBoards: { CYC: board },
  });
  await user.click(await screen.findByRole("button", { name: "Kanban" }));
  const text = (name: string) =>
    within(screen.getByRole("region", { name }))
      .getAllByRole("listitem")
      .map((li) => li.textContent);
  await screen.findByRole("region", { name: "In Progress" });
  expect(text("In Progress")).toEqual(["CYC-386HighTicket 386"]);
  expect(text("In Review")).toEqual(["CYC-387HighTicket 387"]);
  expect(
    within(screen.getByRole("region", { name: "Todo" })).getAllByRole("listitem"),
  ).toHaveLength(1);
  expect(
    within(screen.getByRole("region", { name: "Backlog" })).getByText("Nothing here"),
  ).toBeTruthy();
  // Board uses full content width rather than the 48rem centered column.
  const main = document.querySelector<HTMLElement>('[data-slot="page-body"]');
  const boardEl = document.querySelector<HTMLElement>('[data-kind="loop-board"]');
  expect(main && boardEl && boardEl.getBoundingClientRect().width >= main.clientWidth - 2).toBe(
    true,
  );
  // Done is open like the others.
  expect(await screen.findByText("Ticket 300")).toBeTruthy();
  expect(document.querySelector("[data-folded]")).toBeNull();
  expect(calls.some(([name, key]) => name === "loopBoard" && key === "CYC")).toBe(true);
});

test("with the Loop server away, the project Kanban and Timeline entries are greyed out and the page says so", async () => {
  const options: Parameters<typeof fakeBridge>[0] = {
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    workspaceRepos: { "/work": cycle.repo.displayName },
    loopBoards: { CYC: board },
  };
  const fake = fakeBridge(options);
  const store = await renderApp(fake.bridge);
  const user = userEvent.setup();
  const kanban = await screen.findByRole("button", { name: "Kanban" });
  expect(kanban.hasAttribute("disabled") || kanban.getAttribute("aria-disabled") === "true").toBe(
    false,
  );
  await user.click(await screen.findByRole("button", { name: "Loop" }));
  // The server goes away: the next read says so, and the project entries stay listed, greyed, with the reason.
  options.loopProjects = { kind: "disconnected" };
  await act(() => store.loadLoopProjects());
  const grey = await screen.findByRole("button", { name: /Kanban/ });
  expect(grey.hasAttribute("disabled") || grey.getAttribute("aria-disabled") === "true").toBe(true);
  expect(within(grey).getByText("Offline")).toBeTruthy();
  expect(await screen.findByText("The Loop server is not running")).toBeTruthy();
});

test("with no server ever seen, the page says it is not running and offers to refresh", async () => {
  await mount({});
  expect(await screen.findByText("The Loop server is not running")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Read again" })).toBeTruthy();
});

test("with no server for the board, the page says the Loop server is not running", async () => {
  await mountBoard({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: { kind: "no_server" } },
  });
  expect(await screen.findByText("The Loop server is not running")).toBeTruthy();
});

test("a stale board says its data may be out of date, and a fresh one does not", async () => {
  const { user } = await mount({
    loopProjects: { kind: "ok", projects: [cycle, docs] },
    loopBoards: { CYC: { ...board, stale: true } as LoopBoardAnswer, DOC: board },
  });
  await openOverviewProject(user, "Cycle");
  await user.click(await screen.findByRole("button", { name: "Kanban" }));
  expect(await screen.findByText("Data may be out of date")).toBeTruthy();
  await user.click(await screen.findByRole("button", { name: "Loop" }));
  await openOverviewProject(user, "Docs");
  await waitFor(() =>
    expect(screen.getByRole("navigation", { name: "Where you are" }).textContent).toBe(
      "Docs/Console",
    ),
  );
  await screen.findByRole("region", { name: "Running now" });
  expect(screen.queryByText("Data may be out of date")).toBeNull();
});

test("unmatched workspaces hide Kanban and Timeline, and switching projects updates them", async () => {
  const fake = fakeBridge({
    connected: true,
    workspaceRepos: {
      "/work": cycle.repo.displayName,
      "/other": "org/unmatched",
    },
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: board },
  });
  fake.bridge.sessions = async () => [
    { ...summary("s1"), cwd: "/work", title: "Cycle session", updatedAt: "2026-11-26T02:00:00Z" },
    { ...summary("s2"), cwd: "/other", title: "Other session", updatedAt: "2026-11-26T01:00:00Z" },
  ];
  await renderApp(fake.bridge);
  const user = userEvent.setup();
  // Initially in /work (matched): Kanban and Timeline appear above the session list.
  await screen.findByRole("button", { name: "Kanban" });
  await screen.findByRole("button", { name: "Timeline" });
  // Open Kanban, then switch workspace to /other (unmatched): Kanban/Timeline disappear and view leaves Loop.
  await user.click(screen.getByRole("button", { name: "Kanban" }));
  await screen.findByRole("region", { name: "In Progress" });
  await user.click(screen.getByRole("button", { name: /Switch workspace/ }));
  await user.click(await screen.findByRole("menuitem", { name: /other/ }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Kanban" })).toBeNull());
  expect(screen.queryByRole("button", { name: "Timeline" })).toBeNull();
  expect(document.querySelector('[data-kind="loop-board"]')).toBeNull();
});

test("the Backlog opens on 20 tickets and shows more when asked", async () => {
  const many = Array.from({ length: 45 }, (_, i) => ticket(500 + i, "Backlog"));
  const { user } = await mountBoard({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: withTickets({ Backlog: many }) },
  });
  const backlog = await screen.findByRole("region", { name: "Backlog" });
  expect(within(backlog).getAllByRole("listitem")).toHaveLength(20);
  await user.click(within(backlog).getByRole("button", { name: "Show 25 more" }));
  expect(within(backlog).getAllByRole("listitem")).toHaveLength(40);
  await user.click(within(backlog).getByRole("button", { name: "Show 5 more" }));
  expect(within(backlog).getAllByRole("listitem")).toHaveLength(45);
  expect(within(backlog).queryByRole("button", { name: /more/ })).toBeNull();
});

test("Approve asks first; only the confirmation writes, and a failure is said, not hidden", async () => {
  const backlog = ticket(600, "Backlog");
  const doing = ticket(601, "In Progress");
  const { user, calls } = await mountBoard({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: withTickets({ "In Progress": [doing], Backlog: [backlog] }) },
    loopTickets: { "CYC-600": detailOf(backlog, { actions: ["approve", "to_todo"], chat: "new" }) },
    loopAct: { kind: "failed", reason: "forbidden" },
  });
  const column = await screen.findByRole("region", { name: "Backlog" });
  // A card has no state buttons of its own, and Loop's own ticket in Doing none either.
  expect(
    within(screen.getByRole("region", { name: "In Progress" })).queryByRole("button", {
      name: /Approve|Back to/,
    }),
  ).toBeNull();
  expect(within(column).queryByRole("button", { name: /Approve|Back to/ })).toBeNull();
  await user.click(within(column).getByRole("button", { name: "Ticket 600" }));
  await user.click(await screen.findByRole("button", { name: "Approve CYC-600" }));
  expect(calls.some(([name]) => name === "loopAct")).toBe(false);
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Approve" }));
  expect(await within(dialog).findByText(/did not accept this from Loop/)).toBeTruthy();
  expect(calls.filter(([name]) => name === "loopAct")).toEqual([
    ["loopAct", "CYC", "CYC-600", "approve", true],
  ]);
});

test("a failed Back to Backlog in the ticket drawer is said there, and gone after closing", async () => {
  const mine = ticket(602, "In Review");
  const { user } = await mountBoard({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: withTickets({ "In Progress": [mine] }) },
    loopTickets: {
      "CYC-602": detailOf(mine, {
        actions: ["to_backlog", "to_todo"],
        body: "## Details\n\nSome markdown body.",
      }),
    },
    loopAct: { kind: "failed", reason: "offline" },
  });
  await user.click(await screen.findByRole("button", { name: "Ticket 602" }));
  const drawer = await screen.findByRole("complementary", { name: "CYC-602" });
  // Board remains mounted under the right-side drawer.
  expect(document.querySelector('[data-kind="loop-board"]')).not.toBeNull();
  // Markdown body is rendered as structured HTML, not raw <pre>.
  await within(drawer).findByText("Some markdown body.");
  expect(drawer.querySelector('[data-slot="loop-detail-markdown"] h2')?.textContent).toBe(
    "Details",
  );
  await user.click(within(drawer).getByRole("button", { name: "Back to Backlog CYC-602" }));
  await within(drawer).findByText(/could not be reached/);
  await user.click(within(drawer).getByRole("button", { name: /Close ticket/ }));
  await waitFor(() => expect(screen.queryByRole("complementary", { name: "CYC-602" })).toBeNull());
  expect(screen.queryByText(/could not be reached/)).toBeNull();
});

const openTicketDrawer = async (
  chat: "new" | "watch",
  script: Parameters<typeof fakeBridge>[0] = {},
) => {
  const mine = ticket(700, chat === "new" ? "Backlog" : "In Progress");
  const fake = await mountLoop(
    {
      loopProjects: { kind: "ok", projects: [cycle] },
      workspaceRepos: { "/work": cycle.repo.displayName },
      loopBoards: {
        CYC: withTickets({
          Backlog: chat === "new" ? [mine] : [],
          "In Progress": chat === "new" ? [] : [mine],
        }),
      },
      loopTickets: { "CYC-700": detailOf(mine, { chat, acceptance: [] }) },
      ...script,
    },
    "none",
  );
  const { user } = fake;
  await user.click(await screen.findByRole("button", { name: "Kanban" }));
  await user.click(await screen.findByRole("button", { name: "Ticket 700" }));
  return { user, fake };
};

test("a Backlog ticket drawer has the chat button: it asks main and opens the session", async () => {
  const { user, fake } = await openTicketDrawer("new");
  await user.click(await screen.findByRole("button", { name: "Talk with an agent CYC-700" }));
  await waitFor(() => expect(fake.named("loopChat")).toEqual([["loopChat", "CYC", "CYC-700"]]));
  await waitFor(() => expect(fake.named("openSession").length).toBeGreaterThan(0));
  expect(fake.named("openSession")[0]?.slice(1)).toEqual(["local", "chat-1"]);
});

test("with no default model the drawer says to set one in Settings", async () => {
  const { user } = await openTicketDrawer("new", {
    loopChat: { kind: "failed", reason: "needs_model" },
  });
  await user.click(await screen.findByRole("button", { name: "Talk with an agent CYC-700" }));
  expect(await screen.findByText(/Set one in Settings/)).toBeTruthy();
});

test("a session made whose first message did not go can still be opened", async () => {
  const { user, fake } = await openTicketDrawer("new", {
    loopChat: { kind: "failed", reason: "offline", locationId: "local", sessionId: "orphan-1" },
  });
  await user.click(await screen.findByRole("button", { name: "Talk with an agent CYC-700" }));
  await user.click(await screen.findByRole("button", { name: "Open the conversation" }));
  await waitFor(() =>
    expect(fake.named("openSession")[0]?.slice(1)).toEqual(["local", "orphan-1"]),
  );
});

test("an In Progress ticket is only watched: a note, and no chat button", async () => {
  const { fake } = await openTicketDrawer("watch");
  expect(await screen.findByText(/Loop is working on this ticket/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Talk with an agent/ })).toBeNull();
  expect(fake.named("loopChat")).toEqual([]);
});

test("closing the ticket drawer plays the slide-out first, then removes it", async () => {
  const { user } = await openTicketDrawer("new");
  await screen.findByRole("complementary", { name: "CYC-700" });
  const layer = document.querySelector('[data-slot="loop-drawer-layer"]');
  expect(layer?.getAttribute("data-state")).toBe("open");
  await user.keyboard("{Escape}");
  expect(layer?.getAttribute("data-state")).toBe("closing");
  expect(layer?.isConnected).toBe(true);
  await waitFor(() => expect(document.querySelector('[data-slot="loop-drawer-layer"]')).toBeNull());
});

test("a card clicked while the drawer closes opens that ticket", async () => {
  const { user } = await openTicketDrawer("new");
  await screen.findByRole("complementary", { name: "CYC-700" });
  await user.keyboard("{Escape}");
  await user.click(await screen.findByRole("button", { name: "Ticket 700" }));
  const layer = await waitFor(() => {
    const el = document.querySelector('[data-slot="loop-drawer-layer"]');
    expect(el?.getAttribute("data-state")).toBe("open");
    return el;
  });
  await new Promise((r) => setTimeout(r, 500));
  expect(layer?.isConnected).toBe(true);
  expect(screen.getByRole("complementary", { name: "CYC-700" })).toBeTruthy();
});

test("Escape closes the ticket drawer to its board and leaves the board open; clicking a session returns to sessions", async () => {
  const { user } = await openTicketDrawer("new");
  await screen.findByRole("complementary", { name: "CYC-700" });
  // Ticket drawer → board by Escape; the board stays, out of Loop by clicking a session, and back to Kanban from the sidebar.
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("complementary", { name: "CYC-700" })).toBeNull());
  expect(document.querySelector('[data-kind="loop-board"]')).not.toBeNull();
  await user.keyboard("{Escape}");
  expect(document.querySelector('[data-kind="loop-board"]')).not.toBeNull();
  await user.click(screen.getByRole("option"));
  await waitFor(() => expect(document.querySelector('[data-kind="loop-board"]')).toBeNull());
  await user.click(await screen.findByRole("button", { name: "Kanban" }));
  await waitFor(() => expect(document.querySelector('[data-kind="loop-board"]')).not.toBeNull());
});

const overviewScript = (extra: Parameters<typeof fakeBridge>[0] = {}) => ({
  loopProjects: { kind: "ok" as const, projects: [cycle, docs] },
  loopBoards: {
    CYC: board,
    DOC: { kind: "unreachable" as const },
  },
  ...extra,
});

test("with two Projects the Loop lands on the overview, with each Project's counts", async () => {
  const { user } = await mount(overviewScript());
  const projects = await screen.findByRole("region", { name: "Projects" });
  const cycleRow = await waitFor(() => {
    const row = projects.querySelector<HTMLElement>('[data-project="CYC"]');
    if (row === null || !row.textContent?.includes("Doing 2")) throw new Error("not yet");
    return row;
  });
  // Counts follow the board's columns; a column with none is not named.
  expect(cycleRow.textContent).toContain("Todo 1");
  expect(cycleRow.textContent).toContain("Done 1");
  expect(cycleRow.textContent).not.toContain("Backlog");
  expect(document.querySelector('[data-kind="loop-board"]')).toBeNull();
  // The row that cannot be read says so and refreshes.
  const docsRow = projects.querySelector<HTMLElement>('[data-project="DOC"]') as HTMLElement;
  await within(docsRow).findByText("Could not read the board");
  await user.click(within(docsRow).getByRole("button", { name: "Read again Docs" }));
  // A row opens the Project's Console.
  await user.click(within(cycleRow).getByRole("button", { name: /Cycle/ }));
  await screen.findByRole("region", { name: "Running now" });
});

test("even with one Project, clicking top Loop opens Overview instead of redirecting", async () => {
  const { user } = await mount({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: board },
  });
  await screen.findByRole("region", { name: "Projects" });
  expect(document.querySelector('[data-kind="loop-board"]')).toBeNull();
  await user.keyboard("{Escape}");
  expect(document.querySelector('[data-kind="loop-overview"]')).not.toBeNull();
  await openOverviewProject(user, "CYC");
  await screen.findByRole("region", { name: "Running now" });
});

test("Needs you is on the project's Console, not on the overview or the board", async () => {
  const blocked = {
    id: "CYC:blocked:CYC-9",
    kind: "blocked" as const,
    identifier: "CYC-9",
    text: "stuck",
    session: null,
  };
  const { user } = await mount(
    overviewScript({
      loopNotices: { CYC: { kind: "ok", notices: [blocked] } },
    }),
  );
  await screen.findByRole("region", { name: "Projects" });
  expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
  await openOverviewProject(user, "CYC");
  const notices = await screen.findByRole("region", { name: "Needs you" });
  expect(within(notices).getByText("CYC-9")).toBeTruthy();
  await user.click(await screen.findByRole("button", { name: "Kanban" }));
  await screen.findByRole("region", { name: "In Progress" });
  expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
});

test("with nothing that needs a person, the section is not there", async () => {
  await mount(overviewScript({ loopNotices: { CYC: { kind: "ok", notices: [] } } }));
  await screen.findByRole("region", { name: "Projects" });
  expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
});

test("a Project opens on its board with clean breadcrumbs leading back to Overview", async () => {
  const { user } = await mountBoard({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: board },
  });
  await screen.findByRole("region", { name: "In Progress" });
  // No placeholder "Coming later" tab clutter.
  expect(screen.queryByText("Coming later")).toBeNull();
  const heading = screen.getByRole("navigation", { name: "Where you are" });
  expect(heading.textContent).toBe("Cycle/Kanban");
  // The Project name leads back to the Loop overview.
  await user.click(within(heading).getByRole("button", { name: "Cycle" }));
  await screen.findByRole("region", { name: "Projects" });
});

test("opening a ticket drawer updates breadcrumbs to Project / ticket and clicking Project closes it", async () => {
  const { user } = await mountBoard({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: board },
  });
  await user.click(await screen.findByRole("button", { name: /Ticket 388/ }));
  await screen.findByRole("complementary", { name: "CYC-388" });
  const heading = screen.getByRole("navigation", { name: "Where you are" });
  expect(heading.textContent).toBe("Cycle/CYC-388");
  await user.click(within(heading).getByRole("button", { name: "Cycle" }));
  await waitFor(() => expect(screen.queryByRole("complementary", { name: "CYC-388" })).toBeNull());
  expect(screen.getByRole("region", { name: "In Progress" })).toBeTruthy();
});

test("the board is a row of columns by name with Done last and open: cards are not draggable, there is no move menu, and the tops line up", async () => {
  await mountBoard({ loopProjects: { kind: "ok", projects: [cycle] }, loopBoards: { CYC: board } });
  await screen.findByRole("region", { name: "In Review" });
  const names = [...document.querySelectorAll('[data-slot="loop-column"]')].map((e) =>
    e.getAttribute("aria-label"),
  );
  expect(names).toEqual(["Backlog", "Todo", "In Progress", "In Review", "Blocked", "Done"]);
  expect(document.querySelectorAll("[draggable='true']")).toHaveLength(0);
  expect(screen.queryByText(/Move to/i)).toBeNull();
  expect(screen.queryByRole("menu")).toBeNull();
  const done = screen.getByRole("region", { name: "Done" });
  expect(within(done).getByText("1")).toBeTruthy();
  expect(within(done).getAllByRole("listitem")).toHaveLength(1);
  const tops = [...document.querySelectorAll('[data-slot="loop-column"]')].map(
    (e) => e.getBoundingClientRect().top,
  );
  expect(new Set(tops).size).toBe(1);
});

test("a card opens its drawer, a button on it does not, and cancelling Approve writes nothing", async () => {
  const backlog = waiting(600, "high", "Ready");
  const { user, calls } = await mountBoard({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: withTickets({ Backlog: [backlog] }) },
  });
  const column = await screen.findByRole("region", { name: "Backlog" });
  await user.click(within(column).getByRole("button", { name: "Approve CYC-600" }));
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(calls.some(([name]) => name === "loopAct")).toBe(false);
  expect(document.querySelector('[data-kind="loop-ticket-drawer"]')).toBeNull();
  await user.click(within(column).getByRole("button", { name: "Ticket 600" }));
  await waitFor(() => expect(calls.some(([name]) => name === "loopTicket")).toBe(true));
});

test("at 720px the page has no sideways scrollbar and the columns scroll by themselves", async () => {
  await page.viewport(720, 800);
  try {
    await checkNarrow();
  } finally {
    await page.viewport(1280, 800);
  }
});

const checkNarrow = async () => {
  await mountBoard({ loopProjects: { kind: "ok", projects: [cycle] }, loopBoards: { CYC: board } });
  await screen.findByRole("region", { name: "In Review" });
  const strip = document.querySelector<HTMLElement>('[data-slot="loop-columns"]');
  if (strip === null) throw new Error("no columns");
  const root = document.documentElement;
  const body = document.querySelector<HTMLElement>('[data-slot="page-body"]');
  expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
  expect(body === null || body.scrollWidth <= body.clientWidth).toBe(true);
  expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth);
  strip.scrollLeft = 40;
  expect(strip.scrollLeft).toBeGreaterThan(0);
  const columns = [...document.querySelectorAll<HTMLElement>('[data-slot="loop-column"]')];
  for (const c of columns) expect(c.getBoundingClientRect().width).toBeGreaterThanOrEqual(320);
  expect(document.querySelector("[data-folded]")).toBeNull();
};

test("a column header lays its dot, title and count on one row", async () => {
  await mountBoard({ loopProjects: { kind: "ok", projects: [cycle] }, loopBoards: { CYC: board } });
  const todo = await screen.findByRole("region", { name: "Todo" });
  const head = todo.querySelector<HTMLElement>('[data-slot="loop-column-head"]') as HTMLElement;
  expect(getComputedStyle(head).flexDirection).toBe("row");
  const tops = ["dot", "title", "count"].map((n) =>
    Math.round(
      (head.querySelector(`[data-slot="loop-column-${n}"]`) as HTMLElement).getBoundingClientRect()
        .top,
    ),
  );
  expect(Math.abs((tops[0] ?? 0) - (tops[1] ?? 99))).toBeLessThan(8);
  expect(Math.abs((tops[2] ?? 0) - (tops[1] ?? 99))).toBeLessThan(8);
});

test("a column's cards sit symmetrically whether or not the column scrolls", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ticket(700 + i, "Backlog"));
  await mountBoard({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: withTickets({ Backlog: many }) },
  });
  const backlog = await screen.findByRole("region", { name: "Backlog" });
  const todo = screen.getByRole("region", { name: "Todo" });
  // Give the strip a fixed height so the 20 loaded Backlog cards overflow their column.
  const strip = document.querySelector<HTMLElement>('[data-slot="loop-columns"]');
  if (strip === null) throw new Error("no columns");
  strip.style.flex = "none";
  strip.style.height = "400px";
  const body = (c: HTMLElement) =>
    c.querySelector<HTMLElement>('[data-slot="loop-column-body"]') as HTMLElement;
  expect(body(backlog).scrollHeight).toBeGreaterThan(body(backlog).clientHeight);
  const gap = (c: HTMLElement) => {
    const b = body(c).getBoundingClientRect();
    const k = (body(c).querySelector("li") as HTMLElement).getBoundingClientRect();
    return [k.left - b.left, b.right - k.right] as [number, number];
  };
  const [l, r] = gap(backlog);
  expect(Math.abs(l - r)).toBeLessThanOrEqual(0.5);
  const [tl, tr] = gap(todo);
  expect(Math.abs(tl - tr)).toBeLessThanOrEqual(0.5);
  expect(l).toBeCloseTo(tl, 0);
});

test("while the board is read each column shows skeleton cards", async () => {
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    workspaceRepos: { "/work": cycle.repo.displayName },
    loopBoards: { CYC: board },
  });
  const never = new Promise<LoopBoardAnswer>(() => {});
  fake.bridge.loopBoard = () => never;
  await renderApp(fake.bridge);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Kanban" }));
  await waitFor(() =>
    expect(document.querySelectorAll('[data-slot="loop-column"][data-skeleton]').length).toBe(3),
  );
  expect(document.querySelectorAll('[data-slot="loop-ticket"][data-skeleton]').length).toBe(9);
});

test("a short title is not clipped or masked", async () => {
  await mountBoard({ loopProjects: { kind: "ok", projects: [cycle] }, loopBoards: { CYC: board } });
  const text = (await screen.findByText("Ticket 386")) as HTMLElement;
  expect(text.scrollHeight).toBeLessThanOrEqual(text.clientHeight);
  expect(getComputedStyle(text).maskImage).toBe("none");
});

test("an In Progress card shows Loop's stage and how long, with a nudge past 30 minutes", async () => {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const staged = (n: number, stage: "qa" | "dev", min: number): LoopTicket => ({
    ...ticket(n, "In Progress"),
    phase: { name: stage, since: ago(min) },
  });
  await mountBoard({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: {
      CYC: withTickets({
        "In Progress": [staged(1, "qa", 3), staged(2, "dev", 72), ticket(3, "In Progress")],
        "In Review": [ticket(4, "In Review")],
      }),
    },
  });
  const quick = await screen.findByText("QA · 3 min");
  expect(quick.getAttribute("data-slow")).toBeNull();
  const slow = screen.getByText("Developing · 1 h 12 min");
  expect(slow.getAttribute("data-slow")).toBe("true");
  expect(document.querySelectorAll('[data-slot="loop-ticket-stage"]')).toHaveLength(2);
});

const waiting = (n: number, priority: string, reason: string): LoopTicket => ({
  ...ticket(n, "Backlog"),
  priority,
  pending: { reason },
});

test("awaiting-approval cards sit at the top of Backlog with a badge and a quick approve, and no batch selection", async () => {
  const { calls } = await mountBoard({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: {
      CYC: withTickets({
        Backlog: [
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
  const backlog = await screen.findByRole("region", { name: "Backlog" });
  // Pending tickets appear first in Backlog sorted by priority, each with its badge, criteria, reason and quick Approve.
  const items = within(backlog).getAllByRole("listitem");
  expect(items.map((li) => li.textContent)).toEqual([
    expect.stringContaining("CYC-702"),
    expect.stringContaining("CYC-701"),
    expect.stringContaining("CYC-703"),
  ]);
  expect(items[0]?.textContent).toContain("Awaiting approval");
  expect(items[0]?.textContent).toContain("Reason urgent");
  // Ordinary tickets do not carry the awaiting-approval badge.
  expect(items[2]?.textContent).not.toContain("Awaiting approval");
  // Selecting and approving a batch lives on the Console now; the board keeps the badge and the single Approve.
  expect(within(backlog).queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("region", { name: "Awaiting approval" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Awaiting approval/ })).toBeNull();
  expect(within(items[0] as HTMLElement).getByRole("button", { name: /^Approve/ })).toBeTruthy();
  expect(calls.some(([name]) => name === "loopActMany")).toBe(false);
});

const withPriority = (n: number, column: string, priority: string | null): LoopTicket => ({
  ...ticket(n, column),
  priority,
});

test("open columns sort by priority (stable), Backlog keeps pending first, Done keeps server order", async () => {
  await mountBoard({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: {
      CYC: withTickets({
        Backlog: [
          withPriority(801, "Backlog", "medium"),
          { ...withPriority(802, "Backlog", "low"), pending: { reason: "r" } },
          withPriority(803, "Backlog", "urgent"),
          { ...withPriority(804, "Backlog", "high"), pending: { reason: "r" } },
        ],
        Todo: [
          withPriority(811, "Todo", null),
          withPriority(812, "Todo", "low"),
          withPriority(813, "Todo", "medium"),
          withPriority(814, "Todo", "urgent"),
          withPriority(815, "Todo", "medium"),
          withPriority(816, "Todo", "high"),
        ],
        Done: [
          withPriority(821, "Done", "low"),
          withPriority(822, "Done", "urgent"),
          withPriority(823, "Done", "medium"),
        ],
      }),
    },
  });
  const idsOf = async (name: string) =>
    within(await screen.findByRole("region", { name }))
      .getAllByRole("listitem")
      .map((li) => /CYC-\d+/.exec(li.textContent ?? "")?.[0]);
  expect(await idsOf("Todo")).toEqual([
    "CYC-814",
    "CYC-816",
    "CYC-813",
    "CYC-815",
    "CYC-812",
    "CYC-811",
  ]);
  expect(await idsOf("Backlog")).toEqual(["CYC-804", "CYC-802", "CYC-803", "CYC-801"]);
  expect(await idsOf("Done")).toEqual(["CYC-821", "CYC-822", "CYC-823"]);
});

test("with nothing waiting for approval there is no awaiting-approval badge or filter chip", async () => {
  await mountBoard({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: withTickets({ Backlog: [ticket(710, "Backlog")] }) },
  });
  await screen.findByRole("region", { name: "Backlog" });
  expect(screen.queryByText("Awaiting approval")).toBeNull();
});

test("search narrows visible cards and can be cleared", async () => {
  const { user } = await mountBoard({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: {
      CYC: withTickets({
        Backlog: [waiting(701, "urgent", "Ready"), ticket(702, "Backlog")],
        Todo: [ticket(703, "Todo")],
      }),
    },
  });
  await screen.findByRole("region", { name: "Backlog" });
  await user.type(screen.getByRole("searchbox", { name: "Search tickets" }), "701");
  expect(screen.getByText("Ticket 701")).toBeTruthy();
  expect(screen.queryByText("Ticket 702")).toBeNull();
  expect(screen.queryByText("Ticket 703")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(screen.getByText("Ticket 703")).toBeTruthy();

  await user.type(screen.getByRole("searchbox", { name: "Search tickets" }), "703");
  expect(screen.getByText("Ticket 703")).toBeTruthy();
  expect(screen.queryByText("Ticket 701")).toBeNull();
});

test("a Backlog of only waiting tickets does not say it is empty", async () => {
  await mountBoard({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: withTickets({ Backlog: [waiting(730, "high", "Why")] }) },
  });
  const column = await screen.findByRole("region", { name: "Backlog" });
  expect(within(column).queryByText("Nothing here")).toBeNull();
});

test("Notices show research and QA sessions too, and pressing one joins its session", async () => {
  const notice = (kind: "permission" | "blocked", key: string, session: string, sk: string) => ({
    id: `CYC:${kind}:${key}`,
    kind,
    identifier: key,
    text: "",
    session: { kind: sk, id: session },
  });
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle, docs] },
    loopBoards: { CYC: board, DOC: board },
    loopNotices: {
      CYC: {
        kind: "ok",
        notices: [
          notice("permission", "CYC-21", "s-research", "research"),
          notice("permission", "CYC-22", "s-qa", "qa"),
          notice("blocked", "CYC-23", "s-gone", "dev"),
        ],
      },
    },
  });
  const store = await renderApp(fake.bridge);
  void store;
  await user.click(await screen.findByRole("button", { name: "Loop" }));
  await openOverviewProject(user, "Cycle");
  const notices = await screen.findByRole("region", { name: "Needs you" });
  expect(within(notices).getByText("CYC-21")).toBeTruthy();
  expect(within(notices).getByText("CYC-22")).toBeTruthy();
  // A session that is not in any location falls back to the ticket's page.
  await user.click(within(notices).getByRole("button", { name: /Blocked/ }));
  await screen.findByRole("complementary", { name: "CYC-23" });
  expect(screen.getByRole("navigation", { name: "Where you are" }).textContent).toBe(
    "Cycle/CYC-23",
  );
});

test("the Settings page has a name field for itsaplan and no key field", async () => {
  const user = userEvent.setup();
  const fake = fakeBridge({ connected: true });
  await renderApp(fake.bridge);
  await openSettings(user);
  const field = await screen.findByLabelText("Your name in itsaplan");
  await user.type(field, "Ada");
  await user.tab();
  await waitFor(() =>
    expect(fake.named("setPreferences").some((c) => JSON.stringify(c).includes("Ada"))).toBe(true),
  );
  expect(screen.queryByText(/itsaplan key/i)).toBeNull();
});

/** What `loop/ticket/get` gives for a ticket: the text, the buttons it allows, whether a conversation may start. */
const withoutGraph = ({ graph: _summary, ...rest }: LoopTicket): Omit<LoopTicket, "graph"> => rest;

const detailOf = (
  base: LoopTicket,
  extra: Partial<LoopTicketDetail> = {},
): { kind: "ok"; ticket: LoopTicketDetail } => ({
  kind: "ok",
  ticket: {
    ...withoutGraph(base),
    actions: [],
    chat: "none",
    body: "text",
    acceptance: ["one"],
    links: [],
    ...extra,
  },
});

test("cancelling Approve writes nothing; a ticket with no buttons shows none", async () => {
  const backlog = ticket(600, "Backlog");
  const doing = ticket(601, "In Progress");
  const { user, calls } = await mountBoard({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: withTickets({ Backlog: [backlog], "In Progress": [doing] }) },
    loopTickets: {
      "CYC-600": detailOf(backlog, { actions: ["approve"] }),
      "CYC-601": detailOf(doing),
    },
  });
  await user.click(await screen.findByRole("button", { name: "Ticket 600" }));
  await user.click(await screen.findByRole("button", { name: "Approve CYC-600" }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }),
  );
  expect(calls.some(([name]) => name === "loopAct")).toBe(false);
  await user.click(screen.getByRole("button", { name: /Close ticket/ }));
  await user.click(await screen.findByRole("button", { name: "Ticket 601" }));
  await screen.findByText("text");
  expect(screen.queryByRole("button", { name: /Approve|Back to Backlog|Back to Todo/ })).toBeNull();
});

test("a state button that works reads the board again", async () => {
  const mine = ticket(603, "Todo");
  const { user, named } = await mountBoard({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: withTickets({ Todo: [mine] }) },
    loopTickets: { "CYC-603": detailOf(mine, { actions: ["to_backlog"] }) },
  });
  await user.click(await screen.findByRole("button", { name: "Ticket 603" }));
  const reads = () => named("loopBoard").length;
  const before = reads();
  await user.click(await screen.findByRole("button", { name: "Back to Backlog CYC-603" }));
  await waitFor(() => expect(reads()).toBeGreaterThan(before));
  expect(named("loopAct")).toEqual([["loopAct", "CYC", "CYC-603", "to_backlog", false]]);
});

test("a ticket drawer shows the text, the criteria, why it needs a person, and joins its session", async () => {
  const mine = ticket(710, "Blocked");
  const { user } = await mountBoard({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: withTickets({ Blocked: [mine] }) },
    loopTickets: {
      "CYC-710": detailOf(mine, {
        body: "The body",
        acceptance: ["first", "first"],
        links: ["https://example.com/pr/1"],
        attention: { kind: "blocked", text: "Needs a decision", session: null },
      }),
    },
  });
  await user.click(await screen.findByRole("button", { name: "Ticket 710" }));
  expect(await screen.findByText("The body")).toBeTruthy();
  expect(screen.getAllByText("first")).toHaveLength(2);
  expect(screen.getByText("Needs a decision")).toBeTruthy();
  expect(screen.getByText("https://example.com/pr/1")).toBeTruthy();
  // The Dev session is not here: it says so.
  await user.click(screen.getByRole("button", { name: "Join the Dev session" }));
  expect(
    await screen.findByText("The Dev session is not in the list of any connected location."),
  ).toBeTruthy();
});

const runState = (projects: HTMLElement, key: string) =>
  projects.querySelector<HTMLElement>(`[data-project="${key}"] [data-kind="loop-run"]`)
    ?.textContent ?? null;

test("a Project with a running record says Running, and one without says Not running", async () => {
  await mount(overviewScript({ loopRuns: { kind: "ok", running: { CYC: ["CYC-386"], DOC: [] } } }));
  const projects = await screen.findByRole("region", { name: "Projects" });
  await waitFor(() => expect(runState(projects, "CYC")).toBe("Running"));
  expect(runState(projects, "DOC")).toBe("Not running");
});

test("a Loop server that does not answer is never shown as running, even with In Progress tickets", async () => {
  await mount(overviewScript({ loopRuns: { kind: "disconnected" } }));
  const projects = await screen.findByRole("region", { name: "Projects" });
  await waitFor(() => expect(runState(projects, "CYC")).toBe("Not running"));
});

test("a pushed run state updates the page without reading again", async () => {
  const { named, emit } = await mount(
    overviewScript({ loopRuns: { kind: "ok", running: { CYC: [], DOC: [] } } }),
  );
  const projects = await screen.findByRole("region", { name: "Projects" });
  await waitFor(() => expect(runState(projects, "CYC")).toBe("Not running"));
  const reads = named("loopRuns").length;
  act(() => emit({ type: "loop-runs", runs: { kind: "ok", running: { CYC: ["CYC-386"] } } }));
  await waitFor(() => expect(runState(projects, "CYC")).toBe("Running"));
  act(() => emit({ type: "loop-runs", runs: { kind: "disconnected" } }));
  await waitFor(() => expect(runState(projects, "CYC")).toBe("Not running"));
  expect(named("loopRuns").length).toBe(reads);
});

test("reopening the Loop page reads the run state again, and applies what changed meanwhile", async () => {
  const script = overviewScript({ loopRuns: { kind: "ok", running: { CYC: [], DOC: [] } } });
  const { user, options } = await mount(script);
  const projects = await screen.findByRole("region", { name: "Projects" });
  await waitFor(() => expect(runState(projects, "CYC")).toBe("Not running"));
  await user.click(screen.getByRole("option"));
  await waitFor(() => expect(document.querySelector('[data-kind="loop-overview"]')).toBeNull());
  // Loop started while the page was closed, and nothing was pushed to it.
  options.loopRuns = { kind: "ok", running: { CYC: ["CYC-386"], DOC: [] } };
  await user.click(await screen.findByRole("button", { name: "Loop" }));
  const again = await screen.findByRole("region", { name: "Projects" });
  await waitFor(() => expect(runState(again, "CYC")).toBe("Running"));
});

test("a pushed run state that changes who Loop is running reads the board again", async () => {
  const { named, emit, user } = await mount(
    overviewScript({ loopRuns: { kind: "ok", running: { CYC: [], DOC: [] } } }),
  );
  await openOverviewProject(user, "CYC");
  await screen.findByRole("region", { name: "Running now" });
  const reads = named("loopBoard").length;
  act(() => emit({ type: "loop-runs", runs: { kind: "ok", running: { CYC: ["CYC-386"] } } }));
  await waitFor(() => expect(named("loopBoard").length).toBeGreaterThan(reads));
  // The same state pushed again changes nothing: no read.
  const after = named("loopBoard").length;
  act(() => emit({ type: "loop-runs", runs: { kind: "ok", running: { CYC: ["CYC-386"] } } }));
  expect(named("loopBoard").length).toBe(after);
});

test("an older board read that lands last does not replace a newer one", async () => {
  const { bridge, emit } = await mount(
    overviewScript({ loopRuns: { kind: "ok", running: { CYC: [], DOC: [] } } }),
  );
  const projects = await screen.findByRole("region", { name: "Projects" });
  await waitFor(() =>
    expect(projects.querySelector('[data-project="CYC"]')?.textContent).toContain("Todo 1"),
  );
  // Two reads in flight at once, answered in the opposite order.
  const waiting: ((answer: LoopBoardAnswer) => void)[] = [];
  bridge.loopBoard = () => new Promise<LoopBoardAnswer>((resolve) => waiting.push(resolve));
  act(() => emit({ type: "loop-runs", runs: { kind: "ok", running: { CYC: ["CYC-386"] } } }));
  act(() =>
    emit({ type: "loop-runs", runs: { kind: "ok", running: { CYC: ["CYC-386", "CYC-388"] } } }),
  );
  await waitFor(() => expect(waiting.length).toBe(2));
  act(() => waiting[1]?.(withTickets({ Todo: [ticket(388, "Todo"), ticket(389, "Todo")] })));
  await waitFor(() =>
    expect(projects.querySelector('[data-project="CYC"]')?.textContent).toContain("Todo 2"),
  );
  act(() => waiting[0]?.(board));
  await new Promise((r) => setTimeout(r, 50));
  expect(projects.querySelector('[data-project="CYC"]')?.textContent).toContain("Todo 2");
});

test("sidebar keeps New/Search/Connectors/Loop at top, shows Kanban and Timeline under matched workspace, and hides them on unmatched workspaces", async () => {
  const fake = await mountLoop(
    {
      loopProjects: { kind: "ok", projects: [cycle, docs] },
      loopBoards: { CYC: board, DOC: board },
      loopTimelines: {
        CYC: {
          kind: "ok",
          project: "CYC",
          entries: [],
          hasMore: false,
          nextBefore: null,
          knownSessionIds: [],
        },
        DOC: {
          kind: "ok",
          project: "DOC",
          entries: [],
          hasMore: false,
          nextBefore: null,
          knownSessionIds: [],
        },
      },
      workspaceRepos: {
        "/work/cycle-v1": "CLAWDOT/CYCLE",
        "/work/plain": null,
      },
    },
    "none",
    {
      configure: (script) => {
        script.bridge.sessions = async () => [
          {
            ...summary("s1"),
            cwd: "/work/cycle-v1",
            title: "Cycle chat",
            updatedAt: "2020-01-03T00:00:00Z",
          },
          {
            ...summary("s2"),
            cwd: "/work/plain",
            title: "Plain chat",
            updatedAt: "2020-01-02T00:00:00Z",
          },
        ];
      },
    },
  );
  const { user } = fake;

  // Top global actions: New, Search, Connectors, Loop; no Sessions/Loop mode switch.
  expect(document.querySelector('[data-slot="mode-switch"]')).toBeNull();
  expect(screen.getByRole("button", { name: "New session" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Search sessions" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Connectors" })).toBeTruthy();
  const loopBtn = screen.getByRole("button", { name: "Loop" });
  expect(document.querySelector('[data-kind="sidebar-toggle"]')).not.toBeNull();
  expect(document.querySelector('[data-kind="account-menu"]')).not.toBeNull();

  // Matched workspace shows Kanban and Timeline above the session list.
  const kanbanBtn = await screen.findByRole("button", { name: "Kanban" });
  const timelineBtn = screen.getByRole("button", { name: "Timeline" });
  expect(screen.getByRole("button", { name: "Show archived" })).toBeTruthy();

  // Clicking Kanban opens the board and marks Kanban current.
  await user.click(kanbanBtn);
  await screen.findByRole("region", { name: "In Progress" });
  expect(kanbanBtn.getAttribute("aria-current")).toBe("page");
  expect(timelineBtn.getAttribute("aria-current")).toBeNull();

  // Clicking Timeline opens the Timeline view with breadcrumbs and a button to Kanban when empty.
  await user.click(timelineBtn);
  expect(await screen.findByText("No Loop activity yet")).toBeTruthy();
  expect(screen.getByRole("navigation", { name: "Where you are" }).textContent).toBe(
    "Cycle/Timeline",
  );
  expect(timelineBtn.getAttribute("aria-current")).toBe("page");
  await user.click(screen.getByRole("button", { name: "Open Kanban" }));
  await screen.findByRole("region", { name: "In Progress" });

  // Clicking top Loop opens Overview and marks Loop current.
  await user.click(loopBtn);
  await screen.findByRole("region", { name: "Projects" });
  expect(loopBtn.getAttribute("aria-current")).toBe("page");

  // Switching to an unmatched workspace hides Kanban & Timeline; switching from Kanban to unmatched leaves Loop.
  await user.click(kanbanBtn);
  await screen.findByRole("region", { name: "In Progress" });
  await user.click(screen.getByRole("button", { name: /Switch workspace/ }));
  await user.click(await screen.findByRole("menuitem", { name: /plain/ }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Kanban" })).toBeNull());
  expect(screen.queryByRole("button", { name: "Timeline" })).toBeNull();
  expect(document.querySelector('[data-kind="loop-board"]')).toBeNull();
});

test("switching between two matched workspaces updates Kanban and Timeline, and Overview syncs workspace", async () => {
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle, docs] },
    loopBoards: {
      CYC: withTickets({ "In Progress": [ticket(386, "In Progress")] }),
      DOC: withTickets({ "In Progress": [ticket(901, "In Progress")] }),
    },
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
    {
      ...summary("s2"),
      cwd: "/work/docs",
      title: "Docs chat",
      updatedAt: "2020-01-02T00:00:00Z",
    },
  ];
  await renderApp(fake.bridge);

  // Open Cycle's Timeline, then switch workspace to Docs -> main switches to Docs Timeline.
  await user.click(await screen.findByRole("button", { name: "Timeline" }));
  expect(screen.getByRole("navigation", { name: "Where you are" }).textContent).toBe(
    "Cycle/Timeline",
  );
  await user.click(screen.getByRole("button", { name: /Switch workspace/ }));
  await user.click(await screen.findByRole("menuitem", { name: /docs/ }));
  await waitFor(() =>
    expect(screen.getByRole("navigation", { name: "Where you are" }).textContent).toBe(
      "Docs/Timeline",
    ),
  );

  // Open Overview and click Cycle -> syncs sidebar workspace back to cycle-v1 and highlights Kanban.
  await user.click(screen.getByRole("button", { name: "Loop" }));
  await openOverviewProject(user, "Cycle");
  await screen.findByRole("region", { name: "Running now" });
  expect(screen.getByRole("button", { name: /Switch workspace/ }).textContent).toContain(
    "cycle-v1",
  );
  expect(screen.getByRole("button", { name: "Console" }).getAttribute("aria-current")).toBe("page");
});

test("a loop-open notification syncs the matched workspace and tracks from notification", async () => {
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle, docs] },
    loopBoards: {
      CYC: board,
      DOC: withTickets({ "In Progress": [ticket(902, "In Progress")] }),
    },
    loopTickets: { "DOC-902": detailOf(ticket(902, "In Progress")) },
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
    {
      ...summary("s2"),
      cwd: "/work/docs",
      title: "Docs chat",
      updatedAt: "2020-01-02T00:00:00Z",
    },
  ];
  await renderApp(fake.bridge);
  await screen.findByRole("button", { name: "Kanban" });

  await act(() => {
    fake.emit({ type: "open-loop-ticket", projectKey: "DOC", identifier: "DOC-902" });
  });
  await screen.findByRole("complementary", { name: "DOC-902" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /Switch workspace/ }).textContent).toContain("docs"),
  );
  expect(tracked(fake.calls)).toContainEqual([
    "loop_project_view_opened",
    { view: "console", from: "notification" },
  ]);
});

test("a remote workspace with the same cwd as a local repo never shows Kanban or Timeline", async () => {
  const remote = {
    id: "ssh-1",
    name: "Box",
    kind: "remote" as const,
    transport: { type: "ssh" as const, host: "box.example" },
  };
  const fake = fakeBridge({
    connected: true,
    locations: [remote],
    states: { "ssh-1": "connected" },
    loopProjects: { kind: "ok", projects: [cycle] },
    workspaceRepos: { "/work/cycle-v1": cycle.repo.displayName },
  });
  fake.bridge.sessions = async (locationId) =>
    locationId === "ssh-1"
      ? [
          {
            ...summary("s1", "ssh-1"),
            cwd: "/work/cycle-v1",
            title: "Remote work",
            updatedAt: "2020-01-04T00:00:00Z",
          },
        ]
      : [];
  await renderApp(fake.bridge);
  await screen.findByRole("option", { name: /Remote work/ });
  expect(screen.queryByRole("button", { name: "Kanban" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Timeline" })).toBeNull();
});

test("the right panel stays mounted but hidden in the Loop view and returns intact", async () => {
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
    ...overviewScript(),
  });
  fake.bridge.sessions = async () => [{ ...summary("s1"), title: "Work" }];
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("option", { name: /Work/ }));
  await user.click(await screen.findByRole("button", { name: "Show panel" }));
  const sidePanel = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-slot="side-panel"]');
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
  expect(sidePanel.hidden).toBe(false);
  await user.click(await screen.findByRole("button", { name: "Loop" }));
  await screen.findByRole("region", { name: "Projects" });
  expect(document.querySelector('[data-slot="side-panel"]')).toBe(sidePanel);
  expect(sidePanel.hidden).toBe(true);
  expect(sidePanel.inert).toBe(true);
  await user.click(screen.getByRole("option", { name: /Work/ }));
  await waitFor(() => expect(sidePanel.hidden).toBe(false));
  expect(document.querySelector('[data-slot="side-panel"]')).toBe(sidePanel);
  expect(sidePanel.inert).toBe(false);
});

test("a focus-session request while Settings is open over the Loop leaves both Settings and the Loop", async () => {
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
    ...overviewScript(),
  });
  fake.bridge.sessions = async () => [{ ...summary("s1"), title: "Work" }];
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Loop" }));
  await screen.findByRole("region", { name: "Projects" });
  await openSettings(user);
  await screen.findByRole("tab", { name: "General" });
  act(() => fake.emit({ type: "focus-session", locationId: "local", sessionId: "s1" }));
  await waitFor(() => {
    expect(screen.queryByRole("tab", { name: "General" })).toBeNull();
    expect(document.querySelector('[data-kind="loop-overview"]')).toBeNull();
  });
  expect(screen.getByRole("button", { name: "Loop" }).getAttribute("aria-current")).toBeNull();
});

test("New session leaves the Loop view", async () => {
  const { user } = await mount(overviewScript());
  await screen.findByRole("region", { name: "Projects" });
  await user.click(screen.getByRole("button", { name: "New session" }));
  await waitFor(() => expect(document.querySelector('[data-kind="loop-overview"]')).toBeNull());
  expect(screen.getByRole("button", { name: "Loop" }).getAttribute("aria-current")).toBeNull();
});

test("the sidebar folds in the Loop and the title bar then has the button to show it, without sideways overflow", async () => {
  const { user } = await mount(overviewScript());
  await screen.findByRole("region", { name: "Projects" });
  await user.click(screen.getByRole("button", { name: "Hide sidebar" }));
  const header = document.querySelector<HTMLElement>('[data-slot="main-header"]');
  expect(header?.querySelector('[data-kind="sidebar-toggle"]')).not.toBeNull();
  const root = document.documentElement;
  expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
  await user.click(within(header as HTMLElement).getByRole("button", { name: "Show sidebar" }));
  expect(screen.getByRole("button", { name: "Loop" })).toBeTruthy();
});

test("Settings opened from the Loop returns to the Loop", async () => {
  const { user } = await mount(overviewScript());
  await screen.findByRole("region", { name: "Projects" });
  await openSettings(user);
  await user.keyboard("{Escape}");
  await screen.findByRole("region", { name: "Projects" });
  expect(screen.getByRole("button", { name: "Loop" }).getAttribute("aria-current")).toBe("page");
});

test("Settings opened while Loop projects are loading stays open when the Projects arrive", async () => {
  const fake = fakeBridge({ connected: true, loopBoards: { CYC: board } });
  let answer: (value: LoopProjectsAnswer) => void = () => {};
  fake.bridge.loopProjects = () =>
    new Promise<LoopProjectsAnswer>((resolve) => {
      answer = resolve;
    });
  await renderApp(fake.bridge);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Loop" }));
  await openSettings(user);
  await screen.findByRole("heading", { name: "General", level: 2 });
  await act(async () => {
    answer({ kind: "ok", projects: [cycle] });
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(screen.getByRole("heading", { name: "General", level: 2 })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: /Back to Loop/ }));
  await screen.findByRole("region", { name: "Projects" });
});

test("a parent card folds a sub-ticket list; children keep their cards and name the parent", async () => {
  const child = (n: number, column: string): LoopTicket => ({
    ...ticket(n, column),
    parent: { identifier: "CYC-381", title: "The Epic" },
  });
  const { user, calls } = await mountBoard({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: {
      CYC: withTickets({
        Todo: [ticket(381, "Todo"), child(390, "Todo")],
        Done: [child(391, "Done")],
      }),
    },
  });
  const todo = await screen.findByRole("region", { name: "Todo" });
  const toggle = within(todo).getByRole("button", { name: /Subtasks/ });
  expect(toggle.textContent).toContain("1/2");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  // The children stay in their own columns, with the parent named on the card.
  expect(within(todo).getByText("Ticket 390")).toBeTruthy();
  expect(within(todo).getByRole("button", { name: "Parent CYC-381" })).toBeTruthy();
  await user.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector('[data-slot="loop-drawer"], [role="dialog"]')).toBeNull();
  const done = document.querySelector<HTMLElement>('[data-slot="loop-subtask"][data-id="CYC-391"]');
  expect(done?.hasAttribute("data-done")).toBe(true);
  expect(done?.textContent).toContain("Ticket 391");
  await user.click(done as HTMLElement);
  await waitFor(() =>
    expect(calls.some(([n, , id]) => n === "loopTicket" && id === "CYC-391")).toBe(true),
  );
});

test("the parent id on a child card opens the parent", async () => {
  const { user, calls } = await mountBoard({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: {
      CYC: withTickets({
        Todo: [{ ...ticket(390, "Todo"), parent: { identifier: "CYC-381", title: "The Epic" } }],
      }),
    },
  });
  await user.click(await screen.findByRole("button", { name: "Parent CYC-381" }));
  await waitFor(() =>
    expect(calls.some(([n, , id]) => n === "loopTicket" && id === "CYC-381")).toBe(true),
  );
});

test("the Loop title and crumbs fade at the end, and the scrolling areas fade at the top", async () => {
  const { user } = await mountBoard({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: board },
  });
  await screen.findByRole("region", { name: "In Progress" });
  const crumbs = document.querySelector<HTMLElement>('[data-slot="loop-crumbs"]') as HTMLElement;
  const crumbsStyle = getComputedStyle(crumbs);
  expect(crumbsStyle.textOverflow).not.toBe("ellipsis");
  expect(crumbsStyle.animationName).toBe("cycle-fade");
  const column = document.querySelector<HTMLElement>(
    '[data-slot="loop-column-body"]',
  ) as HTMLElement;
  expect(getComputedStyle(column).maskImage).toContain("linear-gradient");
  expect(Number.parseFloat(getComputedStyle(column).paddingTop)).toBeGreaterThan(0);
  await user.click(screen.getByRole("button", { name: "Loop" }));
  await screen.findByRole("region", { name: "Projects" });
  const heading = document.querySelector<HTMLElement>('[data-slot="loop-heading"]') as HTMLElement;
  expect(getComputedStyle(heading).textOverflow).not.toBe("ellipsis");
  const body = document.querySelector<HTMLElement>('[data-kind="loop-body"]') as HTMLElement;
  expect(getComputedStyle(body).maskImage).toContain("linear-gradient");
});

const node = (n: number, extra: Partial<LoopGraphNode> = {}): LoopGraphNode => ({
  id: `n${n}`,
  position: n,
  origin: "planned",
  title: `Node ${n}`,
  goal: `Goal ${n}`,
  dependsOn: [],
  filesHint: [],
  verify: [`bun test ${n}`],
  status: "pending",
  sessionId: null,
  commitSha: null,
  rounds: 0,
  lastError: null,
  summary: null,
  startedAt: null,
  finishedAt: null,
  ...extra,
});
const graphOf = (nodes: LoopGraphNode[]): LoopGraph => ({
  runKey: "CYC-610",
  source: "plan_doc",
  revision: 1,
  currentNodeId: "n2",
  nodes,
  createdAt: "2026-11-26T00:00:00Z",
  updatedAt: "2026-11-26T00:00:00Z",
});

test("a card shows passed/total and the current node when it has a graph, and nothing when it has none", async () => {
  const withGraph: LoopTicket = {
    ...ticket(610, "In Progress"),
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
  };
  const plain = ticket(611, "In Progress");
  await mountBoard({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: withTickets({ "In Progress": [withGraph, plain] }) },
  });
  const region = await screen.findByRole("region", { name: "In Progress" });
  const cards = within(region).getAllByRole("listitem");
  const graphCard = cards.find((c) => c.getAttribute("data-id") === "CYC-610");
  const plainCard = cards.find((c) => c.getAttribute("data-id") === "CYC-611");
  expect(within(graphCard as HTMLElement).getByText("1/4")).toBeTruthy();
  expect(within(graphCard as HTMLElement).getByText("Now: Wire the bridge")).toBeTruthy();
  expect(plainCard?.querySelector('[data-slot="loop-graph-progress"]')).toBeNull();
});

const graphTicket = () => {
  const mine = ticket(610, "In Progress");
  const nodes = [
    node(1, { status: "passed", sessionId: "sess-1", summary: "Did the first part" }),
    node(0, { status: "passed" }),
    node(2, {
      status: "blocked",
      sessionId: "sess-2",
      lastError: "tests red",
      origin: "fix",
      rounds: 2,
      commitSha: "abcdef1234567890",
      dependsOn: ["n1"],
      filesHint: ["src/a.ts"],
      startedAt: "2026-11-26T00:00:00Z",
      finishedAt: "2026-11-26T00:05:00Z",
    }),
    node(3, { status: "failed", startedAt: "2026-11-26T00:00:00Z", finishedAt: null }),
    node(4, { status: "running" }),
    node(5, { status: "pending" }),
  ];
  return {
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    workspaceRepos: { "/work": cycle.repo.displayName },
    loopBoards: { CYC: withTickets({ "In Progress": [mine] }) },
    loopTickets: { "CYC-610": detailOf(mine, { graph: graphOf(nodes) }) },
  } satisfies NonNullable<Parameters<typeof fakeBridge>[0]>;
};
const tracked = (calls: [string, ...unknown[]][]) =>
  calls.filter(([name]) => name === "track").map(([, event, props]) => [event, props]);

const openGraphDrawer = async (
  extra: Partial<NonNullable<Parameters<typeof fakeBridge>[0]>> = {},
) => {
  const user = userEvent.setup();
  const fake = fakeBridge({ ...graphTicket(), ...extra });
  fake.bridge.sessions = async () => [{ ...summary("sess-2"), title: "[CYC-610] Node 2" }];
  const store = await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Kanban" }));
  await user.click(await screen.findByRole("button", { name: "Ticket 610" }));
  const drawer = await screen.findByRole("complementary", { name: "CYC-610" });
  await within(drawer).findByRole("heading", { name: "Execution Graph" });
  return { user, fake, store, drawer };
};

test("the drawer lists the graph in order, auto-expands active/stuck nodes, shows metadata, and verifies session jumps", async () => {
  const { user, fake, drawer } = await openGraphDrawer();
  const titles = Array.from(drawer.querySelectorAll('[data-slot="loop-graph-node-title"]')).map(
    (e) => e.textContent,
  );
  expect(titles).toEqual(["Node 0", "Node 1", "Node 2", "Node 3", "Node 4", "Node 5"]);
  // Running, blocked and failed nodes are expanded by default; passed and pending nodes start collapsed.
  expect(within(drawer).getByText("tests red")).toBeTruthy();
  expect(within(drawer).getByText("Goal 2")).toBeTruthy();
  expect(within(drawer).getByText("bun test 2")).toBeTruthy();
  expect(within(drawer).getByText("Fix")).toBeTruthy();
  expect(within(drawer).getByText("Round 2")).toBeTruthy();
  expect(within(drawer).getByText("5 min")).toBeTruthy();
  expect(within(drawer).getByText("abcdef1")).toBeTruthy();
  expect(within(drawer).getByText("src/a.ts")).toBeTruthy();
  const dependsField = drawer.querySelector<HTMLElement>('[data-field="dependsOn"]');
  expect(dependsField?.textContent).toContain("Node 1");
  // Non-running node with null finishedAt must not display a live-ticking duration.
  const failedNode = drawer.querySelector<HTMLElement>(
    '[data-slot="loop-graph-node"][data-id="n3"]',
  );
  expect(failedNode?.querySelector('[data-slot="loop-graph-meta"]')).toBeNull();
  expect(within(drawer).queryByText("Did the first part")).toBeNull();
  expect(within(drawer).queryByText("Goal 5")).toBeNull();

  await user.click(within(drawer).getByRole("button", { name: "Expand node Node 1" }));
  expect(within(drawer).getByText("Did the first part")).toBeTruthy();
  // Only nodes with a session have the entry.
  expect(within(drawer).getAllByRole("button", { name: /^Open the session of node/ })).toHaveLength(
    2,
  );

  // Missing session shows an inline alert instead of navigating to a dead session.
  await user.click(within(drawer).getByRole("button", { name: "Open the session of node Node 1" }));
  expect(
    await within(drawer).findByText(
      "The node's session is not in the list of any connected location.",
    ),
  ).toBeTruthy();

  // Existing session opens through joinLoopSession.
  await user.click(within(drawer).getByRole("button", { name: "Open the session of node Node 2" }));
  await waitFor(() => expect(fake.named("openSession")[0]?.slice(1)).toEqual(["local", "sess-2"]));
  expect(tracked(fake.calls)).toContainEqual([
    "loop_graph_node_opened",
    { status: "blocked", origin: "fix" },
  ]);
  expect(tracked(fake.calls)).toContainEqual([
    "loop_graph_viewed",
    { node_count: 6, source: "plan_doc" },
  ]);
  // No event carries what a node says.
  const sent = JSON.stringify(tracked(fake.calls));
  for (const text of ["Node 2", "Goal 2", "tests red", "Did the first part", "bun test"])
    expect(sent.includes(text)).toBe(false);
});

test("a QA node shows as a QA session with its verdict, and Dev nodes stay as they were", async () => {
  const mine = ticket(610, "In Progress");
  const nodes = [
    node(0, { status: "passed" }),
    node(1, {
      id: "qa-1",
      role: "qa",
      status: "passed",
      verdict: "fail",
      report: "Missing test for X",
      sessionId: "sess-qa",
      commitSha: "1234567890abcdef",
      dependsOn: ["n0"],
    }),
    node(2, { id: "qa-2", role: "qa", status: "passed", verdict: "pass", dependsOn: ["n0"] }),
  ];
  const { drawer } = await openGraphDrawer({
    loopTickets: { "CYC-610": detailOf(mine, { graph: graphOf(nodes) }) },
  });
  const qa1 = drawer.querySelector('[data-slot="loop-graph-node"][data-id="qa-1"]') as HTMLElement;
  expect(within(qa1).getByText("QA session")).toBeTruthy();
  expect(within(qa1).getByText("Rejected")).toBeTruthy();
  const qa2 = drawer.querySelector('[data-slot="loop-graph-node"][data-id="qa-2"]') as HTMLElement;
  expect(within(qa2).getByText("Approved")).toBeTruthy();
  const dev = drawer.querySelector('[data-slot="loop-graph-node"][data-id="n0"]') as HTMLElement;
  expect(dev.querySelector('[data-slot="loop-graph-verdict"]')).toBeNull();
  expect(within(dev).queryByText("QA session")).toBeNull();
});

test("research and design nodes show as their own sessions with the report and no empty verify", async () => {
  const mine = ticket(610, "In Progress");
  const nodes = [
    node(0, {
      id: "r1",
      role: "research",
      status: "passed",
      verify: [],
      summary: "Found it",
      report: "Full research report",
    }),
    node(1, {
      id: "d1",
      role: "design",
      status: "passed",
      verify: [],
      report: "Option A vs B",
      dependsOn: ["r1"],
    }),
  ];
  const { user, drawer } = await openGraphDrawer({
    loopTickets: { "CYC-610": detailOf(mine, { graph: graphOf(nodes) }) },
  });
  const r1 = drawer.querySelector('[data-slot="loop-graph-node"][data-id="r1"]') as HTMLElement;
  expect(within(r1).getByText("Research session")).toBeTruthy();
  const d1 = drawer.querySelector('[data-slot="loop-graph-node"][data-id="d1"]') as HTMLElement;
  expect(within(d1).getByText("Design session")).toBeTruthy();
  await user.click(within(r1).getByRole("button", { name: /^Expand node/ }));
  expect(within(r1).getByText("Full research report")).toBeTruthy();
  expect(r1.querySelector('[data-field="verify"]')).toBeNull();
});

test("only blocked and failed nodes have retry and skip (with confirm), and editable nodes can be edited in place", async () => {
  const { user, fake, drawer } = await openGraphDrawer();
  expect(within(drawer).getAllByRole("button", { name: /^Retry node/ })).toHaveLength(2);
  expect(within(drawer).getAllByRole("button", { name: /^Skip node/ })).toHaveLength(2);
  expect(within(drawer).getAllByRole("button", { name: /^Edit node/ })).toHaveLength(3);
  expect(within(drawer).queryByRole("button", { name: "Retry node Node 1" })).toBeNull();
  expect(within(drawer).queryByRole("button", { name: "Skip node Node 4" })).toBeNull();
  expect(within(drawer).queryByRole("button", { name: "Edit node Node 4" })).toBeNull();
  expect(within(drawer).getByRole("button", { name: "Edit node Node 5" })).toBeTruthy();

  await user.click(within(drawer).getByRole("button", { name: "Retry node Node 2" }));

  // Skip requires destructive confirmation; cancelling sends nothing.
  await user.click(within(drawer).getByRole("button", { name: "Skip node Node 3" }));
  const cancelDialog = await screen.findByRole("alertdialog");
  await user.click(within(cancelDialog).getByRole("button", { name: "Cancel" }));
  expect(fake.calls.filter(([name]) => name === "loopGraphAct")).toHaveLength(1);

  await user.click(within(drawer).getByRole("button", { name: "Skip node Node 3" }));
  const confirmDialog = await screen.findByRole("alertdialog");
  await user.click(within(confirmDialog).getByRole("button", { name: "Skip node" }));

  // Edit opens a FormDialog disabled until a change is made, and submits only changed fields.
  await user.click(within(drawer).getByRole("button", { name: "Edit node Node 2" }));
  const editDialog = await screen.findByRole("dialog", { name: "Edit node" });
  const saveButton = within(editDialog).getByRole("button", { name: "Save node" });
  expect(saveButton.hasAttribute("disabled")).toBe(true);
  const titleInput = within(editDialog).getByLabelText("Title");
  const goalInput = within(editDialog).getByLabelText("Goal");
  const verifyInput = within(editDialog).getByLabelText("Verify");
  await user.clear(titleInput);
  expect(saveButton.hasAttribute("disabled")).toBe(true);
  await user.type(titleInput, "Node 2 revised");
  await user.clear(goalInput);
  await user.type(goalInput, "Fix flaky spec");
  await user.clear(verifyInput);
  await user.type(verifyInput, "bun run check\nbun test");
  await user.click(saveButton);

  await waitFor(() =>
    expect(fake.calls.filter(([name]) => name === "loopGraphAct")).toEqual([
      ["loopGraphAct", "CYC", "CYC-610", "n2", "retry_node"],
      ["loopGraphAct", "CYC", "CYC-610", "n3", "skip_node"],
      [
        "loopGraphAct",
        "CYC",
        "CYC-610",
        "n2",
        "edit_node",
        { title: "Node 2 revised", goal: "Fix flaky spec", verify: ["bun run check", "bun test"] },
      ],
    ]),
  );
});

test("an edit_node refused with invalid_verify stays open and shows the allowlist hint", async () => {
  const { user, drawer } = await openGraphDrawer({
    loopGraphAct: { kind: "failed", reason: "invalid_verify" },
  });
  await user.click(within(drawer).getByRole("button", { name: "Edit node Node 2" }));
  const editDialog = await screen.findByRole("dialog", { name: "Edit node" });
  const verifyInput = within(editDialog).getByLabelText("Verify");
  await user.clear(verifyInput);
  await user.type(verifyInput, "rm -rf /");
  await user.click(within(editDialog).getByRole("button", { name: "Save node" }));
  expect(
    await within(editDialog).findByText(
      "Nothing was changed: one of the verify commands is not on Loop's allowlist.",
    ),
  ).toBeTruthy();
});

test("a pending Backlog ticket can be returned from the drawer with an optional reason, and errors stay inline", async () => {
  const mine: LoopTicket = {
    ...ticket(705, "Backlog"),
    pending: { reason: "Needs approval" },
  };
  const { user, options, ...fake } = await mountLoop(
    {
      loopProjects: { kind: "ok", projects: [cycle] },
      workspaceRepos: { "/work": cycle.repo.displayName },
      loopBoards: { CYC: withTickets({ Backlog: [mine] }) },
      loopTickets: {
        "CYC-705": detailOf(mine, { actions: ["approve", "return"] }),
      },
      loopAct: { kind: "failed", reason: "offline" },
    },
    "none",
  );
  await user.click(await screen.findByRole("button", { name: "Kanban" }));
  await user.click(await screen.findByRole("button", { name: "Ticket 705" }));
  const drawer = await screen.findByRole("complementary", { name: "CYC-705" });
  await user.click(await within(drawer).findByRole("button", { name: "Return CYC-705" }));
  const dialog = await screen.findByRole("dialog", { name: "Return CYC-705?" });
  await user.type(within(dialog).getByLabelText("Reason (optional)"), "Split into two tickets");
  await user.click(within(dialog).getByRole("button", { name: "Return" }));
  expect(await within(dialog).findByRole("alert")).toBeTruthy();
  // Retrying after recovery closes the dialog and submits the same reason.
  options.loopAct = { kind: "ok" };
  await user.click(within(dialog).getByRole("button", { name: "Return" }));
  await waitFor(() =>
    expect(fake.calls.filter(([name]) => name === "loopAct")).toEqual([
      ["loopAct", "CYC", "CYC-705", "return", false, "Split into two tickets"],
      ["loopAct", "CYC", "CYC-705", "return", false, "Split into two tickets"],
    ]),
  );
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Return CYC-705?" })).toBeNull());
});

test("ticket chat shows an agent picker when multiple local agents are available, hides it with one, and forwards the choice", async () => {
  const mine = ticket(388, "Todo");
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    workspaceRepos: { "/work": cycle.repo.displayName },
    loopBoards: { CYC: withTickets({ Todo: [mine] }) },
    loopTickets: { "CYC-388": detailOf(mine, { chat: "new" }) },
    loopChat: { kind: "failed", reason: "offline" },
  });
  fake.bridge.agents = async () => [
    { id: "claude", name: "Claude", available: true, configSchema: {} },
    { id: "codex", name: "Codex", available: true, configSchema: {} },
    { id: "pi", name: "Pi", available: false, configSchema: {} },
  ];
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Kanban" }));
  await user.click(await screen.findByRole("button", { name: "Ticket 388" }));
  const drawer = await screen.findByRole("complementary", { name: "CYC-388" });

  // Default uses automatic agent selection (omitted agent arg) and accessible name includes the selection.
  const picker = await within(drawer).findByRole("button", { name: "Agent: Auto (default)" });
  expect(picker.textContent).toContain("Auto (default)");
  await user.click(within(drawer).getByRole("button", { name: "Talk with an agent CYC-388" }));
  await waitFor(() =>
    expect(fake.calls.filter(([name]) => name === "loopChat")).toEqual([
      ["loopChat", "CYC", "CYC-388"],
    ]),
  );

  // Choosing a specific agent forwards its id, updates the accessible name, and omits unavailable agents.
  await user.click(picker);
  expect(screen.queryByRole("menuitemradio", { name: "Pi" })).toBeNull();
  await user.click(await screen.findByRole("menuitemradio", { name: "Claude" }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(within(drawer).getByRole("button", { name: "Agent: Claude" })).toBeTruthy();
  await user.click(within(drawer).getByRole("button", { name: "Talk with an agent CYC-388" }));
  await waitFor(() =>
    expect(fake.calls.filter(([name]) => name === "loopChat")[1]).toEqual([
      "loopChat",
      "CYC",
      "CYC-388",
      "claude",
    ]),
  );

  // When fewer than 2 local agents are available, the agent picker is hidden.
  cleanup();
  const single = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    workspaceRepos: { "/work": cycle.repo.displayName },
    loopBoards: { CYC: withTickets({ Todo: [mine] }) },
    loopTickets: { "CYC-388": detailOf(mine, { chat: "new" }) },
  });
  await renderApp(single.bridge);
  await user.click(await screen.findByRole("button", { name: "Kanban" }));
  await user.click(await screen.findByRole("button", { name: "Ticket 388" }));
  const singleDrawer = await screen.findByRole("complementary", { name: "CYC-388" });
  await within(singleDrawer).findByRole("button", { name: "Talk with an agent CYC-388" });
  expect(within(singleDrawer).queryByRole("button", { name: /^Agent:/ })).toBeNull();
});

test("a refused retry says why", async () => {
  const user = userEvent.setup();
  const fake = fakeBridge({
    ...graphTicket(),
    loopGraphAct: { kind: "failed", reason: "not_allowed" },
  });
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Kanban" }));
  await user.click(await screen.findByRole("button", { name: "Ticket 610" }));
  const drawer = await screen.findByRole("complementary", { name: "CYC-610" });
  await user.click(await within(drawer).findByRole("button", { name: "Retry node Node 2" }));
  expect(await within(drawer).findByRole("alert")).toBeTruthy();
});

test("an In Progress ticket drawer shows run progress, translated stage, heartbeat, sessions, events and cancel", async () => {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const mine: LoopTicket = {
    ...ticket(900, "In Progress"),
    phase: { name: "graph_plan", since: ago(4) },
  };
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    workspaceRepos: { "/work": cycle.repo.displayName },
    loopBoards: { CYC: withTickets({ "In Progress": [mine] }) },
    loopTickets: { "CYC-900": detailOf(mine, { chat: "watch" }) },
    loopRunDetails: {
      "CYC-900": {
        kind: "ok",
        run: {
          key: "CYC-900",
          title: "Ticket 900",
          kind: "dev",
          phase: "ci",
          state: "active",
          round: 2,
          startedAt: ago(25),
          updatedAt: ago(5),
          blockedReason: null,
          sessions: [
            { kind: "dev", id: "sess-dev" },
            { kind: "qa", id: "sess-qa" },
          ],
          prUrl: "https://example.com/pull/90",
          events: [
            { ts: ago(20), kind: "claimed" },
            { ts: ago(5), kind: "ci_wait" },
          ],
          heartbeat: { at: ago(20), detail: "Waiting for CI checks" },
        },
      },
    },
  });
  fake.bridge.sessions = async () => [{ ...summary("sess-qa"), title: "[CYC-900] QA" }];
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Kanban" }));
  await user.click(await screen.findByRole("button", { name: "Ticket 900" }));
  const drawer = await screen.findByRole("complementary", { name: "CYC-900" });

  // Stage uses translated label for `ci` and displays round, stale heartbeat and workflow steps.
  await within(drawer).findByText(/Waiting on CI · 5 min/);
  expect(within(drawer).getByText("Round 2")).toBeTruthy();
  expect(within(drawer).getByText(/No heartbeat for 20 min/)).toBeTruthy();
  expect(within(drawer).getByText("Waiting for CI checks")).toBeTruthy();
  expect(
    drawer.querySelector('[data-slot="loop-run-step"][data-state="active"]')?.textContent,
  ).toContain("Waiting on CI");

  // Recent events toggle expands to show event kinds.
  await user.click(within(drawer).getByRole("button", { name: "Recent events (2)" }));
  expect(within(drawer).getByText("ci_wait")).toBeTruthy();

  // Cancel turn asks for destructive confirmation before calling loopCancelRun.
  await user.click(within(drawer).getByRole("button", { name: "Cancel turn" }));
  expect(fake.named("loopCancelRun")).toEqual([]);
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Cancel turn" }));
  await waitFor(() =>
    expect(fake.named("loopCancelRun")).toEqual([["loopCancelRun", "CYC", "CYC-900"]]),
  );
  expect(await within(drawer).findByText("Cancelled the current turn.")).toBeTruthy();

  // Clicking a missing session shows an inline alert; clicking an existing session opens it.
  await user.click(within(drawer).getByRole("button", { name: "Dev session" }));
  expect(
    await within(drawer).findByText("That session is not in the list of any connected location."),
  ).toBeTruthy();
  await user.click(within(drawer).getByRole("button", { name: "QA session" }));
  await waitFor(() => expect(fake.named("openSession")[0]?.slice(1)).toEqual(["local", "sess-qa"]));

  // Behaviour-only analytics: `loop_run_viewed` carries no ticket title or heartbeat text.
  expect(tracked(fake.calls)).toContainEqual([
    "loop_run_viewed",
    { kind: "dev", state: "active", sessions: 2 },
  ]);
  const sent = JSON.stringify(tracked(fake.calls));
  expect(sent.includes("Waiting for CI checks")).toBe(false);
  expect(sent.includes("Ticket 900")).toBe(false);
});

test("a Project-level Notice shows no ticket number and opens no ticket", async () => {
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    workspaceRepos: { "/work": cycle.repo.displayName },
    loopBoards: { CYC: board },
    loopNotices: {
      CYC: {
        kind: "ok",
        notices: [
          {
            id: "CYC:notice:1",
            kind: "supervisor",
            identifier: null,
            text: "A new supervisor version is out",
            session: null,
          },
        ],
      },
    },
  });
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Kanban" }));

  await screen.findByText("1 item needs you");
  // The kind says what it is; there is no bare project key standing in for a ticket, and nothing to click.
  const alerts = document.querySelector('[data-slot="loop-board-alerts"]');
  expect(alerts?.querySelector('[data-slot="loop-ticket-id"]')).toBeNull();
  expect(
    within(alerts as HTMLElement).queryByRole("button", { name: /Supervisor note/ }),
  ).toBeNull();
  expect(within(alerts as HTMLElement).getByText("Supervisor note")).toBeTruthy();
  expect(fake.named("loopTicket")).toEqual([]);
});

test("escalated In Review ticket shows review conclusion and marks In review as awaiting review, not Done", async () => {
  const user = userEvent.setup();
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const escalated: LoopTicket = {
    ...ticket(517, "In Review"),
    title: "Codex MCP readable title",
  };
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    workspaceRepos: { "/work": cycle.repo.displayName },
    loopBoards: { CYC: withTickets({ "In Review": [escalated] }) },
    loopTickets: {
      "CYC-517": detailOf(escalated, {
        body: "Escalated ticket body",
        attention: {
          kind: "review",
          text: "Needs human sign-off on scope",
          prUrl: "https://github.com/OhMyJames/cycle/pull/401",
        },
        links: ["https://github.com/OhMyJames/cycle/pull/401"],
      }),
    },
    loopRunDetails: {
      "CYC-517": {
        kind: "ok",
        run: {
          key: "CYC-517",
          title: "Codex MCP readable title",
          kind: "dev",
          phase: "done",
          state: "done",
          round: 0,
          startedAt: ago(30),
          updatedAt: ago(5),
          blockedReason: null,
          sessions: [
            { kind: "dev", id: "sess-dev" },
            { kind: "qa", id: "sess-qa" },
            { kind: "review", id: "sess-rev" },
          ],
          prUrl: "https://github.com/OhMyJames/cycle/pull/401",
          events: [
            { ts: ago(30), kind: "claimed" },
            { ts: ago(5), kind: "delivered" },
          ],
          heartbeat: null,
        },
      },
    },
  });
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Kanban" }));
  await user.click(await screen.findByRole("button", { name: "Codex MCP readable title" }));
  const drawer = await screen.findByRole("complementary", { name: "CYC-517" });

  // Review conclusion card and PR link appear above workflow progress.
  await within(drawer).findByText("Review conclusion");
  expect(within(drawer).getByText("Needs human sign-off on scope")).toBeTruthy();
  expect(
    within(drawer).getAllByRole("link", { name: "https://github.com/OhMyJames/cycle/pull/401" })
      .length,
  ).toBeGreaterThanOrEqual(1);

  // In review is highlighted as `attention` (Awaiting review) with aria-current="step", and Done stays `pending`.
  const steps = [...drawer.querySelectorAll('[data-slot="loop-run-step"]')];
  const byLabel = Object.fromEntries(
    steps.map((el) => [
      el.querySelector('[data-slot="loop-run-step-label"]')?.textContent ?? "",
      el.getAttribute("data-state"),
    ]),
  );
  expect(byLabel).toEqual({
    Developing: "done",
    Verifying: "done",
    QA: "done",
    "Opening PR": "done",
    "Waiting on CI": "done",
    "In review": "attention",
    Done: "pending",
  });
  const reviewStep = steps.find(
    (el) => el.querySelector('[data-slot="loop-run-step-label"]')?.textContent === "In review",
  );
  const doneStep = steps.find(
    (el) => el.querySelector('[data-slot="loop-run-step-label"]')?.textContent === "Done",
  );
  expect(reviewStep?.getAttribute("aria-current")).toBe("step");
  expect(doneStep?.getAttribute("aria-current")).toBeNull();
});

test("board alert strip, sidebar notice badge, intent retry, and loop-activity live refresh work together", async () => {
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    workspaceRepos: { "/work": cycle.repo.displayName },
    loopBoards: { CYC: board },
    loopNotices: {
      CYC: {
        kind: "ok",
        notices: [
          {
            id: "CYC:intent_stuck:1",
            kind: "intent_stuck",
            identifier: "CYC-386",
            text: "write stuck",
            session: null,
          },
          {
            id: "CYC:stuck:CYC-387",
            kind: "stuck",
            identifier: "CYC-387",
            text: "no heartbeat",
            session: null,
          },
        ],
      },
    },
    loopRetryIntents: { kind: "ok", retried: 2 },
  });
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Kanban" }));

  // Board shows the compact alert strip and top Loop action shows the notice badge without breaking its exact button name.
  await screen.findByText("2 items need you");
  const loopBtn = screen.getByRole("button", { name: "Loop" });
  expect(loopBtn.querySelector('[data-slot="loop-nav-badge"]')?.textContent).toBe("2");

  // Retry write calls loopRetryIntents and displays dismissible status.
  await user.click(screen.getByRole("button", { name: "Retry write for CYC-386" }));
  await waitFor(() =>
    expect(fake.named("loopRetryIntents")).toEqual([["loopRetryIntents", "CYC", "CYC-386"]]),
  );
  expect(await screen.findByText("Queued 2 writes to retry.")).toBeTruthy();

  // Clicking a notice chip opens the ticket drawer and tracks `loop_notice_opened`.
  await user.click(screen.getByRole("button", { name: /CYC-387/ }));
  await screen.findByRole("complementary", { name: "CYC-387" });
  expect(tracked(fake.calls)).toContainEqual([
    "loop_notice_opened",
    { kind: "stuck", from: "board" },
  ]);

  // A `loop-activity` event refreshes board and run without re-fetching loopTicket (no `loop_ticket_opened` inflation).
  const boardsBefore = fake.named("loopBoard").length;
  const runsBefore = fake.named("loopRun").length;
  const ticketsBefore = fake.named("loopTicket").length;
  act(() => fake.emit({ type: "loop-activity", projectKeys: ["CYC"] }));
  await waitFor(() => {
    expect(fake.named("loopBoard").length).toBeGreaterThan(boardsBefore);
    expect(fake.named("loopRun").length).toBeGreaterThan(runsBefore);
  });
  expect(fake.named("loopTicket").length).toBe(ticketsBefore);
});

test("CYC-534: Loop sessions stay out of the sidebar session list and appear on the project Timeline with filters, pagination, and one-click return", async () => {
  const nowIso = new Date().toISOString();
  const earlierIso = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const user = userEvent.setup();
  const timelineAnswer = (opts?: { limit?: number; before?: string }) =>
    opts?.before !== undefined
      ? {
          kind: "ok" as const,
          project: "CYC",
          entries: [
            {
              entryKind: "run" as const,
              id: "run:CYC-501",
              key: "CYC-501",
              title: "Older research ticket",
              kind: "research" as const,
              phase: "done",
              state: "done" as const,
              round: 1,
              startedAt: earlierIso,
              updatedAt: earlierIso,
              prUrl: null,
              blockedReason: null,
              graph: null,
              steps: [
                {
                  id: "session:research:sess-res-501",
                  label: "research",
                  role: "research" as const,
                  status: "passed" as const,
                  sessionId: "sess-res-501",
                  startedAt: null,
                  finishedAt: null,
                  summary: null,
                  error: null,
                },
              ],
            },
          ],
          hasMore: false,
          nextBefore: null,
          knownSessionIds: ["sess-legacy-loop", "sess-dev-517", "sess-shape-517", "sess-res-501"],
        }
      : {
          kind: "ok" as const,
          project: "CYC",
          entries: [
            {
              entryKind: "run" as const,
              id: "run:CYC-517",
              key: "CYC-517",
              title: "Implement timeline page",
              kind: "dev" as const,
              phase: "qa",
              state: "active" as const,
              round: 2,
              startedAt: nowIso,
              updatedAt: nowIso,
              prUrl: "https://github.com/clawdot/cycle/pull/390",
              blockedReason: null,
              graph: {
                source: "plan_doc" as const,
                total: 2,
                passed: 1,
                failed: 0,
                blocked: 0,
                running: 1,
                currentNodeId: "n2",
                currentNodeTitle: "Wire UI",
              },
              steps: [
                {
                  id: "node:n1",
                  label: "Protocol schema",
                  role: "dev" as const,
                  status: "passed" as const,
                  sessionId: "sess-dev-517",
                  startedAt: nowIso,
                  finishedAt: nowIso,
                  summary: "Added origin and timeline RPC",
                  error: null,
                },
              ],
            },
            {
              entryKind: "plan" as const,
              id: "plan:2026-11-28T00-00-00-000Z",
              planId: "2026-11-28T00-00-00-000Z",
              phase: "finished" as const,
              state: "done" as const,
              startedAt: nowIso,
              updatedAt: nowIso,
              endedAt: nowIso,
              candidateCount: 3,
              stoppedReason: null,
              triageSessionId: "sess-legacy-loop",
              items: [
                {
                  key: "CYC-517",
                  state: "stopped" as const,
                  round: 1,
                  resultKind: null,
                  splitCount: 0,
                  stoppedReason: "QA found missing test",
                  shapeSessionId: "sess-shape-517",
                  qaSessionId: null,
                },
              ],
            },
          ],
          hasMore: true,
          nextBefore: `${nowIso}|plan:2026-11-28T00-00-00-000Z`,
          knownSessionIds: ["sess-legacy-loop", "sess-dev-517", "sess-shape-517", "sess-res-501"],
        };
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    workspaceRepos: { "/work": cycle.repo.displayName },
    loopBoards: { CYC: withTickets({ "In Progress": [ticket(517, "In Progress")] }) },
    loopTickets: { "CYC-517": detailOf(ticket(517, "In Progress")) },
    loopTimelines: { CYC: timelineAnswer },
  });
  fake.bridge.sessions = async () => [
    { ...summary("human-1"), title: "My own chat", updatedAt: nowIso },
    {
      ...summary("sess-dev-517"),
      title: "[CYC-517] Dev",
      unread: true,
      state: "running",
      updatedAt: nowIso,
      origin: { kind: "loop", project: "CYC", run: "CYC-517", role: "dev" },
    },
    {
      ...summary("sess-legacy-loop"),
      title: "[plan-2026] Triage",
      unread: true,
      updatedAt: nowIso,
    },
  ];

  await renderApp(fake.bridge);
  // Sidebar lists only human-initiated sessions; both origin-stamped and known legacy Loop sessions are hidden.
  await screen.findByRole("option", { name: /My own chat/ });
  await waitFor(() => {
    expect(screen.queryByRole("option", { name: /\[CYC-517\] Dev/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /\[plan-2026\] Triage/ })).toBeNull();
  });

  // Open project Timeline from sidebar.
  await user.click(await screen.findByRole("button", { name: "Timeline" }));
  await screen.findByText("Implement timeline page");
  expect(screen.getByText("Protocol schema")).toBeTruthy();
  expect(screen.getByText("Plan round · 3 checked, 0 shaped")).toBeTruthy();

  // Filter by Needs attention -> shows the plan round with a stopped item, hides active dev run.
  await user.click(screen.getByRole("button", { name: "Needs attention" }));
  expect(screen.queryByText("Implement timeline page")).toBeNull();
  expect(screen.getByText("Plan round · 3 checked, 0 shaped")).toBeTruthy();
  expect(tracked(fake.calls)).toContainEqual([
    "loop_timeline_filtered",
    { status: "attention", kind: "all" },
  ]);

  // Reset filter to All, then load more via pagination.
  await user.click(screen.getByRole("button", { name: "All" }));
  await user.click(screen.getByRole("button", { name: "Show more" }));
  await screen.findByText("Older research ticket");

  // Search narrows to CYC-517.
  const search = screen.getByRole("searchbox", { name: "Filter by ticket or step…" });
  await user.type(search, "CYC-517");
  expect(screen.queryByText("Older research ticket")).toBeNull();
  expect(screen.getByText("Implement timeline page")).toBeTruthy();

  // Clicking a step's session button opens that session in the right panel beside Timeline, without leaving Timeline.
  const openDevBtn = screen.getByRole("button", { name: "Open Protocol schema" });
  await user.click(openDevBtn);
  await waitFor(() =>
    expect(fake.named("openSession").some(([, , sid]) => sid === "sess-dev-517")).toBe(true),
  );
  expect(tracked(fake.calls)).toContainEqual([
    "loop_timeline_session_opened",
    { entry_kind: "run", role: "dev" },
  ]);
  const sessionPanel = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-slot="loop-session-panel"]');
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
  expect(within(sessionPanel).getByRole("heading", { name: "[CYC-517] Dev" })).toBeTruthy();
  expect(screen.getByText("Implement timeline page")).toBeTruthy();
  expect(openDevBtn.hasAttribute("data-active")).toBe(true);

  // Sending a message from the right panel's composer targets the opened Loop session, not the background human session.
  const panelInput = sessionPanel.querySelector<HTMLElement>('[data-slot="composer-input"]');
  expect(panelInput).not.toBeNull();
  await user.click(panelInput as HTMLElement);
  await user.keyboard("Check edge cases{Enter}");
  await waitFor(() =>
    expect(fake.named("prompt").some(([, , sid]) => sid === "sess-dev-517")).toBe(true),
  );
  expect(fake.named("prompt").some(([, , sid]) => sid === "human-1")).toBe(false);

  // Escape closes the right-side session panel while staying on Timeline.
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(document.querySelector('[data-slot="loop-session-panel"]')).toBeNull(),
  );
  expect(screen.getByText("Implement timeline page")).toBeTruthy();

  // Re-opening and clicking Open full session jumps to the full session view with one-click Back to Timeline.
  await user.click(screen.getByRole("button", { name: "Open Protocol schema" }));
  const reopenedPanel = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-slot="loop-session-panel"]');
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
  await user.click(within(reopenedPanel).getByRole("button", { name: "Open full session" }));
  await user.click(await screen.findByRole("button", { name: "Back to Timeline" }));
  await screen.findByText("Implement timeline page");

  // Clicking a ticket key opens the ticket drawer.
  await user.click(screen.getAllByRole("button", { name: "CYC-517" })[0] as HTMLElement);
  await screen.findByRole("complementary", { name: "CYC-517" });
});

test("Timeline right panel switches between sessions and preserves the background session's SidePanel", async () => {
  const nowIso = new Date().toISOString();
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    workspaceRepos: { "/work": cycle.repo.displayName },
    loopTimelines: {
      CYC: {
        kind: "ok",
        project: "CYC",
        entries: [
          {
            entryKind: "run",
            id: "run:CYC-540",
            key: "CYC-540",
            title: "Side-by-side timeline sessions",
            kind: "dev",
            phase: "qa",
            state: "active",
            round: 1,
            startedAt: nowIso,
            updatedAt: nowIso,
            prUrl: null,
            blockedReason: null,
            graph: null,
            steps: [
              {
                id: "session:dev:sess-dev-540",
                label: "dev",
                role: "dev",
                status: "passed",
                sessionId: "sess-dev-540",
                startedAt: nowIso,
                finishedAt: nowIso,
                summary: "Implemented panel",
                error: null,
              },
              {
                id: "session:qa:sess-qa-540",
                label: "qa",
                role: "qa",
                status: "running",
                sessionId: "sess-qa-540",
                startedAt: nowIso,
                finishedAt: null,
                summary: null,
                error: null,
              },
            ],
          },
        ],
        hasMore: false,
        nextBefore: null,
        knownSessionIds: ["sess-dev-540", "sess-qa-540"],
      },
    },
  });
  fake.bridge.sessions = async () => [
    { ...summary("human-1"), title: "My own chat", updatedAt: nowIso },
    {
      ...summary("sess-dev-540"),
      title: "[CYC-540] Dev",
      updatedAt: nowIso,
      origin: { kind: "loop", project: "CYC", run: "CYC-540", role: "dev" },
    },
    {
      ...summary("sess-qa-540"),
      title: "[CYC-540] QA",
      state: "running",
      updatedAt: nowIso,
      origin: { kind: "loop", project: "CYC", run: "CYC-540", role: "qa" },
    },
  ];

  await renderApp(fake.bridge);
  // Open the human session and its right-side SidePanel first.
  await user.click(await screen.findByRole("option", { name: /My own chat/ }));
  await user.click(await screen.findByRole("button", { name: "Show panel" }));
  const humanSidePanel = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-slot="side-panel"]');
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });

  // Switch to Timeline and open Dev session in the right panel.
  await user.click(await screen.findByRole("button", { name: "Timeline" }));
  await screen.findByText("Side-by-side timeline sessions");
  await user.click(screen.getByRole("button", { name: "Open Dev session" }));
  const panel = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-slot="loop-session-panel"]');
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
  expect(within(panel).getByRole("heading", { name: "[CYC-540] Dev" })).toBeTruthy();
  expect(humanSidePanel.hidden).toBe(true);
  expect(humanSidePanel.inert).toBe(true);

  // Switch directly to QA session without closing the panel.
  await user.click(screen.getByRole("button", { name: "Open QA session" }));
  await waitFor(() =>
    expect(within(panel).getByRole("heading", { name: "[CYC-540] QA" })).toBeTruthy(),
  );
  expect(screen.getByRole("button", { name: "Open QA session" }).hasAttribute("data-active")).toBe(
    true,
  );
  expect(screen.getByRole("button", { name: "Open Dev session" }).hasAttribute("data-active")).toBe(
    false,
  );

  // Returning to My own chat brings back the exact same SidePanel DOM node intact.
  await user.click(screen.getByRole("option", { name: /My own chat/ }));
  await waitFor(() => expect(humanSidePanel.hidden).toBe(false));
  expect(document.querySelector('[data-slot="side-panel"]')).toBe(humanSidePanel);
  expect(humanSidePanel.inert).toBe(false);
  expect(document.querySelector('[data-slot="loop-session-panel"]')).toBeNull();
});

test("Timeline right panel shows an error state with Reload instead of looping when openSession fails", async () => {
  const nowIso = new Date().toISOString();
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    workspaceRepos: { "/work": cycle.repo.displayName },
    loopTimelines: {
      CYC: {
        kind: "ok",
        project: "CYC",
        entries: [
          {
            entryKind: "run",
            id: "run:CYC-541",
            key: "CYC-541",
            title: "Retry panel load",
            kind: "dev",
            phase: "dev",
            state: "active",
            round: 1,
            startedAt: nowIso,
            updatedAt: nowIso,
            prUrl: null,
            blockedReason: null,
            graph: null,
            steps: [
              {
                id: "session:dev:sess-fail-541",
                label: "dev",
                role: "dev",
                status: "running",
                sessionId: "sess-fail-541",
                startedAt: nowIso,
                finishedAt: null,
                summary: null,
                error: null,
              },
            ],
          },
        ],
        hasMore: false,
        nextBefore: null,
        knownSessionIds: ["sess-fail-541"],
      },
    },
  });
  fake.bridge.sessions = async () => [
    { ...summary("human-1"), title: "My own chat", updatedAt: nowIso },
    {
      ...summary("sess-fail-541"),
      title: "[CYC-541] Dev",
      updatedAt: nowIso,
      origin: { kind: "loop", project: "CYC", run: "CYC-541", role: "dev" },
    },
  ];
  const baseOpen = fake.bridge.openSession;
  let attempts = 0;
  fake.bridge.openSession = async (locationId, sessionId) => {
    if (sessionId === "sess-fail-541" && attempts++ === 0) {
      throw new Error("daemon busy");
    }
    return baseOpen(locationId, sessionId);
  };

  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Timeline" }));
  await screen.findByText("Retry panel load");
  await user.click(screen.getByRole("button", { name: "Open Dev session" }));

  const panel = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-slot="loop-session-panel"]');
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
  await within(panel).findByText("Could not load the session");
  expect(attempts).toBe(1);

  await user.click(within(panel).getByRole("button", { name: "Read again" }));
  await waitFor(() => expect(within(panel).queryByText("Could not load the session")).toBeNull());
  expect(attempts).toBe(2);
});

test("CYC-534: Timeline shows inline alert when a session is unavailable and renders error state", async () => {
  const nowIso = new Date().toISOString();
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle, docs] },
    workspaceRepos: {
      "/work/cycle": cycle.repo.displayName,
      "/work/docs": docs.repo.displayName,
    },
    loopTimelines: {
      CYC: {
        kind: "ok",
        project: "CYC",
        entries: [
          {
            entryKind: "run",
            id: "run:CYC-520",
            key: "CYC-520",
            title: "Gone session run",
            kind: "dev",
            phase: "dev",
            state: "active",
            round: 1,
            startedAt: nowIso,
            updatedAt: nowIso,
            prUrl: null,
            blockedReason: null,
            graph: null,
            steps: [
              {
                id: "session:dev:missing-session",
                label: "dev",
                role: "dev",
                status: "running",
                sessionId: "missing-session",
                startedAt: null,
                finishedAt: null,
                summary: null,
                error: null,
              },
            ],
          },
        ],
        hasMore: false,
        nextBefore: null,
        knownSessionIds: [],
      },
      DOC: { kind: "unreachable" },
    },
  });
  fake.bridge.sessions = async () => [
    { ...summary("h1"), cwd: "/work/cycle", title: "Cycle chat", updatedAt: nowIso },
    { ...summary("h2"), cwd: "/work/docs", title: "Docs chat", updatedAt: nowIso },
  ];
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Timeline" }));
  await screen.findByText("Gone session run");

  // Opening a missing session shows an inline alert and does not emit loop_timeline_session_opened.
  await user.click(screen.getByRole("button", { name: "Open Dev session" }));
  expect(
    await screen.findByText("That session is not in the list of any connected location."),
  ).toBeTruthy();
  expect(tracked(fake.calls).some(([e]) => e === "loop_timeline_session_opened")).toBe(false);

  // Switching to Docs workspace shows the unreachable error state with retry.
  await user.click(screen.getByRole("button", { name: /Switch workspace/ }));
  await user.click(await screen.findByRole("menuitem", { name: /docs/ }));
  expect(await screen.findByText("Could not load the timeline")).toBeTruthy();
});

test("Timeline: a Task Graph is drawn as a graph, the page scrolls, and the search box keeps its icon inside", async () => {
  const nowIso = new Date().toISOString();
  const user = userEvent.setup();
  const node = (id: string, label: string, dependsOn: string[]) => ({
    id: `node:${id}`,
    label,
    role: "dev" as const,
    status: "passed" as const,
    sessionId: null,
    startedAt: nowIso,
    finishedAt: nowIso,
    summary: `${label} done`,
    error: null,
    dependsOn: dependsOn.map((d) => `node:${d}`),
  });
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    workspaceRepos: { "/work": cycle.repo.displayName },
    loopTimelines: {
      CYC: {
        kind: "ok",
        project: "CYC",
        entries: [
          {
            entryKind: "run",
            id: "run:CYC-527",
            key: "CYC-527",
            title: "Graph run",
            kind: "dev",
            phase: "dev",
            state: "active",
            round: 1,
            startedAt: nowIso,
            updatedAt: nowIso,
            prUrl: null,
            blockedReason: null,
            graph: null,
            steps: [
              node("n1", "Schema", []),
              node("n2", "Store", ["n1"]),
              node("n3", "Tests", ["n1"]),
              node("n4", "Docs", ["n2", "n3"]),
            ],
          },
        ],
        hasMore: false,
        nextBefore: null,
        knownSessionIds: [],
      },
    },
  });
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Timeline" }));
  await screen.findByText("Graph run");

  // Four nodes in three columns, one arrow per dependency.
  const graph = await screen.findByRole("list", { name: "Task graph" });
  expect(within(graph).getAllByRole("listitem")).toHaveLength(4);
  expect(graph.parentElement?.querySelectorAll('[data-slot="loop-dag-edge"]')).toHaveLength(4);
  // The state is in words as well as in the colour of the dot.
  expect(within(graph).getAllByText(/\(Passed\)/)).toHaveLength(4);
  expect(within(graph).getAllByText(/Waits for: Store, Tests\./)).toHaveLength(1);
  const left = (name: string) =>
    Number.parseFloat(within(graph).getByText(name).closest("li")?.style.left ?? "NaN");
  expect(left("Schema")).toBeLessThan(left("Store"));
  expect(left("Store")).toBe(left("Tests"));
  expect(left("Tests")).toBeLessThan(left("Docs"));

  // The search icon is inside the field, on the same line as the input.
  const field = document.querySelector('[data-slot="search-field"]') as HTMLElement;
  const icon = field.querySelector("svg") as SVGElement;
  const input = field.querySelector("input") as HTMLInputElement;
  expect(icon.getBoundingClientRect().top).toBeLessThan(input.getBoundingClientRect().bottom);
  expect(icon.getBoundingClientRect().bottom).toBeGreaterThan(input.getBoundingClientRect().top);
  expect(icon.getBoundingClientRect().right).toBeLessThanOrEqual(
    input.getBoundingClientRect().left + 1,
  );

  // The page body scrolls as a whole instead of clipping what does not fit.
  const body = document.querySelector('[data-slot="page-body"]') as HTMLElement;
  expect(body.hasAttribute("data-full")).toBe(false);
  expect(getComputedStyle(body).overflowY).toBe("auto");
});
