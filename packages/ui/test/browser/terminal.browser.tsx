import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { FitAddon } from "@xterm/addon-fit";
import { afterEach, expect, test, vi } from "vitest";
import { cdp, userEvent } from "vitest/browser";
import type { TerminalInfo, TerminalProblem } from "../../src/api.ts";
import { App, StoreProvider } from "../../src/react/index.ts";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge, summary } from "../fake-bridge.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const running = (terminalId: string, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({
  terminalId,
  sessionId: "s1",
  title: "zsh",
  cols: 80,
  rows: 24,
  status: "running",
  ...extra,
});

const mount = async (
  options: {
    terminals?: Map<string, TerminalInfo[]>;
    terminalProblem?: TerminalProblem;
    terminal?: boolean;
  } = {},
) => {
  const script = fakeBridge({
    connected: true,
    capabilities: {
      queue: true,
      files: true,
      folders: true,
      fs: true,
      diff: true,
      terminal: options.terminal ?? true,
    },
    ...(options.terminals !== undefined ? { terminals: options.terminals } : {}),
    ...(options.terminalProblem !== undefined ? { terminalProblem: options.terminalProblem } : {}),
  });
  script.bridge.sessions = async () => [{ ...summary("s1"), title: "first" }];
  const store = new AppStore(script.bridge);
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await act(() => store.start());
  const user = userEvent.setup();
  await user.click(await screen.findByRole("option", { name: /first/ }));
  const tracked = () =>
    script.calls
      .filter(([name]) => name === "track")
      .map(([, event, props]) => [event, props])
      .filter(([event]) => String(event).startsWith("terminal"));
  return { store, user, script, tracked };
};

/** What the terminal's screen shows, as text. */
const screenText = () =>
  document.querySelector('[data-slot="terminal-screen"] .xterm-rows')?.textContent ?? "";

test("a daemon without terminals has no Terminal button", async () => {
  await mount({ terminal: false });
  expect(screen.queryByRole("button", { name: "Show terminal" })).toBeNull();
});

test("the Terminal button opens a shell in a tab of its own, with the keyboard in it", async () => {
  const { user, script, tracked } = await mount();
  await user.click(await screen.findByRole("button", { name: "Show terminal" }));
  const tab = await screen.findByRole("tab", { name: "zsh", selected: true });
  expect(tab).toBeDefined();
  expect(script.named("createTerminal")[0]?.slice(1, 3)).toEqual(["local", "s1"]);
  // Shown: attached, and drawn from the daemon's screen.
  await waitFor(() => expect(screenText()).toContain("screen of t1"));
  await waitFor(() =>
    expect(document.activeElement?.closest('[data-slot="terminal-screen"]')).not.toBeNull(),
  );
  // What is typed goes to the shell as it is.
  await user.keyboard("ls");
  await waitFor(() => expect(script.named("terminalInput").map((c) => c[3])).toEqual(["l", "s"]));
  // Output after the screen is drawn; a piece the screen already holds is not.
  act(() => {
    script.emit({
      type: "terminal-output",
      environmentId: "local",
      terminalId: "t1",
      seq: 2,
      data: "OLD",
    });
    script.emit({
      type: "terminal-output",
      environmentId: "local",
      terminalId: "t1",
      seq: 4,
      data: "fresh",
    });
  });
  await waitFor(() => expect(screenText()).toContain("fresh"));
  expect(screenText()).not.toContain("OLD");
  expect(tracked()).toEqual([["terminal_opened", { via: "header", count: "one" }]]);
  // On a terminal already, the button closes the panel.
  await user.click(screen.getByRole("button", { name: "Hide terminal" }));
  await waitFor(() => expect(document.querySelector('[data-slot="side-panel"]')).toBeNull());
  expect(script.named("detachTerminal").length).toBeGreaterThan(0);
});

