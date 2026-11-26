import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { LoopBoardAnswer, LoopProjectInfo, LoopTicket } from "../../src/api.ts";
import { fakeBridge } from "../fake-bridge.ts";
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
  actions: [],
  chat: "none",
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
  columns: (board.kind === "ok" ? board.columns : []).map((c) => ({
    ...c,
    tickets: tickets[c.name] ?? c.tickets,
  })),
});

const mount = async (script: Parameters<typeof fakeBridge>[0]) => {
  const fake = fakeBridge({ connected: true, ...script });
  await renderApp(fake.bridge);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Loop" }));
  return { user, ...fake };
};

test("the Loop page shows a Project's board as a row of columns, with Done collapsed", async () => {
  const { user, calls } = await mount({
    loopProjects: { kind: "ok", projects: [cycle, docs] },
    loopBoards: { CYC: board },
  });
  await user.click(await screen.findByRole("tab", { name: /Cycle/ }));
  const text = (name: string) =>
    within(screen.getByRole("region", { name }))
      .getAllByRole("listitem")
      .map((li) => li.textContent);
  await screen.findByRole("region", { name: "In Progress" });
  expect(text("In Progress")).toEqual(["CYC-386highTicket 386"]);
  expect(text("In Review")).toEqual(["CYC-387highTicket 387"]);
  expect(
    within(screen.getByRole("region", { name: "Todo" })).getAllByRole("listitem"),
  ).toHaveLength(1);
  expect(
    within(screen.getByRole("region", { name: "Backlog" })).getByText("Nothing here"),
  ).toBeTruthy();
  // Done is collapsed until asked for.
  expect(screen.queryByText("Ticket 300")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Show done" }));
  expect(await screen.findByText("Ticket 300")).toBeTruthy();
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
  const tab = await screen.findByRole("tab", { name: /Cycle/ });
  expect(tab.hasAttribute("disabled") || tab.getAttribute("aria-disabled") === "true").toBe(false);
  // The server goes away: the next read says so, and the Project stays listed, greyed, with the reason.
  options.loopProjects = { kind: "disconnected" };
  await act(() => store.loadLoopProjects());
  const grey = await screen.findByRole("tab", { name: /Cycle/ });
  expect(grey.hasAttribute("disabled") || grey.getAttribute("aria-disabled") === "true").toBe(true);
  expect(within(grey).getByText("Offline")).toBeTruthy();
  expect(await screen.findByText("The Loop server is not running")).toBeTruthy();
});

test("with no server ever seen, the page says it is not running and offers to read again", async () => {
  await mount({});
  expect(await screen.findByText("The Loop server is not running")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Read again" })).toBeTruthy();
});

test("with no key file, the board says how to give one", async () => {
  await mount({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: { kind: "no_key" } },
  });
  expect(await screen.findByText("No itsaplan key")).toBeTruthy();
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
  const backlog = {
    ...ticket(600, "Backlog"),
    actions: ["approve" as const],
    chat: "new" as const,
  };
  const doing = ticket(601, "In Progress");
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: withTickets({ "In Progress": [doing], Backlog: [backlog] }) },
    loopAct: { kind: "failed", reason: "forbidden" },
  });
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Loop" }));
  const column = await screen.findByRole("region", { name: "Backlog" });
  // Loop's own ticket in Doing has no buttons.
  expect(
    within(screen.getByRole("region", { name: "In Progress" })).queryByRole("button", {
      name: /Approve|Back to/,
    }),
  ).toBeNull();
  await user.click(within(column).getByRole("button", { name: "Approve CYC-600" }));
  expect(fake.calls.some(([name]) => name === "loopAct")).toBe(false);
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Approve" }));
  expect(await within(dialog).findByText(/did not accept your key/)).toBeTruthy();
  expect(fake.calls.filter(([name]) => name === "loopAct")).toEqual([
    ["loopAct", "CYC", "CYC-600", "approve", true],
  ]);
});

test("a failed Back to Backlog on the ticket page is said there, and gone after going back", async () => {
  const mine = {
    ...ticket(602, "In Review"),
    actions: ["to_backlog" as const, "to_todo" as const],
    chat: "none" as const,
  };
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: withTickets({ "In Progress": [mine] }) },
    loopTickets: {
      "CYC-602": {
        kind: "ok",
        ticket: { ...mine, body: "text", acceptance: ["one"], links: [] },
      },
    },
    loopAct: { kind: "failed", reason: "offline" },
  });
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Loop" }));
  await user.click(await screen.findByRole("button", { name: "Ticket 602" }));
  await user.click(await screen.findByRole("button", { name: "Back to Backlog CYC-602" }));
  const problem = () => document.querySelector('[data-slot="loop-problem"]');
  await screen.findByText(/could not be reached/);
  expect(problem()?.textContent).toMatch(/could not be reached/);
  await user.click(screen.getByRole("button", { name: "Back to the board" }));
  expect(problem()).toBeNull();
});

