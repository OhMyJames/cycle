// The sign-in page and the notes about the login (CYCL-166, CYCL-167), in a real browser.
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { AccountStatus } from "../../src/api.ts";
import { fakeBridge, SIGNED_IN } from "../fake-bridge.ts";
import { accountMenu, openSettings } from "./account-menu.ts";
import { renderApp } from "./render-app.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const SIGNED_OUT: AccountStatus = { state: "signed-out", open: false, signingIn: false };

const mount = async (options: Parameters<typeof fakeBridge>[0] = {}) => {
  const script = fakeBridge({ connected: true, ...options });
  const store = await renderApp(script.bridge);
  return { user: userEvent.setup(), store, ...script };
};

test("signed out, the sign-in page is the whole window: one button, which has the focus", async () => {
  const { user, named, emit } = await mount({ account: SIGNED_OUT });
  expect(screen.getByRole("heading", { name: "Sign in to Cycle" })).toBeTruthy();
  const button = screen.getByRole("button", { name: "Sign in with browser" });
  expect(document.activeElement).toBe(button);
  expect(screen.getByText(/stay as they are/)).toBeTruthy();
  // Nothing of the app is there behind it.
  expect(screen.queryByRole("button", { name: "New session" })).toBeNull();
  expect(named("environments")).toHaveLength(0);

  // Waiting for the browser, with a way to stop.
  act(() => emit({ type: "account", account: { ...SIGNED_OUT, signingIn: true } }));
  const waiting = await screen.findByRole("status");
  expect(waiting.textContent).toContain("Waiting for the browser");
  await user.click(within(waiting).getByRole("button", { name: "Stop waiting" }));
  expect(named("cancelSignIn")).toHaveLength(1);

  // Signed in: the app, and its sessions are read.
  act(() => emit({ type: "account", account: SIGNED_OUT }));
  await user.click(screen.getByRole("button", { name: "Sign in with browser" }));
  expect(await screen.findByRole("button", { name: "New session" })).toBeTruthy();
  expect(named("environments")).toHaveLength(1);
});

test("the sign-in page says why it is shown, and what went wrong the last time", async () => {
  const { emit } = await mount({ account: { ...SIGNED_OUT, reason: "expired" } });
  expect(screen.getByRole("alert").textContent).toContain("more than 30 days");
  act(() => emit({ type: "account", account: { ...SIGNED_OUT, reason: "revoked" } }));
  expect(screen.getByRole("alert").textContent).toContain("Your sign-in has ended");
  act(() => emit({ type: "account", account: { ...SIGNED_OUT, problem: "failed" } }));
  expect(screen.getByRole("alert").textContent).toContain("did not finish");
  act(() => emit({ type: "account", account: { ...SIGNED_OUT, problem: "unreachable" } }));
  expect(screen.getByRole("alert").textContent).toContain("could not be reached");
});

test("offline within the grace: the app opens, and a line says online features wait", async () => {
  await mount({ account: { ...SIGNED_IN, state: "offline" } });
  expect(await screen.findByRole("button", { name: "New session" })).toBeTruthy();
  expect(screen.getByText(/Online features are unavailable/)).toBeTruthy();
});

test("refused while open: the sessions stay, a note asks to sign in again, and it goes once signed in", async () => {
  const { user, named } = await mount({ account: { ...SIGNED_IN, state: "reauth" } });
  expect(await screen.findByRole("button", { name: "New session" })).toBeTruthy();
  expect(screen.getByText(/Sessions keep running/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Sign in again" }));
  expect(named("signIn")).toHaveLength(1);
  await waitFor(() => expect(screen.queryByText(/Sessions keep running/)).toBeNull());
  expect(screen.getByRole("button", { name: "New session" })).toBeTruthy();
});

test("someone else signed in: it is said once, and dismissed", async () => {
  const { user } = await mount({ account: { ...SIGNED_IN, switched: true } });
  expect(await screen.findByText("Signed in as Ada Lovelace.")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByText("Signed in as Ada Lovelace.")).toBeNull();
});

test("Settings shows who is signed in, and signing out is asked first and returns to the sign-in page", async () => {
  const { user, named } = await mount();
  await openSettings(user);
  await screen.findByText("Account");
  const page = document.querySelector('[data-kind="page"]') as HTMLElement;
  expect(within(page).getByText("Ada Lovelace")).toBeTruthy();
  expect(within(page).getByText("ada@example.com")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText(/stay/)).toBeTruthy();
  // Cancel goes back, and nothing is done.
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(named("signOut")).toHaveLength(0);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

  await user.click(screen.getByRole("button", { name: "Sign out" }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Sign out" }),
  );
  expect(named("signOut")).toHaveLength(1);
  expect(await screen.findByRole("heading", { name: "Sign in to Cycle" })).toBeTruthy();
});

test("the sidebar's foot is who is signed in: its menu says who, opens Settings, and signs out after asking", async () => {
  const { user, named } = await mount();
  const button = await accountMenu();
  expect(button.textContent).toContain("Ada Lovelace");
  await user.click(button);
  const menu = await screen.findByRole("menu");
  expect(within(menu).getByText("ada@example.com")).toBeTruthy();
  expect(within(menu).getByRole("menuitem", { name: /^Check for updates/ })).toBeTruthy();
  await user.click(within(menu).getByRole("menuitem", { name: "Sign out" }));
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Sign out" }));
  expect(named("signOut")).toHaveLength(1);
  expect(await screen.findByRole("heading", { name: "Sign in to Cycle" })).toBeTruthy();
});
