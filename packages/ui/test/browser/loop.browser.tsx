import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import type {
  LoopBoardAnswer,
  LoopProjectInfo,
  LoopTicket,
  LoopTicketDetail,
} from "../../src/api.ts";
import { fakeBridge } from "../fake-bridge.ts";
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
  await user.click(await screen.findByRole("tab", { name: /Cycle/ }));
  expect(await screen.findByText("Data may be out of date")).toBeTruthy();
  await user.click(screen.getByRole("tab", { name: /Docs/ }));
  await screen.findByRole("region", { name: "In Progress" });
  expect(screen.queryByText("Data may be out of date")).toBeNull();
});

test("leaving the Loop and coming back lands on the level it was left on", async () => {
  const { user } = await mount({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: board },
  });
  await screen.findByRole("region", { name: "In Progress" });
  // Board → overview → out of the Loop, one Escape each.
  await user.keyboard("{Escape}");
  await screen.findByRole("region", { name: "Projects" });
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.querySelector('[data-kind="loop-board"]')).toBeNull());
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
  await user.click(await screen.findByRole("tab", { name: /Cycle/ }));
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
  // By priority, each with Loop's reason; ordinary tickets stay outside the group.
  const items = within(group).getAllByRole("listitem");
  expect(items.map((li) => li.textContent)).toEqual([
    expect.stringContaining("CYC-702"),
    expect.stringContaining("CYC-701"),
  ]);
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
  await screen.findByRole("button", { name: "Back to the board" });
  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Cycle/CYC-23");
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

test("Approve on the ticket page asks first; only the confirmation writes, and a failure is said", async () => {
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
  await user.click(screen.getByRole("button", { name: "Back to the board" }));
  await user.click(await screen.findByRole("button", { name: "Ticket 601" }));
  await screen.findByText("text");
  expect(screen.queryByRole("button", { name: /Approve|Back to Backlog|Back to Todo/ })).toBeNull();
});

test("a failed Back to Backlog on the ticket page is said there, and gone after going back", async () => {
  const mine = ticket(602, "In Review");
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: withTickets({ "In Progress": [mine] }) },
    loopTickets: { "CYC-602": detailOf(mine, { actions: ["to_backlog", "to_todo"] }) },
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

const openTicketPage = async (
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
    loopTickets: { "CYC-700": detailOf(mine, { chat }) },
    ...script,
  });
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Loop" }));
  await user.click(await screen.findByRole("button", { name: "Ticket 700" }));
  return { user, fake };
};

test("a ticket page shows the text, the criteria, why it needs a person, and joins its session", async () => {
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

test("Escape on the ticket page goes back to the board, not out of the Loop", async () => {
  const { user } = await openTicketPage("new");
  await screen.findByRole("button", { name: "Back to the board" });
  await user.keyboard("{Escape}");
  await screen.findByRole("button", { name: "Ticket 700" });
  expect(screen.queryByRole("button", { name: "Back to the board" })).toBeNull();
  expect(document.querySelector('[data-kind="loop-board"]')).not.toBeNull();
});

test("leaving the Loop from a ticket page and coming back lands on the level it was left on", async () => {
  const { user } = await openTicketPage("new");
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

test("a card opens its ticket; so does a waiting ticket's title", async () => {
  const { user, calls } = await mount({
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: withTickets({ Backlog: [ticket(600, "Backlog")] }) },
  });
  const column = await screen.findByRole("region", { name: "Backlog" });
  expect(document.querySelector('[data-kind="loop-ticket-page"]')).toBeNull();
  await user.click(within(column).getByRole("button", { name: "Ticket 600" }));
  await waitFor(() => expect(calls.some(([name]) => name === "loopTicket")).toBe(true));
});
