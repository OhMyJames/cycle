import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { ConnectorInfo, PluginFailure, PluginInfo, PluginSourceInfo } from "../../src/api.ts";
import { mountApp } from "./mount.tsx";

// The Plugins section of the Connectors page (CYCL-84, docs/protocol.md §15).

afterEach(cleanup);

const directory: PluginSourceInfo = {
  agentId: "claude",
  id: "directory",
  name: "Plugin directory",
  kind: "builtin",
  removable: false,
};
const team: PluginSourceInfo = {
  agentId: "claude",
  id: "team",
  name: "team-plugins",
  kind: "git",
  location: "acme/team-plugins",
  removable: true,
};

const available = (name: string, description: string, sourceId = "directory"): PluginInfo => ({
  agentId: "claude",
  id: `${name}@${sourceId}`,
  name,
  description,
  sourceId,
  installed: false,
});

const tracker: PluginInfo = {
  ...available("tracker", "Issues and projects"),
  installed: true,
  enabled: true,
  scope: "user",
  version: "1.2.0",
  contents: { skills: 2, commands: 0, agents: 0, hooks: 1, mcpServers: 1 },
  servers: [{ name: "api", by: "cycle", connectorId: "c-tracker" }],
};

const trackerServer: ConnectorInfo = {
  id: "c-tracker",
  name: "tracker-api",
  enabled: true,
  transport: { type: "http", url: "https://mcp.tracker.example/mcp" },
  auth: { type: "oauth" },
  secrets: { headers: [], env: [] },
  authorized: false,
  status: { state: "needs_auth" },
  origin: {
    type: "plugin",
    agentId: "claude",
    pluginId: "tracker@directory",
    pluginName: "tracker",
    server: "api",
  },
};

const mount = async (
  options: {
    all?: PluginInfo[];
    sources?: PluginSourceInfo[];
    connectors?: ConnectorInfo[];
    plugins?: string[];
  } = {},
) => {
  const plugins: {
    sources: PluginSourceInfo[];
    all: PluginInfo[];
    fail?: PluginFailure | undefined;
  } = {
    sources: options.sources ?? [{ ...directory }],
    all: options.all ?? [],
  };
  const app = await mountApp({
    capabilities: {
      queue: true,
      files: true,
      folders: true,
      connectors: true,
      plugins: options.plugins ?? ["claude"],
    },
    connectors: options.connectors ?? [],
    plugins,
  });
  await app.user.click(await screen.findByRole("button", { name: "Connectors" }));
  const page = await screen.findByRole("tabpanel", { name: "Plugins" });
  return { ...app, page, plugins };
};

const group = (page: HTMLElement, title: string): HTMLElement =>
  within(page).getByRole("heading", { name: title, level: 3 }).closest("section") as HTMLElement;

const tracked = (calls: [string, ...unknown[]][]) =>
  calls.filter(([name]) => name === "track").map(([, event, props]) => [event, props]);

test("the page opens on Plugins: nothing installed is said with the way on, and what can be installed is listed with where it comes from", async () => {
  const { user, page, calls, named } = await mount({
    all: [available("linear", "Issue tracking"), available("figma", "Design files")],
  });
  const installed = group(page, "Installed");
  expect(await within(installed).findByText("No plugins installed yet.")).toBeTruthy();
  expect(within(installed).getByText("Install one from the list below.")).toBeTruthy();

  const list = group(page, "Available");
  expect(await within(list).findByText("linear")).toBeTruthy();
  expect(within(list).getByText("Issue tracking")).toBeTruthy();
  expect(within(list).getAllByText("Plugin directory")).toHaveLength(2);
  expect(within(list).getByText("Showing 2 of 2")).toBeTruthy();
  // One source: nothing to choose among.
  expect(within(list).queryByRole("combobox", { name: "Source" })).toBeNull();
  expect(named("listPlugins")[0]).toEqual(["listPlugins", "local", "claude"]);

  // The other section is a tab away, and going there is reported by its word only.
  await user.click(screen.getByRole("tab", { name: "MCP servers" }));
  expect(await screen.findByRole("heading", { name: "MCP servers", level: 2 })).toBeTruthy();
  expect(tracked(calls)).toEqual([
    ["panel_opened", { panel: "connectors", via: "click" }],
    ["connectors_section_shown", { section: "mcp" }],
  ]);
});

