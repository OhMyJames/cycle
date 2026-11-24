// The sub-agent's card (CYCL-217): its states, one loader in the conversation, cards side by side, the task's clamp.
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { cdp, userEvent } from "vitest/browser";
import type { PermissionRequest, SessionSnapshot } from "../../src/api.ts";
import { applyUpdate, emptyConversation } from "../../src/model/index.ts";
import { fakeBridge } from "../fake-bridge.ts";
import { renderApp } from "./render-app.tsx";

const reduceMotion = (on: boolean) =>
  cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: on ? "reduce" : "no-preference" }],
  });

afterEach(async () => {
  cleanup();
  localStorage.clear();
  await reduceMotion(false);
});

const u = (update: object) => update as SessionUpdate;
const tool = (id: string, status: string, rawInput: object) => [
  u({ sessionUpdate: "tool_call_update", toolCallId: id, name: "Agent", status: "pending" }),
  u({ sessionUpdate: "tool_call_update", toolCallId: id, status, rawInput }),
];
const news = (
  id: string,
  call: string,
  state: "running" | "end_turn" | "error" | "cancelled",
  meta: object = {},
) =>
  u({
    sessionUpdate: "subagent_update",
    sessionId: id,
    state: state === "running" ? { state: "running" } : { state: "idle", stopReason: state },
    ...(state === "running" ? { capabilities: { cancel: {} } } : {}),
    _meta: { "cycle/subagent": { toolCallId: call, background: false, ...meta } },
  });

/** The session `s1`, open, with these updates in it, on a daemon that can stop one sub-agent alone. */
const open = async (...updates: SessionUpdate[]) => {
  const snapshot = (): SessionSnapshot => ({
    conversation: updates.reduce((c, u) => applyUpdate(c, u), emptyConversation()),
    permissions: [],
    version: updates.length,
  });
  const script = fakeBridge({
    connected: true,
    snapshot,
    capabilities: { queue: true, files: true, folders: true, stopSubagent: true },
  });
  await renderApp(script.bridge);
  const user = userEvent.setup();
  // Pressed where it is found: the row's name changes as the session's state arrives (it says it is at work), and a
  // locator looked up again by the old name would wait for it in vain.
  const row = await screen.findByRole("option", { name: /work/ });
  await act(() => row.click());
  const log = await screen.findByRole("log", { name: "Conversation" });
  let version = updates.length;
  const emit = (update: SessionUpdate) => {
    version += 1;
    return act(() =>
      script.emit({ type: "update", locationId: "local", sessionId: "s1", update, version }),
    );
  };
  const ask = (request: PermissionRequest) => {
    version += 1;
    return act(() => script.emit({ type: "permission", request, version }));
  };
  return { user, log, emit, ask, script };
};

/** Each sub-agent's card in the conversation, by its call's id. */
const cardsOf = async (log: HTMLElement, count: number) =>
  waitFor(() => {
    const found = [...log.querySelectorAll<HTMLElement>('[data-kind="subagent"]')];
    expect(found).toHaveLength(count);
    return Object.fromEntries(found.map((card) => [card.dataset.itemId, card])) as Record<
      string,
      HTMLElement | undefined
    >;
  });

/** The loaders on screen (the step line keeps its own while quiet, out of the layout). */
const loadersShown = () =>
  [...document.querySelectorAll<HTMLElement>('[data-slot="morph-loader"]')].filter(
    (loader) => loader.getBoundingClientRect().width > 0,
  );

