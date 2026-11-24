// The blank conversation's folder, as a person reaches it: a button named for the folder, whose menu offers the folders
// with sessions, Browse… and "Enter a path…" (CYCL-55).
import { screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";
import type { userEvent } from "vitest/browser";

type User = ReturnType<typeof userEvent.setup>;

/** The folder's button: "Folder: <path>", or "Choose a folder" while there is none. */
export const folderButton = () =>
  screen.findByRole("button", { name: /^(Folder: |Choose a folder)/ });

/** The folder the blank conversation has, as its button's tip names it (without the shortcut beside it); "" when none. */
export const chosenFolder = async (): Promise<string> => {
  const button = await folderButton();
  const tip = document.getElementById(button.getAttribute("aria-labelledby") ?? "");
  const name = tip?.firstChild?.textContent ?? "";
  return name.startsWith("Folder: ") ? (name.slice("Folder: ".length).split(" · ")[0] ?? "") : "";
};

/** Opens the folder's menu. */
export const openFolders = async (user: User) => {
  await user.click(await folderButton());
  return screen.findByRole("menu");
};

/** Chooses the folder by typing its path, as "Enter a path…" offers. */
export const typeFolder = async (user: User, path: string) => {
  const menu = await openFolders(user);
  await user.click(within(menu).getByRole("menuitem", { name: "Enter a path…" }));
  const dialog = await screen.findByRole("dialog", { name: "Enter a folder path" });
  const field = within(dialog).getByRole("textbox", { name: "Folder" });
  await user.clear(field);
  await user.type(field, path);
  await user.click(within(dialog).getByRole("button", { name: "Use folder" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Enter a folder path" })).toBeNull(),
  );
};

/** Opens the folder browser from the folder's menu. */
export const browseFolders = async (user: User) => {
  const menu = await openFolders(user);
  await user.click(within(menu).getByRole("menuitem", { name: "Browse…" }));
};

/** Moves the blank conversation to another location, from the same menu the folder is chosen in. */
export const chooseLocation = async (user: User, name: string) => {
  const menu = await openFolders(user);
  await user.click(within(menu).getByRole("menuitem", { name }));
};
