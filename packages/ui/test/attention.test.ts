import { expect, test } from "bun:test";
import type { SessionStatus } from "@cycle/protocol";
import { attentionLabel } from "../src/lib/attention.ts";

test.each<[SessionStatus, SessionStatus, string | null]>([
  ["running", "idle", "Finished"],
  ["waiting", "idle", "Finished"],
  ["running", "error", "Stopped with an error"],
  ["waiting", "error", "Stopped with an error"],
  ["running", "waiting", "Needs your approval"],
  ["idle", "waiting", "Needs your approval"],
  ["error", "waiting", "Needs your approval"],
  ["stored", "waiting", "Needs your approval"],
  ["stored", "idle", null],
  ["idle", "stored", null],
  ["stored", "error", null],
  ["idle", "error", null],
  ["idle", "running", null],
  ["waiting", "running", null],
  ["error", "running", null],
  ["running", "running", null],
  ["waiting", "waiting", null],
  ["idle", "idle", null],
])("a session going from %s to %s says %p", (before, after, label) => {
  expect(attentionLabel(before, after)).toBe(label);
});
