// Environments (docs/desktop.md "环境"): the Settings section and its editor, the choice of one on the blank
// conversation, and a session's actions in its title bar. A variable's value is shown only in the editor.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { Environment, EnvironmentsState } from "../../src/api.ts";
import { viewKey } from "../../src/store/index.ts";
import { terminalTab } from "../../src/terminals.ts";
import { fakeBridge, summary } from "../fake-bridge.ts";
import { openSettings } from "./account-menu.ts";
import { openFolders, typeFolder } from "./blank.ts";
import { press, ready, write } from "./box.ts";
import { renderApp } from "./render-app.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const NODE: Environment = {
  id: "env-node",
  name: "Node",
  variables: [{ name: "DATABASE_URL", value: "postgres://secret@db/dev" }],
  actions: [{ id: "dev", name: "Dev server", command: { default: "npm run dev" } }],
};
const PYTHON: Environment = { id: "env-py", name: "Python", variables: [], actions: [] };

const ALL = {
  queue: true,
  files: true,
  folders: true,
  fs: true,
  diff: true,
  terminal: true,
  environments: true,
};

const mount = async (
  options: { environments?: EnvironmentsState; capabilities?: typeof ALL | object } = {},
) => {
  const script = fakeBridge({
    connected: true,
    capabilities: { ...ALL, ...options.capabilities } as typeof ALL,
    ...(options.environments !== undefined ? { environments: options.environments } : {}),
  });
  // Two folders with sessions on this computer: /work (newest) and /srv/api.
  script.bridge.sessions = async (locationId: string) => [
    summary("s1", locationId),
    { ...summary("s3", locationId), cwd: "/srv/api", updatedAt: "2019-12-01T00:00:00.000Z" },
  ];
  const store = await renderApp(script.bridge);
  return { user: userEvent.setup(), store, ...script };
};

const openEnvironments = async (user: ReturnType<typeof userEvent.setup>) => {
  await openSettings(user);
  await user.click(await screen.findByRole("tab", { name: "Environments" }));
  return screen.findByRole("tabpanel");
};

const newSession = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole("button", { name: "New session" }));
  await screen.findByRole("heading", { name: "New session" });
};

