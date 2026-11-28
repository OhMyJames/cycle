// Carrying on in a new session (CYC-279): a long or long-idle conversation is offered a fresh session that mentions it.
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { boxText } from "./box.ts";
import { openSession } from "./mount.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const u = (update: object) => update as SessionUpdate;
const CAPS = { queue: true, files: true, folders: true, sessionMentions: true };

const open = async (
  used: number,
  capabilities: typeof CAPS | Omit<typeof CAPS, "sessionMentions"> = CAPS,
) => {
  const updates = [
    u({ sessionUpdate: "user_message", messageId: "u1", content: [{ type: "text", text: "fix" }] }),
    u({ sessionUpdate: "agent_message", messageId: "a1", content: [{ type: "text", text: "ok" }] }),
    u({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" }),
    u({ sessionUpdate: "usage_update", used, size: 1_000_000 }),
  ];
  const app = await openSession(updates, { box: true, fake: { capabilities } });
  const tracked = () =>
    app.tracked().filter(([event]) => String(event).startsWith("continue_hint"));
  return { ...app, tracked };
};

const hint = () => document.querySelector('[data-kind="continue"]');

test("a long conversation is offered a new session, which opens with the old one mentioned and nothing sent", async () => {
  const { user, tracked, calls } = await open(250_000);
  await waitFor(() => expect(hint()).not.toBeNull());
  expect(hint()?.textContent).toContain("every reply sends all of it again");
  await user.click(screen.getByRole("button", { name: "Continue in new session" }));
  const box = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => expect(boxText(box)).toMatch(/^@\S.* $/));
  expect(hint()).toBeNull();
  expect(calls.some(([name]) => name === "prompt" || name === "createSession")).toBe(false);
  expect(tracked()).toEqual([
    ["continue_hint_shown", { reason: "context" }],
    ["continue_hint_used", { reason: "context" }],
  ]);
});

test("a conversation left idle while big is offered one, a small one is not, and dismissing hides it", async () => {
  const idle = await open(150_000);
  await waitFor(() => expect(hint()).not.toBeNull());
  expect(hint()?.textContent).toContain("has been idle");
  await idle.user.click(screen.getByRole("button", { name: "Dismiss hint" }));
  expect(hint()).toBeNull();
  expect(idle.tracked()).toEqual([["continue_hint_shown", { reason: "idle" }]]);
  cleanup();
  const small = await open(50_000);
  await act(async () => {});
  expect(small.box).toBeTruthy();
  expect(hint()).toBeNull();
});

test("a daemon that cannot expand a mention is not offered it", async () => {
  await open(250_000, { queue: true, files: true, folders: true });
  await act(async () => {});
  expect(hint()).toBeNull();
});