test("a terminal in a panel that is opening is measured at the panel's width, not again on every frame", async () => {
  const fits = vi.spyOn(FitAddon.prototype, "fit");
  try {
    const { user } = await mount({ terminals: new Map([["s1", [running("t1")]]]) });
    await user.click(await screen.findByRole("button", { name: "Show terminal" }));
    const host = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-slot="terminal-screen"]');
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    // Through the whole slide, a frame at a time: the screen keeps one size, so what fits it to the panel is not woken.
    let resized = 0;
    const watch = new ResizeObserver(() => resized++);
    watch.observe(host);
    const widths = new Set<number>();
    let frames = 0;
    const until = performance.now() + 300;
    while (performance.now() < until) {
      widths.add(host.clientWidth);
      frames++;
      await new Promise((done) => requestAnimationFrame(done));
    }
    watch.disconnect();
    expect(widths.size).toBe(1);
    // The first call is the observer's own, on being given the element.
    expect(resized).toBe(1);
    await waitFor(() => expect(screenText()).toContain("screen of t1"));
    // A handful, when it is shown, its font comes in and the daemon's screen is written; not one a frame.
    expect(frames).toBeGreaterThan(10);
    expect(fits.mock.calls.length).toBeLessThan(frames / 2);
  } finally {
    fits.mockRestore();
  }
});

test("New terminal opens another; closing a tab ends its shell and shows the one before it", async () => {
  const { user, script, tracked } = await mount({
    terminals: new Map([["s1", [running("a", { title: "build" })]]]),
  });
  // A terminal already there: the button shows it rather than opening another.
  await user.click(await screen.findByRole("button", { name: "Show terminal" }));
  await screen.findByRole("tab", { name: "build", selected: true });
  expect(script.named("createTerminal")).toEqual([]);
  await user.click(screen.getByRole("button", { name: "New terminal" }));
  await screen.findByRole("tab", { name: "zsh", selected: true });
  // The keyboard closes the focused tab with Delete.
  await user.click(screen.getByRole("tab", { name: "zsh" }));
  await user.keyboard("{Delete}");
  await screen.findByRole("tab", { name: "build", selected: true });
  expect(screen.queryByRole("tab", { name: "zsh" })).toBeNull();
  expect(script.named("closeTerminal").map((c) => c[2])).toEqual(["t1"]);
  expect(tracked()).toEqual([
    ["terminal_opened", { via: "tab_strip", count: "few" }],
    ["terminal_closed", { state: "running", count: "one" }],
  ]);
});

test("a shell that exited says so, takes no keys, and its tab can be closed from there", async () => {
  const terminals = new Map([["s1", [running("a")]]]);
  const { user, script, store } = await mount({ terminals });
  await user.click(await screen.findByRole("button", { name: "Show terminal" }));
  await waitFor(() => expect(screenText()).toContain("screen of a"));
  act(() =>
    script.emit({
      type: "terminals",
      environmentId: "local",
      sessionId: "s1",
      terminals: [running("a", { status: "exited", exitCode: 3 })],
    }),
  );
  expect(await screen.findByText("The shell exited with code 3.")).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Close terminal" }));
  await waitFor(() => expect(screen.queryByRole("tab", { name: "zsh" })).toBeNull());
  expect(screen.getByRole("tab", { name: "Overview", selected: true })).toBeDefined();
  // The panel remembers the tab it went to, not the terminal that is gone.
  expect(store.sidePanels.get("local:s1").active).toBe("overview");
});

test("a terminal that could not be opened says why, in the page's words", async () => {
  const { user, tracked } = await mount({ terminalProblem: "limit" });
  await user.click(await screen.findByRole("button", { name: "Show terminal" }));
  expect(
    await screen.findByText("Too many terminals are open. Close one to open another."),
  ).toBeDefined();
  expect(tracked()).toEqual([["terminal_open_failed", { reason: "limit" }]]);
});

test("terminals that went while the connection was away stay as tabs that say they ended", async () => {
  const terminals = new Map([["s1", [running("a")]]]);
  const { user, script } = await mount({ terminals });
  await user.click(await screen.findByRole("button", { name: "Show terminal" }));
  await screen.findByRole("tab", { name: "zsh", selected: true });
  act(() =>
    script.emit({ type: "environment-status", environmentId: "local", state: "reconnecting" }),
  );
  expect(
    await screen.findByText(/Typing works again once the environment reconnects/),
  ).toBeDefined();
  // The daemon came back without it (it stopped meanwhile).
  terminals.set("s1", []);
  act(() =>
    script.emit({
      type: "environment-status",
      environmentId: "local",
      state: "connected",
      capabilities: { queue: true, files: true, folders: true, terminal: true },
    }),
  );
  expect(
    await screen.findByText("This terminal ended when the environment's daemon stopped."),
  ).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Close tab" }));
  await waitFor(() => expect(screen.queryByRole("tab", { name: "zsh" })).toBeNull());
  expect(script.named("closeTerminal")).toEqual([]);
});

