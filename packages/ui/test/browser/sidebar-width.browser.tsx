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

// Settings and Connectors are places of the same shell (CYCL-219, CYC-530): the sidebar's edge, its first row and the
// title bar stay where they are going from a session to a page, and from one page to the other.
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

  const frame = (title: string) => ({
    main: box('[data-slot="resizable-panel"]#main')?.left,
    header: box('[data-slot="main-header"]'),
    firstRow: box('[data-slot="sidebar"] [data-kind="sidebar-action"]')?.top,
    title: fontSize(title),
  });
  const session = frame('[data-slot="main-title"] h1');
  expect(session.header?.height).toBeGreaterThan(0);

  await user.click(screen.getByRole("button", { name: "Connectors" }));
  await screen.findByRole("heading", { name: "Plugins", level: 2 });
  expect(frame('[data-slot="page-heading"]')).toEqual(session);

  const mod = /Mac/.test(navigator.userAgent) ? "Meta" : "Control";
  await user.keyboard(`{${mod}>},{/${mod}}`);
  await screen.findByRole("heading", { name: "General", level: 2 });
  expect(frame('[data-slot="page-heading"]')).toEqual(session);

  // A window too narrow for both: the sidebar folds as it does over the sessions, and the section keeps the
  // conversation's least width.
  await page.viewport(640, 800);
  await settle();
  // Only the 1px handle is left of it.
  expect(box('[data-slot="resizable-panel"]#main')?.left).toBeLessThanOrEqual(1);
  expect(screen.getByRole("button", { name: "Show sidebar" })).toBeTruthy();
});

// The sidebar folds over a page as it does over the sessions (⌘B), and the title bar then has the button to show it.
test("a page's sidebar folds with the shortcut and comes back from the title bar", async () => {
  await page.viewport(1200, 800);
  const script = fakeBridge({ connected: true });
  await renderApp(script.bridge);
  const user = userEvent.setup();
  const mod = /Mac/.test(navigator.userAgent) ? "Meta" : "Control";
  await screen.findByRole("button", { name: "Connectors" });
  await user.keyboard(`{${mod}>},{/${mod}}`);
  await screen.findByRole("heading", { name: "General", level: 2 });
  await user.keyboard(`{${mod}>}b{/${mod}}`);
  await settle();
  expect(sidebarWidth()).toBe(0);
  const header = document.querySelector('[data-slot="main-header"]') as HTMLElement;
  await user.click(header.querySelector('[data-kind="sidebar-toggle"]') as HTMLElement);
  await settle();
  expect(sidebarWidth()).toBeGreaterThan(0);
  expect(screen.getByRole("tab", { name: "General" }).getAttribute("aria-selected")).toBe("true");
});