test("installing asks first and says what a plugin can do; only a yes installs it", async () => {
  const { user, page, named } = await mount({ all: [available("linear", "Issue tracking")] });
  const list = group(page, "Available");
  await user.click(await within(list).findByRole("button", { name: "Install linear" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Install linear?" });
  expect(dialog.textContent).toContain("It comes from Plugin directory.");
  expect(dialog.textContent).toContain("can run code on Local");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(named("installPlugin")).toHaveLength(0);

  await user.click(within(list).getByRole("button", { name: "Install linear" }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Install plugin" }),
  );
  const installed = group(page, "Installed");
  expect(await within(installed).findByText("linear")).toBeTruthy();
  expect(within(installed).getByText("On · 1 skill")).toBeTruthy();
  expect(named("installPlugin")).toEqual([
    ["installPlugin", "local", "claude", "linear@directory"],
  ]);
  // In the list it is now marked, not offered again.
  await waitFor(() => expect(within(list).getByText("Installed")).toBeTruthy());
  expect(within(list).queryByRole("button", { name: "Install linear" })).toBeNull();
});

test("an install the agent refuses is said under its row: our sentence, then the agent's own words", async () => {
  const { user, page, plugins } = await mount({ all: [available("linear", "Issue tracking")] });
  plugins.fail = { problem: "not_found", message: 'Plugin "linear" not found in marketplace' };
  const list = group(page, "Available");
  await user.click(await within(list).findByRole("button", { name: "Install linear" }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Install plugin" }),
  );
  expect(
    await within(list).findByText("It was not found. Refresh the lists, then try again."),
  ).toBeTruthy();
  expect(within(list).getByText('Plugin "linear" not found in marketplace')).toBeTruthy();
  // Still offered.
  expect(within(list).getByRole("button", { name: "Install linear" })).toBeTruthy();
});

test("an installed plugin says what it brings, is switched and updated, and uninstalling asks first", async () => {
  const { user, page, named } = await mount({ all: [{ ...tracker }] });
  const installed = group(page, "Installed");
  expect(
    await within(installed).findByText("On · Version 1.2.0 · 2 skills · 1 hook · 1 MCP server"),
  ).toBeTruthy();

  await user.click(within(installed).getByRole("switch", { name: "Use tracker in sessions" }));
  expect(await within(installed).findByText(/^Off · /)).toBeTruthy();
  expect(named("setPluginEnabled")).toEqual([
    ["setPluginEnabled", "local", "claude", "tracker@directory", false],
  ]);

  await user.click(within(installed).getByRole("button", { name: "Actions for tracker" }));
  await user.click(await screen.findByRole("menuitem", { name: "Update" }));
  expect(await within(installed).findByText("tracker is already the latest version.")).toBeTruthy();

  await user.click(within(installed).getByRole("button", { name: "Actions for tracker" }));
  await user.click(await screen.findByRole("menuitem", { name: "Uninstall" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Uninstall tracker?" });
  expect(named("uninstallPlugin")).toHaveLength(0);
  await user.click(within(dialog).getByRole("button", { name: "Uninstall plugin" }));
  expect(await within(installed).findByText("No plugins installed yet.")).toBeTruthy();
  expect(named("uninstallPlugin")).toEqual([
    ["uninstallPlugin", "local", "claude", "tracker@directory"],
  ]);
});

test("a plugin whose server wants a sign-in offers it on its own row; the server is a connector that is the plugin's", async () => {
  const { user, page, named } = await mount({
    all: [{ ...tracker }],
    connectors: [{ ...trackerServer }],
  });
  const installed = group(page, "Installed");
  expect(await within(installed).findByText("Its api server needs a sign-in.")).toBeTruthy();
  await user.click(within(installed).getByRole("button", { name: "Sign in" }));
  await waitFor(() =>
    expect(within(installed).queryByText("Its api server needs a sign-in.")).toBeNull(),
  );
  expect(named("authorizeConnector")).toEqual([["authorizeConnector", "local", "c-tracker"]]);

  // Among the MCP servers it says whose it is, and is not switched, edited or removed there.
  await user.click(screen.getByRole("tab", { name: "MCP servers" }));
  const mcp = await screen.findByRole("tabpanel", { name: "MCP servers" });
  expect(await within(mcp).findByText("From the tracker plugin")).toBeTruthy();
  expect(within(mcp).queryByRole("switch")).toBeNull();
  await user.click(within(mcp).getByRole("button", { name: "Actions for tracker-api" }));
  expect(await screen.findByRole("menuitem", { name: "Sign out" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "Edit" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Remove" })).toBeNull();
});

test("a server that wants a key of the person's asks for it by name; the value goes to the daemon and is not shown", async () => {
  const keyed: ConnectorInfo = {
    ...trackerServer,
    auth: { type: "none" },
    requires: ["TRACKER_TOKEN"],
  };
  const { user, page, named } = await mount({ all: [{ ...tracker }], connectors: [keyed] });
  const installed = group(page, "Installed");
  expect(await within(installed).findByText("Its api server needs a value.")).toBeTruthy();
  await user.click(within(installed).getByRole("button", { name: "Set values" }));
  const dialog = await screen.findByRole("dialog", { name: "Values for api" });
  const field = within(dialog).getByLabelText("TRACKER_TOKEN") as HTMLInputElement;
  expect(document.activeElement).toBe(field);
  expect(field.type).toBe("password");
  expect(within(dialog).getByRole("button", { name: "Save values" })).toHaveProperty(
    "disabled",
    true,
  );
  await user.type(field, "sk-very-secret{Enter}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(named("updateConnector")).toEqual([
    [
      "updateConnector",
      "local",
      "c-tracker",
      { secrets: { env: { TRACKER_TOKEN: "sk-very-secret" } } },
    ],
  ]);
  expect(document.body.textContent).not.toContain("sk-very-secret");
});

test("the list is searched and narrowed to a source, and more of a long one is asked for a page at a time", async () => {
  const many = Array.from({ length: 70 }, (_, i) =>
    available(`plugin-${String(i).padStart(2, "0")}`, "One of many"),
  );
  const { user, page, named } = await mount({
    all: [...many, available("reviewer", "Reviews changes", "team")],
    sources: [{ ...directory }, { ...team }],
  });
  const list = group(page, "Available");
  expect(await within(list).findByText("Showing 30 of 71")).toBeTruthy();
  await user.click(within(list).getByRole("button", { name: "Show more" }));
  expect(await within(list).findByText("Showing 60 of 71")).toBeTruthy();
  expect(named("availablePlugins").at(-1)?.[2]).toMatchObject({ cursor: "30", limit: 30 });

  await user.type(within(list).getByRole("searchbox", { name: "Search plugins" }), "review");
  expect(await within(list).findByText("Showing 1 of 1")).toBeTruthy();
  expect(within(list).getByText("team-plugins")).toBeTruthy();

  await user.clear(within(list).getByRole("searchbox", { name: "Search plugins" }));
  await user.type(within(list).getByRole("searchbox", { name: "Search plugins" }), "zzz");
  expect(await within(list).findByText("No plugin matches “zzz”.")).toBeTruthy();
});

test("a source is added after saying what that means, refreshed, and removed after asking; the one the agent comes with stays", async () => {
  const { user, page, named, plugins } = await mount({ sources: [{ ...directory }, { ...team }] });
  const sources = group(page, "Sources");
  expect(await within(sources).findByText("Comes with claude")).toBeTruthy();
  expect(within(sources).getByText("acme/team-plugins")).toBeTruthy();
  expect(within(sources).queryByRole("button", { name: "Remove Plugin directory" })).toBeNull();

  await user.click(within(sources).getByRole("button", { name: "Add source" }));
  const form = await screen.findByRole("dialog", { name: "Add a source" });
  const field = within(form).getByRole("textbox", { name: "Repository, URL or folder" });
  expect(document.activeElement).toBe(field);
  expect(form.textContent).toContain("can be installed and run on Local");
  await user.type(field, "acme/more-plugins{Enter}");
  expect(await within(sources).findByText("more-plugins")).toBeTruthy();
  expect(named("addPluginSource")).toEqual([
    ["addPluginSource", "local", "claude", "acme/more-plugins"],
  ]);

  await user.click(within(sources).getByRole("button", { name: "Refresh lists" }));
  expect(await within(sources).findByText("The lists are up to date.")).toBeTruthy();

  plugins.fail = { problem: "timeout" };
  await user.click(within(sources).getByRole("button", { name: "Refresh lists" }));
  expect(
    await within(sources).findByText(
      "claude did not answer in time. Check the network on Local, then try again.",
    ),
  ).toBeTruthy();
  plugins.fail = undefined;

  await user.click(within(sources).getByRole("button", { name: "Remove team-plugins" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Remove team-plugins?" });
  await user.click(within(dialog).getByRole("button", { name: "Remove source" }));
  await waitFor(() => expect(within(sources).queryByText("acme/team-plugins")).toBeNull());
  expect(named("removePluginSource")).toEqual([["removePluginSource", "local", "claude", "team"]]);
});

test("plugins that cannot be read say why in the system's words, and can be asked for again", async () => {
  const { user, page, bridge } = await mount({ all: [{ ...tracker }] });
  const installed = group(page, "Installed");
  await within(installed).findByText("tracker");
  const real = bridge.listPlugins;
  bridge.listPlugins = async () => {
    throw new Error("spawn claude ENOENT");
  };
  await user.click(within(group(page, "Sources")).getByRole("button", { name: "Refresh lists" }));
  expect(await within(installed).findByText("The plugins could not be read.")).toBeTruthy();
  expect(within(installed).getByText("spawn claude ENOENT")).toBeTruthy();
  // What was read before stays under it.
  expect(within(installed).getByText("tracker")).toBeTruthy();
  bridge.listPlugins = real;
  await user.click(within(installed).getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(within(installed).queryByText("The plugins could not be read.")).toBeNull(),
  );
});

test("a location whose Cycle knows no plugins says so on that section, and still keeps its connectors", async () => {
  const { user, page, named } = await mount({ plugins: [] });
  expect(within(page).getByText("Cycle on Local is too old for this.")).toBeTruthy();
  expect(named("listPlugins")).toHaveLength(0);
  await user.click(screen.getByRole("tab", { name: "MCP servers" }));
  expect(await screen.findByText("No connectors yet.")).toBeTruthy();
});

test("a sign-in from a plugin's row is waited for and can be given up; one the server refuses says why", async () => {
  const { user, page, bridge } = await mount({
    all: [{ ...tracker }],
    connectors: [{ ...trackerServer }],
  });
  const installed = group(page, "Installed");
  let answer: (value: { cancelled: true } | { problem: "auth_rejected" }) => void = () => {};
  bridge.authorizeConnector = () =>
    new Promise((resolve) => {
      answer = resolve;
    });
  bridge.cancelConnectorAuth = async () => {
    answer({ cancelled: true });
  };
  await user.click(await within(installed).findByRole("button", { name: "Sign in" }));
  expect(
    await within(installed).findByText("Finish signing in to api in your browser."),
  ).toBeTruthy();
  await user.click(within(installed).getByRole("button", { name: "Stop waiting" }));
  expect(await within(installed).findByRole("button", { name: "Sign in" })).toBeTruthy();
  expect(within(installed).queryByRole("alert")).toBeNull();

  await user.click(within(installed).getByRole("button", { name: "Sign in" }));
  await within(installed).findByRole("button", { name: "Stop waiting" });
  answer({ problem: "auth_rejected" });
  const refused = await within(installed).findByRole("alert");
  expect(refused.textContent).not.toBe("");
  expect(within(installed).getByRole("button", { name: "Sign in" })).toBeTruthy();
});
