import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { cdp } from "vitest/browser";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge, summary } from "../fake-bridge.ts";
import { mountApp } from "./mount.tsx";
import { newTerminal, openTab } from "./panel.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const mod = /Mac/.test(navigator.userAgent) ? "Meta" : "Control";

const mount = async (all = false) => {
  const app = await mountApp(
    all
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
      : {},
    {
      configure: (script) => {
        script.bridge.sessions = async () => [
          { ...summary("s1"), title: "first" },
          { ...summary("s2"), title: "second" },
        ];
      },
    },
  );
  const tracked = () =>
    app.calls
      .filter(([name]) => name === "track")
      .map(([, event, props]) => [event, props])
      .filter(([event]) => String(event).startsWith("side_panel"));
  return { ...app, tracked };
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

test("the panel's tabs are in its own strip: a view is closed there and put back from the menu of tabs, and the last tab closes the panel", async () => {
  const { user, tracked, store } = await mount();
  await user.click(await screen.findByRole("option", { name: /first/ }));
  await user.click(await screen.findByRole("button", { name: "Show panel" }));
  await waitFor(() => expect(panel()).not.toBeNull());
  const tabs = () => screen.getAllByRole("tab").map((tab) => tab.textContent);
  // Every view the session has is a tab from the start, each with what it is before its name. This daemon does not
  // read folders, so it has no Files.
  expect(tabs()).toEqual(["Overview", "Diff"]);
  for (const tab of screen.getAllByRole("tab")) expect(tab.querySelector("svg")).not.toBeNull();
  // The header has no button per tab: the strip is the one place to choose what the panel shows.
  expect(screen.queryByRole("button", { name: /overview|changes|files/i })).toBeNull();

  // Closed with the keyboard (Delete on the focused tab), the tab beside it is shown in its place.
  screen.getByRole("tab", { name: "Overview" }).focus();
  await user.keyboard("{Delete}");
  await waitFor(() => expect(tabs()).toEqual(["Diff"]));
  expect(screen.getByRole("tab", { name: "Diff", selected: true })).toBeDefined();
  // Files is kept for a daemon that can show it: not offered here, it is not drawn.
  expect(store.sidePanels.get("local:s1")).toEqual({
    open: true,
    tabs: ["files", "diff"],
    active: "diff",
  });

  // The menu has every view: one that was closed is put back, at the end, and shown.
  await user.click(screen.getByRole("button", { name: "Open a tab" }));
  await user.click(await screen.findByRole("menuitem", { name: "Overview" }));
  await waitFor(() => expect(tabs()).toEqual(["Diff", "Overview"]));
  expect(screen.getByRole("tab", { name: "Overview", selected: true })).toBeDefined();
  // One already in the strip is shown, not added again.
  await user.click(screen.getByRole("button", { name: "Open a tab" }));
  await user.click(await screen.findByRole("menuitem", { name: "Diff" }));
  expect(screen.getByRole("tab", { name: "Diff", selected: true })).toBeDefined();
  expect(tabs()).toEqual(["Diff", "Overview"]);

  // The strip's last tab closes the panel instead, and is there when the panel opens again.
  const cross = (name: string) =>
    screen.getByRole("tab", { name }).querySelector('[data-slot="panel-tab-close"]') as HTMLElement;
  await user.click(cross("Overview"));
  await waitFor(() => expect(tabs()).toEqual(["Diff"]));
  await user.click(cross("Diff"));
  await waitFor(() => expect(panel()).toBeNull());
  await user.click(screen.getByRole("button", { name: "Show panel" }));
  await waitFor(() => expect(tabs()).toEqual(["Diff"]));
  expect(tracked()).toEqual([
    ["side_panel_toggled", { open: true, via: "click", tab: "overview" }],
    ["side_panel_tab_closed", { tab: "overview" }],
    ["side_panel_tab_shown", { tab: "overview" }],
    ["side_panel_tab_shown", { tab: "diff" }],
    ["side_panel_tab_closed", { tab: "overview" }],
    ["side_panel_toggled", { open: false, via: "click", tab: "diff" }],
    ["side_panel_toggled", { open: true, via: "click", tab: "diff" }],
  ]);
});

test("with every view closed and its last terminal gone, the strip starts again from the views, and they are the panel's own", async () => {
  const { user, store, tracked } = await mount(true);
  await user.click(await screen.findByRole("option", { name: /first/ }));
  await newTerminal(user);
  await screen.findByRole("tab", { name: "zsh", selected: true });
  const tabs = () => screen.getAllByRole("tab").map((tab) => tab.textContent);
  const cross = (name: string) =>
    screen.getByRole("tab", { name }).querySelector('[data-slot="panel-tab-close"]') as HTMLElement;
  for (const name of ["Overview", "Files", "Diff"]) {
    await user.hover(screen.getByRole("tab", { name }));
    await user.click(cross(name));
  }
  await waitFor(() => expect(tabs()).toEqual(["zsh"]));
  expect(store.sidePanels.get("local:s1").tabs).toEqual([]);
  // The terminal closed too: the panel is not left empty.
  screen.getByRole("tab", { name: "zsh" }).focus();
  await user.keyboard("{Delete}");
  await waitFor(() => expect(tabs()).toEqual(["Overview", "Files", "Diff"]));
  // What is drawn can be closed and chosen like any tab: closing one leaves the other two.
  await user.hover(screen.getByRole("tab", { name: "Overview" }));
  await user.click(cross("Overview"));
  await waitFor(() => expect(tabs()).toEqual(["Files", "Diff"]));
  await user.click(screen.getByRole("tab", { name: "Files" }));
  expect(tabs()).toEqual(["Files", "Diff"]);
  expect(store.sidePanels.get("local:s1").tabs).toEqual(["files", "diff"]);
  // Choosing the tab already shown from the menu is not counted as showing one.
  const shown = tracked().filter(([event]) => event === "side_panel_tab_shown").length;
  await user.click(screen.getByRole("button", { name: "Open a tab" }));
  await user.click(await screen.findByRole("menuitem", { name: "Files" }));
  expect(tracked().filter(([event]) => event === "side_panel_tab_shown")).toHaveLength(shown);
});

test("the header's actions sit close together, one line of 28px buttons even in the narrowest window", async () => {
  // The narrowest window (720px, apps/desktop MIN_SIZE), as the page sees it.
  document.body.style.width = "720px";
  try {
    const { user } = await mount(true);
    await user.click(await screen.findByRole("option", { name: /first/ }));
    // The worst case: the panel open beside the conversation.
    await user.click(await screen.findByRole("button", { name: "Show panel" }));
    await waitFor(() => expect(panel()).not.toBeNull());
    expect(document.querySelector('[data-slot="split"]')?.getBoundingClientRect().width).toBe(720);
    const row = document.querySelector<HTMLElement>('[data-slot="main-header"] [data-slot="row"]');
    const buttons = [...(row?.querySelectorAll("button") ?? [])].map((x) =>
      x.getBoundingClientRect(),
    );
    // The session's menu and the panel's button: what the panel shows is chosen in the panel.
    expect(buttons).toHaveLength(2);
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

const column = (id: string) =>
  Math.round(
    document.querySelector(`[data-slot="resizable-panel"]#${id}`)?.getBoundingClientRect().width ??
      -1,
  );
const split = () => document.querySelector('[data-slot="split"]') as HTMLElement;

type Frame = { sidebar: number; main: number; panel: number; content: number | undefined };

/** The columns' widths on every frame drawn while `run` ran, and for `after` ms more. */
const frames = async (run: () => Promise<void>, after = 400) => {
  const seen: Frame[] = [];
  let frame = 0;
  const sample = () => {
    const content = panel()?.getBoundingClientRect().width;
    seen.push({
      sidebar: column("sidebar"),
      main: column("main"),
      panel: column("panel"),
      content: content === undefined ? undefined : Math.round(content),
    });
    frame = requestAnimationFrame(sample);
  };
  frame = requestAnimationFrame(sample);
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, after));
  } finally {
    cancelAnimationFrame(frame);
  }
  return seen;
};

const increasing = (xs: number[]) => xs.every((x, i) => i === 0 || x >= (xs[i - 1] ?? 0));

test("the panel opens and closes as the sidebar folds: its column slides, the conversation with it, nothing squeezed", async () => {
  const { user } = await mount(true);
  await user.click(await screen.findByRole("option", { name: /first/ }));
  const together = column("main") + column("panel");
  const opening = await frames(async () => {
    await user.click(await screen.findByRole("button", { name: "Show panel" }));
  });
  const open = column("panel");
  expect(open).toBe(400);
  const widths = opening.map((f) => f.panel);
  expect(increasing(widths)).toBe(true);
  // Frames on the way, not a jump from closed to open.
  expect(widths.filter((w) => w > 0 && w < open).length).toBeGreaterThan(2);
  for (const f of opening) {
    // The sidebar stays as it is, and the conversation gives the panel exactly what it takes.
    expect(f.sidebar).toBe(256);
    expect(Math.abs(f.main + f.panel - together)).toBeLessThanOrEqual(1);
    // What the panel shows is there from the first frame, at its open width: cut off, not squeezed.
    if (f.panel > 0) expect(f.content).toBe(open);
  }
  // The same slide as the sidebar's, and only for it: the attribute goes when the column is open.
  const style = getComputedStyle(document.querySelector("#panel") as Element);
  expect(style.transitionDuration).toBe("0s");
  expect(split().hasAttribute("data-animate")).toBe(false);

  // Closing: the column slides shut, what it showed out of reach but there until it has.
  const closing = await frames(async () => {
    await user.click(screen.getByRole("button", { name: "Hide panel" }));
    expect(split().hasAttribute("data-animate")).toBe(true);
    const going = getComputedStyle(document.querySelector("#panel") as Element);
    expect(going.transitionProperty).toBe("flex-basis");
    expect(going.transitionDuration).toBe("0.16s");
    expect(panel()?.closest("[inert]")).not.toBeNull();
    const handle = document.querySelector(
      '[data-slot="resizable-handle"][aria-label="Resize panel"]',
    );
    expect(handle?.hasAttribute("data-disabled")).toBe(true);
  });
  const shutting = closing.map((f) => f.panel);
  expect(increasing(shutting.toReversed())).toBe(true);
  expect(shutting.filter((w) => w > 0 && w < open).length).toBeGreaterThan(2);
  for (const f of closing) {
    expect(f.sidebar).toBe(256);
    expect(Math.abs(f.main + f.panel - together)).toBeLessThanOrEqual(1);
    if (f.panel > 0) expect(f.content).toBe(open);
  }
  expect(column("panel")).toBe(0);
  expect(panel()).toBeNull();
  expect(split().hasAttribute("data-animate")).toBe(false);

  // Opened again before it has gone, it stays, and is no longer going.
  await user.click(screen.getByRole("button", { name: "Show panel" }));
  await user.click(screen.getByRole("button", { name: "Hide panel" }));
  await user.click(screen.getByRole("button", { name: "Show panel" }));
  await waitFor(() => expect(column("panel")).toBe(open), { timeout: 1000 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(panel()?.closest("[inert]")).toBeNull();
  expect(column("panel")).toBe(open);
});

test("the sidebar's slide carries the conversation with it, and leaves an open panel as it is", async () => {
  const { user } = await mount(true);
  await user.click(await screen.findByRole("option", { name: /first/ }));
  await user.click(await screen.findByRole("button", { name: "Show panel" }));
  await waitFor(() => expect(column("panel")).toBe(400), { timeout: 1000 });
  const together = column("sidebar") + column("main");
  const folding = await frames(async () => {
    await user.click(screen.getByRole("button", { name: "Hide sidebar" }));
  });
  expect(folding.filter((f) => f.sidebar > 0 && f.sidebar < 256).length).toBeGreaterThan(2);
  for (const f of folding) {
    expect(f.panel).toBe(400);
    expect(Math.abs(f.sidebar + f.main - together)).toBeLessThanOrEqual(1);
  }
});

/** Whether the columns were made to slide while `run` ran. */
const slid = async (run: () => Promise<void>) => {
  let seen = false;
  const watch = new MutationObserver(() => {
    if (split().hasAttribute("data-animate")) seen = true;
  });
  watch.observe(split(), { attributeFilter: ["data-animate"] });
  try {
    await run();
  } finally {
    watch.disconnect();
  }
  return seen;
};

test("a panel that comes or goes with the session opened is there, or gone, at once", async () => {
  const { user, store } = await mount();
  store.sidePanels.setOpen("local:s2", true);
  await user.click(await screen.findByRole("option", { name: /first/ }));
  const seen = await slid(async () => {
    await user.click(await screen.findByRole("option", { name: /second/ }));
    await waitFor(() => expect(panel()).not.toBeNull());
    expect(column("panel")).toBe(400);
    await user.click(await screen.findByRole("option", { name: /first/ }));
    expect(panel()).toBeNull();
    expect(column("panel")).toBe(0);
  });
  expect(seen).toBe(false);
});

test("a tab chosen in the panel fades in, the one it replaced gone at once", async () => {
  const { user } = await mount(true);
  await user.click(await screen.findByRole("option", { name: /first/ }));
  await user.click(await screen.findByRole("button", { name: "Show panel" }));
  await waitFor(() => expect(panel()).not.toBeNull());
  const seen: string[] = [];
  const watch = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target as HTMLElement;
      if (record.attributeName === null || !target.hasAttribute(record.attributeName)) continue;
      seen.push(`${target.dataset.slot} ${record.attributeName}`);
    }
  });
  watch.observe(document.body, { subtree: true, attributeFilter: ["data-starting-style"] });
  await openTab(user, "Diff");
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "Diff" }).getAttribute("aria-selected")).toBe("true"),
  );
  watch.disconnect();
  expect(seen).toContain("tabs-panel data-starting-style");
  const drawn = [...document.querySelectorAll('[data-slot="tabs-panel"]')].filter(
    (x) => getComputedStyle(x).display !== "none",
  );
  expect(drawn).toHaveLength(1);
});

