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
      .map(
        (tab) => tab.querySelector('[data-slot="page-nav-label"]')?.textContent ?? tab.textContent,
      ),
  ).toEqual([
    "General",
    "Appearance",
    "Environments",
    "Keyboard shortcuts",
    "Claude",
    "Codex",
    "Antigravity",
    "Fake",
  ]);
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
  const page = await screen.findByRole("tabpanel", { name: "Environments" });
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
  await user.click(await screen.findByRole("tab", { name: "Fake" }));
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
  await user.click(await screen.findByRole("tab", { name: "Claude" }));
  expect(await screen.findByText("No environment is connected.")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Show environments" }));
  expect(await screen.findByRole("heading", { name: "Environments", level: 2 })).toBeTruthy();
});

test("an update that is ready can be started from Settings, after the same question", async () => {
  const { user, named } = await mount({
    update: { current: "0.1.0", kind: "available", version: "0.2.0" },
  });
  await openSettings(user);
  const page = await screen.findByRole("tabpanel", { name: "General" });
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
  const page = await screen.findByRole("tabpanel", { name: "Keyboard shortcuts" });
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

test("Harness tab shows Account & Usage, read-only Host diagnostics, refresh, and local reveal vs remote copy", async () => {
  const script = fakeBridge({
    connected: true,
    environments: [far],
    capabilities: { queue: true, files: true, folders: true, agentSetup: true },
  });
  script.bridge.agents = async () => [
    {
      id: "claude",
      name: "Claude",
      available: true,
      configSchema: {
        type: "object",
        properties: { model: { type: "string", title: "Model", enum: ["default", "opus"] } },
      },
    },
    { id: "codex", name: "Codex", available: true, configSchema: {} },
  ];
  script.bridge.readAgentSetup = async (environmentId, agent, opts) => {
    script.calls.push(["readAgentSetup", environmentId, agent, opts]);
    return {
      agent,
      name: agent === "codex" ? "Codex" : "Claude",
      available: true,
      binary: { source: "builtin", path: `/opt/cycle/${agent}`, version: "2.1.327" },
      auth:
        environmentId === "local"
          ? {
              state: "signed_in",
              method: "subscription",
              viaEnv: "ANTHROPIC_API_KEY",
              account: { email: "dev@example.com", plan: "max", organization: "Acme" },
              signInModes: [],
              canSignOut: false,
              loginCommand: `cycle login ${agent}`,
            }
          : {
              state: "signed_out",
              method: "none",
              signInModes: [],
              canSignOut: false,
              loginCommand: `cycle login ${agent}`,
            },
      planUsage:
        environmentId === "local"
          ? {
              windows: [
                {
                  kind: "five_hour",
                  utilization: 0.4,
                  resetsAt: Date.now() + 3_600_000,
                  status: "allowed",
                },
              ],
              at: Date.now(),
            }
          : undefined,
      canRefreshUsage: agent === "codex",
      runtime: {
        schemaVersion: 1,
        schema: { type: "object", properties: {} },
        values: {},
        overrides: [],
        revision: 0,
      },
      environment: {
        configFile: {
          path: "/home/dev/.cycle/config.json",
          exists: true,
          stale: environmentId === "far",
        },
        dataDir: `/home/dev/.cycle/${agent}`,
        customDataDir: false,
        allowEnv: ["HTTPS_PROXY", "PATH"],
        envNames: ["ANTHROPIC_API_KEY"],
      },
    };
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
  await user.click(await screen.findByRole("tab", { name: "Claude" }));

  // Account & Usage + PlanUsageBars + viaEnv variable name (never a secret value).
  expect(await screen.findByText("dev@example.com")).toBeTruthy();
  expect(screen.getByText(/Overridden by ANTHROPIC_API_KEY/)).toBeTruthy();
  expect(screen.getByText("5-hour limit")).toBeTruthy();

  // Read-only host diagnostics + local "Show in file manager".
  expect(screen.getByText("HTTPS_PROXY, PATH")).toBeTruthy();
  expect(screen.getByText("ANTHROPIC_API_KEY")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Show in file manager" }));
  await waitFor(() =>
    expect(script.named("revealDaemonConfig")).toEqual([["revealDaemonConfig", "local"]]),
  );

  // Refresh bypasses cache and requests usage.
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(script.named("readAgentSetup").at(-1)).toEqual([
      "readAgentSetup",
      "local",
      "claude",
      { forceRefresh: true, refreshUsage: true },
    ]),
  );

  // Switch to remote environment: shows signed out + copyable command + stale notice + Copy path.
  await user.click(screen.getByRole("combobox", { name: "Environment" }));
  await user.click(await screen.findByRole("option", { name: "Build box" }));
  expect(await screen.findByText("Not signed in")).toBeTruthy();
  expect(screen.getByText("config.json changed since daemon startup")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Copy sign-in command" }));
  await waitFor(() =>
    expect(tracked(script.calls)).toContainEqual([
      "agent_setup_command_copied",
      { agent: "claude", kind: "login" },
    ]),
  );
  expect(tracked(script.calls)).toContainEqual([
    "harness_settings_shown",
    { agent: "claude", environment: "local", from: "settings" },
  ]);
  expect(tracked(script.calls)).toContainEqual([
    "harness_settings_shown",
    { agent: "claude", environment: "remote", from: "settings" },
  ]);
});

test("older daemon without agentSetup capability smoothly degrades Harness tab to Session defaults without calling readAgentSetup", async () => {
  const script = fakeBridge({
    connected: true,
    capabilities: { queue: true, files: true, folders: true },
  });
  script.bridge.agents = async () => [
    {
      id: "claude",
      name: "Claude",
      available: true,
      configSchema: {
        type: "object",
        properties: { model: { type: "string", title: "Model", enum: ["sonnet", "opus"] } },
      },
    },
  ];
  const store = new AppStore(script.bridge);
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await act(() => store.start());
  const user = userEvent.setup();
  await openSettings(user);
  await user.click(await screen.findByRole("tab", { name: "Claude" }));
  expect(
    await screen.findByText(
      /Cycle on This computer is older and does not report account or host status/,
    ),
  ).toBeTruthy();
  expect(await screen.findByRole("combobox", { name: "Model" })).toBeTruthy();
  expect(script.named("readAgentSetup")).toHaveLength(0);
});

test("blank page auth/unavailable prompt opens the matching Harness settings tab when agentSetup is supported", async () => {
  const script = fakeBridge({
    connected: true,
    capabilities: { queue: true, files: true, folders: true, agentSetup: true },
  });
  script.bridge.agents = async () => [
    { id: "agy", name: "Antigravity", available: false, configSchema: {} },
  ];
  const store = new AppStore(script.bridge);
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await act(() => store.start());
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "New session" }));
  await user.click(await screen.findByRole("button", { name: "Open Antigravity settings" }));
  expect(await screen.findByRole("heading", { name: "Antigravity", level: 2 })).toBeTruthy();
  expect(tracked(script.calls)).toContainEqual([
    "harness_settings_shown",
    { agent: "agy", environment: "local", from: "blank" },
  ]);
});

test("Harness runtime settings support boolean/integer editing, enabledWhen, reset null, conflict reload, fileError read-only, unknown types, and hide when empty", async () => {
  const script = fakeBridge({
    connected: true,
    capabilities: { queue: true, files: true, folders: true, agentSetup: true },
  });
  script.bridge.agents = async () => [
    { id: "claude", name: "Claude", available: true, configSchema: {} },
    { id: "codex", name: "Codex", available: true, configSchema: {} },
    { id: "agy", name: "Antigravity", available: true, configSchema: {} },
  ];

  let claudeValues: Record<string, boolean | number | string> = {
    warmStart: true,
    maxWarm: 3,
    futureList: "v1",
  };
  let claudeOverrides: string[] = [];
  let claudeRevision = 1;
  let forceConflict = false;
  let agyFileError: string | undefined = "Unexpected token } in JSON";

  const claudeSchema = {
    type: "object" as const,
    properties: {
      warmStart: {
        type: "boolean",
        title: "Warm start",
        default: true,
        _meta: { "cycle/applyScope": "immediate" },
      },
      maxWarm: {
        type: "integer",
        title: "Max warm processes",
        minimum: 1,
        maximum: 10,
        default: 3,
        _meta: {
          "cycle/applyScope": "immediate",
          "cycle/enabledWhen": { key: "warmStart", equals: true },
        },
      },
      futureList: {
        type: "array",
        title: "Future array option",
        description: "From a newer daemon.",
      },
    },
  };

  script.bridge.readAgentSetup = async (_env, agent) => {
    script.calls.push(["readAgentSetup", _env, agent]);
    if (agent === "codex") {
      return {
        agent: "codex",
        name: "Codex",
        available: true,
        binary: { source: "path", path: "/usr/bin/codex", version: "0.90.0" },
        auth: {
          state: "signed_in",
          method: "subscription",
          signInModes: [],
          canSignOut: false,
          loginCommand: "cycle login codex",
        },
        canRefreshUsage: true,
        runtime: {
          schemaVersion: 1,
          schema: { type: "object", properties: {} },
          values: {},
          overrides: [],
          revision: 0,
        },
        environment: {
          configFile: { path: "/tmp/config.json", exists: true, stale: false },
          dataDir: "/tmp/codex",
          customDataDir: false,
          allowEnv: [],
          envNames: [],
        },
      };
    }
    if (agent === "agy") {
      return {
        agent: "agy",
        name: "Antigravity",
        available: true,
        binary: { source: "path", path: "/usr/bin/agy", version: "1.0.0" },
        auth: {
          state: "signed_in",
          method: "subscription",
          signInModes: [],
          canSignOut: false,
          loginCommand: "cycle login agy",
        },
        canRefreshUsage: false,
        runtime: {
          schemaVersion: 1,
          schema: {
            type: "object",
            properties: {
              sandbox: {
                type: "boolean",
                title: "Sandbox",
                default: false,
                _meta: { "cycle/applyScope": "next_idle_restart", "cycle/danger": true },
              },
            },
          },
          values: { sandbox: false },
          overrides: [],
          revision: 0,
          fileError: agyFileError,
        },
        environment: {
          configFile: { path: "/tmp/config.json", exists: true, stale: false },
          dataDir: "/tmp/agy",
          customDataDir: false,
          allowEnv: [],
          envNames: [],
        },
      };
    }
    return {
      agent: "claude",
      name: "Claude",
      available: true,
      binary: { source: "path", path: "/usr/bin/claude", version: "2.1.0" },
      auth: {
        state: "signed_in",
        method: "subscription",
        signInModes: [],
        canSignOut: false,
        loginCommand: "cycle login claude",
      },
      canRefreshUsage: false,
      runtime: {
        schemaVersion: 1,
        schema: claudeSchema,
        values: { ...claudeValues },
        overrides: [...claudeOverrides],
        revision: claudeRevision,
      },
      environment: {
        configFile: { path: "/tmp/config.json", exists: true, stale: false },
        dataDir: "/tmp/claude",
        customDataDir: false,
        allowEnv: [],
        envNames: [],
      },
    };
  };

  script.bridge.setAgentRuntimeSettings = async (env, agent, patch, expectedRevision) => {
    script.calls.push(["setAgentRuntimeSettings", env, agent, patch, expectedRevision]);
    if (forceConflict) {
      forceConflict = false;
      claudeRevision += 1;
      claudeValues = { ...claudeValues, maxWarm: 7 };
      return { saved: false, problem: "revision_conflict", currentRevision: claudeRevision };
    }
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) {
        claudeOverrides = claudeOverrides.filter((o) => o !== k);
        if (k === "warmStart") claudeValues = { ...claudeValues, warmStart: true };
        if (k === "maxWarm") claudeValues = { ...claudeValues, maxWarm: 3 };
      } else {
        if (!claudeOverrides.includes(k)) claudeOverrides = [...claudeOverrides, k];
        claudeValues = { ...claudeValues, [k]: v };
      }
    }
    claudeRevision += 1;
    return {
      saved: true,
      values: { ...claudeValues },
      overrides: [...claudeOverrides],
      revision: claudeRevision,
    };
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
  await user.click(await screen.findByRole("tab", { name: "Claude" }));

  // Agent settings group renders with warmStart switch, maxWarm integer input, and unknown array property read-only.
  expect(await screen.findByRole("heading", { name: "Agent settings" })).toBeTruthy();
  const warmSwitch = screen.getByRole("switch", { name: "Warm start" });
  const maxWarmInput = screen.getByRole("spinbutton", { name: "Max warm processes" });
  expect(warmSwitch.getAttribute("aria-checked")).toBe("true");
  expect((maxWarmInput as HTMLInputElement).disabled).toBe(false);
  expect(screen.getByText("Future array option")).toBeTruthy();
  expect(screen.getByText(/Read-only in this version of Cycle/)).toBeTruthy();

  // Toggling warmStart off sends { warmStart: false } with expectedRevision=1 and disables maxWarm (enabledWhen).
  await user.click(warmSwitch);
  await waitFor(() =>
    expect(script.named("setAgentRuntimeSettings").at(-1)).toEqual([
      "setAgentRuntimeSettings",
      "local",
      "claude",
      { warmStart: false },
      1,
    ]),
  );
  await waitFor(() => expect((maxWarmInput as HTMLInputElement).disabled).toBe(true));

  // Reset button appears for overridden warmStart and sends { warmStart: null }.
  await user.click(screen.getByRole("button", { name: "Reset Warm start to default" }));
  await waitFor(() =>
    expect(script.named("setAgentRuntimeSettings").at(-1)).toEqual([
      "setAgentRuntimeSettings",
      "local",
      "claude",
      { warmStart: null },
      2,
    ]),
  );
  await waitFor(() => expect((maxWarmInput as HTMLInputElement).disabled).toBe(false));

  // Revision conflict shows conflict banner and Reload fetches latest values.
  forceConflict = true;
  await user.click(warmSwitch);
  expect(await screen.findByText("Settings changed elsewhere")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Reload" }));
  await waitFor(() => expect((maxWarmInput as HTMLInputElement).value).toBe("7"));

  // Codex has empty runtime schema & no fileError: Agent settings group is hidden.
  await user.click(screen.getByRole("tab", { name: "Codex" }));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Agent settings" })).toBeNull());

  // Antigravity with fileError renders error notice and read-only (disabled) switch + caution tag.
  await user.click(screen.getByRole("tab", { name: "Antigravity" }));
  expect(await screen.findByText("agent-settings.json could not be read")).toBeTruthy();
  const sandboxSwitch = screen.getByRole("switch", { name: "Sandbox" });
  expect(
    sandboxSwitch.getAttribute("aria-disabled") === "true" ||
      (sandboxSwitch as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(screen.getByText("Caution")).toBeTruthy();
  agyFileError = undefined;
});

test("Harness sign-in dialog displays verified host without auto-opening browser, supports code submission, disconnect fallback, and sign-out confirmation", async () => {
  const script = fakeBridge({
    connected: true,
    capabilities: { queue: true, files: true, folders: true, agentSetup: true },
  });
  script.bridge.agents = async () => [
    { id: "claude", name: "Claude", available: true, configSchema: {} },
  ];

  let signedIn = false;
  script.bridge.readAgentSetup = async (_env, _agent, options) => {
    // A forced read answers last, so the silent read the daemon's broadcast starts overtakes it (as it can for real).
    if (options?.forceRefresh === true) await new Promise((resolve) => setTimeout(resolve, 30));
    return {
      agent: "claude",
      name: "Claude",
      available: true,
      binary: { source: "path", path: "/usr/bin/claude", version: "2.1.0" },
      auth: {
        state: signedIn ? "signed_in" : "signed_out",
        method: signedIn ? "subscription" : "none",
        ...(signedIn ? { account: { email: "dev@example.com" } } : {}),
        signInModes: [{ mode: "code", requiresLocalLoopback: false }],
        canSignOut: true,
        loginCommand: "cycle login claude",
      },
      canRefreshUsage: false,
      runtime: {
        schemaVersion: 1,
        schema: { type: "object", properties: {} },
        values: {},
        overrides: [],
        revision: 0,
      },
      environment: {
        configFile: { path: "/tmp/config.json", exists: true, stale: false },
        dataDir: "/tmp/claude",
        customDataDir: false,
        allowEnv: [],
        envNames: [],
      },
    };
  };

  let flowCounter = 0;
  script.bridge.startAgentAuth = async (env, agent) => {
    script.calls.push(["startAgentAuth", env, agent]);
    flowCounter++;
    return {
      started: true,
      flowId: `flow-${flowCounter}`,
      mode: "code",
      expiresAt: Date.now() + 600_000,
      host: "claude.ai",
      hasUrl: true,
    };
  };

  script.bridge.logoutAgent = async (env, agent) => {
    script.calls.push(["logoutAgent", env, agent]);
    signedIn = false;
    return { ok: true };
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
  await user.click(await screen.findByRole("tab", { name: "Claude" }));

  // 1. Click Sign in -> dialog shows verified host & fallback command; openAgentAuthUrl NOT called until user clicks.
  await user.click(await screen.findByRole("button", { name: "Sign in" }));
  expect(await screen.findByText(/Continue in your browser at claude\.ai/)).toBeTruthy();
  expect(script.named("openAgentAuthUrl")).toHaveLength(0);
  expect(screen.getAllByText("cycle login claude").length).toBeGreaterThanOrEqual(1);

  // Explicit click opens verified browser URL.
  await user.click(screen.getByRole("button", { name: "Open in browser" }));
  await waitFor(() =>
    expect(script.named("openAgentAuthUrl")).toEqual([["openAgentAuthUrl", "local", "flow-1"]]),
  );

  // 2. Simulate disconnect mid-flow: shows clear disconnect message + fallback command.
  act(() => {
    script.emit({
      type: "agent-auth-completed",
      environmentId: "local",
      flowId: "flow-1",
      agent: "claude",
      ok: false,
      reason: "disconnected",
    });
  });
  expect(await screen.findByText(/Connection was interrupted/)).toBeTruthy();

  // 3. Retry -> submit code -> complete sign-in -> transitions to Signed in.
  await user.click(screen.getByRole("button", { name: "Try again" }));
  const codeInput = await screen.findByLabelText("Authorization code");
  await user.type(codeInput, "ONE-TIME-CODE");
  await user.click(screen.getByRole("button", { name: "Complete sign-in" }));
  await waitFor(() =>
    expect(script.named("submitAgentAuth")).toEqual([
      ["submitAgentAuth", "local", "flow-2", "ONE-TIME-CODE"],
    ]),
  );

  signedIn = true;
  act(() => {
    // As the daemon does: the initiator hears it finished, then everyone hears the setup changed.
    script.emit({
      type: "agent-auth-completed",
      environmentId: "local",
      flowId: "flow-2",
      agent: "claude",
      ok: true,
    });
  });
  act(() => {
    script.emit({ type: "agent-setup-changed", environmentId: "local", agent: "claude" });
  });
  expect(await screen.findByText("dev@example.com")).toBeTruthy();
  // The forced read that the sign-in started was overtaken; its spinner still ends with it.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Refresh" }).hasAttribute("disabled")).toBe(false),
  );

  // 4. Sign out requires ConfirmDialog confirmation before calling logoutAgent.
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  expect(await screen.findByText("Sign out of Claude?")).toBeTruthy();
  expect(script.named("logoutAgent")).toHaveLength(0);
  const confirmButtons = screen.getAllByRole("button", { name: "Sign out" });
  await user.click(confirmButtons[confirmButtons.length - 1] as HTMLElement);
  await waitFor(() =>
    expect(script.named("logoutAgent")).toEqual([["logoutAgent", "local", "claude"]]),
  );
  expect(await screen.findByText("Not signed in")).toBeTruthy();
});

test("Codex sign-in supports browser waiting flow locally and device_code userCode + copy flow on remote environments", async () => {
  const script = fakeBridge({
    environments: [far],
    connected: true,
    capabilities: { queue: true, files: true, folders: true, agentSetup: true },
  });
  script.bridge.agents = async () => [
    { id: "codex", name: "Codex", available: true, configSchema: {} },
  ];
  script.bridge.readAgentSetup = async () => ({
    agent: "codex",
    name: "Codex",
    available: true,
    binary: { source: "path", path: "/usr/bin/codex", version: "0.166.0" },
    auth: {
      state: "signed_out",
      method: "none",
      signInModes: [
        { mode: "browser", requiresLocalLoopback: true },
        { mode: "device_code", requiresLocalLoopback: false },
      ],
      canSignOut: true,
      loginCommand: "cycle login codex",
    },
    canRefreshUsage: true,
    runtime: {
      schemaVersion: 1,
      schema: { type: "object", properties: {} },
      values: {},
      overrides: [],
      revision: 0,
    },
    environment: {
      configFile: { path: "/tmp/config.json", exists: true, stale: false },
      dataDir: "/tmp/codex",
      customDataDir: false,
      allowEnv: [],
      envNames: [],
    },
  });
  script.bridge.startAgentAuth = async (env, agent) => {
    script.calls.push(["startAgentAuth", env, agent]);
    if (env === "local") {
      return {
        started: true,
        flowId: "codex-local-1",
        mode: "browser",
        expiresAt: Date.now() + 600_000,
        host: "auth.openai.com",
        hasUrl: true,
      };
    }
    return {
      started: true,
      flowId: "codex-remote-1",
      mode: "device_code",
      expiresAt: Date.now() + 600_000,
      host: "auth.openai.com",
      hasUrl: true,
      userCode: "ZNH8-01S7L",
    };
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
  await user.click(await screen.findByRole("tab", { name: "Codex" }));

  // Local: browser mode shows verified host + waiting status, no auto-open.
  await user.click(await screen.findByRole("button", { name: "Sign in" }));
  expect(await screen.findByText(/Continue in your browser at auth\.openai\.com/)).toBeTruthy();
  expect(screen.getByText("Waiting for browser sign-in to finish…")).toBeTruthy();
  expect(script.named("openAgentAuthUrl")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(script.named("cancelAgentAuth")).toEqual([
      ["cancelAgentAuth", "local", "codex-local-1"],
    ]),
  );

  // Remote: device_code mode shows userCode + Copy code + verified host click-to-open.
  await user.click(screen.getByRole("combobox", { name: "Environment" }));
  await user.click(await screen.findByRole("option", { name: "Build box" }));
  await user.click(await screen.findByRole("button", { name: "Sign in" }));
  expect(await screen.findByText("ZNH8-01S7L")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Copy code" }));
  await waitFor(() => expect(script.named("copyText")).toContainEqual(["copyText", "ZNH8-01S7L"]));
  await user.click(screen.getByRole("button", { name: "Open in browser" }));
  await waitFor(() =>
    expect(script.named("openAgentAuthUrl")).toEqual([
      ["openAgentAuthUrl", "far", "codex-remote-1"],
    ]),
  );
});