const PARALLEL = [
  u({ sessionUpdate: "user_message", messageId: "u1", content: [{ type: "text", text: "go" }] }),
  u({ sessionUpdate: "state_update", state: "running" }),
  ...tool("p1", "in_progress", { description: "Read the queue code", subagent_type: "Explore" }),
  news("sub-1", "p1", "running", { lastTool: "Grep" }),
  ...tool("p2", "in_progress", { description: "Check how logs are kept" }),
  news("sub-2", "p2", "running", { summary: "Reading the log settings" }),
  ...tool("p3", "completed", { description: "Watch the socket" }),
  news("sub-3", "p3", "running", { background: true, lastTool: "Bash" }),
  ...tool("p4", "failed", { description: "Profile the start-up", prompt: "Profile it." }),
  u({
    sessionUpdate: "tool_call_update",
    toolCallId: "p4",
    content: [{ type: "content", content: { type: "text", text: "Agent failed: EPERM" } }],
  }),
  news("sub-4", "p4", "error"),
  ...tool("p5", "in_progress", { description: "Count the sockets" }),
  news("sub-5", "p5", "cancelled", { usage: { tokens: 1, toolUses: 2, durationMs: 4000 } }),
];

test("a sub-agent is a card, closed as it starts, that says how it stands in a word and a mark", async () => {
  const { log } = await open(...PARALLEL);
  const cards = await cardsOf(log, 5);
  const [p1, p2, p3, p4, p5] = ["p1", "p2", "p3", "p4", "p5"].map((id) => cards[id] as HTMLElement);
  for (const card of Object.values(cards)) {
    expect(card?.querySelector(":scope > button")?.getAttribute("aria-expanded")).toBe("false");
  }
  expect([p1, p2, p3, p4, p5].map((card) => card?.dataset.status)).toEqual([
    "running",
    "running",
    "running",
    "failed",
    "stopped",
  ]);
  // Words, never colour alone.
  expect(p1?.textContent).toContain("Working");
  expect(p1?.textContent).toContain("Explore");
  expect(p1?.textContent).toContain("Using Grep");
  expect(p2?.textContent).toContain("Reading the log settings");
  expect(p3?.dataset.background).toBe("true");
  expect(p3?.textContent).toContain("Background");
  expect(p4?.textContent).toContain("Failed");
  expect(p4?.querySelector('[data-slot="subagent-glimpse"]')?.textContent).toBe(
    "Agent failed: EPERM",
  );
  expect(p5?.textContent).toContain("Stopped");
  expect(p5?.textContent).toContain("2 steps");
  // And a shape for each.
  expect(p4?.querySelector('[data-slot="subagent-mark"] svg')).not.toBeNull();
  expect(p5?.querySelector('[data-slot="subagent-mark"] svg')).not.toBeNull();
  // Each one at work has its own Stop; the ones that ended have none.
  expect(within(log).getAllByRole("button", { name: /^Stop sub-agent/ })).toHaveLength(3);
});

test("the conversation has one loader: the first sub-agent at work, the others a still ring, the status line when it speaks", async () => {
  const { log, emit, ask } = await open(...PARALLEL);
  const cards = await cardsOf(log, 5);
  // The step line is quiet while the calls are at work; the first card has the loader.
  await waitFor(() => expect(loadersShown()).toHaveLength(1));
  expect(cards.p1?.contains(loadersShown()[0] as HTMLElement)).toBe(true);
  expect(cards.p2?.querySelector('[data-slot="subagent-still"]')).not.toBeNull();
  expect(cards.p3?.querySelector('[data-slot="subagent-still"]')).not.toBeNull();
  // The first ends: the next at work takes it.
  await emit(news("sub-1", "p1", "end_turn"));
  await waitFor(() => expect(cards.p2?.querySelector('[data-slot="morph-loader"]')).not.toBeNull());
  expect(loadersShown()).toHaveLength(1);
  expect(cards.p1?.dataset.status).toBe("done");
  // The agent asks the person: the status line speaks, and holds the loader; the cards stand still.
  await ask({
    key: "local:s1:p1",
    locationId: "local",
    sessionId: "s1",
    title: "Allow Bash?",
    subject: { type: "tool_call", toolCall: { name: "Bash", rawInput: { command: "ls" } } },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
  });
  await waitFor(() => expect(cards.p2?.querySelector('[data-slot="morph-loader"]')).toBeNull());
  expect(loadersShown()).toHaveLength(1);
  expect(loadersShown()[0]?.closest('[data-slot="step"]')).not.toBeNull();
});

