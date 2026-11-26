import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { fakeBridge } from "../fake-bridge.ts";
import { accountMenu } from "./account-menu.ts";
import { renderApp } from "./render-app.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const mount = async () => {
  const script = fakeBridge({ connected: true });
  const store = await renderApp(script.bridge);
  const user = userEvent.setup();
  const emit = (event: Parameters<typeof script.emit>[0]) => act(() => script.emit(event));
  await accountMenu();
  return { store, user, ...script, emit };
};

const nav = () => document.querySelector("nav") as HTMLElement;
const main = () => document.querySelector('[data-slot="main"]') as HTMLElement;
const cards = (within: HTMLElement) => [
  ...within.querySelectorAll<HTMLElement>('[data-slot="app-notice"]'),
];

test("what concerns the whole app is a card at the sidebar's foot, over its footer, not over the page", async () => {
  const { user, emit } = await mount();
  expect(cards(nav())).toEqual([]);
  await emit({
    type: "app-update",
    state: { current: "0.1.0", kind: "available", version: "0.2.0" },
  });
  const [card] = cards(nav());
  expect(card?.textContent).toContain("Version 0.2.0 is available");
  expect(cards(main())).toEqual([]);
  // Above the footer, in the page's order and on screen.
  const footer = nav().querySelector('[data-slot="sidebar-footer"]') as HTMLElement;
  expect(
    (card as HTMLElement).compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect((card as HTMLElement).getBoundingClientRect().bottom).toBeLessThanOrEqual(
    footer.getBoundingClientRect().top + 1,
  );
  // Put off until the next version: its close button says so.
  await user.click(within(card as HTMLElement).getByRole("button", { name: "Later" }));
  await waitFor(() => expect(cards(nav())).toEqual([]));
});

test("an update put off stays put off when the sidebar is folded, and the footer still says it is there", async () => {
  const { user, emit } = await mount();
  await emit({
    type: "app-update",
    state: { current: "0.1.0", kind: "available", version: "0.2.0" },
  });
  await user.click(within(cards(nav())[0] as HTMLElement).getByRole("button", { name: "Later" }));
  await waitFor(() => expect(cards(nav())).toEqual([]));
  await user.click(await accountMenu());
  expect((await screen.findByRole("menuitem", { name: /0\.1\.0$/ })).textContent).toContain(
    "Version 0.2.0 is available",
  );
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "Hide sidebar" }));
  await user.click(await screen.findByRole("button", { name: "Show sidebar" }));
  expect(cards(document.body)).toEqual([]);
  // A newer one is offered again.
  await emit({
    type: "app-update",
    state: { current: "0.1.0", kind: "available", version: "0.3.0" },
  });
  expect(cards(nav())[0]?.textContent).toContain("Version 0.3.0 is available");
});

test("with the sidebar put away, the notices are rows at the top of the page", async () => {
  const { user, emit } = await mount();
  await emit({
    type: "app-update",
    state: { current: "0.1.0", kind: "available", version: "0.2.0" },
  });
  await user.click(screen.getByRole("button", { name: "Hide sidebar" }));
  const top = await waitFor(() => {
    const stack = main().querySelector('[data-slot="app-notices"][data-at="top"]');
    expect(stack).not.toBeNull();
    return stack as HTMLElement;
  });
  expect(cards(top)[0]?.textContent).toContain("Version 0.2.0 is available");
  // Said once to the reader: the sidebar's own is out of reach while it is away.
  expect(screen.getAllByText("Version 0.2.0 is available")).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Show sidebar" }));
  await waitFor(() => expect(main().querySelector('[data-slot="app-notices"]')).toBeNull());
});

test("a daemon this app cannot use: the card says what to run, the open session says why it is away", async () => {
  const { user, emit } = await mount();
  await user.click(await screen.findByRole("option", { name: /work/ }));
  await screen.findByRole("log", { name: "Conversation" });
  await emit({
    type: "location-status",
    locationId: "local",
    state: "reconnecting",
    incompatible: {
      with: "daemon",
      supported: ["0.2"],
      requested: "1.0",
      command: "sh install.sh",
    },
  });
  const [card] = cards(nav());
  expect(card?.getAttribute("data-tone")).toBe("error");
  expect(card?.textContent).toMatch(/older than the 1\.0 this app needs/);
  expect(within(card as HTMLElement).getByText("sh install.sh")).toBeTruthy();
  const line = document.querySelector('[data-slot="notice-line"]') as HTMLElement;
  expect(line.textContent).toMatch(/speak different protocols/);
  expect(within(line).queryByRole("button")).toBeNull();
});

test("with nothing open, a location this app cannot use is not said to be connecting", async () => {
  const { emit } = await mount();
  await emit({
    type: "location-status",
    locationId: "local",
    state: "reconnecting",
    incompatible: { with: "app", supported: ["2.0"], requested: "1.0" },
  });
  expect(await screen.findByText("Not connected to this location.")).toBeTruthy();
  expect(screen.queryByText("Connecting to this location…")).toBeNull();
  expect(screen.queryByRole("button", { name: "Connect again" })).toBeNull();
});

test("an update from this machine says so, with the version, short commit and first line of the message", async () => {
  const { emit } = await mount();
  await emit({
    type: "app-update",
    state: {
      current: "0.1.0",
      kind: "available",
      version: "0.1.1-alpha.2+abc1234",
      source: "local",
      commit: "abc1234def5678",
      subject: "fix the thing\nlonger body",
    },
  });
  const text = cards(nav())[0]?.textContent ?? "";
  expect(text).toContain("Local build 0.1.1-alpha.2+abc1234: abc1234 fix the thing");
  expect(text).not.toContain("longer body");
});

test("the same version from this machine is a reinstall", async () => {
  const { emit } = await mount();
  await emit({
    type: "app-update",
    state: {
      current: "0.1.1-alpha.2+abc1234",
      kind: "available",
      version: "0.1.1-alpha.2+abc1234",
      source: "local",
      commit: "abc1234",
      subject: "again",
    },
  });
  expect(cards(nav())[0]?.textContent).toContain("Reinstall local build 0.1.1-alpha.2+abc1234");
});

test("from an alpha to a release says which version to which; between releases it is as before", async () => {
  const { emit } = await mount();
  await emit({
    type: "app-update",
    state: {
      current: "0.1.1-alpha.2+abc1234",
      kind: "available",
      version: "0.2.0",
      source: "release",
    },
  });
  const text = cards(nav())[0]?.textContent ?? "";
  expect(text).toContain("0.2.0");
  expect(text).toContain("0.1.1-alpha.2+abc1234");
  await emit({
    type: "app-update",
    state: { current: "0.1.0", kind: "available", version: "0.3.0", source: "release" },
  });
  expect(cards(nav())[0]?.textContent).toContain("Version 0.3.0 is available");
});
