import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { userEvent } from "vitest/browser";
import type { AppEvent, LocationConfig } from "../../src/api.ts";
import { openSettings } from "./account-menu.ts";
import { findAlert } from "./alert.ts";
import { browseFolders, chooseLocation, chosenFolder, openFolders, typeFolder } from "./blank.ts";
import { press, ready, sleep, write } from "./box.ts";
import { mountApp } from "./mount.tsx";

afterEach(cleanup);

const far: LocationConfig = {
  id: "far",
  name: "Build box",
  kind: "remote",
  transport: { type: "ssh", host: "me@box" },
};

const mount = async (
  states: Record<string, "connected" | "closed" | "reconnecting"> = {},
  capabilities?: { queue: boolean; files: boolean; folders: boolean },
) => {
  const app = await mountApp({
    locations: [far],
    states,
    ...(capabilities !== undefined ? { capabilities } : {}),
  });
  await screen.findAllByRole("option");
  // An event can start a read (the agents of a location that connected): wait for it inside act, or React warns.
  const emit = (event: AppEvent) =>
    act(async () => {
      app.emit(event);
      await sleep(5);
    });
  return { ...app, emit };
};

// A blank conversation starts its session by sending its first message.
const sendFirst = async (words: string) => {
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, words);
  await press(box, "Enter");
};

// The workspace the sidebar shows is one at a time: the others are chosen in the switcher.
const choose = async (user: ReturnType<typeof userEvent.setup>, name: RegExp) => {
  await user.click(screen.getByRole("button", { name: /Switch workspace/ }));
  await user.click(await screen.findByRole("menuitem", { name }));
};

test("the workspaces of every host are in the switcher, and one on another host says which", async () => {
  const { user } = await mount();
  // One workspace is shown: the newest, on this computer.
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.getAllByRole("option")[0]?.getAttribute("data-location")).toBe("local");
  const trigger = screen.getByRole("button", { name: /Switch workspace/ });
  // The same folder on two locations: each named after its location.
  expect(trigger.textContent).toContain("work");
  // Every workspace shows where it is, this computer too: a laptop whose name says so.
  expect(within(trigger).getByRole("img", { name: "On Local · Connected" })).toBeTruthy();
  await user.click(trigger);
  const remote = await screen.findByRole("menuitem", { name: /Build box · Connected work/ });
  // The icon's name says where, and how it stands: for the tooltip and for a reader.
  expect(within(remote).getByRole("img", { name: "On Build box · Connected" })).toBeTruthy();
  // Several locations: the menu is grouped by them.
  expect(screen.getByText(/Local · Connected/)).toBeTruthy();
  expect(screen.getByText(/Build box · Connected/)).toBeTruthy();
  await user.click(remote);
  await waitFor(() =>
    expect(screen.getAllByRole("option")[0]?.getAttribute("data-location")).toBe("far"),
  );
  // Shown, it is named by the icon in the switcher.
  expect(
    within(screen.getByRole("button", { name: /Switch workspace/ })).getByRole("img", {
      name: "On Build box · Connected",
    }),
  ).toBeTruthy();
});

test("a host that is away: its sessions stay, greyed and saying why, and it can be tried again", async () => {
  const { user, named } = await mount({ far: "closed" });
  await choose(user, /On Build box · .* work/);
  const rows = screen.getAllByRole("option");
  const greyed = rows.filter((row) => row.getAttribute("data-away") !== null);
  expect(greyed).toHaveLength(1);
  expect(greyed[0]?.getAttribute("data-location")).toBe("far");
  expect(greyed[0]?.getAttribute("title")).toBe("Build box · Not connected");
  // The sidebar says which location, and how it stands, with a way to try again.
  const status = screen
    .getByText("Build box · Not connected", { selector: '[data-slot="location-name"]' })
    .closest<HTMLElement>('[data-slot="location-state"]');
  if (status === null) throw new Error("no state row for the location");
  await user.click(within(status).getByRole("button", { name: "Connect again" }));
  expect(named("connect")).toEqual([["connect", "far"]]);
});

test("a session of a host that is away is not asked of, and opening one that was never opened says why", async () => {
  const { user, named } = await mount({ far: "closed" });
  await choose(user, /On Build box · .* work/);
  await user.click(
    screen
      .getAllByRole("option")
      .find((o) => o.getAttribute("data-location") === "far") as HTMLElement,
  );
  expect((await findAlert()).textContent).toContain(
    "Build box is not connected, so this session cannot be opened.",
  );
  expect(named("openSession")).toEqual([]);
});

test("when the host comes back its rows are no longer greyed", async () => {
  const { user, emit } = await mount({ far: "closed" });
  await choose(user, /On Build box · .* work/);
  expect(screen.getAllByRole("option").some((o) => o.getAttribute("data-away") !== null)).toBe(
    true,
  );
  await emit({ type: "location-status", locationId: "far", state: "connected" });
  await waitFor(() =>
    expect(screen.getAllByRole("option").every((o) => o.getAttribute("data-away") === null)).toBe(
      true,
    ),
  );
});