test("cards side by side open, close and stop each on its own, by keyboard too", async () => {
  const { user, log, emit, script } = await open(...PARALLEL);
  const cards = await cardsOf(log, 5);
  const head = (id: string) => cards[id]?.querySelector(":scope > button") as HTMLElement;
  head("p2").focus();
  await user.keyboard("{Enter}");
  expect(head("p2").getAttribute("aria-expanded")).toBe("true");
  expect(head("p1").getAttribute("aria-expanded")).toBe("false");
  expect(
    script.calls.filter(([name, event]) => name === "track" && event === "subagent_opened"),
  ).toEqual([["track", "subagent_opened", { work: false, running: true }]]);
  // Its Stop is a button beside the head, named for its sub-agent.
  const stop = within(cards.p1 as HTMLElement).getByRole("button", {
    name: "Stop sub-agent Read the queue code",
  });
  expect(stop.textContent).toBe("Stop");
  await user.click(stop);
  await waitFor(() => expect(stop.textContent).toBe("Stopping…"));
  expect(cards.p1?.textContent).toContain("Stopping…");
  expect(script.calls.filter(([name]) => name === "stopSubagent")).toEqual([
    ["stopSubagent", "local", "s1", "sub-1", false],
  ]);
  await emit(news("sub-1", "p1", "cancelled"));
  await waitFor(() => expect(cards.p1?.dataset.status).toBe("stopped"));
  expect(cards.p1?.textContent).toContain("Stopped");
  expect(cards.p1?.textContent).not.toContain("Stopping…");
  // The others go on.
  expect(cards.p2?.dataset.status).toBe("running");
  expect(
    within(cards.p2 as HTMLElement).getByRole("button", { name: /^Stop sub-agent/ }),
  ).toBeDefined();
});

test("a long task shows three lines, all of it on request; a long one does not leave the card", async () => {
  const prompt = Array.from({ length: 30 }, (_, n) => `Step ${n + 1}: ${"x".repeat(300)}`).join(
    "\n",
  );
  const title = `Survey ${"every package ".repeat(10)}`.trim();
  const { user, log, script } = await open(
    u({ sessionUpdate: "user_message", messageId: "u1", content: [{ type: "text", text: "go" }] }),
    u({ sessionUpdate: "state_update", state: "running" }),
    ...tool("l1", "in_progress", { description: title, prompt }),
    news("sub-l", "l1", "running"),
  );
  const { l1 } = await cardsOf(log, 1);
  const card = l1 as HTMLElement;
  const width = card.getBoundingClientRect().width;
  expect(card.scrollWidth).toBeLessThanOrEqual(Math.ceil(width));
  await user.click(card.querySelector(":scope > button") as HTMLElement);
  const shown = await waitFor(() => {
    const found = card.querySelector<HTMLElement>('[data-slot="subagent-prompt"]');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  const lines =
    shown.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(shown).lineHeight);
  expect(Math.round(lines)).toBe(3);
  await user.click(await within(card).findByRole("button", { name: "Show the whole task" }));
  expect(shown.dataset.whole).toBe("true");
  expect(shown.scrollHeight).toBeGreaterThan(shown.clientHeight);
  expect(card.getBoundingClientRect().width).toBe(width);
  expect(
    script.calls.filter(([name, event]) => name === "track" && event === "subagent_task_expanded"),
  ).toEqual([["track", "subagent_task_expanded", {}]]);
  await user.click(within(card).getByRole("button", { name: "Show less of the task" }));
  expect(shown.dataset.whole).toBeUndefined();
});

test("with reduced motion the card's loader stands still", async () => {
  await reduceMotion(true);
  const { log } = await open(...PARALLEL);
  const { p1 } = await cardsOf(log, 5);
  const loader = await waitFor(() => {
    const found = p1?.querySelector<SVGSVGElement>('[data-slot="morph-loader"] svg');
    expect(found).not.toBeNull();
    return found as SVGSVGElement;
  });
  await waitFor(() => expect(loader.dataset.animating).toBe("false"));
});
