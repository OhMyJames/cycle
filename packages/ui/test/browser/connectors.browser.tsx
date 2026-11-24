import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { ConnectorInfo, LocationConfig } from "../../src/api.ts";
import { fakeBridge } from "../fake-bridge.ts";
import { renderApp } from "./render-app.tsx";

afterEach(cleanup);

const notion: ConnectorInfo = {
  id: "c1",
  name: "notion",
  enabled: true,
  transport: { type: "http", url: "https://mcp.notion.example/mcp" },
  auth: { type: "oauth" },
  secrets: { headers: [], env: [] },
  authorized: false,
  status: { state: "needs_auth" },
};

const far: LocationConfig = {
  id: "far",
  name: "Build box",
  kind: "remote",
  transport: { type: "ssh", host: "me@box" },
};

const mount = async (
  options: { connectors?: ConnectorInfo[]; capable?: boolean; locations?: LocationConfig[] } = {},
) => {
  const script = fakeBridge({
    connected: true,
    capabilities: {
      queue: true,
      files: true,
      folders: true,
      connectors: options.capable !== false,
    },
    connectors: options.connectors ?? [],
    ...(options.locations !== undefined ? { locations: options.locations } : {}),
  });
  const store = await renderApp(script.bridge);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Connectors" }));
  // The page opens on its first section, Plugins (plugins.browser.tsx): these are about the second.
  await user.click(await screen.findByRole("tab", { name: "MCP servers" }));
  // The section that is shown: everything of the page that is not its navigation.
  const page = await screen.findByRole("tabpanel", { name: "MCP servers" });
  return { user, page, store, ...script };
};
/** What the page reported, without the change of section `mount` itself makes. */
const tracked = (calls: [string, ...unknown[]][]) =>
  calls
    .filter(([name, event]) => name === "track" && event !== "connectors_section_shown")
    .map(([, event, props]) => [event, props]);

test("Connectors is a page over the sessions: its button opens it, Escape goes back to where the keyboard was", async () => {
  const { user, page, calls } = await mount();
  const sections = screen.getByRole("tablist", { name: "Connectors sections" });
  expect(
    within(sections)
      .getAllByRole("tab")
      .map((tab) => tab.textContent),
  ).toEqual(["Plugins", "MCP servers"]);
  // The keyboard is on the sections, and the sessions under the page are not reachable.
  expect(document.activeElement).toBe(within(sections).getByRole("tab", { name: "MCP servers" }));
  expect(screen.queryByRole("button", { name: "New session" })).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  // One location can keep connectors: there is nothing to choose.
  expect(within(page).queryByRole("combobox", { name: "Work in" })).toBeNull();
  // With none yet, the page says so and offers the way to add one, once.
  expect(await within(page).findByText("No connectors yet.")).toBeTruthy();
  expect(within(page).getAllByRole("button", { name: "Add connector" })).toHaveLength(1);

  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("tablist")).toBeNull());
  expect(screen.getByRole("button", { name: "New session" })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Connectors" }));
  expect(tracked(calls)).toEqual([["panel_opened", { panel: "connectors", via: "click" }]]);
});

test("Escape closes what is open over the page first, and the settings shortcut goes from the page to Settings", async () => {
  const { user, page } = await mount();
  await user.click(await within(page).findByRole("button", { name: "Add connector" }));
  const form = await screen.findByRole("dialog", { name: "Add a connector" });
  // A form dialog opens on its first field.
  expect(document.activeElement).toBe(within(form).getByRole("textbox", { name: "Name" }));
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("tablist", { name: "Connectors sections" })).toBeTruthy();

  const mod = /Mac/.test(navigator.userAgent) ? "Meta" : "Control";
  await user.keyboard(`{${mod}>},{/${mod}}`);
  expect(await screen.findByRole("tablist", { name: "Settings sections" })).toBeTruthy();
  expect(screen.queryByRole("tablist", { name: "Connectors sections" })).toBeNull();
});

