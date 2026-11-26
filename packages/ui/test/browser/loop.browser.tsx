import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
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

test("the Loop page shows a Project's board in three columns, with Done collapsed", async () => {
  const { user, calls } = await mount({
    loopProjects: { kind: "ok", projects: [cycle, docs] },
    loopBoards: { CYC: board },
  });
  expect(await screen.findByRole("tab", { name: /Cycle/ })).toBeTruthy();
  const text = (name: string) =>
    within(screen.getByRole("region", { name }))
      .getAllByRole("listitem")
      .map((li) => li.textContent);
  await screen.findByRole("region", { name: "In Progress" });
  expect(text("In Progress")).toEqual(["CYC-386Ticket 386In Progress · high"]);
  expect(text("In Review")).toEqual(["CYC-387Ticket 387In Review · high"]);
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
  // Ticket → board → out of the Loop, one Escape each.
  await user.keyboard("{Escape}");
  await screen.findByRole("button", { name: "Ticket 700" });
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.querySelector('[data-kind="loop-board"]')).toBeNull());
  await user.click(await screen.findByRole("button", { name: "Loop" }));
  await screen.findByRole("button", { name: "Ticket 700" });
});

test("the board shows the columns by name, in the order they come", async () => {
  await mount({ loopProjects: { kind: "ok", projects: [cycle] }, loopBoards: { CYC: board } });
  await screen.findByRole("region", { name: "In Review" });
  const names = [...document.querySelectorAll('[data-slot="loop-column"]')].map((e) =>
    e.getAttribute("aria-label"),
  );
  expect(names).toEqual(["Backlog", "Todo", "In Progress", "In Review", "Blocked", "Done"]);
});
