// The sign-in page and the notes about the login (CYCL-166, CYCL-167), in a real browser.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { AccountStatus } from "../../src/api.ts";
import { App, StoreProvider } from "../../src/react/index.ts";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge, SIGNED_IN } from "../fake-bridge.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const SIGNED_OUT: AccountStatus = { state: "signed-out", open: false, signingIn: false };

const mount = async (options: Parameters<typeof fakeBridge>[0] = {}) => {
  const script = fakeBridge({ connected: true, ...options });
  const store = new AppStore(script.bridge);
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await act(() => store.start());
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
  await user.click(await screen.findByRole("button", { name: /^Settings/ }));
  const group = await screen.findByText("Account");
  expect(group).toBeTruthy();
  expect(screen.getByText("Ada Lovelace")).toBeTruthy();
  expect(screen.getByText("ada@example.com")).toBeTruthy();
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
