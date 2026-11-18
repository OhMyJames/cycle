import { expect, test } from "bun:test";
import type { Session } from "@cycle/protocol";
import { attentionLabel } from "../src/lib/attention.ts";

type Mark = Pick<Session, "activity" | "failed">;

const marks = {
  idle: { activity: "idle", failed: false },
  running: { activity: "running", failed: false },
  asking: { activity: "requires_action", failed: false },
  failed: { activity: "idle", failed: true },
} satisfies Record<string, Mark>;

test.each<[keyof typeof marks, keyof typeof marks, string | null]>([
  ["running", "idle", "Finished"],
  ["asking", "idle", "Finished"],
  ["running", "failed", "Stopped with an error"],
  ["asking", "failed", "Stopped with an error"],
  ["running", "asking", "Needs your approval"],
  ["idle", "asking", "Needs your approval"],
  ["failed", "asking", "Needs your approval"],
  ["idle", "failed", null],
  ["failed", "idle", null],
  ["idle", "running", null],
  ["asking", "running", null],
  ["failed", "running", null],
  ["running", "running", null],
  ["asking", "asking", null],
  ["idle", "idle", null],
])("a session going from %s to %s says %p", (before, after, label) => {
  expect(attentionLabel(marks[before], marks[after])).toBe(label);
});
