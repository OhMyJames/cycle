import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import type {
  LoopBoardAnswer,
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

const mount = async (script: NonNullable<Parameters<typeof fakeBridge>[0]>) => {
  // `options` stays live: a test can change what the bridge answers later.
  const options = { connected: true, ...script };
  const fake = fakeBridge(options);
  await renderApp(fake.bridge);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Loop" }));
  return { user, options, ...fake };
};

test("the Loop page shows a full-width board as a row of columns, with Done open at the end", async () => {
  const { user, calls } = await mount({
    loopProjects: { kind: "ok", projects: [cycle, docs] },
    loopBoards: { CYC: board },
  });
  await user.click(await screen.findByRole("button", { name: "Cycle Kanban" }));
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

test("with the Loop server away, the Projects it had are greyed out and the page says so", async () => {
  const options: Parameters<typeof fakeBridge>[0] = {
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: board },
  };
  const fake = fakeBridge(options);
  const store = await renderApp(fake.bridge);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Loop" }));
  const tab = await screen.findByRole("button", { name: "Cycle Kanban" });
  expect(tab.hasAttribute("disabled") || tab.getAttribute("aria-disabled") === "true").toBe(false);
  // The server goes away: the next read says so, and the Project stays listed, greyed, with the reason.
  options.loopProjects = { kind: "disconnected" };
  await act(() => store.loadLoopProjects());
  const grey = await screen.findByRole("button", { name: "Cycle Kanban" });
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
  await mount({
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
  await user.click(await screen.findByRole("button", { name: "Cycle Kanban" }));
  expect(await screen.findByText("Data may be out of date")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Docs Kanban" }));
  await screen.findByRole("region", { name: "In Progress" });
  expect(screen.queryByText("Data may be out of date")).toBeNull();
});

test("leaving the Loop and coming back lands on the level it was left on", async () => {
  const { user } = await mount({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: board },
  });
  await screen.findByRole("region", { name: "In Progress" });
  // Overview, then out of the Loop (Sessions) and back in: Escape does not leave the Loop.
  await user.click(screen.getByRole("button", { name: "Overview" }));
  await screen.findByRole("region", { name: "Projects" });
  await user.keyboard("{Escape}");
  expect(document.querySelector('[data-kind="loop-overview"]')).not.toBeNull();
  await user.click(screen.getByRole("button", { name: "Sessions" }));
  await waitFor(() => expect(document.querySelector('[data-kind="loop-overview"]')).toBeNull());
  await user.click(await screen.findByRole("button", { name: "Loop" }));
  await screen.findByRole("region", { name: "Projects" });
});

test("the Backlog opens on 20 tickets and shows more when asked", async () => {
  const many = Array.from({ length: 45 }, (_, i) => ticket(500 + i, "Backlog"));
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: withTickets({ Backlog: many }) },
  });
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Loop" }));
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
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: withTickets({ "In Progress": [doing], Backlog: [backlog] }) },
    loopTickets: { "CYC-600": detailOf(backlog, { actions: ["approve", "to_todo"], chat: "new" }) },
    loopAct: { kind: "failed", reason: "forbidden" },
  });
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Loop" }));
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
  expect(fake.calls.some(([name]) => name === "loopAct")).toBe(false);
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Approve" }));
  expect(await within(dialog).findByText(/did not accept this from Loop/)).toBeTruthy();
  expect(fake.calls.filter(([name]) => name === "loopAct")).toEqual([
    ["loopAct", "CYC", "CYC-600", "approve", true],
  ]);
});

test("a failed Back to Backlog in the ticket drawer is said there, and gone after closing", async () => {
  const mine = ticket(602, "In Review");
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
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
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Loop" }));
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
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: {
      CYC: withTickets({
        Backlog: chat === "new" ? [mine] : [],
        "In Progress": chat === "new" ? [] : [mine],
      }),
    },
    loopTickets: { "CYC-700": detailOf(mine, { chat, acceptance: [] }) },
    ...script,
  });
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Loop" }));
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

test("Escape on the ticket drawer closes the drawer, not the board", async () => {
  const { user } = await openTicketDrawer("new");
  await screen.findByRole("complementary", { name: "CYC-700" });
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("complementary", { name: "CYC-700" })).toBeNull());
  expect(document.querySelector('[data-kind="loop-board"]')).not.toBeNull();
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

