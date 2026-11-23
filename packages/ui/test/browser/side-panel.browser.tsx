import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { cdp, userEvent } from "vitest/browser";
import { App, StoreProvider } from "../../src/react/index.ts";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge, summary } from "../fake-bridge.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const mod = /Mac/.test(navigator.userAgent) ? "Meta" : "Control";

const mount = async (all = false) => {
  const script = fakeBridge({
    connected: true,
    ...(all
      ? {
          capabilities: {
            queue: true,
            files: true,
            folders: true,
            fs: true,
            diff: true,
            terminal: true,
          },
        }
      : {}),
  });
  script.bridge.sessions = async () => [
    { ...summary("s1"), title: "first" },
    { ...summary("s2"), title: "second" },
  ];
  const store = new AppStore(script.bridge);
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await act(() => store.start());
  const user = userEvent.setup();
  const tracked = () =>
    script.calls
      .filter(([name]) => name === "track")
      .map(([, event, props]) => [event, props])
      .filter(([event]) => String(event).startsWith("side_panel"));
  return { store, user, script, tracked };
};

const panel = () => document.querySelector('[data-slot="side-panel"]');

test("no session open, no panel and no button for one", async () => {
  await mount();
  expect(panel()).toBeNull();
  expect(screen.queryByRole("button", { name: "Show panel" })).toBeNull();
});

test("the button and ⌘\\ open and close the open session's panel, on its Overview", async () => {
  const { user, tracked } = await mount();
  await user.click(await screen.findByRole("option", { name: /first/ }));
  expect(panel()).toBeNull();
  await user.click(await screen.findByRole("button", { name: "Show panel" }));
  await waitFor(() => expect(panel()).not.toBeNull());
  expect(screen.getByRole("tab", { name: "Overview", selected: true })).toBeDefined();
  await user.keyboard(`{${mod}>}\\{/${mod}}`);
  await waitFor(() => expect(panel()).toBeNull());
  expect(await screen.findByRole("button", { name: "Show panel" })).toBeDefined();
  expect(tracked()).toEqual([
    ["side_panel_toggled", { open: true, via: "click", tab: "overview" }],
    ["side_panel_toggled", { open: false, via: "shortcut", tab: "overview" }],
  ]);
});

test("each session has its own panel, and a restart finds it as it was", async () => {
  const { user, store } = await mount();
  await user.click(await screen.findByRole("option", { name: /first/ }));
  await user.click(await screen.findByRole("button", { name: "Show panel" }));
  await waitFor(() => expect(panel()).not.toBeNull());
  await user.click(await screen.findByRole("option", { name: /second/ }));
  await waitFor(() => expect(panel()).toBeNull());
  await user.click(await screen.findByRole("option", { name: /first/ }));
  await waitFor(() => expect(panel()).not.toBeNull());
  cleanup();
  // What a restart reads: the page's storage, written as the panel changed.
  expect(new AppStore(fakeBridge().bridge).sidePanels.get("local:s1").open).toBe(true);
  expect(store.sidePanels.get("local:s2").open).toBe(false);
});

test("a deleted session's panel is forgotten", async () => {
  const { user, store } = await mount();
  await user.click(await screen.findByRole("option", { name: /first/ }));
  await user.click(await screen.findByRole("button", { name: "Show panel" }));
  await waitFor(() => expect(panel()).not.toBeNull());
  await act(() => store.deleteSession("s1"));
  expect(store.sidePanels.get("local:s1").open).toBe(false);
  expect(localStorage.getItem("cycle:side-panel")).toBeNull();
});

test("the Overview's own button opens the panel on the Overview, and closes it from there", async () => {
  const { user, tracked } = await mount();
  await user.click(await screen.findByRole("option", { name: /first/ }));
  await user.click(await screen.findByRole("button", { name: "Show overview" }));
  await waitFor(() => expect(panel()).not.toBeNull());
  expect(screen.getByRole("tab", { name: "Overview", selected: true })).toBeDefined();
  // The panel's own button still says it can hide the panel.
  expect(screen.getByRole("button", { name: "Hide panel" })).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Hide overview" }));
  await waitFor(() => expect(panel()).toBeNull());
  expect(tracked()).toEqual([
    ["side_panel_toggled", { open: true, via: "tab_button", tab: "overview" }],
    ["side_panel_toggled", { open: false, via: "tab_button", tab: "overview" }],
  ]);
});