const openTicketPage = async (
  chat: "new" | "watch",
  script: Parameters<typeof fakeBridge>[0] = {},
) => {
  const mine = { ...ticket(700, chat === "new" ? "Backlog" : "In Progress"), chat };
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
    loopTickets: {
      "CYC-700": { kind: "ok", ticket: { ...mine, body: "text", acceptance: [], links: [] } },
    },
    ...script,
  });
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Loop" }));
  await user.click(await screen.findByRole("button", { name: "Ticket 700" }));
  return { user, fake };
};

test("a Backlog ticket's page has the chat button: it asks main and opens the session", async () => {
  const { user, fake } = await openTicketPage("new");
  await user.click(await screen.findByRole("button", { name: "Talk with an agent CYC-700" }));
  await waitFor(() => expect(fake.named("loopChat")).toEqual([["loopChat", "CYC", "CYC-700"]]));
  await waitFor(() => expect(fake.named("openSession").length).toBeGreaterThan(0));
  expect(fake.named("openSession")[0]?.slice(1)).toEqual(["local", "chat-1"]);
});

test("with no default model the page says to set one in Settings", async () => {
  const { user } = await openTicketPage("new", {
    loopChat: { kind: "failed", reason: "needs_model" },
  });
  await user.click(await screen.findByRole("button", { name: "Talk with an agent CYC-700" }));
  expect(await screen.findByText(/Set one in Settings/)).toBeTruthy();
});

test("a session made whose first message did not go can still be opened", async () => {
  const { user, fake } = await openTicketPage("new", {
    loopChat: { kind: "failed", reason: "offline", locationId: "local", sessionId: "orphan-1" },
  });
  await user.click(await screen.findByRole("button", { name: "Talk with an agent CYC-700" }));
  await user.click(await screen.findByRole("button", { name: "Open the conversation" }));
  await waitFor(() =>
    expect(fake.named("openSession")[0]?.slice(1)).toEqual(["local", "orphan-1"]),
  );
});

test("an In Progress ticket is only watched: a note, and no chat button", async () => {
  const { fake } = await openTicketPage("watch");
  expect(await screen.findByText(/Loop is working on this ticket/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Talk with an agent/ })).toBeNull();
  expect(fake.named("loopChat")).toEqual([]);
});

const withTicketPage = () => openTicketPage("new");

test("Escape on the ticket page goes back to the board, not out of the Loop", async () => {
  const { user } = await withTicketPage();
  await screen.findByRole("button", { name: "Back to the board" });
  await user.keyboard("{Escape}");
  await screen.findByRole("button", { name: "Ticket 700" });
  expect(screen.queryByRole("button", { name: "Back to the board" })).toBeNull();
  expect(document.querySelector('[data-kind="loop-board"]')).not.toBeNull();
});

test("leaving the Loop and coming back lands on the level it was left on", async () => {
  const { user } = await withTicketPage();
  await screen.findByRole("button", { name: "Back to the board" });
  // Ticket → board → overview → out of the Loop, one Escape each.
  await user.keyboard("{Escape}");
  await screen.findByRole("button", { name: "Ticket 700" });
  await user.keyboard("{Escape}");
  await screen.findByRole("region", { name: "Projects" });
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.querySelector('[data-kind="loop-board"]')).toBeNull());
  await user.click(await screen.findByRole("button", { name: "Loop" }));
  await screen.findByRole("region", { name: "Projects" });
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
  // The row that cannot be read says so and reads again.
  const docsRow = projects.querySelector<HTMLElement>('[data-project="DOC"]') as HTMLElement;
  await within(docsRow).findByText("Could not read the board");
  await user.click(within(docsRow).getByRole("button", { name: "Read again Docs" }));
  // A row opens its board.
  await user.click(within(cycleRow).getByRole("button", { name: /Cycle/ }));
  await screen.findByRole("region", { name: "In Progress" });
});

test("with one Project the Loop lands on its board, and Escape goes up to the overview", async () => {
  const { user } = await mount({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: board },
  });
  await screen.findByRole("region", { name: "In Progress" });
  await user.keyboard("{Escape}");
  await screen.findByRole("region", { name: "Projects" });
});