test("no location that can keep connectors is said, not asked, with the way to the locations", async () => {
  const { user, page, named, calls } = await mount({ capable: false });
  expect(
    within(page).getByText("No connected location can keep connectors or plugins."),
  ).toBeTruthy();
  expect(within(page).queryByRole("button", { name: "Add connector" })).toBeNull();
  expect(named("listConnectors")).toHaveLength(0);
  await user.click(within(page).getByRole("button", { name: "Show locations" }));
  expect(await screen.findByRole("heading", { name: "Work in", level: 2 })).toBeTruthy();
  expect(screen.queryByRole("tablist", { name: "Connectors sections" })).toBeNull();
  expect(tracked(calls)).toEqual([
    ["panel_opened", { panel: "connectors", via: "click" }],
    ["panel_opened", { panel: "settings", via: "click" }],
  ]);
});

test("with several locations the page says whose connectors it shows, and another can be chosen", async () => {
  const { user, page, named } = await mount({ locations: [far], connectors: [{ ...notion }] });
  // It starts on the location that is open.
  const location = await within(page).findByRole("combobox", { name: "Work in" });
  expect(location.textContent).toContain("This computer");
  await waitFor(() => expect(named("listConnectors")).toEqual([["listConnectors", "local"]]));
  await user.click(location);
  await user.click(await screen.findByRole("option", { name: "Build box" }));
  await waitFor(() => expect(named("listConnectors").at(-1)).toEqual(["listConnectors", "far"]));
  expect(await within(page).findByText(/every agent on Build box can use/)).toBeTruthy();
});

test("a location that goes away is no longer the one the page manages", async () => {
  const { page, emit } = await mount({ connectors: [{ ...notion }] });
  expect(await within(page).findByText("notion")).toBeTruthy();
  await act(async () =>
    emit({ type: "location-status", locationId: "local", state: "reconnecting" }),
  );
  expect(
    await within(page).findByText("No connected location can keep connectors or plugins."),
  ).toBeTruthy();
  expect(within(page).queryByText("notion")).toBeNull();
});

test("a list that cannot be read says why, in the system's words, and can be asked for again", async () => {
  const script = fakeBridge({
    connected: true,
    capabilities: { queue: true, files: true, folders: true, connectors: true },
    connectors: [{ ...notion }],
  });
  const listed = script.bridge.listConnectors;
  script.bridge.listConnectors = async () => {
    throw new Error("Error invoking remote method 'cycle:listConnectors': Error: Not connected");
  };
  await renderApp(script.bridge);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Connectors" }));
  await user.click(await screen.findByRole("tab", { name: "MCP servers" }));
  const failed = await screen.findByRole("alert");
  expect(within(failed).getByText("The connectors could not be read.")).toBeTruthy();
  expect(within(failed).getByText("Not connected")).toBeTruthy();
  script.bridge.listConnectors = listed;
  await user.click(within(failed).getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("notion")).toBeTruthy();
  expect(screen.queryByText("The connectors could not be read.")).toBeNull();
});

test("a connector that does not work says how, and a change the daemon refuses is said under its row", async () => {
  const broken: ConnectorInfo = {
    ...notion,
    auth: { type: "none" },
    status: { state: "error", reason: "unreachable" },
  };
  const { user, page, bridge, calls } = await mount({ connectors: [broken] });
  expect(await within(page).findByText("Cannot be reached")).toBeTruthy();
  expect(within(page).getByText("mcp.notion.example")).toBeTruthy();
  bridge.updateConnector = async () => ({ problem: "failed", message: "disk is full" });
  await user.click(within(page).getByRole("switch", { name: "Use notion in sessions" }));
  expect(await within(page).findByRole("alert")).toHaveProperty(
    "textContent",
    "It could not be done: disk is full",
  );
  // What is counted is that the page was opened: no name, no address, none of the daemon's words.
  const events = JSON.stringify(tracked(calls));
  expect(events).not.toContain("notion");
  expect(events).not.toContain("disk");
});

