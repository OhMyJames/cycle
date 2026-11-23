// The sidebar is a column of pixels the user chose: the window and the right panel do not stretch or squeeze it.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { App, StoreProvider } from "../../src/react/index.ts";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge, summary } from "../fake-bridge.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const sidebarWidth = () =>
  Math.round(
    document.querySelector('[data-slot="resizable-panel"]#sidebar')?.getBoundingClientRect()
      .width ?? -1,
  );
// A few frames: the SDK fits its columns to the window, and the layout puts the sidebar back the frame after.
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
const panel = () => document.querySelector('[data-slot="side-panel"]');

test("the sidebar keeps its width as the panel opens and closes, and as the window changes", async () => {
  await page.viewport(1400, 800);
  const script = fakeBridge({ connected: true });
  script.bridge.sessions = async () => [{ ...summary("s1"), title: "first" }];
  const store = new AppStore(script.bridge);
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await act(() => store.start());
  const user = userEvent.setup();
  await user.click(await screen.findByRole("option", { name: /first/ }));
  // Opened, the window narrowed, the panel opened and closed, the window widened again: the same width each time.
  const widths: number[] = [sidebarWidth()];
  await page.viewport(1100, 800);
  await settle();
  widths.push(sidebarWidth());
  await user.click(await screen.findByRole("button", { name: "Show panel" }));
  await waitFor(() => expect(panel()).not.toBeNull());
  await settle();
  widths.push(sidebarWidth());
  await user.click(await screen.findByRole("button", { name: "Hide panel" }));
  await waitFor(() => expect(panel()).toBeNull());
  await settle();
  widths.push(sidebarWidth());
  await page.viewport(1400, 800);
  await settle();
  widths.push(sidebarWidth());
  expect(widths).toEqual([256, 256, 256, 256, 256]);
});
