import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { EnvironmentConfig, SessionSummary } from "../../src/api.ts";
import { fakeBridge, summary } from "../fake-bridge.ts";
import { sleep } from "./box.ts";
import { renderApp } from "./render-app.tsx";

afterEach(() => {
  cleanup();
  document.hasFocus = () => false;
});

const row = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  ...summary(id),
  title: id,
  cwd: "/work/app",
  ...over,
});

const mount = async (sessions: SessionSummary[]) => {
  const script = fakeBridge({ connected: true });
  script.bridge.sessions = async () => sessions;
  await renderApp(script.bridge);
  const user = userEvent.setup();
  await screen.findAllByRole("option");
  return { user, ...script };
};

const switcher = () => screen.getByRole("button", { name: /Switch workspace/ });

test("a row says one thing, in words for those who do not see the dot", async () => {
  await mount([
    row("a", { unread: true, lastSeq: 1 }),
    row("b", { background: 2, lastSeq: 2 }),
    row("c", { lastSeq: 3 }),
  ]);
  const a = screen.getByRole("option", { name: /(^|\s)a(\s|$)/ });
  const b = screen.getByRole("option", { name: /(^|\s)b(\s|$)/ });
  const c = screen.getByRole("option", { name: /(^|\s)c(\s|$)/ });
  expect(a.getAttribute("data-mark")).toBe("unread");
  expect(a.textContent).toContain("Unread");
  expect(b.getAttribute("data-mark")).toBe("background");
  expect(b.textContent).toContain("Background work is running");
  expect(c.getAttribute("data-mark")).toBeNull();
  // A session with background work is running, as far as the list is concerned.
  const running = screen.getByRole("group", { name: "Running" });
  expect(within(running).getAllByRole("option")).toHaveLength(1);
});

test("the switcher shows one workspace, and counts what is going on in the others", async () => {
  const { user } = await mount([
    row("here", { cwd: "/work/here", updatedAt: "2020-01-02T00:00:00.000Z" }),
    row("ask1", {
      cwd: "/work/there",
      state: "requires_action",
      updatedAt: "2020-01-01T00:00:00.000Z",
    }),
    row("ask2", {
      cwd: "/work/there",
      state: "requires_action",
      updatedAt: "2020-01-01T00:00:00.000Z",
    }),
    row("news", { cwd: "/work/other", unread: true, updatedAt: "2019-01-01T00:00:00.000Z" }),
  ]);
  // The newest workspace is shown, and what waits on the person elsewhere is the badge.
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(switcher().textContent).toContain("here");
  expect(switcher().getAttribute("aria-label")).toBe(
    "Switch workspace. here. In other workspaces: 2 sessions need you, 1 session is unread",
  );
  expect(within(switcher()).getByText("2", { selector: '[data-slot="badge"]' })).toBeTruthy();
  // Chosen, a workspace is shown, and what was shown is now elsewhere.
  await user.click(switcher());
  await user.click(await screen.findByRole("menuitem", { name: /there/ }));
  await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
  expect(switcher().textContent).toContain("there");
  expect(switcher().getAttribute("aria-label")).toBe(
    "Switch workspace. there. In other workspaces: 1 session is unread",
  );
});

test("the session that is open is told it has been seen, while the app is in front", async () => {
  document.hasFocus = () => true;
  const { user, named } = await mount([row("a", { unread: true })]);
  await user.click(screen.getByRole("option", { name: /(^|\s)a(\s|$)/ }));
  await waitFor(() => expect(named("markRead")).toEqual([["markRead", "local", "a"]]));
});

test("an unread session is not told it has been seen while the app is behind", async () => {
  document.hasFocus = () => false;
  const { user, named } = await mount([row("a", { unread: true })]);
  await user.click(screen.getByRole("option", { name: /(^|\s)a(\s|$)/ }));
  await waitFor(() => expect(named("openSession")).toHaveLength(1));
  await act(() => sleep(20));
  expect(named("markRead")).toEqual([]);
});

test("a daemon that says nothing of news is never told anything", async () => {
  document.hasFocus = () => true;
  const { user, named } = await mount([row("a")]);
  await user.click(screen.getByRole("option", { name: /(^|\s)a(\s|$)/ }));
  await waitFor(() => expect(named("openSession")).toHaveLength(1));
  await act(() => sleep(20));
  expect(named("markRead")).toEqual([]);
});

test("the search finds sessions by workspace: each group is a folder on one environment, and a folder name finds its sessions", async () => {
  const far: EnvironmentConfig = {
    id: "far",
    name: "Build box",
    kind: "remote",
    transport: { type: "ssh", host: "box" },
  };
  const script = fakeBridge({ connected: true, environments: [far] });
  script.bridge.sessions = async (id) =>
    id === "local"
      ? [row("mine", { cwd: "/work/app" }), row("other", { cwd: "/work/lib", lastSeq: 5 })]
      : [row("remote-one", { environmentId: "far", cwd: "/srv/api" })];
  await renderApp(script.bridge);
  const user = userEvent.setup();
  await screen.findAllByRole("option");
  await user.keyboard(
    `{${/Mac/.test(navigator.userAgent) ? "Meta" : "Control"}>}k{/${/Mac/.test(navigator.userAgent) ? "Meta" : "Control"}}`,
  );
  const search = await screen.findByRole("combobox", { name: "Search sessions" });
  const dialog = screen.getByRole("dialog");
  const groups = within(dialog).getAllByRole("group");
  // A group per workspace; the remote one has the icon that says where.
  expect(groups.map((g) => g.textContent)).toEqual(
    expect.arrayContaining([
      expect.stringContaining("app"),
      expect.stringContaining("lib"),
      expect.stringContaining("api"),
    ]),
  );
  expect(within(dialog).getByRole("img", { name: "On Build box · Connected" })).toBeTruthy();
  // The folder is not in the row, but it finds the row.
  await user.type(search, "lib");
  await waitFor(() => expect(within(dialog).getAllByRole("option")).toHaveLength(1));
  expect(within(dialog).getByRole("option").textContent).toContain("other");
});
