// What to say next (CYCL-225): the agent's suggestion stands in the empty message box in place of its usual words, →
// or Tab makes it the message, typing hides it, and the next turn makes it stale.
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { Preferences, SessionSnapshot } from "../../src/api.ts";
import { applyUpdate, emptyConversation } from "../../src/model/index.ts";
import { fakeBridge } from "../fake-bridge.ts";
import { openSettings } from "./account-menu.ts";
import { boxText, ready, write } from "./box.ts";
import { renderApp } from "./render-app.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const u = (update: object) => update as SessionUpdate;
const IDLE = "Message the agent";
const SUGGESTED = "Run the tests";
const turn = (suggestion?: string) => [
  u({ sessionUpdate: "user_message", messageId: "u1", content: [{ type: "text", text: "fix" }] }),
  u({ sessionUpdate: "state_update", state: "running" }),
  u({ sessionUpdate: "agent_message", messageId: "a1", content: [{ type: "text", text: "done" }] }),
  u({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" }),
  ...(suggestion !== undefined
    ? [u({ sessionUpdate: "_cycle/prompt_suggestion", suggestion })]
    : []),
];

const open = async (updates: SessionUpdate[], preferences: Partial<Preferences> = {}) => {
  const snapshot = (): SessionSnapshot => ({
    conversation: updates.reduce((c, x) => applyUpdate(c, x), emptyConversation()),
    permissions: [],
    version: updates.length,
  });
  const script = fakeBridge({ connected: true, snapshot, preferences });
  const store = await renderApp(script.bridge);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("option", { name: /work/ }));
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  let version = updates.length;
  const emit = (update: SessionUpdate) => {
    version += 1;
    return act(() =>
      script.emit({ type: "update", environmentId: "local", sessionId: "s1", update, version }),
    );
  };
  const tracked = () =>
    script.calls
      .filter(([name, event]) => name === "track" && event === "prompt_suggestion_accepted")
      .map(([, , props]) => props);
  return { ...script, user, box, emit, tracked, store };
};

const placeholderOf = (box: HTMLElement) => box.getAttribute("aria-placeholder");
const shown = () => document.querySelector('[data-slot="composer-placeholder"]');

test("after a turn, the suggestion is the empty box's placeholder, and → makes it the message with the caret at its end", async () => {
  const { user, box, tracked } = await open(turn(SUGGESTED));
  await waitFor(() => expect(placeholderOf(box)).toBe(SUGGESTED));
  expect(shown()?.textContent).toBe(SUGGESTED);
  expect(shown()?.hasAttribute("data-suggested")).toBe(true);
  expect(box.getAttribute("aria-keyshortcuts")).toBe("ArrowRight Tab");
  await user.click(box);
  await user.keyboard("{ArrowRight}");
  await waitFor(() => expect(boxText(box)).toBe(SUGGESTED));
  await user.keyboard(" now");
  expect(boxText(box)).toBe(`${SUGGESTED} now`);
  // Once there is text, → is the caret's again.
  await user.keyboard("{ArrowLeft}{ArrowRight}");
  expect(boxText(box)).toBe(`${SUGGESTED} now`);
  expect(tracked()).toEqual([{ key: "arrow" }]);
  // Only how it was taken is counted, never what it said.
  expect(JSON.stringify(tracked())).not.toContain(SUGGESTED);
});

test("Tab takes it too; typing hides it, and emptying the box shows it again", async () => {
  const { user, box, tracked } = await open(turn(SUGGESTED));
  await waitFor(() => expect(placeholderOf(box)).toBe(SUGGESTED));
  await write(box, "x");
  expect(placeholderOf(box)).toBe(IDLE);
  await user.keyboard("{Backspace}");
  await waitFor(() => expect(placeholderOf(box)).toBe(SUGGESTED));
  await user.keyboard("{Tab}");
  await waitFor(() => expect(boxText(box)).toBe(SUGGESTED));
  expect(document.activeElement).toBe(box);
  expect(tracked()).toEqual([{ key: "tab" }]);
});

test("the next turn makes the suggestion stale", async () => {
  const { box, emit } = await open(turn(SUGGESTED));
  await waitFor(() => expect(placeholderOf(box)).toBe(SUGGESTED));
  await emit(u({ sessionUpdate: "user_message", messageId: "u2", content: [] }));
  await waitFor(() => expect(placeholderOf(box)).toBe(IDLE));
  await emit(u({ sessionUpdate: "state_update", state: "running" }));
  await emit(u({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" }));
  // Done again, with nothing new suggested: the old one does not come back.
  await waitFor(() => expect(placeholderOf(box)).toBe(IDLE));
  // A turn the agent began itself makes it stale as well.
  await emit(u({ sessionUpdate: "_cycle/prompt_suggestion", suggestion: "Commit it" }));
  await waitFor(() => expect(placeholderOf(box)).toBe("Commit it"));
  await emit(u({ sessionUpdate: "state_update", state: "running" }));
  await waitFor(() => expect(placeholderOf(box)).not.toBe("Commit it"));
});

test("an agent that suggests nothing keeps the usual words, and → and Tab do nothing", async () => {
  const { user, box, tracked } = await open(turn());
  await waitFor(() => expect(placeholderOf(box)).toBe(IDLE));
  expect(shown()?.hasAttribute("data-suggested")).toBe(false);
  expect(box.hasAttribute("aria-keyshortcuts")).toBe(false);
  await user.click(box);
  await user.keyboard("{ArrowRight}");
  expect(boxText(box)).toBe("");
  expect(tracked()).toEqual([]);
});

test("turned off in Settings, no suggestion is shown; the switch there says so and changes it", async () => {
  const { user, box, named } = await open(turn(SUGGESTED), { promptSuggestions: false });
  await waitFor(() => expect(placeholderOf(box)).toBe(IDLE));
  await user.click(box);
  await user.keyboard("{ArrowRight}");
  expect(boxText(box)).toBe("");

  await openSettings(user);
  const toggle = await screen.findByRole("switch", { name: "Suggest the next message" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await user.click(toggle);
  await waitFor(() =>
    expect(named("setPreferences")).toEqual([["setPreferences", { promptSuggestions: true }]]),
  );
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
});
