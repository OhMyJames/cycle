// Worktrees on the blank conversation (docs/desktop.md "Worktree"): the branch chip with its search, the Worktree switch,
// and the line above an open session's box.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { GitBranches } from "../../src/api.ts";
import { fakeBridge, summary } from "../fake-bridge.ts";
import { typeFolder } from "./blank.ts";
import { press, ready, write } from "./box.ts";
import { mountApp } from "./mount.tsx";
import { renderApp } from "./render-app.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const CAPABILITIES = { queue: true, files: true, folders: true, trust: true, worktrees: true };

const mount = async (branches: GitBranches | null) => {
  const app = await mountApp({ capabilities: CAPABILITIES, branches });
  await app.user.click(await screen.findByRole("button", { name: "New session" }));
  await screen.findByRole("heading", { name: "New session" });
  await typeFolder(app.user, "/repo");
  return app;
};

const REPO = { branches: ["main", "release/1.0", "feature/login"], current: "main" };

test("the branch chip shows the branch checked out; a search finds a branch, and picking another one turns the worktree on", async () => {
  const { user, named } = await mount(REPO);
  const chip = await screen.findByRole("button", { name: "Branch: main" });
  const toggle = screen.getByRole("switch", { name: "Worktree" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");

  await user.click(chip);
  const menu = await screen.findByRole("menu");
  const search = within(menu).getByRole("textbox", { name: "Search branches" });
  // The cursor is in the search as the menu opens, and the checked-out branch is marked.
  await waitFor(() => expect(document.activeElement).toBe(search));
  expect(within(menu).getByText("Current")).toBeTruthy();
  await user.keyboard("REL");
  expect(
    within(menu)
      .getAllByRole("menuitemradio")
      .map((item) => item.textContent),
  ).toEqual(["release/1.0"]);
  await user.keyboard("{Enter}");

  await waitFor(() =>
    expect(screen.getByRole("switch", { name: "Worktree" }).getAttribute("aria-checked")).toBe(
      "true",
    ),
  );
  expect(screen.getByRole("button", { name: "Branch: release/1.0" })).toBeTruthy();
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "hi");
  await press(box, "Enter");
  await waitFor(() => expect(named("createSession")).toHaveLength(1));
  expect(named("createSession")[0]?.[2]).toMatchObject({ worktree: { base: "release/1.0" } });
});

test("picking the branch already checked out changes nothing; turning the switch off goes back to it", async () => {
  const { user } = await mount(REPO);
  await user.click(await screen.findByRole("button", { name: "Branch: main" }));
  await user.click(
    within(await screen.findByRole("menu")).getByRole("menuitemradio", { name: /main/ }),
  );
  expect(screen.getByRole("switch", { name: "Worktree" }).getAttribute("aria-checked")).toBe(
    "false",
  );

  await user.click(screen.getByRole("switch", { name: "Worktree" }));
  expect(screen.getByRole("switch", { name: "Worktree" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  await user.click(screen.getByRole("switch", { name: "Worktree" }));
  expect(screen.getByRole("button", { name: "Branch: main" })).toBeTruthy();
});

test("a search that finds nothing says so", async () => {
  const { user } = await mount(REPO);
  await user.click(await screen.findByRole("button", { name: "Branch: main" }));
  const menu = await screen.findByRole("menu");
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(menu).getByRole("textbox", { name: "Search branches" }),
    ),
  );
  await user.keyboard("zzz");
  expect(await within(menu).findByText("No matching branches")).toBeTruthy();
});

test("outside a repository there is neither a branch nor a worktree", async () => {
  await mount(null);
  await Promise.resolve();
  expect(screen.queryByRole("switch", { name: "Worktree" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Branch:/ })).toBeNull();
});

test("a session in a worktree has no line of its own above its box", async () => {
  const inside = fakeBridge({ connected: true, capabilities: CAPABILITIES });
  inside.bridge.sessions = async (locationId: string) => [
    {
      ...summary("w1", locationId),
      title: "In a worktree",
      worktree: {
        root: "/work",
        path: "/work/.agents/worktree/one",
        branch: "worktree-one",
        managed: true,
      },
    },
  ];
  await renderApp(inside.bridge);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("option", { name: /In a worktree/ }));
  expect(await screen.findByRole("textbox")).toBeTruthy();
  expect(document.querySelector('[data-slot="worktree-strip"]')).toBeNull();
  expect(screen.queryByText("worktree-one")).toBeNull();
});
