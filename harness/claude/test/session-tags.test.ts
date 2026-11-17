import { expect, test } from "bun:test";
import { ClaudeHarness } from "../src/index.ts";
import { FakeSdk, settle } from "./fake-sdk.ts";

const MODEL = "claude-sonnet-5-5";

test("a conversation's tag is Claude Code's own: set through the SDK, read back with the session", async () => {
  const sdk = new FakeSdk();
  sdk.stored = [
    { sessionId: "s1", summary: "x", lastModified: 1, cwd: "/project", tag: " later " },
    { sessionId: "s2", summary: "y", lastModified: 2, cwd: "/project" },
  ];
  const harness = new ClaudeHarness({ sdk, env: { CLAUDE_CONFIG_DIR: "/home/me/.claude" } });
  expect(harness.capabilities.tags).toBe(true);
  const listed = await harness.listSessions({ archived: false });
  expect(listed.find((each) => each.id === "s1")?.tag).toBe("later");
  expect(listed.find((each) => each.id === "s2")).not.toHaveProperty("tag");

  await harness.tagSession("s1", "now");
  await harness.tagSession("s1", null);
  expect(sdk.calls).toEqual(["tag s1 now", "tag s1 none"]);
});

test("a conversation with no turn yet has no file to keep a tag in, and says so", async () => {
  const sdk = new FakeSdk();
  const harness = new ClaudeHarness({ sdk, env: { CLAUDE_CONFIG_DIR: "/home/me/.claude" } });
  const session = await harness.createSession({ cwd: "/project", model: MODEL });
  await expect(harness.tagSession(session.id, "x")).rejects.toThrow("once it has had a turn");
  await harness.send(session.id, { text: "hi", images: [] }, { mode: "default", model: MODEL });
  await settle();
  sdk.last.say({ type: "result", subtype: "success", is_error: false });
  await settle();
  await harness.tagSession(session.id, "x");
  expect(sdk.calls).toContain(`tag ${session.id} x`);
});
