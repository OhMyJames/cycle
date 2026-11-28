import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { LocationConfig, SessionSummary } from "../../src/api.ts";
import { sessionKey } from "../../src/sessions.ts";
import { fakeBridge, summary } from "../fake-bridge.ts";
import { renderApp } from "./render-app.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const far: LocationConfig = {
  id: "far",
  name: "Build box",
  kind: "remote",
  transport: { type: "ssh", host: "me@box" },
};

const sessions: SessionSummary[] = [
  { ...summary("a"), title: "alpha", lastSeq: 2 },
  { ...summary("b"), title: "beta", lastSeq: 1 },
  {
    ...summary("r"),
    title: "running one with a rather long title to hold",
    lastSeq: 3,
    state: "running",
  },
  { ...summary("f", "far"), title: "faraway", lastSeq: 1 },
];

const mount = async () => {
  const script = fakeBridge({ connected: true, locations: [far], states: { far: "closed" } });
  script.bridge.sessions = async (locationId: string) =>
    sessions.filter((s) => s.locationId === locationId);
  const store = await renderApp(script.bridge);
  await screen.findAllByRole("option");
  const row = (title: string) => screen.getByRole("option", { name: new RegExp(title) });
  const draft = (id: string, locationId = "local") => sessionKey(summary(id, locationId));
  return { store, row, draft };
};

const mark = (row: HTMLElement) => row.querySelector('[data-slot="session-draft"]');

test("a row with an unsent draft shows the marker and says so to a reader; one without does not", async () => {
  const { store, row, draft } = await mount();
  expect(mark(row("alpha"))).toBeNull();
  act(() => store.drafts.setText(draft("a"), "half a sentence"));
  await waitFor(() => expect(mark(row("alpha"))).not.toBeNull());
  expect(row("alpha").textContent).toContain("Unsent draft");
  expect(
    within(row("alpha"))
      .getByText(/Unsent draft/)
      .getAttribute("data-slot"),
  ).toBe("visually-hidden");
  expect(mark(row("beta"))).toBeNull();
  expect(row("beta").textContent).not.toContain("Unsent draft");
});

test("blank text is not a draft", async () => {
  const { store, row, draft } = await mount();
  act(() => store.drafts.setText(draft("a"), "  \n "));
  await new Promise((r) => setTimeout(r, 20));
  expect(mark(row("alpha"))).toBeNull();
});

test("when the draft is sent or cleared the marker goes without a reload", async () => {
  const { store, row, draft } = await mount();
  act(() => store.drafts.setText(draft("a"), "one"));
  act(() => store.drafts.setText(draft("b"), "two"));
  await waitFor(() => expect(mark(row("beta"))).not.toBeNull());
  act(() => store.drafts.clear(draft("a")));
  await waitFor(() => expect(mark(row("alpha"))).toBeNull());
  expect(row("alpha").textContent).not.toContain("Unsent draft");
  act(() => store.drafts.setText(draft("b"), ""));
  await waitFor(() => expect(mark(row("beta"))).toBeNull());
});

test("a row of a location that is away does not show it", async () => {
  const { store, row, draft } = await mount();
  act(() => store.drafts.setText(draft("f", "far"), "kept for later"));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Switch workspace/ }));
  await user.click(await screen.findByRole("menuitem", { name: /On Build box · .* work/ }));
  const away = await waitFor(() => {
    const r = screen.getAllByRole("option").find((o) => o.getAttribute("data-away") !== null);
    if (r === undefined) throw new Error("no away row");
    return r;
  });
  expect(mark(away)).toBeNull();
  expect(away.textContent).not.toContain("Unsent draft");
  void row;
});

test("it sits beside the time or the status dot, and the title still gives way", async () => {
  const { store, row, draft } = await mount();
  act(() => store.drafts.setText(draft("a"), "x"));
  act(() => store.drafts.setText(draft("r"), "y"));
  await waitFor(() => expect(mark(row("running one"))).not.toBeNull());
  for (const [title, other] of [
    ["alpha", "session-time"],
    ["running one", "session-dot"],
  ] as const) {
    const r = row(title);
    const m = mark(r) as HTMLElement;
    const o = r.querySelector<HTMLElement>(`[data-slot="${other}"]`);
    expect(o).not.toBeNull();
    const rr = r.getBoundingClientRect();
    const mr = m.getBoundingClientRect();
    const or = (o as HTMLElement).getBoundingClientRect();
    // Side by side, not on top of one another, and inside the row.
    expect(mr.right).toBeLessThanOrEqual(or.left + 0.5);
    expect(or.right).toBeLessThanOrEqual(rr.right + 0.5);
    expect(mr.width).toBeGreaterThan(0);
    const t = r.querySelector<HTMLElement>('[data-slot="session-title"]') as HTMLElement;
    expect(t.getBoundingClientRect().right).toBeLessThanOrEqual(mr.left + 0.5);
    expect(r.scrollWidth).toBeLessThanOrEqual(r.clientWidth);
  }
});
