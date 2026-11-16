import { expect, test } from "bun:test";
import { draftKey, opening } from "../src/lib/opening.ts";

test("a first prompt the agent takes leaves the session as it is", async () => {
  const calls: string[] = [];
  const result = await opening({
    send: async () => (calls.push("send"), true),
    drop: async () => (calls.push("drop"), true),
  });
  expect(result).toBe("sent");
  expect(calls).toEqual(["send"]);
});

test("a first prompt the agent does not take deletes the empty session", async () => {
  const calls: string[] = [];
  const result = await opening({
    send: async () => (calls.push("send"), false),
    drop: async () => (calls.push("drop"), true),
  });
  expect(result).toBe("dropped");
  expect(calls).toEqual(["send", "drop"]);
});

test("a session that cannot be deleted stays, for the prompt to wait in", async () => {
  expect(await opening({ send: async () => false, drop: async () => false })).toBe("kept");
});

test("a new session's composer is known by its folder, so a prompt can be given back to it", () => {
  expect(draftKey("/work/app")).toBe("new:/work/app");
});