test("when the theme turns dark, a program's red becomes GitHub Dark's", async () => {
  const media = (value: string) =>
    cdp().send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value }],
    });
  try {
    const { user, script } = await mount({ terminals: new Map([["s1", [running("a")]]]) });
    await user.click(await screen.findByRole("button", { name: "Show terminal" }));
    await waitFor(() => expect(screenText()).toContain("screen of a"));
    act(() =>
      script.emit({
        type: "terminal-output",
        environmentId: "local",
        terminalId: "a",
        seq: 4,
        data: "\x1b[31mRED\x1b[0m",
      }),
    );
    const red = () =>
      [...document.querySelectorAll(".xterm-rows span")].find((el) => el.textContent === "RED");
    await waitFor(() => expect(getComputedStyle(red() as Element).color).toBe("rgb(207, 34, 46)"));
    await media("dark");
    await waitFor(() =>
      expect(getComputedStyle(red() as Element).color).toBe("rgb(255, 123, 114)"),
    );
  } finally {
    await media("");
  }
});

/** What the panel's tabs say, in order. */
const tabNames = () => screen.getAllByRole("tab").map((tab) => tab.textContent);

test("three terminals: each its own tab and screen, one closed leaves the others, and after the last another opens", async () => {
  const { user, script } = await mount();
  await user.click(await screen.findByRole("button", { name: "Show terminal" }));
  await user.click(await screen.findByRole("button", { name: "New terminal" }));
  await user.click(await screen.findByRole("button", { name: "New terminal" }));
  // All three start as the shell's name: each tab still reads as its own.
  await screen.findByRole("tab", { name: "zsh 3", selected: true });
  expect(tabNames()).toEqual(["Overview", "zsh", "zsh 2", "zsh 3"]);
  await waitFor(() => expect(screenText()).toContain("screen of t3"));
  // Switching shows that terminal's own screen.
  await user.click(screen.getByRole("tab", { name: "zsh" }));
  await waitFor(() => expect(screenText()).toContain("screen of t1"));
  expect(screenText()).not.toContain("screen of t3");
  // A terminal's tab looks like the panel's other tabs.
  const overview = getComputedStyle(screen.getByRole("tab", { name: "Overview" }));
  const terminal = getComputedStyle(screen.getByRole("tab", { name: "zsh" }));
  for (const property of ["height", "font-family", "font-size", "font-weight", "border-radius"])
    expect(terminal.getPropertyValue(property)).toBe(overview.getPropertyValue(property));
  // Closing the middle one with its cross leaves the other two (the last now second of its name, so "zsh 2").
  const middle = screen.getByRole("tab", { name: "zsh 2" });
  await user.hover(middle);
  await user.click(middle.querySelector('[data-slot="panel-tab-close"]') as HTMLElement);
  await waitFor(() => expect(tabNames()).toEqual(["Overview", "zsh", "zsh 2"]));
  expect(script.named("closeTerminal").map((c) => c[2])).toEqual(["t2"]);
  // The other two closed from the keyboard: a new one still opens from the strip.
  await user.click(screen.getByRole("tab", { name: "zsh 2" }));
  await user.keyboard("{Delete}");
  await user.click(await screen.findByRole("tab", { name: "zsh", selected: true }));
  await user.keyboard("{Delete}");
  await waitFor(() => expect(tabNames()).toEqual(["Overview"]));
  await user.click(screen.getByRole("button", { name: "New terminal" }));
  await screen.findByRole("tab", { name: "zsh", selected: true });
  await waitFor(() => expect(screenText()).toContain("screen of t4"));
});