test("the section says there are none and offers to add one; the editor says what is wrong by line, and saves", async () => {
  const { user, named } = await mount();
  const page = await openEnvironments(user);
  expect(within(page).getByText("No environments yet.")).toBeTruthy();
  // The section's own button and the empty state's: both add one.
  await user.click(
    within(page).getAllByRole("button", { name: "Add environment" })[0] as HTMLElement,
  );
  const dialog = await screen.findByRole("dialog", { name: "Add an environment" });
  const name = within(dialog).getByRole("textbox", { name: "Name" });
  await waitFor(() => expect(document.activeElement).toBe(name));
  await user.type(name, "Node");
  const variables = within(dialog).getByRole("textbox", { name: "Variables" });
  await user.type(variables, "PATH=/x{Enter}not a line{Enter}A=1{Enter}A=2{Enter}9X=1");
  await user.click(within(dialog).getByRole("button", { name: "Add environment" }));
  const problems = await within(dialog).findByRole("alert");
  expect([...problems.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
    "Line 1: Cycle sets PATH for the agent, so an environment cannot change it.",
    "Line 2: write it as NAME=value.",
    "Line 4: A is already set on line 3.",
    "Line 5: 9X is not a variable name. Use letters, digits and _, and do not start with a digit.",
  ]);
  expect(variables.getAttribute("aria-invalid")).toBe("true");
  expect(named("saveEnvironment")).toEqual([]);
  // Fixed as it is typed: the lines that are wrong go as they are fixed.
  await user.clear(variables);
  await user.type(variables, '# the database{Enter}DATABASE_URL="postgres://secret@db/dev"');
  await waitFor(() => expect(within(dialog).queryByRole("alert")).toBeNull());

  await user.click(within(dialog).getByRole("button", { name: "Add action" }));
  await user.type(within(dialog).getByRole("textbox", { name: "Action name" }), "Dev server");
  // Saved with an action that has no command: said, and not saved.
  await user.click(within(dialog).getByRole("button", { name: "Add environment" }));
  expect((await within(dialog).findByRole("alert")).textContent).toBe(
    "Give the action Dev server a command.",
  );
  await user.type(within(dialog).getByRole("textbox", { name: "Command" }), "npm run dev");
  await user.click(within(dialog).getByRole("button", { name: "Add environment" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(named("saveEnvironment")).toHaveLength(1);
  expect(named("saveEnvironment")[0]?.[1]).toMatchObject({
    name: "Node",
    variables: [{ name: "DATABASE_URL", value: "postgres://secret@db/dev" }],
    actions: [{ name: "Dev server", command: { default: "npm run dev" } }],
  });
  // The row: its name and how many of each, never a value.
  const row = within(page).getByText("Node").closest('[data-slot="page-row"]') as HTMLElement;
  expect(row.textContent).toContain("1 variable · 1 action");
  expect(page.textContent).not.toContain("postgres");
});

test("an environment is edited, duplicated and removed from its row's menu; removing asks first", async () => {
  const { user, named } = await mount({ environments: { environments: [NODE], defaults: {} } });
  const page = await openEnvironments(user);
  await user.click(within(page).getByRole("button", { name: "Manage Node" }));
  await user.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
  const copy = await screen.findByRole("dialog", { name: "Add an environment" });
  expect(within(copy).getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe(
    "Node copy",
  );
  // The editor is the only place a value is shown.
  expect(within(copy).getByRole<HTMLTextAreaElement>("textbox", { name: "Variables" }).value).toBe(
    "DATABASE_URL=postgres://secret@db/dev",
  );
  await user.click(within(copy).getByRole("button", { name: "Add environment" }));
  await waitFor(() => expect(named("saveEnvironment")).toHaveLength(1));
  expect(named("saveEnvironment")[0]?.[1]).not.toMatchObject({ id: "env-node" });
  expect(await within(page).findByText("Node copy")).toBeTruthy();

  await user.click(within(page).getByRole("button", { name: "Manage Node" }));
  await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
  const confirm = await screen.findByRole("alertdialog", { name: "Remove Node?" });
  expect(confirm.textContent).toContain("Sessions that already use it keep their own copy.");
  // The keyboard starts on Cancel: a second Enter removes nothing.
  await waitFor(() =>
    expect(document.activeElement).toBe(within(confirm).getByRole("button", { name: "Cancel" })),
  );
  await user.click(within(confirm).getByRole("button", { name: "Remove environment" }));
  await waitFor(() =>
    expect(named("removeEnvironment")).toEqual([["removeEnvironment", "env-node"]]),
  );
  await waitFor(() => expect(within(page).queryByText("Node", { exact: true })).toBeNull());
});

test("the blank conversation starts with the workspace's environment; choosing one makes it the workspace's", async () => {
  const { user, named } = await mount({
    environments: { environments: [NODE, PYTHON], defaults: { local: { "/srv/api": "env-py" } } },
  });
  await newSession(user);
  // /work has none saved: "No environment".
  const picker = await screen.findByRole("button", { name: "Environment: No environment" });
  await user.click(picker);
  const menu = await screen.findByRole("menu", { name: "Environment" });
  expect(
    within(menu)
      .getAllByRole("menuitemradio")
      .map((i) => i.textContent),
  ).toEqual(["No environment", "Node", "Python"]);
  await user.click(within(menu).getByRole("menuitemradio", { name: "Node" }));
  await waitFor(() =>
    expect(named("setEnvironmentDefault")).toEqual([
      ["setEnvironmentDefault", "local", "/work", "env-node"],
    ]),
  );
  expect(await screen.findByRole("button", { name: "Environment: Node" })).toBeTruthy();

  // Another folder: its own default.
  const folders = await openFolders(user);
  await user.click(within(folders).getByRole("menuitem", { name: /^api/ }));
  expect(await screen.findByRole("button", { name: "Environment: Python" })).toBeTruthy();

  // The first message makes the session with it: main sends it whole, by its id.
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "Run the tests");
  await press(box, "Enter");
  await waitFor(() => expect(named("createSession")).toHaveLength(1));
  expect(named("createSession")[0]?.[2]).toMatchObject({
    cwd: "/srv/api",
    environmentId: "env-py",
  });
});

test("with no environment defined there is no choice, and none is sent", async () => {
  const { user, named } = await mount();
  await newSession(user);
  await screen.findByRole("button", { name: /^Folder: / });
  expect(screen.queryByRole("button", { name: /^Environment/ })).toBeNull();
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "Hello");
  await press(box, "Enter");
  await waitFor(() => expect(named("createSession")).toHaveLength(1));
  expect(named("createSession")[0]?.[2]).not.toHaveProperty("environmentId");
});

test("a location whose Cycle cannot take an environment shows the choice, unusable, and says why", async () => {
  const { user, named } = await mount({
    environments: { environments: [NODE], defaults: { local: { "/work": "env-node" } } },
    capabilities: { environments: false },
  });
  await newSession(user);
  const picker = await screen.findByRole("button", {
    name: "Cycle on This computer needs an update to use environments.",
  });
  expect(picker.getAttribute("aria-disabled")).toBe("true");
  // Reached by the keyboard, so its reason can be read; a press does nothing.
  picker.focus();
  await user.keyboard("{Enter}");
  expect(screen.queryByRole("menu", { name: "Environment" })).toBeNull();
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "Hello");
  await press(box, "Enter");
  await waitFor(() => expect(named("createSession")).toHaveLength(1));
  // The saved default is not sent to a daemon that would not take it.
  expect(named("createSession")[0]?.[2]).not.toHaveProperty("environmentId");
});

test("a session's actions are buttons in its title bar: one runs in a new terminal of the session, which is shown", async () => {
  const script = fakeBridge({ connected: true, capabilities: ALL });
  script.bridge.sessions = async () => [
    {
      ...summary("s1"),
      title: "first",
      environment: {
        id: "env-node",
        name: "Node",
        variableNames: ["DATABASE_URL"],
        actions: [{ id: "dev", name: "Dev server" }],
      },
    },
  ];
  const store = await renderApp(script.bridge);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("option", { name: /first/ }));
  await user.click(await screen.findByRole("button", { name: "Run Dev server in a new terminal" }));
  await waitFor(() => expect(script.named("createTerminal")).toHaveLength(1));
  expect(script.named("createTerminal")[0]?.slice(1)).toEqual(["local", "s1", 80, 24, "dev"]);
  await waitFor(() =>
    expect(store.sidePanels.get(viewKey("local", "s1")).active).toBe(terminalTab("t1")),
  );
  expect(
    script.calls.filter(([name, event]) => name === "track" && event === "terminal_opened"),
  ).toEqual([["track", "terminal_opened", { via: "action", count: "one" }]]);
});