test("Needs you is on the overview, not on the board, and absent when empty", async () => {
  const blocked = { kind: "blocked" as const, identifier: "CYC-9", title: "Nine", reason: "stuck" };
  const { user } = await mount(
    overviewScript({
      loopNotices: { CYC: { kind: "ok", notices: [blocked] } },
    }),
  );
  const notices = await screen.findByRole("region", { name: "Needs you" });
  expect(within(notices).getByText("CYC-9")).toBeTruthy();
  await user.click(screen.getByRole("tab", { name: /Cycle/ }));
  await screen.findByRole("region", { name: "In Progress" });
  expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
});

test("with nothing that needs a person, the section is not there", async () => {
  await mount(overviewScript({ loopNotices: { CYC: { kind: "ok", notices: [] } } }));
  await screen.findByRole("region", { name: "Projects" });
  expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
});

test("a Project opens on its board; the Overview tab is disabled and the crumbs lead back", async () => {
  const { user } = await mount({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: board },
  });
  await screen.findByRole("region", { name: "In Progress" });
  const tabs = screen.getByRole("radiogroup", { name: "Project pages" });
  const boardTab = within(tabs).getByRole("radio", { name: "Board" }) as HTMLElement;
  const overviewTab = within(tabs).getByRole("radio", { name: "Overview" }) as HTMLElement;
  expect(boardTab.getAttribute("aria-checked")).toBe("true");
  expect(
    overviewTab.getAttribute("aria-disabled") ?? overviewTab.hasAttribute("disabled"),
  ).toBeTruthy();
  expect(screen.getByText("Coming later")).toBeTruthy();
  overviewTab.click();
  expect(boardTab.getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("region", { name: "In Progress" })).toBeTruthy();
  const heading = screen.getByRole("heading", { level: 2 });
  expect(heading.textContent).toBe("Cycle/Board");
  // The Project name leads back to the Loop overview.
  await user.click(within(heading).getByRole("button", { name: "Cycle" }));
  await screen.findByRole("region", { name: "Projects" });
});

test("a ticket page's title is Project / ticket, and the Project name leads to the board", async () => {
  const { user } = await mount({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: board },
  });
  await user.click(await screen.findByRole("button", { name: /Ticket 388/ }));
  await screen.findByRole("button", { name: "Back to the board" });
  const heading = screen.getByRole("heading", { level: 2 });
  expect(heading.textContent).toBe("Cycle/CYC-388");
  await user.click(within(heading).getByRole("button", { name: "Cycle" }));
  await screen.findByRole("region", { name: "In Progress" });
});

test("the board shows the columns by name, in the order they come", async () => {
  await mount({ loopProjects: { kind: "ok", projects: [cycle] }, loopBoards: { CYC: board } });
  await screen.findByRole("region", { name: "In Review" });
  const names = [...document.querySelectorAll('[data-slot="loop-column"]')].map((e) =>
    e.getAttribute("aria-label"),
  );
  expect(names).toEqual(["Backlog", "Todo", "In Progress", "Done", "In Review", "Blocked"]);
});

test("the board is a row of columns: cards are not draggable, there is no move menu, and Done shows its count folded", async () => {
  await mount({ loopProjects: { kind: "ok", projects: [cycle] }, loopBoards: { CYC: board } });
  await screen.findByRole("region", { name: "In Review" });
  expect(document.querySelectorAll("[draggable='true']")).toHaveLength(0);
  expect(screen.queryByText(/Move to/i)).toBeNull();
  expect(screen.queryByRole("menu")).toBeNull();
  const done = screen.getByRole("region", { name: "Done" });
  expect(within(done).getByText("1")).toBeTruthy();
  expect(within(done).queryByRole("listitem")).toBeNull();
  const tops = [...document.querySelectorAll('[data-slot="loop-column"]')].map(
    (e) => e.getBoundingClientRect().top,
  );
  expect(new Set(tops).size).toBe(1);
});

