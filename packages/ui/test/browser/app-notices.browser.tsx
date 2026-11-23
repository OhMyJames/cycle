import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { App, StoreProvider } from "../../src/react/index.ts";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge } from "../fake-bridge.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const mount = async () => {
  const script = fakeBridge({ connected: true });
  const store = new AppStore(script.bridge);
  const user = userEvent.setup();
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await act(() => store.start());
  const emit = (event: Parameters<typeof script.emit>[0]) => act(() => script.emit(event));
  await screen.findByText("Cycle 0.1.0");
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
    type: "environment-status",
    environmentId: "local",
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

test("with nothing open, an environment this app cannot use is not said to be connecting", async () => {
  const { emit } = await mount();
  await emit({
    type: "environment-status",
    environmentId: "local",
    state: "reconnecting",
    incompatible: { with: "app", supported: ["2.0"], requested: "1.0" },
  });
  expect(await screen.findByText("Not connected to this environment.")).toBeTruthy();
  expect(screen.queryByText("Connecting to this environment…")).toBeNull();
  expect(screen.queryByRole("button", { name: "Connect again" })).toBeNull();
});