test("a blank conversation asks which location when there are several, and the system's chooser is for this computer", async () => {
  const { user, named } = await mount();
  await user.click(await screen.findByRole("button", { name: "New session" }));
  const _dialog = await screen.findByRole("group", { name: "Where the session runs" });
  // It starts where the person is: this computer, which has the system's folder chooser.
  expect(within(await openFolders(user)).getByRole("menuitem", { name: "Browse…" })).toBeTruthy();
  await user.keyboard("{Escape}");
  await chooseLocation(user, "Build box");
  await typeFolder(user, "/srv/app");
  await sendFirst("hi");
  await waitFor(() => expect(named("createSession")).toHaveLength(1));
  expect(named("createSession")[0]).toEqual([
    "createSession",
    "far",
    { cwd: "/srv/app", agent: "fake", config: {} },
  ]);
});

const tree: Record<string, string[]> = {
  "/": ["home"],
  "/home": ["me"],
  "/home/me": ["app", "docs"],
  "/home/me/docs": ["notes"],
};
const folders = (asked: (string | undefined)[]) => async (_location: string, path?: string) => {
  asked.push(path);
  const here = path ?? "/home/me";
  const names = tree[here];
  if (names === undefined) throw new Error("No such folder");
  const parent = here === "/" ? null : here.slice(0, here.lastIndexOf("/")) || "/";
  return {
    path: here,
    parent,
    home: "/home/me",
    folders: names.map((name) => ({ name })),
    truncated: false,
  };
};

