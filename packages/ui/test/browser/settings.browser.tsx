import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { EnvironmentConfig } from "../../src/api.ts";
import { App, StoreProvider } from "../../src/react/index.ts";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge } from "../fake-bridge.ts";
import { accountMenu, openSettings } from "./account-menu.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const far: EnvironmentConfig = {
  id: "far",
  name: "Build box",
  kind: "remote",
  transport: { type: "ssh", host: "me@box" },
};

const mount = async (options: Parameters<typeof fakeBridge>[0] = {}) => {
  const script = fakeBridge({ connected: true, ...options });
  const store = new AppStore(script.bridge);
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await act(() => store.start());
  return { user: userEvent.setup(), store, ...script };
};
const mod = /Mac/.test(navigator.userAgent) ? "Meta" : "Control";
const tracked = (calls: [string, ...unknown[]][]) =>
  calls.filter(([name]) => name === "track").map(([, event, props]) => [event, props]);

test("Settings is a page over the sessions: its button opens it, Escape goes back to where the keyboard was", async () => {
  const { user, calls } = await mount();
  await openSettings(user);
  const sections = await screen.findByRole("tablist", { name: "Settings sections" });
  expect(
    within(sections)
      .getAllByRole("tab")
      .map((tab) => tab.textContent),
  ).toEqual(["General", "Appearance", "Environments", "Session defaults", "Keyboard shortcuts"]);
  expect(screen.getByRole("heading", { name: "General", level: 2 })).toBeTruthy();
  // The keyboard is on the sections, and the sessions under the page are not reachable.
  expect(document.activeElement).toBe(within(sections).getByRole("tab", { name: "General" }));
  expect(screen.queryByRole("button", { name: "New session" })).toBeNull();

  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("tablist", { name: "Settings sections" })).toBeNull(),
  );
  expect(screen.getByRole("button", { name: "New session" })).toBeTruthy();
  expect(document.activeElement).toBe(await accountMenu());
  expect(tracked(calls)).toEqual([["panel_opened", { panel: "settings", via: "click" }]]);
});

test("the shortcut opens and closes Settings, the arrows walk its sections, and it comes back on the section it was left on", async () => {
  const { user, calls } = await mount();
  await accountMenu();
  await user.keyboard(`{${mod}>},{/${mod}}`);
  await screen.findByRole("tablist", { name: "Settings sections" });
  await user.keyboard("{ArrowDown}");
  expect(await screen.findByRole("heading", { name: "Appearance", level: 2 })).toBeTruthy();
  await user.keyboard(`{${mod}>},{/${mod}}`);
  await waitFor(() => expect(screen.queryByRole("tablist")).toBeNull());
  await user.keyboard(`{${mod}>},{/${mod}}`);
  expect(await screen.findByRole("heading", { name: "Appearance", level: 2 })).toBeTruthy();
  expect(tracked(calls)).toEqual([
    ["panel_opened", { panel: "settings", via: "shortcut" }],
    ["settings_section_shown", { section: "appearance" }],
    ["panel_opened", { panel: "settings", via: "shortcut" }],
  ]);
});

test("the environments are listed with how each stands, one that is away can be connected again, and one can be added", async () => {
  const { user, named, emit } = await mount({ environments: [far], states: { far: "closed" } });
  await act(async () =>
    emit({
      type: "environment-status",
      environmentId: "far",
      state: "closed",
      error: "ssh: connect to host box port 22: Connection refused",
    }),
  );
  await openSettings(user);
  await user.click(await screen.findByRole("tab", { name: "Environments" }));
  const page = (await screen.findByRole("heading", { name: "Environments", level: 2 }))
    .parentElement as HTMLElement;
  expect(within(page).getByText("This computer")).toBeTruthy();
  expect(within(page).getByText("Connected")).toBeTruthy();
  expect(within(page).getByText("Build box")).toBeTruthy();
  expect(within(page).getByText("me@box")).toBeTruthy();
  // The system's own words, as they came.
  expect(
    within(page).getByText("ssh: connect to host box port 22: Connection refused"),
  ).toBeTruthy();
  // This computer is not one to edit or remove.
  expect(within(page).queryByRole("button", { name: "Actions for This computer" })).toBeNull();
  await user.click(within(page).getByRole("button", { name: "Connect again" }));
  await waitFor(() => expect(named("connect")).toEqual([["connect", "far"]]));

  await user.click(within(page).getByRole("button", { name: "Add environment" }));
  const dialog = await screen.findByRole("dialog", { name: "Add an environment" });
  await user.type(within(dialog).getByLabelText("Address"), "me@other");
  await user.click(within(dialog).getByRole("button", { name: "Add" }));
  await waitFor(() => expect(named("saveEnvironment")).toHaveLength(1));
  // Still in Settings: the dialog closed over the page it was opened from.
  expect(screen.getByRole("heading", { name: "Environments", level: 2 })).toBeTruthy();
});