test("with reduced motion the panel does not slide: it is there, and gone, at once", async () => {
  await cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  try {
    const { user } = await mount();
    await user.click(await screen.findByRole("option", { name: /first/ }));
    const seen = await slid(async () => {
      await user.click(await screen.findByRole("button", { name: "Show panel" }));
      await waitFor(() => expect(panel()).not.toBeNull());
      expect(column("panel")).toBe(400);
      const content = document.querySelector('[data-slot="tabs-panel"][data-selected]');
      expect(getComputedStyle(content as Element).transitionDuration).toBe("0s");
      await user.click(screen.getByRole("button", { name: "Hide panel" }));
      expect(panel()).toBeNull();
      expect(column("panel")).toBe(0);
    });
    expect(seen).toBe(false);
  } finally {
    await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  }
});

test("the panel opens as wide as the user left it, closed in between and after a restart", async () => {
  const { user } = await mount();
  await user.click(await screen.findByRole("option", { name: /first/ }));
  await user.click(await screen.findByRole("button", { name: "Show panel" }));
  await waitFor(() => expect(column("panel")).toBe(400), { timeout: 1000 });
  // Open, not sliding to it: a key then would slide the handle too, and the width read here would be on the way.
  await waitFor(() => expect(split().hasAttribute("data-animate")).toBe(false), { timeout: 1000 });
  screen.getByRole("separator", { name: "Resize panel" }).focus();
  await user.keyboard("{ArrowLeft}{ArrowLeft}");
  const wide = column("panel");
  expect(wide).toBeGreaterThan(400);
  await user.click(screen.getByRole("button", { name: "Hide panel" }));
  await waitFor(() => expect(panel()).toBeNull(), { timeout: 1000 });
  await user.click(screen.getByRole("button", { name: "Show panel" }));
  await waitFor(() => expect(column("panel")).toBe(wide), { timeout: 1000 });
  await user.click(screen.getByRole("button", { name: "Hide panel" }));
  await waitFor(() => expect(panel()).toBeNull(), { timeout: 1000 });
  cleanup();
  // A restart: the panel is closed, and opens as wide as it was.
  const { user: again } = await mount();
  await again.click(await screen.findByRole("option", { name: /first/ }));
  expect(column("panel")).toBe(0);
  await again.click(await screen.findByRole("button", { name: "Show panel" }));
  await waitFor(() => expect(column("panel")).toBe(wide), { timeout: 1000 });
});

test("a key on the panel's handle while it is still sliding open sets its width all the same", async () => {
  const { user } = await mount();
  await user.click(await screen.findByRole("option", { name: /first/ }));
  await user.click(await screen.findByRole("button", { name: "Show panel" }));
  screen.getByRole("separator", { name: "Resize panel" }).focus();
  await user.keyboard("{ArrowLeft}{ArrowLeft}");
  await waitFor(() => expect(split().hasAttribute("data-animate")).toBe(false), { timeout: 1000 });
  const wide = column("panel");
  expect(wide).toBeGreaterThan(400);
  await user.click(screen.getByRole("button", { name: "Hide panel" }));
  await waitFor(() => expect(panel()).toBeNull(), { timeout: 1000 });
  await user.click(screen.getByRole("button", { name: "Show panel" }));
  await waitFor(() => expect(column("panel")).toBe(wide), { timeout: 1000 });
});
