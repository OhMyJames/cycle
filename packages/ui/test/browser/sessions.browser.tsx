import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { SessionSummary } from "../../src/api.ts";
import { PER_WORKSPACE } from "../../src/sessions.ts";
import { summary } from "../fake-bridge.ts";
import { mountApp } from "./mount.tsx";

afterEach(cleanup);

const row = (id: string, over: Partial<SessionSummary>): SessionSummary => ({
  ...summary(id),
  title: id,
  cwd: "/work/app",
  ...over,
});

const mount = async (sessions: SessionSummary[]) => {
  const app = await mountApp(
    {},
    {
      configure: (script) => {
        script.bridge.sessions = async () => sessions;
      },
    },
  );
  await screen.findAllByRole("option");
  return app;
};

const names = () => screen.getAllByRole("option").map((o) => o.textContent ?? "");
const mod = () => (/Mac/.test(navigator.userAgent) ? "Meta" : "Control");

const mixed = [
  row("old", { lastSeq: 1 }),
  row("run", { lastSeq: 5, state: "running" }),
  row("ask", { lastSeq: 2, state: "requires_action" }),
  row("new", { lastSeq: 9 }),
];

test("what needs you comes first, then what is running, then the days", async () => {
  await mount(mixed);
  const groups = screen.getAllByRole("group");
  // Each group is named by its heading (and not by a word in a row), and its rows are inside it.
  expect(groups.map((g) => g.getAttribute("aria-labelledby") !== null)).toEqual([true, true, true]);
  const needs = screen.getByRole("group", { name: "Needs you" });
  const running = screen.getByRole("group", { name: "Running" });
  expect(within(needs).getAllByRole("option")).toHaveLength(1);
  expect(within(running).getAllByRole("option")).toHaveLength(1);
  expect(groups.indexOf(needs)).toBe(0);
  expect(groups.indexOf(running)).toBe(1);
  // The rest is by day: these are long ago.
  expect(
    within(screen.getByRole("group", { name: "Earlier" })).getAllByRole("option"),
  ).toHaveLength(2);
  const rows = names();
  expect(rows[0]).toContain("ask");
  expect(rows[1]).toContain("run");
  expect(rows[2]).toContain("new");
  expect(rows[3]).toContain("old");
});

test("the arrow keys walk the whole list, across its groups", async () => {
  const { user } = await mount(mixed);
  await user.click(screen.getAllByRole("option")[0] as HTMLElement);
  await user.keyboard("{ArrowDown}");
  expect(document.activeElement?.textContent).toContain("run");
  await user.keyboard("{ArrowDown}{ArrowDown}");
  expect(document.activeElement?.textContent).toContain("old");
});

test("Cmd or Ctrl+] moves to the next session on screen, not the next by number", async () => {
  const { user, named } = await mount(mixed);
  await user.click(screen.getAllByRole("option")[0] as HTMLElement);
  await waitFor(() => expect(named("openSession").at(-1)?.[2]).toBe("ask"));
  await user.keyboard(`{${mod()}>}]{/${mod()}}`);
  // By number the next would be "old" (2 -> 1); on screen it is the running one.
  await waitFor(() => expect(named("openSession").at(-1)?.[2]).toBe("run"));
});

test("a workspace shows a page of its sessions, and the rest on request", async () => {
  const many = Array.from({ length: PER_WORKSPACE + 5 }, (_, n) => row(`s${n}`, { lastSeq: n }));
  const { user } = await mount(many);
  expect(names()).toHaveLength(PER_WORKSPACE);
  await user.click(screen.getByRole("button", { name: "Show 5 more sessions" }));
  await waitFor(() => expect(names()).toHaveLength(PER_WORKSPACE + 5));
  expect(screen.queryByRole("button", { name: /more session/ })).toBeNull();
});

test("a session found by the search that is past the page is shown, not selected out of sight", async () => {
  const many = Array.from({ length: PER_WORKSPACE + 5 }, (_, n) =>
    row(`s${n}`, { lastSeq: n, ...(n === 0 ? { title: "needle" } : {}) }),
  );
  const { user } = await mount(many);
  expect(within(screen.getByRole("listbox")).queryByText("needle")).toBeNull();
  await user.keyboard(`{${mod()}>}k{/${mod()}}`);
  await user.type(await screen.findByRole("combobox", { name: "Search sessions" }), "needle");
  await user.keyboard("{Enter}");
  const shown = await screen.findByRole("option", { name: /needle/ });
  await waitFor(() => expect(shown.getAttribute("aria-selected")).toBe("true"));
});

test("a row that moves to another group keeps the keyboard focus", async () => {
  const { user, emit } = await mount([row("one", { lastSeq: 1 }), row("two", { lastSeq: 2 })]);
  const first = screen.getAllByRole("option")[1] as HTMLElement;
  await user.click(first);
  first.focus();
  expect(document.activeElement).toBe(first);
  // It starts working: it moves up to Running, and is another element there.
  await emit({
    type: "sessions",
    locationId: "local",
    sessions: [row("one", { lastSeq: 3, state: "running" }), row("two", { lastSeq: 2 })],
  });
  const moved = await screen.findByRole("option", { name: /one/ });
  expect(
    within(screen.getByRole("group", { name: "Running" })).getByRole("option", { name: /one/ }),
  ).toBe(moved);
  expect(document.activeElement).toBe(moved);
});
