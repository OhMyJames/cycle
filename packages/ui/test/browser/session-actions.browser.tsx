import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { SessionSummary } from "../../src/api.ts";
import { pins } from "../../src/pins.ts";
import { App, StoreProvider } from "../../src/react/index.ts";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge, summary } from "../fake-bridge.ts";

afterEach(() => {
  cleanup();
  for (const key of pins.all()) pins.set(key, false);
});

const row = (id: string, title: string): SessionSummary => ({
  ...summary(id),
  title,
  updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
});

const mount = async () => {
  const script = fakeBridge({ connected: true });
  script.bridge.sessions = async () => [row("a", "First"), row("b", "Second")];
  const store = new AppStore(script.bridge);
  const user = userEvent.setup();
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await act(() => store.start());
  await screen.findAllByRole("option");
  return { user, script };
};

const option = (name: string) => screen.getByRole("option", { name: new RegExp(name) });
const actionsOf = (name: string) =>
  option(name).querySelector('[data-slot="session-actions"]') as HTMLElement;
const groupOf = (name: string) =>
  option(name).closest('[data-slot="listbox-group"]')?.getAttribute("data-kind");

test("a row with a mark shows the mark where its time would be", async () => {
  const script = fakeBridge({ connected: true });
  script.bridge.sessions = async () => [
    { ...row("a", "Busy"), state: "running" },
    row("b", "Quiet"),
  ];
  const store = new AppStore(script.bridge);
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await act(() => store.start());
  await screen.findAllByRole("option");
  const busy = option("Busy");
  expect(busy.querySelector('[data-slot="session-time"]')).toBeNull();
  const dot = busy.querySelector('[data-slot="session-dot"]') as HTMLElement;
  expect(dot).not.toBeNull();
  // At the row's end, after the title.
  const title = busy.querySelector('[data-slot="session-title"]') as HTMLElement;
  expect(dot.getBoundingClientRect().left).toBeGreaterThan(title.getBoundingClientRect().right - 1);
  // Without a mark, the time as before.
  expect(option("Quiet").querySelector('[data-slot="session-dot"]')).toBeNull();
  expect(option("Quiet").querySelector('[data-slot="session-time"]')?.textContent).toBe("5m");
});

test("under the pointer a row offers pin and its menu in place of its time", async () => {
  const { user } = await mount();
  const time = option("Second").querySelector('[data-slot="session-time"]') as HTMLElement;
  expect(time.textContent).toBe("5m");
  expect(getComputedStyle(actionsOf("Second")).opacity).toBe("0");
  // Found by its name with the time, as before the pointer came.
  const named = page.getByRole("option", { name: /Second.*5m/ });
  expect(named.elements()).toEqual([option("Second")]);
  await user.hover(option("Second"));
  await waitFor(() => expect(getComputedStyle(actionsOf("Second")).opacity).toBe("1"));
  // Out of sight, but still part of the row's name: the name does not change under the pointer, so a screen reader
  // reads the same row and a locator taken before the hover still finds it (it did not: CYCL-209's flaky click).
  expect(time.getBoundingClientRect().width).toBeLessThanOrEqual(1);
  expect(named.elements()).toEqual([option("Second")]);
  await user.click(named);
  await waitFor(() => expect(option("Second").getAttribute("aria-selected")).toBe("true"));
  // Neither takes a Tab stop: the arrow keys walk the rows.
  for (const button of actionsOf("Second").querySelectorAll("button"))
    expect(button.tabIndex).toBe(-1);
});

test("pin moves the row to the top under Pinned without opening it; unpin puts it back", async () => {
  const { user, script } = await mount();
  expect(groupOf("Second")).not.toBe("pinned");
  await user.hover(option("Second"));
  await user.click(within(actionsOf("Second")).getByRole("button", { name: "Pin session" }));
  await waitFor(() => expect(groupOf("Second")).toBe("pinned"));
  expect(option("Second").getAttribute("aria-selected")).not.toBe("true");
  expect(document.querySelector('[data-slot="session-header"]')).toBeNull();
  await user.hover(option("Second"));
  await user.click(within(actionsOf("Second")).getByRole("button", { name: "Unpin session" }));
  await waitFor(() => expect(groupOf("Second")).not.toBe("pinned"));
  // Counted, by where it was done; never which session.
  expect(script.named("track").filter(([, name]) => name === "session_pinned")).toEqual([
    ["track", "session_pinned", { pinned: true, where: "sidebar" }],
    ["track", "session_pinned", { pinned: false, where: "sidebar" }],
  ]);
});

test("the row's menu archives that row's session, in its own environment", async () => {
  const { user, script } = await mount();
  await user.hover(option("Second"));
  await user.click(within(actionsOf("Second")).getByRole("button", { name: "More actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Archive" }));
  expect(script.named("archiveSession")).toEqual([["archiveSession", "local", "b", true]]);
  expect(document.querySelector('[data-slot="session-header"]')).toBeNull();
});

test("Delete from the row's menu asks first, with Cancel focused, and deletes that row's session", async () => {
  const { user, script } = await mount();
  await user.hover(option("First"));
  await user.click(within(actionsOf("First")).getByRole("button", { name: "Pin session" }));
  await user.hover(option("First"));
  await user.click(within(actionsOf("First")).getByRole("button", { name: "More actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
  const dialog = await screen.findByRole("alertdialog");
  await waitFor(() =>
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })),
  );
  await user.click(within(dialog).getByRole("button", { name: "Delete session" }));
  await waitFor(() =>
    expect(script.named("deleteSession")).toEqual([["deleteSession", "local", "a"]]),
  );
  // A deleted session's pin goes with it.
  expect(pins.all().size).toBe(0);
});

test("Rename from the row's menu turns its title into a field that keeps the focus", async () => {
  const { user } = await mount();
  await user.hover(option("Second"));
  await user.click(within(actionsOf("Second")).getByRole("button", { name: "More actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
  const field = (await screen.findByRole("textbox", { name: "Session name" })) as HTMLInputElement;
  await waitFor(() => expect(document.activeElement).toBe(field));
  // Still there once the menu has finished closing.
  await new Promise((r) => setTimeout(r, 300));
  expect(document.activeElement).toBe(field);
});
