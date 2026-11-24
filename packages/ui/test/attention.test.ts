import { expect, test } from "bun:test";
import type { SessionSummary } from "../src/api.ts";
import { type Attention, attentionOf } from "../src/attention.ts";

const row = (
  state: SessionSummary["state"],
  over: Partial<SessionSummary> = {},
): SessionSummary => ({
  locationId: "local",
  sessionId: "s",
  cwd: "/work",
  archived: false,
  agent: "claude",
  state,
  lastSeq: 1,
  ...over,
});

type Case = [string, SessionSummary["state"], SessionSummary["state"], Attention | undefined];

test.each<Case>([
  ["working -> asks", "running", "requires_action", "needs-you"],
  ["idle -> asks", "idle", "requires_action", "needs-you"],
  ["stopped -> asks", "stopped", "requires_action", "needs-you"],
  ["asks -> asks", "requires_action", "requires_action", undefined],
  ["working -> done", "running", "idle", "finished"],
  ["asks -> done (answered, then finished)", "requires_action", "idle", "finished"],
  ["working -> agent gone", "running", "stopped", "stopped"],
  ["asks -> agent gone", "requires_action", "stopped", "stopped"],
  ["idle -> released (quiet)", "idle", "stopped", undefined],
  ["stopped -> idle (an agent started)", "stopped", "idle", undefined],
  ["idle -> working", "idle", "running", undefined],
  ["asks -> working (answered)", "requires_action", "running", undefined],
  ["working -> working", "running", "running", undefined],
])("%s", (_name, before, after, expected) => {
  expect(attentionOf(row(before), row(after))).toBe(expected);
});

test("a session that was not in the list before says nothing, whatever it is", () => {
  expect(attentionOf(undefined, row("requires_action"))).toBeUndefined();
  expect(attentionOf(undefined, row("idle"))).toBeUndefined();
});

test("an archived session says nothing", () => {
  expect(attentionOf(row("running"), row("idle", { archived: true }))).toBeUndefined();
  expect(attentionOf(row("idle"), row("requires_action", { archived: true }))).toBeUndefined();
});

test("a turn too short for any list to see it running is still told, by the session turning unread", () => {
  const seen = row("idle", { unread: false });
  expect(attentionOf(seen, row("idle", { unread: true }))).toBe("finished");
  // Already unread, or a daemon that does not say: nothing new.
  expect(attentionOf(row("idle", { unread: true }), row("idle", { unread: true }))).toBeUndefined();
  expect(attentionOf(row("idle"), row("idle"))).toBeUndefined();
  // Read: nothing to tell.
  expect(
    attentionOf(row("idle", { unread: true }), row("idle", { unread: false })),
  ).toBeUndefined();
});