test("a card opens its ticket, a button on it does not, and cancelling Approve writes nothing", async () => {
  const backlog = {
    ...ticket(600, "Backlog"),
    actions: ["approve" as const],
    chat: "new" as const,
  };
  const { user, calls } = await mount({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: withTickets({ Backlog: [backlog] }) },
  });
  const column = await screen.findByRole("region", { name: "Backlog" });
  await user.click(within(column).getByRole("button", { name: "Approve CYC-600" }));
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(calls.some(([name]) => name === "loopAct")).toBe(false);
  expect(screen.queryByText("Back to board")).toBeNull();
  expect(document.querySelector('[data-kind="loop-ticket-page"]')).toBeNull();
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
  const done = screen.getByRole("region", { name: "Done" });
  const folded = done.getBoundingClientRect().width;
  expect(folded).toBeLessThan(16 * 16 * 0.5);
  await userEvent.click(screen.getByRole("button", { name: "Show done" }));
  expect(done.getBoundingClientRect().width).toBeGreaterThan(folded);
};

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
  const staged = (n: number, stage: "qa" | "ci", min: number): LoopTicket => ({
    ...ticket(n, "In Progress"),
    loopStage: { stage, since: ago(min) },
  });
  const { user } = await mount({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: {
      CYC: withTickets({
        "In Progress": [staged(1, "qa", 3), staged(2, "ci", 72), ticket(3, "In Progress")],
        "In Review": [ticket(4, "In Review")],
      }),
    },
  });
  await user.click(await screen.findByRole("tab", { name: /Cycle/ }));
  const quick = await screen.findByText("QA · 3 min");
  expect(quick.getAttribute("data-slow")).toBeNull();
  const slow = screen.getByText("Waiting for CI · 1 h 12 min");
  expect(slow.getAttribute("data-slow")).toBe("true");
  expect(document.querySelectorAll('[data-slot="loop-ticket-stage"]')).toHaveLength(2);
});

const waiting = (n: number, priority: string, reason: string): LoopTicket => ({
  ...ticket(n, "Backlog"),
  priority,
  actions: ["approve"],
  chat: "new",
  pending: { reason, criteria: n % 10 },
});

test("tickets waiting for approval are a group on top of Backlog: pick, select all, approve after asking, return with a reason", async () => {
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
  const group = await screen.findByRole("region", { name: "Awaiting approval" });
  // By priority, each with its criteria count and Loop's reason; ordinary tickets stay outside the group.
  const items = within(group).getAllByRole("listitem");
  expect(items.map((li) => li.textContent)).toEqual([
    expect.stringContaining("CYC-702"),
    expect.stringContaining("CYC-701"),
  ]);
  expect(items[0]?.textContent).toContain("2 acceptance criteria");
  expect(items[0]?.textContent).toContain("Reason urgent");
  const approve = within(group).getByRole("button", { name: "Approve selected" });
  expect((approve as HTMLButtonElement).disabled).toBe(true);
  await user.click(within(group).getByRole("checkbox", { name: "Select all" }));
  await user.click(approve);
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
  await user.click(within(group).getByRole("checkbox", { name: "Select CYC-701" }));
  await user.type(within(group).getByRole("textbox"), "not now");
  await user.click(within(group).getByRole("button", { name: "Return selected" }));
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

test("with nothing waiting for approval there is no group", async () => {
  const { user: _user } = await mount({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: withTickets({ Backlog: [ticket(710, "Backlog")] }) },
  });
  await screen.findByRole("region", { name: "Backlog" });
  expect(screen.queryByRole("region", { name: "Awaiting approval" })).toBeNull();
});

test("a batch return that fails is said in the group, and the picks stay", async () => {
  const { user, calls } = await mount({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: withTickets({ Backlog: [waiting(720, "high", "Why")] }) },
    loopActMany: { kind: "failed", reason: "offline" },
  });
  const group = await screen.findByRole("region", { name: "Awaiting approval" });
  await user.click(within(group).getByRole("checkbox", { name: "Select CYC-720" }));
  await user.click(within(group).getByRole("button", { name: "Return selected" }));
  expect(await within(group).findByRole("alert")).toBeTruthy();
  expect(calls.filter(([name]) => name === "loopActMany")).toHaveLength(1);
  expect(
    (within(group).getByRole("checkbox", { name: "Select CYC-720" }) as HTMLInputElement).checked,
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
  const group = await screen.findByRole("region", { name: "Awaiting approval" });
  await user.click(within(group).getByRole("checkbox", { name: "Select all" }));
  await user.click(within(group).getByRole("button", { name: "Return selected" }));
  expect(await screen.findByText(/1 succeeded, 0 skipped, 0 failed/)).toBeTruthy();
  expect(screen.queryByRole("checkbox", { name: "Select all" })).toBeNull();
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

test("a read after the state changed is applied, not dropped", async () => {
  const { emit } = await mount(
    overviewScript({ loopRuns: { kind: "ok", running: { CYC: ["CYC-386"], DOC: [] } } }),
  );
  const projects = await screen.findByRole("region", { name: "Projects" });
  await waitFor(() => expect(runState(projects, "CYC")).toBe("Running"));
  // An earlier push said nothing runs; the page is then read again (reopened) and the read says Running.
  act(() => emit({ type: "loop-runs", runs: { kind: "ok", running: { CYC: [] } } }));
  await waitFor(() => expect(runState(projects, "CYC")).toBe("Not running"));
});
