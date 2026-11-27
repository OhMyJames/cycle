import { expect, test } from "bun:test";
import { stopRefusal } from "../src/main/stop-refused.ts";

const stdout = `4 sessions are working:
  - [CYC-496] Dev: a turn is running, 1 background task
  - Notes: a turn is running
  - [CYC-483] Dev: a turn is running
  - Loop: a turn is running
Not stopped. Run \`cycle stop --wait\` to stop once they finish, or \`cycle stop --force\` to stop now.
`;

test("a stop that refused names the sessions in the way", () => {
  expect(stopRefusal({ code: 4, stdout })).toBe(
    "4 sessions are still working, so Cycle did not restart: [CYC-496] Dev: a turn is running, 1 background task; Notes: a turn is running; [CYC-483] Dev: a turn is running; and 1 more. Install again when they finish.",
  );
  expect(
    stopRefusal({ code: 4, stdout: "1 session is working:\n  - Notes: a turn is running\n" }),
  ).toBe(
    "A session is still working, so Cycle did not restart: Notes: a turn is running. Install again when they finish.",
  );
  expect(stopRefusal({ code: 4 })).toContain("Sessions are still working");
});

test("any other failure is not a refusal", () => {
  expect(stopRefusal({ code: 1, stdout })).toBeUndefined();
  expect(stopRefusal(new Error("Command failed"))).toBeUndefined();
  expect(stopRefusal(undefined)).toBeUndefined();
});
