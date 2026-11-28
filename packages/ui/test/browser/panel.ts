// The right panel in a test: opened by the header's one button, its tabs chosen in its own strip, a terminal opened from
// the strip's menu, as a person does it.
import { screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";
import type { userEvent } from "vitest/browser";

type User = ReturnType<typeof userEvent.setup>;

export const sidePanel = () => document.querySelector<HTMLElement>('[data-slot="side-panel"]');

/** The panel, open: the header's button is pressed when it is not. */
export const openPanel = async (user: User): Promise<HTMLElement> => {
  if (sidePanel() === null)
    await user.click(await screen.findByRole("button", { name: "Show panel" }));
  await waitFor(() => expect(sidePanel()).not.toBeNull());
  return sidePanel() as HTMLElement;
};

/** Shows a tab of the panel by its name (a view's, or a terminal's title), opening the panel first. */
export const openTab = async (user: User, name: string): Promise<void> => {
  const panel = await openPanel(user);
  await user.click(await within(panel).findByRole("tab", { name }));
};

/** Opens a terminal from the strip's menu of tabs, opening the panel first. */
export const newTerminal = async (user: User): Promise<void> => {
  const panel = await openPanel(user);
  await user.click(await within(panel).findByRole("button", { name: "Open a tab" }));
  await user.click(await screen.findByRole("menuitem", { name: "New terminal" }));
};
