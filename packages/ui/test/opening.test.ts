import { expect, test } from "bun:test";
import { draftKey, opening } from "../src/lib/opening.ts";

const ports = (sent: "sent" | "refused" | "lost", gone = true) => {
  const calls: string[] = [];
  return {
    calls,
    send: async () => (calls.push("send"), sent),
    drop: async () => (calls.push("drop"), gone),
  };
};

test("a first prompt the daemon takes leaves the session as it is", async () => {
  const one = ports("sent");
  expect(await opening(one)).toBe("sent");
  expect(one.calls).toEqual(["send"]);
});

test("a first prompt the daemon refuses deletes the empty session", async () => {
  const one = ports("refused");
  expect(await opening(one)).toBe("dropped");
  expect(one.calls).toEqual(["send", "drop"]);
});

test("a connection that failed under the prompt keeps the session: the daemon may have it", async () => {
  const one = ports("lost");
  expect(await opening(one)).toBe("kept");
  expect(one.calls).toEqual(["send"]);
});

test("a session that cannot be deleted stays, for the prompt to wait in", async () => {
  expect(await opening(ports("refused", false))).toBe("kept");
});

test("a new session's composer is known by its folder, so a prompt can be given back to it", () => {
  expect(draftKey("/work/app")).toBe("new:/work/app");
});