test("a session without an environment, or one with no actions, has no action buttons", async () => {
  const script = fakeBridge({ connected: true, capabilities: ALL });
  script.bridge.sessions = async () => [
    { ...summary("s1"), title: "first" },
    {
      ...summary("s2"),
      title: "second",
      environment: { id: "e", name: "E", variableNames: [], actions: [] },
    },
  ];
  await renderApp(script.bridge);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("option", { name: /first/ }));
  await screen.findByRole("button", { name: "Session actions" });
  expect(screen.queryByRole("group", { name: "Environment actions" })).toBeNull();
  await user.click(await screen.findByRole("option", { name: /second/ }));
  await screen.findByRole("button", { name: "Session actions" });
  expect(screen.queryByRole("group", { name: "Environment actions" })).toBeNull();
});

test("an action's icon is chosen from a fixed set by its name, and saved by its id", async () => {
  const { user, named } = await mount({ environments: { environments: [NODE], defaults: {} } });
  const page = await openEnvironments(user);
  await user.click(within(page).getByRole("button", { name: "Manage Node" }));
  await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit Node" });
  // No icon yet: the terminal, as the title bar draws it.
  const icon = within(dialog).getByRole("combobox", { name: "Icon" });
  expect(icon.textContent).toBe("Terminal");
  icon.focus();
  await user.keyboard("{Enter}");
  const list = await screen.findByRole("listbox");
  expect(
    within(list)
      .getAllByRole("option")
      .map((o) => o.textContent),
  ).toEqual(["Terminal", "Run", "Test", "Build", "Database", "Server", "Refresh", "Clean"]);
  await user.click(within(list).getByRole("option", { name: "Run" }));
  await waitFor(() => expect(icon.textContent).toBe("Run"));
  expect(icon.querySelector("[data-icon]")?.getAttribute("data-icon")).toBe("play");
  await user.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(named("saveEnvironment")).toHaveLength(1));
  expect(named("saveEnvironment")[0]?.[1]).toMatchObject({
    actions: [{ id: "dev", name: "Dev server", icon: "play" }],
  });
});