test("on another location the folder is chosen by browsing its machine", async () => {
  const { user, bridge, named } = await mount();
  const asked: (string | undefined)[] = [];
  bridge.listFolders = folders(asked);
  await user.click(await screen.findByRole("button", { name: "New session" }));
  const _dialog = await screen.findByRole("group", { name: "Where the session runs" });
  await chooseLocation(user, "Build box");
  await browseFolders(user);
  // It opens at the machine's home, and shows the real path and the folders in it.
  expect((await screen.findByText("/home/me", { selector: "code" })).textContent).toBe("/home/me");
  await user.click(await screen.findByRole("option", { name: "docs" }));
  expect((await screen.findByText("/home/me/docs", { selector: "code" })).textContent).toBe(
    "/home/me/docs",
  );
  expect(screen.getByRole("option", { name: "notes" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Up one level" }));
  await screen.findByRole("option", { name: "docs" });
  await user.click(screen.getByRole("option", { name: "docs" }));
  await screen.findByRole("option", { name: "notes" });
  await user.click(screen.getByRole("button", { name: "Choose this folder" }));
  // Back in the blank conversation, with the folder in it, to start the session there.
  expect(await chosenFolder()).toBe("/home/me/docs");
  await sendFirst("hi");
  await waitFor(() => expect(named("createSession")).toHaveLength(1));
  expect(named("createSession")[0]?.[1]).toBe("far");
  expect(asked[0]).toBeUndefined();
});

test("browsing stays where it is when the page around it changes, and the hidden toggle keeps the folder", async () => {
  const { user, bridge, emit } = await mount();
  const asked: (string | undefined)[] = [];
  bridge.listFolders = folders(asked);
  await user.click(await screen.findByRole("button", { name: "New session" }));
  const _dialog = await screen.findByRole("group", { name: "Where the session runs" });
  await chooseLocation(user, "Build box");
  await browseFolders(user);
  await user.click(await screen.findByRole("option", { name: "docs" }));
  await screen.findByText("/home/me/docs", { selector: "code" });
  const before = asked.length;
  // Something else happens in the app: the page is drawn again, and the browser is where it was.
  await emit({ type: "location-status", locationId: "far", state: "connected" });
  await user.click(screen.getByRole("button", { name: "Show hidden folders" }));
  await waitFor(() => expect(asked.length).toBe(before + 1));
  expect(asked.at(-1)).toBe("/home/me/docs");
  expect(screen.getByText("/home/me/docs", { selector: "code" })).toBeTruthy();
});

test("a folder that cannot be listed can be left by going up or home", async () => {
  const { user, bridge } = await mount();
  const base = folders([]);
  bridge.listFolders = async (location, path) => {
    if (path === "/home/me/locked") throw new Error("The folder cannot be read");
    const listing = await base(location, path);
    return path === undefined || path === "/home/me"
      ? { ...listing, folders: [...listing.folders, { name: "locked" }] }
      : listing;
  };
  await user.click(await screen.findByRole("button", { name: "New session" }));
  const _dialog = await screen.findByRole("group", { name: "Where the session runs" });
  await chooseLocation(user, "Build box");
  await browseFolders(user);
  await user.click(await screen.findByRole("option", { name: "locked" }));
  expect((await findAlert()).textContent).toContain("The folder cannot be read");
  // The way out is there: up from where it failed, and home.
  expect((screen.getByRole("button", { name: "Up one level" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  await user.click(screen.getByRole("button", { name: "Up one level" }));
  await screen.findByText("/home/me", { selector: "code" });
  await screen.findByRole("option", { name: "locked" });
});

test("browsing starts from the folder that is typed, and from home when that cannot be read", async () => {
  const { user, bridge } = await mount();
  const asked: (string | undefined)[] = [];
  bridge.listFolders = folders(asked);
  await user.click(await screen.findByRole("button", { name: "New session" }));
  const _dialog = await screen.findByRole("group", { name: "Where the session runs" });
  await chooseLocation(user, "Build box");
  await typeFolder(user, "/gone/for/good");
  await browseFolders(user);
  await screen.findByText("/home/me", { selector: "code" });
  expect(asked).toEqual(["/gone/for/good", undefined]);
});

test("a folder that cannot be listed says why, and can be tried again", async () => {
  const { user, bridge } = await mount();
  let fail = true;
  bridge.listFolders = async (...args) => {
    if (fail) throw new Error("The folder cannot be read");
    return folders([])(...(args as [string, string?]));
  };
  await user.click(await screen.findByRole("button", { name: "New session" }));
  const _dialog = await screen.findByRole("group", { name: "Where the session runs" });
  await chooseLocation(user, "Build box");
  await browseFolders(user);
  expect((await findAlert()).textContent).toContain("The folder cannot be read");
  fail = false;
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("option", { name: "docs" });
});

test("a location whose daemon cannot list folders is typed into, not browsed", async () => {
  const { user } = await mount({}, { queue: true, files: true, folders: false });
  await user.click(await screen.findByRole("button", { name: "New session" }));
  const _dialog = await screen.findByRole("group", { name: "Where the session runs" });
  await chooseLocation(user, "Build box");
  const menu = await openFolders(user);
  expect(within(menu).queryByRole("menuitem", { name: "Browse…" })).toBeNull();
  expect(within(menu).getByRole("menuitem", { name: "Enter a path…" })).toBeTruthy();
});

test("a blank page whose location drops can be moved to one that is up", async () => {
  const { user, emit, named } = await mount();
  await user.click(await screen.findByRole("button", { name: "New session" }));
  const _where = await screen.findByRole("group", { name: "Where the session runs" });
  await chooseLocation(user, "Build box");
  await emit({ type: "location-status", locationId: "far", state: "closed" });
  await screen.findByText("Not connected to Build box.");
  // Still there, with this computer to go to.
  await chooseLocation(user, "Local");
  await waitFor(() => expect(screen.queryByText("Not connected to Build box.")).toBeNull());
  await typeFolder(user, "/srv/app");
  await sendFirst("hi");
  await waitFor(() => expect(named("createSession")).toHaveLength(1));
  expect(named("createSession")[0]?.[1]).toBe("local");
});

test("a host that is not connected cannot have a session started on it", async () => {
  const { user } = await mount({ far: "closed" });
  await user.click(await screen.findByRole("button", { name: "New session" }));
  const dialog = await screen.findByRole("group", { name: "Where the session runs" });
  // Only the location that is connected: nothing to choose.
  const menu = await openFolders(user);
  expect(within(menu).getByRole("menuitem", { name: "Enter a path…" })).toBeTruthy();
  expect(within(menu).queryByText("Work in")).toBeNull();
  expect(within(dialog).queryByText("Build box")).toBeNull();
});

test("a remote location can be edited, and removing one asks for confirmation first", async () => {
  const { user, named } = await mount();
  await openSettings(user);
  await user.click(await screen.findByRole("tab", { name: "Work in" }));
  await user.click(await screen.findByRole("button", { name: "Actions for Build box" }));
  await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const edit = await screen.findByRole("dialog", { name: "Edit Build box" });
  const name = within(edit).getByRole("textbox", { name: "Name" });
  await user.clear(name);
  await user.type(name, "Build 2");
  await user.click(within(edit).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(named("saveLocation")).toHaveLength(1));
  expect(named("saveLocation")[0]?.[1]).toMatchObject({ id: "far", name: "Build 2" });

  await user.click(await screen.findByRole("button", { name: "Actions for Build box" }));
  await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
  const confirm = await screen.findByRole("alertdialog", { name: "Remove Build box?" });
  expect(named("removeLocation")).toHaveLength(0);
  await user.click(within(confirm).getByRole("button", { name: "Remove location" }));
  await waitFor(() => expect(named("removeLocation")).toEqual([["removeLocation", "far"]]));
});