test("leaving the Loop from a ticket drawer and coming back lands on the level it was left on", async () => {
  const { user } = await openTicketDrawer("new");
  await screen.findByRole("complementary", { name: "CYC-700" });
  // Ticket drawer → board by Escape; the board stays, out of the Loop by Sessions, and back on the board.
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("complementary", { name: "CYC-700" })).toBeNull());
  await user.keyboard("{Escape}");
  expect(document.querySelector('[data-kind="loop-board"]')).not.toBeNull();
  await user.click(screen.getByRole("button", { name: "Sessions" }));
  await waitFor(() => expect(document.querySelector('[data-kind="loop-board"]')).toBeNull());
  await user.click(await screen.findByRole("button", { name: "Loop" }));
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
  // A row opens its board.
  await user.click(within(cycleRow).getByRole("button", { name: /Cycle/ }));
  await screen.findByRole("region", { name: "In Progress" });
});

test("with one Project the Loop lands on its board, and Overview in the sidebar goes up", async () => {
  const { user } = await mount({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: board },
  });
  await screen.findByRole("region", { name: "In Progress" });
  await user.click(screen.getByRole("button", { name: "Overview" }));
  await screen.findByRole("region", { name: "Projects" });
});

test("Needs you is on the overview, not on the board, and absent when empty", async () => {
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
  const notices = await screen.findByRole("region", { name: "Needs you" });
  expect(within(notices).getByText("CYC-9")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Cycle Kanban" }));
  await screen.findByRole("region", { name: "In Progress" });
  expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
});

test("with nothing that needs a person, the section is not there", async () => {
  await mount(overviewScript({ loopNotices: { CYC: { kind: "ok", notices: [] } } }));
  await screen.findByRole("region", { name: "Projects" });
  expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
});

test("a Project opens on its board with clean breadcrumbs leading back to Overview", async () => {
  const { user } = await mount({
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
  const { user } = await mount({
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

test("the board shows the columns by name, with Done last, the rest in the order they come", async () => {
  await mount({ loopProjects: { kind: "ok", projects: [cycle] }, loopBoards: { CYC: board } });
  await screen.findByRole("region", { name: "In Review" });
  const names = [...document.querySelectorAll('[data-slot="loop-column"]')].map((e) =>
    e.getAttribute("aria-label"),
  );
  expect(names).toEqual(["Backlog", "Todo", "In Progress", "In Review", "Blocked", "Done"]);
});

test("the board is a row of columns: cards are not draggable, there is no move menu, and Done is open with its card", async () => {
  await mount({ loopProjects: { kind: "ok", projects: [cycle] }, loopBoards: { CYC: board } });
  await screen.findByRole("region", { name: "In Review" });
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
  const { user, calls } = await mount({
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
  await mount({ loopProjects: { kind: "ok", projects: [cycle] }, loopBoards: { CYC: board } });
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
  await mount({ loopProjects: { kind: "ok", projects: [cycle] }, loopBoards: { CYC: board } });
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
  await mount({
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
    loopBoards: { CYC: board },
  });
  const never = new Promise<LoopBoardAnswer>(() => {});
  fake.bridge.loopBoard = () => never;
  await renderApp(fake.bridge);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Loop" }));
  await waitFor(() =>
    expect(document.querySelectorAll('[data-slot="loop-column"][data-skeleton]').length).toBe(3),
  );
  expect(document.querySelectorAll('[data-slot="loop-ticket"][data-skeleton]').length).toBe(9);
});

test("a short title is not clipped or masked", async () => {
  await mount({ loopProjects: { kind: "ok", projects: [cycle] }, loopBoards: { CYC: board } });
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
  const { user } = await mount({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: {
      CYC: withTickets({
        "In Progress": [staged(1, "qa", 3), staged(2, "dev", 72), ticket(3, "In Progress")],
        "In Review": [ticket(4, "In Review")],
      }),
    },
  });
  await user.click(await screen.findByRole("button", { name: "Cycle Kanban" }));
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

test("awaiting-approval cards sit at the top of Backlog with a badge, quick approve, and floating batch bar", async () => {
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
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
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Loop" }));
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
  // Floating selection bar is hidden until at least one pending card is picked.
  expect(screen.queryByRole("region", { name: "Awaiting approval" })).toBeNull();

  await user.click(within(backlog).getByRole("checkbox", { name: "Select all" }));
  const bar = await screen.findByRole("region", { name: "Awaiting approval" });
  await user.click(within(bar).getByRole("button", { name: "Approve selected" }));
  expect(fake.calls.some(([name]) => name === "loopActMany")).toBe(false);
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog.textContent).toContain("CYC-702 Ticket 702");
  expect(dialog.textContent).toContain("CYC-701 Ticket 701");
  await user.click(within(dialog).getByRole("button", { name: "Approve selected" }));
  expect(await screen.findByText(/1 succeeded, 1 skipped, 0 failed/)).toBeTruthy();
  expect(fake.calls.filter(([name]) => name === "loopActMany")).toEqual([
    ["loopActMany", "CYC", "approve_many", ["CYC-702", "CYC-701"], true, undefined],
  ]);

  // Return: one ticket, with a reason; no second confirmation.
  await user.click(within(backlog).getByRole("checkbox", { name: "Select CYC-701" }));
  const bar2 = await screen.findByRole("region", { name: "Awaiting approval" });
  await user.type(within(bar2).getByRole("textbox"), "not now");
  await user.click(within(bar2).getByRole("button", { name: "Return selected" }));
  await waitFor(() =>
    expect(fake.calls.filter(([name]) => name === "loopActMany")[1]).toEqual([
      "loopActMany",
      "CYC",
      "return_many",
      ["CYC-701"],
      true,
      "not now",
    ]),
  );
});

const withPriority = (n: number, column: string, priority: string | null): LoopTicket => ({
  ...ticket(n, column),
  priority,
});

test("open columns sort by priority (stable), Backlog keeps pending first, Done keeps server order", async () => {
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
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
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Loop" }));
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
  await mount({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: withTickets({ Backlog: [ticket(710, "Backlog")] }) },
  });
  await screen.findByRole("region", { name: "Backlog" });
  expect(screen.queryByText("Awaiting approval")).toBeNull();
});

test("search and awaiting-approval filter chip narrow visible cards and can be cleared", async () => {
  const { user } = await mount({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: {
      CYC: withTickets({
        Backlog: [waiting(701, "urgent", "Ready"), ticket(702, "Backlog")],
        Todo: [ticket(703, "Todo")],
      }),
    },
  });
  await screen.findByRole("region", { name: "Backlog" });
  await user.click(screen.getByRole("button", { name: /Awaiting approval/ }));
  expect(screen.getByText("Ticket 701")).toBeTruthy();
  expect(screen.queryByText("Ticket 702")).toBeNull();
  expect(screen.queryByText("Ticket 703")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(screen.getByText("Ticket 703")).toBeTruthy();

  await user.type(screen.getByRole("searchbox", { name: "Search tickets" }), "703");
  expect(screen.getByText("Ticket 703")).toBeTruthy();
  expect(screen.queryByText("Ticket 701")).toBeNull();
});

test("a batch return that fails is said on the board, and the picks stay", async () => {
  const { user, calls } = await mount({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: withTickets({ Backlog: [waiting(720, "high", "Why")] }) },
    loopActMany: { kind: "failed", reason: "offline" },
  });
  const backlog = await screen.findByRole("region", { name: "Backlog" });
  await user.click(within(backlog).getByRole("checkbox", { name: "Select CYC-720" }));
  const bar = await screen.findByRole("region", { name: "Awaiting approval" });
  await user.click(within(bar).getByRole("button", { name: "Return selected" }));
  expect(await screen.findByText(/could not be reached/)).toBeTruthy();
  expect(calls.filter(([name]) => name === "loopActMany")).toHaveLength(1);
  expect(
    (within(backlog).getByRole("checkbox", { name: "Select CYC-720" }) as HTMLInputElement).checked,
  ).toBe(true);
});

test("a Backlog of only waiting tickets does not say it is empty", async () => {
  await mount({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: withTickets({ Backlog: [waiting(730, "high", "Why")] }) },
  });
  const column = await screen.findByRole("region", { name: "Backlog" });
  expect(within(column).queryByText("Nothing here")).toBeNull();
});

test("the counts of a batch stay when the reloaded board has nothing waiting any more", async () => {
  const user = userEvent.setup();
  const before = withTickets({ Backlog: [waiting(740, "high", "Why")] });
  const after = withTickets({ Backlog: [ticket(741, "Backlog")] });
  // The board changes once the batch has been asked for.
  let asked: () => boolean = () => false;
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: {
      get CYC() {
        return asked() ? after : before;
      },
    },
  });
  asked = () => fake.calls.some(([name]) => name === "loopActMany");
  const bridge = fake.bridge;
  await renderApp(bridge);
  await user.click(await screen.findByRole("button", { name: "Loop" }));
  const backlog = await screen.findByRole("region", { name: "Backlog" });
  await user.click(within(backlog).getByRole("checkbox", { name: "Select all" }));
  const bar = await screen.findByRole("region", { name: "Awaiting approval" });
  await user.click(within(bar).getByRole("button", { name: "Return selected" }));
  expect(await screen.findByText(/1 succeeded, 0 skipped, 0 failed/)).toBeTruthy();
  expect(screen.queryByRole("checkbox", { name: "Select all" })).toBeNull();
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
const detailOf = (
  base: LoopTicket,
  extra: Partial<LoopTicketDetail> = {},
): { kind: "ok"; ticket: LoopTicketDetail } => ({
  kind: "ok",
  ticket: {
    ...base,
    actions: [],
    chat: "none",
    body: "text",
    acceptance: ["one"],
    links: [],
    ...extra,
  },
});

test("Approve in the ticket drawer asks first; only the confirmation writes, and a failure is said", async () => {
  const backlog = ticket(600, "Backlog");
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: withTickets({ Backlog: [backlog] }) },
    loopTickets: { "CYC-600": detailOf(backlog, { actions: ["approve", "to_todo"], chat: "new" }) },
    loopAct: { kind: "failed", reason: "forbidden" },
  });
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Loop" }));
  await user.click(await screen.findByRole("button", { name: "Ticket 600" }));
  await user.click(await screen.findByRole("button", { name: "Approve CYC-600" }));
  expect(fake.calls.some(([name]) => name === "loopAct")).toBe(false);
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Approve" }));
  expect(await within(dialog).findByText(/did not accept this from Loop/)).toBeTruthy();
  expect(fake.calls.filter(([name]) => name === "loopAct")).toEqual([
    ["loopAct", "CYC", "CYC-600", "approve", true],
  ]);
});

test("cancelling Approve writes nothing; a ticket with no buttons shows none", async () => {
  const backlog = ticket(600, "Backlog");
  const doing = ticket(601, "In Progress");
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: withTickets({ Backlog: [backlog], "In Progress": [doing] }) },
    loopTickets: {
      "CYC-600": detailOf(backlog, { actions: ["approve"] }),
      "CYC-601": detailOf(doing),
    },
  });
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Loop" }));
  await user.click(await screen.findByRole("button", { name: "Ticket 600" }));
  await user.click(await screen.findByRole("button", { name: "Approve CYC-600" }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }),
  );
  expect(fake.calls.some(([name]) => name === "loopAct")).toBe(false);
  await user.click(screen.getByRole("button", { name: /Close ticket/ }));
  await user.click(await screen.findByRole("button", { name: "Ticket 601" }));
  await screen.findByText("text");
  expect(screen.queryByRole("button", { name: /Approve|Back to Backlog|Back to Todo/ })).toBeNull();
});

test("a state button that works reads the board again", async () => {
  const mine = ticket(603, "Todo");
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: withTickets({ Todo: [mine] }) },
    loopTickets: { "CYC-603": detailOf(mine, { actions: ["to_backlog"] }) },
  });
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Loop" }));
  await user.click(await screen.findByRole("button", { name: "Ticket 603" }));
  const reads = () => fake.named("loopBoard").length;
  const before = reads();
  await user.click(await screen.findByRole("button", { name: "Back to Backlog CYC-603" }));
  await waitFor(() => expect(reads()).toBeGreaterThan(before));
  expect(fake.named("loopAct")).toEqual([["loopAct", "CYC", "CYC-603", "to_backlog", false]]);
});

