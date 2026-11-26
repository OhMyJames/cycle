import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { LoopBoardAnswer, LoopProjectInfo } from "../../src/api.ts";
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
const ticket = (n: number, column: string) => ({
  identifier: `CYC-${n}`,
  title: `Ticket ${n}`,
  priority: "high",
  column,
  actions: [],
  chat: "none" as const,
});
const board: LoopBoardAnswer = {
  kind: "ok",
  doing: [ticket(386, "In Progress"), ticket(387, "In Review")],
  todo: [ticket(388, "Todo")],
  backlog: [],
  done: [ticket(300, "Done")],
};

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
  const doing = await screen.findByRole("region", { name: "Doing" });
  expect(
    within(doing)
      .getAllByRole("listitem")
      .map((li) => li.textContent),
  ).toEqual(["CYC-386Ticket 386In Progress · high", "CYC-387Ticket 387In Review · high"]);
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
    loopBoards: { CYC: { ...board, backlog: many } },
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
    loopBoards: { CYC: { ...board, doing: [doing], backlog: [backlog] } },
    loopAct: { kind: "failed", reason: "forbidden" },
  });
  await renderApp(fake.bridge);
  await user.click(await screen.findByRole("button", { name: "Loop" }));
  const column = await screen.findByRole("region", { name: "Backlog" });
  // Loop's own ticket in Doing has no buttons.
  expect(
    within(screen.getByRole("region", { name: "Doing" })).queryByRole("button", {
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
    chat: "watch" as const,
  };
  const user = userEvent.setup();
  const fake = fakeBridge({
    connected: true,
    loopProjects: { kind: "ok", projects: [cycle] },
    loopBoards: { CYC: { ...board, doing: [mine] } },
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