test("in the light theme a program's red is GitHub Light's, on the panel's own ground", async () => {
  const { user, script } = await mount({ terminals: new Map([["s1", [running("a")]]]) });
  await user.click(await screen.findByRole("button", { name: "Show terminal" }));
  await waitFor(() => expect(screenText()).toContain("screen of a"));
  act(() =>
    script.emit({
      type: "terminal-output",
      environmentId: "local",
      terminalId: "a",
      seq: 4,
      data: "\x1b[31mRED\x1b[0m",
    }),
  );
  await waitFor(() => expect(screenText()).toContain("RED"));
  const red = [...document.querySelectorAll(".xterm-rows span")].find(
    (el) => el.textContent === "RED",
  );
  expect(red).toBeDefined();
  expect(getComputedStyle(red as Element).color).toBe("rgb(207, 34, 46)");
});

test("opening a terminal lets go of the attachment it came with before its tab attaches", async () => {
  const { user, script } = await mount();
  await user.click(await screen.findByRole("button", { name: "Show terminal" }));
  await waitFor(() => expect(script.named("attachTerminal").length).toBe(1));
  const order = script.calls
    .map(([name]) => name)
    .filter((name) => ["createTerminal", "detachTerminal", "attachTerminal"].includes(name));
  expect(order).toEqual(["createTerminal", "detachTerminal", "attachTerminal"]);
});

test("pressed before the list has come, the Terminal button shows the terminal there instead of opening one", async () => {
  const terminals = new Map([["s1", [running("a", { title: "build" })]]]);
  const script = fakeBridge({
    connected: true,
    capabilities: { queue: true, files: true, folders: true, terminal: true },
    terminals,
  });
  script.bridge.sessions = async () => [{ ...summary("s1"), title: "first" }];
  const list = script.bridge.listTerminals;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  script.bridge.listTerminals = async (...args) => {
    await held;
    return list(...args);
  };
  const store = new AppStore(script.bridge);
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await act(() => store.start());
  const user = userEvent.setup();
  await user.click(await screen.findByRole("option", { name: /first/ }));
  await user.click(await screen.findByRole("button", { name: "Show terminal" }));
  release();
  await screen.findByRole("tab", { name: "build", selected: true });
  expect(script.named("createTerminal")).toEqual([]);
});

test("a close the daemon did not take gives the tab back, and says why", async () => {
  const terminals = new Map([["s1", [running("a", { title: "build" })]]]);
  const { user, script } = await mount({ terminals });
  script.bridge.closeTerminal = async () => {
    throw new Error("Not connected to the daemon");
  };
  await user.click(await screen.findByRole("button", { name: "Show terminal" }));
  await user.click(await screen.findByRole("tab", { name: "build", selected: true }));
  await user.keyboard("{Delete}");
  expect(await screen.findByText("Not connected to the daemon")).toBeDefined();
  expect(await screen.findByRole("tab", { name: "build" })).toBeDefined();
});

test("after a reconnect, news of another terminal that comes before the list does not lose the ones that ended", async () => {
  const terminals = new Map([["s1", [running("a")]]]);
  const { user, script } = await mount({ terminals });
  await user.click(await screen.findByRole("button", { name: "Show terminal" }));
  await screen.findByRole("tab", { name: "zsh", selected: true });
  act(() =>
    script.emit({ type: "environment-status", environmentId: "local", state: "reconnecting" }),
  );
  const list = script.bridge.listTerminals;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  script.bridge.listTerminals = async (...args) => {
    await held;
    return list(...args);
  };
  terminals.set("s1", [running("b", { title: "other" })]);
  act(() =>
    script.emit({
      type: "environment-status",
      environmentId: "local",
      state: "connected",
      capabilities: { queue: true, files: true, folders: true, terminal: true },
    }),
  );
  act(() =>
    script.emit({
      type: "terminals",
      environmentId: "local",
      sessionId: "s1",
      terminals: [running("b", { title: "other" })],
    }),
  );
  release();
  expect(
    await screen.findByText("This terminal ended when the environment's daemon stopped."),
  ).toBeDefined();
  expect(screen.getByRole("tab", { name: "other" })).toBeDefined();
});