test("an agent's defaults are read, changed and saved for the environment chosen", async () => {
  const script = fakeBridge({ connected: true, environments: [far] });
  const schema = {
    type: "object",
    properties: { model: { type: "string", title: "Model", enum: ["sonnet", "opus"] } },
  };
  script.bridge.agents = async () => [
    { id: "fake", name: "Fake", available: true, configSchema: schema },
  ];
  script.bridge.agentDefaults = async (environmentId) => {
    script.calls.push(["agentDefaults", environmentId]);
    return { model: "sonnet" };
  };
  const store = new AppStore(script.bridge);
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await act(() => store.start());
  const user = userEvent.setup();
  await openSettings(user);
  await user.click(await screen.findByRole("tab", { name: "Session defaults" }));
  // Two environments are connected: which one's defaults is a choice, and it starts on the one that is open.
  const environment = await screen.findByRole("combobox", { name: "Environment" });
  expect(environment.textContent).toContain("This computer");
  const model = await screen.findByRole("combobox", { name: "Model" });
  expect(model.textContent).toContain("sonnet");
  await user.click(environment);
  await user.click(await screen.findByRole("option", { name: "Build box" }));
  await waitFor(() =>
    expect(script.named("agentDefaults").at(-1)).toEqual(["agentDefaults", "far"]),
  );
  await user.click(await screen.findByRole("combobox", { name: "Model" }));
  await user.click(await screen.findByRole("option", { name: "opus" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(script.named("setAgentDefaults")).toEqual([
      ["setAgentDefaults", "far", "fake", { model: "opus" }],
    ]),
  );
  expect(await screen.findByText("Saved")).toBeTruthy();
  // The environment tells every client its defaults changed, the one that saved them too: the form reads them again
  // where it is, still on the environment chosen and still saying it saved.
  await act(async () => {
    script.emit({ type: "agent-defaults", environmentId: "far", agent: "fake" });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(screen.getByText("Saved")).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Environment" }).textContent).toContain("Build box");
  expect(screen.queryByText("Reading the defaults…")).toBeNull();
});

test("with no environment connected, the defaults say so and lead to the environments", async () => {
  const { user } = await mount({ connected: false });
  await openSettings(user);
  await user.click(await screen.findByRole("tab", { name: "Session defaults" }));
  expect(await screen.findByText("No environment is connected.")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Show environments" }));
  expect(await screen.findByRole("heading", { name: "Environments", level: 2 })).toBeTruthy();
});

test("an update that is ready can be started from Settings, after the same question", async () => {
  const { user, named } = await mount({
    update: { current: "0.1.0", kind: "available", version: "0.2.0" },
  });
  await openSettings(user);
  const page = (await screen.findByRole("heading", { name: "General", level: 2 }))
    .parentElement as HTMLElement;
  expect(within(page).getByText("Cycle 0.1.0")).toBeTruthy();
  expect(within(page).getByText("Version 0.2.0 is available")).toBeTruthy();
  await user.click(within(page).getByRole("button", { name: "Update and restart" }));
  const confirm = await screen.findByRole("alertdialog", { name: "Update to 0.2.0?" });
  expect(named("installUpdate")).toHaveLength(0);
  await user.click(within(confirm).getByRole("button", { name: "Update and restart" }));
  await waitFor(() => expect(named("installUpdate")).toHaveLength(1));
});

test("starting a new session leaves Settings for it", async () => {
  const { user } = await mount();
  await openSettings(user);
  await screen.findByRole("tablist", { name: "Settings sections" });
  await user.keyboard(`{${mod}>}n{/${mod}}`);
  await waitFor(() =>
    expect(screen.queryByRole("tablist", { name: "Settings sections" })).toBeNull(),
  );
  expect(await screen.findByRole("textbox", { name: "Message" })).toBeTruthy();
});

test("the language is a choice kept by main: the whole interface changes at once, and back", async () => {
  const { user, named } = await mount();
  await openSettings(user);
  const language = await screen.findByRole("combobox", { name: "Language" });
  // Following the system says which language that comes to.
  expect(language.textContent).toContain("Match system (English)");
  await user.click(language);
  await user.click(await screen.findByRole("option", { name: "简体中文" }));
  await waitFor(() =>
    expect(named("setPreferences")).toEqual([["setPreferences", { language: "zh-CN" }]]),
  );
  expect(await screen.findByRole("heading", { name: "通用", level: 2 })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "外观" })).toBeTruthy();
  expect(document.documentElement.lang).toBe("zh-CN");
  // Each language is named in its own words, so the way back can be read from either.
  await user.click(screen.getByRole("combobox", { name: "语言" }));
  await user.click(await screen.findByRole("option", { name: "English" }));
  expect(await screen.findByRole("heading", { name: "General", level: 2 })).toBeTruthy();
  expect(document.documentElement.lang).toBe("en-US");
});

test("a system in simplified Chinese is followed from the first thing drawn", async () => {
  await mount({ preferences: { systemLanguage: "zh-Hans-CN" } });
  expect(await screen.findByRole("button", { name: "搜索会话" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "New session" })).toBeNull();
});

test("the theme is one of three, and choosing one asks main to apply and keep it", async () => {
  const { user, named } = await mount();
  await openSettings(user);
  await user.click(await screen.findByRole("tab", { name: "Appearance" }));
  const theme = await screen.findByRole("radiogroup", { name: "Theme" });
  expect(
    within(theme)
      .getAllByRole("radio")
      .map((r) => r.textContent),
  ).toEqual(["Match system", "Light", "Dark"]);
  const dark = within(theme).getByRole("radio", { name: "Dark" });
  expect(
    within(theme).getByRole("radio", { name: "Match system" }).getAttribute("aria-checked"),
  ).toBe("true");
  await user.click(dark);
  await waitFor(() =>
    expect(named("setPreferences")).toEqual([["setPreferences", { theme: "dark" }]]),
  );
  await waitFor(() => expect(dark.getAttribute("aria-checked")).toBe("true"));
});

test("the shortcuts are listed with their keys, to look up and not to change", async () => {
  const { user } = await mount();
  await openSettings(user);
  await user.click(await screen.findByRole("tab", { name: "Keyboard shortcuts" }));
  const page = (await screen.findByRole("heading", { name: "Keyboard shortcuts", level: 2 }))
    .parentElement as HTMLElement;
  const row = within(page).getByText("Open or close Settings").closest('[data-slot="page-row"]');
  expect(Array.from(row?.querySelectorAll("kbd") ?? []).map((k) => k.textContent)).toEqual([
    /Mac/.test(navigator.userAgent) ? "⌘" : "Ctrl",
    ",",
  ]);
  expect(within(page).queryByRole("textbox")).toBeNull();
  expect(within(page).queryByRole("button")).toBeNull();
});

test("Settings stays while it is used, also when what was open under it goes away", async () => {
  const { user, store, named } = await mount({ environments: [far] });
  await act(() => store.selectSession("far", "s1"));
  await openSettings(user);
  await user.click(await screen.findByRole("tab", { name: "Environments" }));
  await user.click(await screen.findByRole("button", { name: "Actions for Build box" }));
  await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
  const confirm = await screen.findByRole("alertdialog", { name: "Remove Build box?" });
  // The shortcut does not take the page away from under a question it is asking.
  await user.keyboard(`{${mod}>},{/${mod}}`);
  expect(screen.getByRole("alertdialog", { name: "Remove Build box?" })).toBeTruthy();
  await user.click(within(confirm).getByRole("button", { name: "Remove environment" }));
  await waitFor(() => expect(named("removeEnvironment")).toHaveLength(1));
  // The session that was open was on it and is gone: the person is still where they were working.
  expect(screen.getByRole("heading", { name: "Environments", level: 2 })).toBeTruthy();
});

test("a notification's session is shown over Settings, also when it is the one already open", async () => {
  const { user, store, emit } = await mount();
  await act(() => store.selectSession("local", "s1"));
  await openSettings(user);
  await screen.findByRole("tablist", { name: "Settings sections" });
  await act(async () => emit({ type: "focus-session", environmentId: "local", sessionId: "s1" }));
  await waitFor(() =>
    expect(screen.queryByRole("tablist", { name: "Settings sections" })).toBeNull(),
  );
});

test("leaving Settings for a new session leaves the keyboard with the new session, not on the button that opened Settings", async () => {
  const { user } = await mount();
  await openSettings(user);
  await screen.findByRole("tablist", { name: "Settings sections" });
  await user.keyboard(`{${mod}>}n{/${mod}}`);
  await screen.findByRole("textbox", { name: "Message" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(document.activeElement).not.toBe(await accountMenu());
});