test("the header's six actions sit close together, one line of 28px buttons even in the narrowest window", async () => {
  // The narrowest window (720px, apps/desktop MIN_SIZE), as the page sees it.
  document.body.style.width = "720px";
  try {
    const { user } = await mount(true);
    await user.click(await screen.findByRole("option", { name: /first/ }));
    // The worst case: the panel open beside the conversation.
    await user.click(await screen.findByRole("button", { name: "Show panel" }));
    await waitFor(() => expect(panel()).not.toBeNull());
    expect(document.querySelector('[data-slot="split"]')?.getBoundingClientRect().width).toBe(720);
    const row = document.querySelector<HTMLElement>(
      '[data-slot="session-header"] [data-slot="row"]',
    );
    const buttons = [...(row?.querySelectorAll("button") ?? [])].map((x) =>
      x.getBoundingClientRect(),
    );
    expect(buttons).toHaveLength(6);
    for (const box of buttons) {
      expect(box.width).toBe(28);
      expect(box.top).toBe(buttons[0]?.top);
    }
    for (let i = 1; i < buttons.length; i++)
      expect((buttons[i]?.left ?? 0) - (buttons[i - 1]?.right ?? 0)).toBe(4);
    // All of it inside the conversation's column, none under the panel.
    const main = document.querySelector('[data-slot="resizable-panel"]#main');
    expect(buttons.at(-1)?.right).toBeLessThanOrEqual(main?.getBoundingClientRect().right ?? 0);
  } finally {
    document.body.style.width = "";
  }
});

test("the panel slides in as it opens, and fades out before its column goes as it closes", async () => {
  const { user } = await mount();
  await user.click(await screen.findByRole("option", { name: /first/ }));
  await user.click(await screen.findByRole("button", { name: "Show panel" }));
  await waitFor(() => expect(panel()).not.toBeNull());
  const opening = getComputedStyle(panel() as Element);
  expect(opening.animationName).toBe("cycle-panel-in");
  expect(opening.animationDuration).toBe("0.16s");
  // A tab's content fades in as it is shown.
  const content = document.querySelector('[data-slot="tabs-panel"][data-selected]');
  expect(getComputedStyle(content as Element).animationName).toBe("cycle-banner-in");
  await user.click(screen.getByRole("button", { name: "Hide panel" }));
  // Still there a moment, going, and out of reach.
  const leaving = panel() as HTMLElement;
  expect(leaving.hasAttribute("data-leaving")).toBe(true);
  expect(leaving.inert).toBe(true);
  expect(getComputedStyle(leaving).animationName).toBe("cycle-panel-out");
  expect(screen.getByRole("button", { name: "Show panel" })).toBeDefined();
  await waitFor(() => expect(panel()).toBeNull(), { timeout: 1000 });
  // Opened again before it has gone, it stays, and is no longer going.
  await user.click(screen.getByRole("button", { name: "Show panel" }));
  await waitFor(() => expect(panel()).not.toBeNull());
  await user.click(screen.getByRole("button", { name: "Hide panel" }));
  await user.click(screen.getByRole("button", { name: "Show panel" }));
  expect(panel()?.hasAttribute("data-leaving")).toBe(false);
  expect((panel() as HTMLElement).inert).toBe(false);
});

test("with reduced motion the panel neither slides nor fades: it is there, and gone, at once", async () => {
  await cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  try {
    const { user } = await mount();
    await user.click(await screen.findByRole("option", { name: /first/ }));
    await user.click(await screen.findByRole("button", { name: "Show panel" }));
    await waitFor(() => expect(panel()).not.toBeNull());
    expect(getComputedStyle(panel() as Element).animationName).toBe("none");
    const content = document.querySelector('[data-slot="tabs-panel"][data-selected]');
    expect(getComputedStyle(content as Element).animationName).toBe("none");
    await user.click(screen.getByRole("button", { name: "Hide panel" }));
    expect(panel()).toBeNull();
  } finally {
    await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  }
});
