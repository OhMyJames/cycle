import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { SessionSummary } from "../../src/api.ts";
import { App, StoreProvider } from "../../src/react/index.ts";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge, summary } from "../fake-bridge.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const MINUTE = 60_000;

const mount = async (sessions: SessionSummary[], language?: "zh-CN") => {
  const script = fakeBridge({
    connected: true,
    ...(language !== undefined ? { preferences: { language } } : {}),
  });
  script.bridge.sessions = async () => sessions;
  const store = new AppStore(script.bridge);
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await act(() => store.start());
  await screen.findAllByRole("option");
};

const timeOf = (title: string) =>
  screen.getByRole("option", { name: new RegExp(title) }).querySelector("time");

test("a row says how long ago its session changed, and the whole time on hover", async () => {
  const at = new Date(Date.now() - 5 * MINUTE);
  const { updatedAt: _, ...older } = summary("b");
  await mount([
    { ...summary("a"), title: "Recent", updatedAt: at.toISOString() },
    // An older daemon does not say: the row says nothing, rather than a wrong time.
    { ...older, title: "Older daemon" },
  ]);
  const time = timeOf("Recent");
  expect(time?.textContent).toBe("5m");
  expect(time?.getAttribute("dateTime")).toBe(at.toISOString());
  expect(time?.getAttribute("title")).toContain(String(at.getFullYear()));
  expect(timeOf("Older daemon")).toBeNull();
  // It sits after the title, at the row's end (where the row's actions take its place under the pointer), apart from
  // the status dot at its start.
  const row = screen.getByRole("option", { name: /Recent/ });
  expect(row.querySelector('[data-slot="session-actions"]')?.previousElementSibling).toBe(time);
  const title = row.querySelector('[data-slot="session-title"]') as HTMLElement;
  expect(time?.getBoundingClientRect().left).toBeGreaterThanOrEqual(
    title.getBoundingClientRect().right,
  );
});

test("the times move on with the clock", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date(2026, 10, 22, 15, 0));
  await mount([{ ...summary("a"), title: "Ticking", updatedAt: new Date().toISOString() }]);
  expect(timeOf("Ticking")?.textContent).toBe("now");
  await act(() => vi.advanceTimersByTimeAsync(3 * MINUTE));
  expect(timeOf("Ticking")?.textContent).toBe("3m");
});

test("in Chinese it reads as Chinese does", async () => {
  await mount(
    [
      {
        ...summary("a"),
        title: "近的",
        updatedAt: new Date(Date.now() - 3 * 60 * MINUTE).toISOString(),
      },
    ],
    "zh-CN",
  );
  expect(timeOf("近的")?.textContent).toBe("3小时");
});