test("an icon this version does not know is drawn as the terminal, and is written back unchanged", async () => {
  const rocket: Environment = {
    ...NODE,
    actions: [
      { id: "dev", name: "Dev server", icon: "rocket", command: { default: "npm run dev" } },
    ],
  };
  const { user, named } = await mount({ environments: { environments: [rocket], defaults: {} } });
  const page = await openEnvironments(user);
  await user.click(within(page).getByRole("button", { name: "Manage Node" }));
  await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit Node" });
  const icon = within(dialog).getByRole("combobox", { name: "Icon" });
  expect(icon.textContent).toBe("Terminal");
  await user.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(named("saveEnvironment")).toHaveLength(1));
  expect(named("saveEnvironment")[0]?.[1]).toMatchObject({
    actions: [{ id: "dev", icon: "rocket" }],
  });
});

test("the title bar draws each action's icon, and the terminal for one it does not know", async () => {
  const script = fakeBridge({ connected: true, capabilities: ALL });
  script.bridge.sessions = async () => [
    {
      ...summary("s1"),
      title: "first",
      environment: {
        id: "env-node",
        name: "Node",
        variableNames: [],
        actions: [
          { id: "db", name: "Database", icon: "database" },
          { id: "x", name: "Launch", icon: "rocket" },
          { id: "t", name: "Tests", icon: "test" },
          { id: "c", name: "Clean", icon: "clean" },
        ],
      },
    },
  ];
  await renderApp(script.bridge);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("option", { name: /first/ }));
  const iconOf = async (name: string) =>
    (await screen.findByRole("button", { name: `Run ${name} in a new terminal` }))
      .querySelector("[data-icon]")
      ?.getAttribute("data-icon");
  expect(await iconOf("Database")).toBe("database");
  expect(await iconOf("Launch")).toBe("terminal");
  // The rest are in the menu, each with its icon.
  const bar = screen.getByRole("group", { name: "Environment actions" });
  await user.click(within(bar).getByRole("button", { name: "More actions" }));
  const menu = await screen.findByRole("menu");
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => [
        item.textContent,
        item.querySelector("[data-icon]")?.getAttribute("data-icon"),
      ]),
  ).toEqual([
    ["Tests", "test"],
    ["Clean", "clean"],
  ]);
});

test("before a folder, the environment chosen waits; a folder without a default keeps it and saves it when the session is made", async () => {
  const script = fakeBridge({
    connected: true,
    capabilities: ALL,
    environments: { environments: [NODE, PYTHON], defaults: { local: { "/srv/api": "env-py" } } },
  });
  script.bridge.sessions = async () => [];
  await renderApp(script.bridge);
  const user = userEvent.setup();
  await newSession(user);
  // No folder yet, and the choice is there, at "No environment".
  await user.click(await screen.findByRole("button", { name: "Environment: No environment" }));
  await user.click(await screen.findByRole("menuitemradio", { name: "Node" }));
  expect(await screen.findByRole("button", { name: "Environment: Node" })).toBeTruthy();
  // Nothing saved: there is no workspace to save it for.
  expect(script.named("setEnvironmentDefault")).toEqual([]);

  await typeFolder(user, "/fresh");
  expect(await screen.findByRole("button", { name: "Environment: Node" })).toBeTruthy();
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "Hello");
  await press(box, "Enter");
  await waitFor(() => expect(script.named("createSession")).toHaveLength(1));
  expect(script.named("createSession")[0]?.[2]).toMatchObject({
    cwd: "/fresh",
    environmentId: "env-node",
  });
  await waitFor(() =>
    expect(script.named("setEnvironmentDefault")).toEqual([
      ["setEnvironmentDefault", "local", "/fresh", "env-node"],
    ]),
  );
});