test("adds an HTTP connector with a header; the value is sent, and only its name is shown after", async () => {
  const { user, page, named } = await mount();
  await user.click(await within(page).findByRole("button", { name: "Add connector" }));
  const form = await screen.findByRole("dialog", { name: "Add a connector" });
  await user.type(within(form).getByRole("textbox", { name: "Name" }), "linear");
  await user.type(within(form).getByRole("textbox", { name: "URL" }), "https://mcp.linear.app/mcp");
  await user.click(within(form).getByRole("button", { name: "Add value" }));
  await user.type(within(form).getByRole("textbox", { name: "Secret name" }), "Authorization");
  await user.type(within(form).getByLabelText("Secret value"), "Bearer sk-1");
  await user.click(within(form).getByRole("button", { name: "Add connector" }));
  await waitFor(() => expect(named("addConnector")).toHaveLength(1));
  expect(named("addConnector")[0]).toEqual([
    "addConnector",
    "local",
    {
      name: "linear",
      transport: { type: "http", url: "https://mcp.linear.app/mcp" },
      auth: { type: "none" },
      secrets: { headers: { Authorization: "Bearer sk-1" } },
    },
  ]);
  // The form closes over the page, which shows what was added.
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await within(page).findByText("linear")).toBeTruthy();
  expect(within(page).getByText("mcp.linear.app")).toBeTruthy();
  expect(page.textContent).not.toContain("sk-1");
});

test("a connector that needs signing in offers it, and says when it is done", async () => {
  const { user, page, named } = await mount({ connectors: [{ ...notion }] });
  expect(await within(page).findByText("Needs sign-in")).toBeTruthy();
  await user.click(within(page).getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(named("authorizeConnector")).toHaveLength(1));
  expect(await within(page).findByText("Signed in to notion.")).toBeTruthy();
  expect(within(page).getByText("Ready")).toBeTruthy();
  expect(within(page).queryByRole("button", { name: "Sign in" })).toBeNull();
});

test("a token the server no longer takes still offers signing in again", async () => {
  const { page } = await mount({ connectors: [{ ...notion, authorized: true }] });
  expect(await within(page).findByText("Needs sign-in")).toBeTruthy();
  expect(within(page).getByRole("button", { name: "Sign in" })).toBeTruthy();
});

test("turning one off goes to the daemon at once", async () => {
  const { user, page, named } = await mount({ connectors: [{ ...notion }] });
  await user.click(await within(page).findByRole("switch", { name: "Use notion in sessions" }));
  await waitFor(() =>
    expect(named("updateConnector")).toEqual([
      ["updateConnector", "local", "c1", { enabled: false }],
    ]),
  );
});

test("removing asks first, and only then removes", async () => {
  const { user, page, named } = await mount({ connectors: [{ ...notion }] });
  await user.click(await within(page).findByRole("button", { name: "Actions for notion" }));
  await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
  const confirm = await screen.findByRole("alertdialog", { name: "Remove notion?" });
  expect(named("removeConnector")).toHaveLength(0);
  await user.click(within(confirm).getByRole("button", { name: "Remove connector" }));
  await waitFor(() => expect(named("removeConnector")).toHaveLength(1));
  expect(await within(page).findByText(/No connectors yet/)).toBeTruthy();
});

test("what the daemon refuses is said next to the form, in words", async () => {
  const { user, page, bridge } = await mount();
  bridge.addConnector = async () => ({ problem: "insecure_url" });
  await user.click(await within(page).findByRole("button", { name: "Add connector" }));
  const form = await screen.findByRole("dialog", { name: "Add a connector" });
  await user.type(within(form).getByRole("textbox", { name: "Name" }), "plain");
  await user.type(within(form).getByRole("textbox", { name: "URL" }), "http://x.example/mcp");
  await user.click(within(form).getByRole("button", { name: "Add connector" }));
  expect(await within(form).findByRole("alert")).toHaveProperty(
    "textContent",
    "Use an https URL. Plain http is only for this machine.",
  );
});

test("an edit shows a kept secret by name only, and removing it sends null", async () => {
  const kept: ConnectorInfo = {
    ...notion,
    auth: { type: "none" },
    authorized: false,
    status: { state: "ready" },
    secrets: { headers: ["Authorization"], env: [] },
  };
  const { user, page, named } = await mount({ connectors: [kept] });
  await user.click(await within(page).findByRole("button", { name: "Actions for notion" }));
  await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const form = await screen.findByRole("dialog", { name: "Edit notion" });
  expect(within(form).getByText("Authorization is set")).toBeTruthy();
  await user.click(within(form).getByRole("button", { name: "Remove Authorization" }));
  await user.click(within(form).getByRole("button", { name: "Save connector" }));
  await waitFor(() => expect(named("updateConnector")).toHaveLength(1));
  expect(named("updateConnector")[0]?.[3]).toMatchObject({
    secrets: { headers: { Authorization: null } },
  });
});