test("a ticket drawer shows the text, the criteria, why it needs a person, and joins its session", async () => {
  const mine = ticket(710, "Blocked");
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
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
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Loop" }));
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
  await user.click(screen.getByRole("button", { name: "Sessions" }));
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
  await user.click(await screen.findByRole("button", { name: "Cycle Kanban" }));
  await screen.findByRole("region", { name: "In Progress" });
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

test("the Loop keeps the sidebar's frame: Sessions and Loop side by side, the account menu, the fold button", async () => {
  const { user } = await mount(overviewScript());
  await screen.findByRole("region", { name: "Projects" });
  const sessions = screen.getByRole("button", { name: "Sessions" });
  const loop = screen.getByRole("button", { name: "Loop" });
  expect(loop.getAttribute("aria-pressed")).toBe("true");
  expect(sessions.getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByRole("navigation", { name: "Loop" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Loop navigation" })).toBeTruthy();
  expect(document.querySelector('[data-kind="sidebar-toggle"]')).not.toBeNull();
  expect(document.querySelector('[data-kind="account-menu"]')).not.toBeNull();
  expect(screen.getByRole("button", { name: "New session" })).toBeTruthy();
  // The lower half is the Loop's: Overview and each Project's Kanban, not the sessions' list.
  expect(screen.getByRole("button", { name: "Overview" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Show archived" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Cycle Kanban" }));
  await screen.findByRole("region", { name: "In Progress" });
  expect(screen.getByRole("button", { name: "Cycle Kanban" }).getAttribute("aria-current")).toBe(
    "page",
  );
  // Sessions brings the list back.
  await user.click(sessions);
  expect(await screen.findByRole("button", { name: "Show archived" })).toBeTruthy();
  expect(screen.getByRole("navigation", { name: "Sessions" })).toBeTruthy();
  expect(sessions.getAttribute("aria-pressed")).toBe("true");
});

test("the right panel stays mounted but hidden in the Loop mode and returns intact", async () => {
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
  await user.click(screen.getByRole("button", { name: "Sessions" }));
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
  expect(screen.getByRole("button", { name: "Sessions" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
});

test("New session leaves the Loop mode", async () => {
  const { user } = await mount(overviewScript());
  await screen.findByRole("region", { name: "Projects" });
  await user.click(screen.getByRole("button", { name: "New session" }));
  await waitFor(() => expect(document.querySelector('[data-kind="loop-overview"]')).toBeNull());
  expect(screen.getByRole("button", { name: "Sessions" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
});

test("the sidebar folds in the Loop and the title bar then has the button to show it, without sideways overflow", async () => {
  const { user } = await mount(overviewScript());
  await screen.findByRole("region", { name: "Projects" });
  await user.click(screen.getByRole("button", { name: "Hide sidebar" }));
  const header = document.querySelector<HTMLElement>('[data-kind="loop-header"]');
  expect(header?.querySelector('[data-kind="sidebar-toggle"]')).not.toBeNull();
  const root = document.documentElement;
  expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
  await user.click(within(header as HTMLElement).getByRole("button", { name: "Show sidebar" }));
  expect(screen.getByRole("button", { name: "Overview" })).toBeTruthy();
});

test("Settings opened from the Loop returns to the Loop", async () => {
  const { user } = await mount(overviewScript());
  await screen.findByRole("region", { name: "Projects" });
  await openSettings(user);
  await user.keyboard("{Escape}");
  await screen.findByRole("region", { name: "Projects" });
  expect(screen.getByRole("button", { name: "Loop" }).getAttribute("aria-pressed")).toBe("true");
});

test("a parent card folds a sub-ticket list; children keep their cards and name the parent", async () => {
  const child = (n: number, column: string): LoopTicket => ({
    ...ticket(n, column),
    parent: { identifier: "CYC-381", title: "The Epic" },
  });
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: {
      CYC: withTickets({
        Todo: [ticket(381, "Todo"), child(390, "Todo")],
        Done: [child(391, "Done")],
      }),
    },
  });
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Loop" }));
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
    expect(fake.calls.some(([n, , id]) => n === "loopTicket" && id === "CYC-391")).toBe(true),
  );
});

test("the parent id on a child card opens the parent", async () => {
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: {
      CYC: withTickets({
        Todo: [{ ...ticket(390, "Todo"), parent: { identifier: "CYC-381", title: "The Epic" } }],
      }),
    },
  });
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Loop" }));
  await user.click(await screen.findByRole("button", { name: "Parent CYC-381" }));
  await waitFor(() =>
    expect(fake.calls.some(([n, , id]) => n === "loopTicket" && id === "CYC-381")).toBe(true),
  );
});

test("the Loop title and crumbs fade at the end, and the scrolling areas fade at the top", async () => {
  const { user } = await mount({
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
  await user.click(screen.getByRole("button", { name: "Overview" }));
  await screen.findByRole("region", { name: "Projects" });
  const heading = document.querySelector<HTMLElement>('[data-slot="loop-heading"]') as HTMLElement;
  expect(getComputedStyle(heading).textOverflow).not.toBe("ellipsis");
  const body = document.querySelector<HTMLElement>('[data-kind="loop-body"]') as HTMLElement;
  expect(getComputedStyle(body).maskImage).toContain("linear-gradient");
});
