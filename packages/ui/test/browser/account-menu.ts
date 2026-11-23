// The way into Settings and the update's check, as a person takes it: the sidebar's foot opens the account's menu.
import { screen } from "@testing-library/react";
import type { userEvent } from "vitest/browser";

type User = ReturnType<typeof userEvent.setup>;

/** The foot of the sidebar: who is signed in, the menu's button. */
export const accountMenu = () => screen.findByRole("button", { name: /account and settings$/ });

/** Opens the account's menu and chooses one of its items. */
export const chooseInAccountMenu = async (user: User, name: string | RegExp) => {
  await user.click(await accountMenu());
  await user.click(await screen.findByRole("menuitem", { name }));
};

/** Opens Settings from the account's menu. */
export const openSettings = (user: User) => chooseInAccountMenu(user, "Settings");
