import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { AnalyticsStatus } from "../../src/api.ts";
import { fakeBridge } from "../fake-bridge.ts";
import { openSettings } from "./account-menu.ts";
import { renderApp } from "./render-app.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const mount = async (analytics?: AnalyticsStatus) => {
  const script = fakeBridge({ connected: true, ...(analytics ? { analytics } : {}) });
  await renderApp(script.bridge);
  return { user: userEvent.setup(), ...script };
};
const tracked = (calls: [string, ...unknown[]][]) =>
  calls.filter(([name]) => name === "track").map(([, event, props]) => [event, props]);

test("the first time, it says what is counted and what is not, and either button is an answer", async () => {
  const { user, calls } = await mount({ available: true, enabled: true, noticed: false });
  await screen.findByText(/never sends what you write/);
  await user.click(screen.getByRole("button", { name: "Turn off" }));
  await waitFor(() => expect(screen.queryByText(/never sends what you write/)).toBeNull());
  expect(calls.filter(([name]) => name === "setAnalytics")).toEqual([["setAnalytics", false]]);
  // Settings offers the way back, so it shows what was answered.
  await openSettings(user);
  const toggle = await screen.findByRole("switch", { name: "Usage statistics" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
});

test("a person who was told is not told again, and can turn it off and on in Settings", async () => {
  const { user, calls } = await mount({ available: true, enabled: true, noticed: true });
  expect(screen.queryByText(/never sends what you write/)).toBeNull();
  await openSettings(user);
  const toggle = await screen.findByRole("switch", { name: "Usage statistics" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  await user.click(toggle);
  await waitFor(() =>
    expect(calls.filter(([n]) => n === "setAnalytics")).toEqual([["setAnalytics", false]]),
  );
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  await user.click(toggle);
  await waitFor(() =>
    expect(calls.filter(([n]) => n === "setAnalytics")).toEqual([
      ["setAnalytics", false],
      ["setAnalytics", true],
    ]),
  );
});

test("with nowhere to report to, neither the notice nor the switch is shown", async () => {
  await mount({ available: false, enabled: false, noticed: false });
  expect(screen.queryByText(/never sends what you write/)).toBeNull();
  await openSettings(userEvent.setup());
  await screen.findByRole("tab", { name: "General" });
  expect(screen.queryByRole("switch", { name: /usage statistics/i })).toBeNull();
});

test("opening the search from the sidebar is counted, with how it was opened", async () => {
  const { user, calls } = await mount();
  await user.click(await screen.findByRole("button", { name: /Search/ }));
  expect(tracked(calls)).toEqual([["panel_opened", { panel: "search", via: "click" }]]);
});

test("opening Loop Overview and project views from the sidebar reports fixed properties only", async () => {
  const script = fakeBridge({
    connected: true,
    loopProjects: {
      kind: "ok",
      projects: [
        {
          name: "Cycle",
          projectKey: "CYC",
          repo: { displayName: "clawdot/cycle", forge: "github" },
        },
      ],
    },
    workspaceRepos: { "/work": "clawdot/cycle" },
    loopBoards: { CYC: { kind: "ok", stale: false, columns: [] } },
  });
  await renderApp(script.bridge);
  const user = userEvent.setup();
  const loop = await screen.findByRole("button", { name: "Loop" });
  await user.click(loop);
  // Pressing Loop while already on Overview does not count twice.
  await user.click(loop);
  await user.click(await screen.findByRole("button", { name: "Kanban" }));
  await user.click(await screen.findByRole("button", { name: "Timeline" }));
  expect(tracked(script.calls)).toEqual([
    ["panel_opened", { panel: "loop", via: "click" }],
    ["loop_project_view_opened", { view: "kanban", from: "sidebar" }],
    ["loop_project_view_opened", { view: "timeline", from: "sidebar" }],
  ]);
  const payload = JSON.stringify(tracked(script.calls));
  expect(payload.includes("CYC")).toBe(false);
  expect(payload.includes("clawdot/cycle")).toBe(false);
});

test("toggling the sidebar and opening remote location panels report only fixed event properties", async () => {
  const script = fakeBridge({
    connected: true,
    locations: [
      {
        id: "ssh-secret",
        name: "secret-prod-host",
        kind: "remote",
        transport: { type: "ssh", host: "admin@secret.internal" },
      },
    ],
  });
  await renderApp(script.bridge);
  const user = userEvent.setup();
  const mod = /Mac/.test(navigator.userAgent) ? "Meta" : "Control";
  await user.keyboard(`{${mod}>}b{/${mod}}`);
  await user.click(await screen.findByRole("button", { name: "Show sidebar" }));
  await openSettings(user);
  await user.click(await screen.findByRole("tab", { name: "Work in" }));
  await user.click(await screen.findByRole("button", { name: "Actions for secret-prod-host" }));
  await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
  await user.keyboard("{Escape}");
  await user.click(await screen.findByRole("button", { name: "Actions for secret-prod-host" }));
  await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
  const events = tracked(script.calls);
  expect(events).toEqual([
    ["sidebar_toggled", { open: false, via: "shortcut" }],
    ["sidebar_toggled", { open: true, via: "click" }],
    ["panel_opened", { panel: "settings", via: "click" }],
    ["settings_section_shown", { section: "locations" }],
    ["panel_opened", { panel: "edit_location", via: "click" }],
    ["panel_opened", { panel: "remove_location", via: "click" }],
  ]);
  expect(JSON.stringify(events)).not.toContain("secret");
});
