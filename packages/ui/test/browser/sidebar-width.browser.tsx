// The sidebar is a column of pixels the user chose: the window and the right panel do not stretch or squeeze it.
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge, summary } from "../fake-bridge.ts";
import { renderApp } from "./render-app.tsx";

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
  await renderApp(script.bridge);
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

const box = (selector: string) => {
  const rect = document.querySelector(selector)?.getBoundingClientRect();
  return rect === undefined
    ? undefined
    : { left: Math.round(rect.left), top: Math.round(rect.top), height: Math.round(rect.height) };
};
const fontSize = (selector: string) =>
  getComputedStyle(document.querySelector(selector) as Element).fontSize;

// Settings and Connectors keep the sessions' frame (CYCL-219): the sidebar's edge, its first row and the title bar stay
// where they are going from a session to a page, and from one page to the other.
test("a page keeps the sidebar's width as the user left it, its first row and the session's title bar", async () => {
  await page.viewport(1400, 800);
  const script = fakeBridge({ connected: true });
  script.bridge.sessions = async () => [{ ...summary("s1"), title: "first" }];
  await renderApp(script.bridge);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("option", { name: /first/ }));
  // Not the default: a width the user moved it to, with the keyboard.
  screen.getByRole("separator", { name: "Resize sidebar" }).focus();
  await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
  await settle();
  expect(sidebarWidth()).toBeGreaterThan(256);

  const session = {
    main: box('[data-slot="resizable-panel"]#main')?.left,
    header: box('[data-slot="session-header"]'),
    firstRow: box('[data-slot="sidebar"] [data-kind="sidebar-action"]')?.top,
    title: fontSize('[data-slot="session-header"] h1'),
  };
  const shown = () => ({
    main: box('[data-slot="page-main"]')?.left,
    header: box('[data-slot="page-header"]'),
    firstRow: box('[data-slot="page-nav"] [data-kind="sidebar-action"]')?.top,
    title: fontSize('[data-slot="page-heading"]'),
  });
  expect(session.header?.height).toBeGreaterThan(0);

  await user.click(screen.getByRole("button", { name: "Connectors" }));
  await screen.findByRole("heading", { name: "Plugins", level: 2 });
  expect(shown()).toEqual(session);

  const mod = /Mac/.test(navigator.userAgent) ? "Meta" : "Control";
  await user.keyboard(`{${mod}>},{/${mod}}`);
  await screen.findByRole("heading", { name: "General", level: 2 });
  expect(shown()).toEqual(session);

  // A window too narrow for both: the nav gives way so the section keeps the conversation's least width.
  await page.viewport(640, 800);
  await settle();
  expect(box('[data-slot="page-main"]')?.left).toBe(640 - 400);
});