test("before a folder, the environment chosen gives way to the saved default of the folder chosen after", async () => {
  const script = fakeBridge({
    connected: true,
    capabilities: ALL,
    environments: { environments: [NODE, PYTHON], defaults: { local: { "/srv/api": "env-py" } } },
  });
  script.bridge.sessions = async () => [];
  await renderApp(script.bridge);
  const user = userEvent.setup();
  await newSession(user);
  await user.click(await screen.findByRole("button", { name: "Environment: No environment" }));
  await user.click(await screen.findByRole("menuitemradio", { name: "Node" }));
  await typeFolder(user, "/srv/api");
  expect(await screen.findByRole("button", { name: "Environment: Python" })).toBeTruthy();
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "Hello");
  await press(box, "Enter");
  await waitFor(() => expect(script.named("createSession")).toHaveLength(1));
  expect(script.named("createSession")[0]?.[2]).toMatchObject({ environmentId: "env-py" });
  // The workspace had its own: nothing is saved over it.
  expect(script.named("setEnvironmentDefault")).toEqual([]);
});

test("with Antigravity and an environment that has variables, a quiet line says its own commands do not get them", async () => {
  const script = fakeBridge({
    connected: true,
    capabilities: ALL,
    environments: {
      environments: [NODE, PYTHON],
      defaults: { local: { "/work": "env-node", "/srv/api": "env-py" } },
    },
  });
  script.bridge.agents = async () => [
    { id: "agy", name: "Antigravity", available: true, configSchema: {} },
    { id: "claude", name: "Claude", available: true, configSchema: {} },
  ];
  script.bridge.sessions = async (locationId: string) => [
    summary("s1", locationId),
    { ...summary("s3", locationId), cwd: "/srv/api", updatedAt: "2019-12-01T00:00:00.000Z" },
  ];
  await renderApp(script.bridge);
  const user = userEvent.setup();
  await newSession(user);
  const note =
    "Antigravity runs its own commands without these variables. Terminals and actions have them.";
  expect(await screen.findByText(note)).toBeTruthy();
  // An environment with no variables: nothing to say.
  const folders = await openFolders(user);
  await user.click(within(folders).getByRole("menuitem", { name: /^api/ }));
  await screen.findByRole("button", { name: "Environment: Python" });
  expect(screen.queryByText(note)).toBeNull();
  // Claude gives them to its commands: nothing to say either.
  const again = await openFolders(user);
  await user.click(within(again).getByRole("menuitem", { name: /^work/ }));
  await screen.findByText(note);
  await user.click(screen.getByRole("button", { name: /^Agent: / }));
  await user.click(await screen.findByRole("menuitemradio", { name: "Claude" }));
  await waitFor(() => expect(screen.queryByText(note)).toBeNull());
});

test("an environment the file holds that the daemon would refuse says what to fix in its row", async () => {
  const twice: Environment = {
    id: "env-twice",
    name: "Twice",
    variables: [],
    actions: [
      { id: "a", name: "One", command: { default: "true" } },
      { id: "a", name: "Two", command: { default: "true" } },
    ],
  };
  const { user, named } = await mount({ environments: { environments: [twice], defaults: {} } });
  const page = await openEnvironments(user);
  const row = within(page).getByText("Twice").closest('[data-slot="page-row"]') as HTMLElement;
  expect(row.textContent).toContain("Needs a fix: Two actions have the same id, or one has none.");
  // Saving it again gives each action its own id.
  await user.click(within(page).getByRole("button", { name: "Manage Twice" }));
  await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit Twice" });
  await user.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(named("saveEnvironment")).toHaveLength(1));
  const saved = named("saveEnvironment")[0]?.[1] as Environment;
  expect(new Set(saved.actions.map((a) => a.id)).size).toBe(2);
  await waitFor(() => expect(row.textContent).toContain("0 variables · 2 actions"));
});
