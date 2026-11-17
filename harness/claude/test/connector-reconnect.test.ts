import { expect, test } from "bun:test";
import { ClaudeHarness } from "../src/index.ts";
import { FakeSdk, settle } from "./fake-sdk.ts";

const MODEL = "claude-sonnet-5-5";

test("a server is connected again in the process that runs, and the next look at the servers asks again", async () => {
  const sdk = new FakeSdk();
  const harness = new ClaudeHarness({ sdk, env: { CLAUDE_CONFIG_DIR: "/home/me/.claude" } });
  expect(harness.capabilities.mcpReconnect).toBe(true);
  // With nothing running, there is no process to connect it in: that is said, not guessed at.
  await expect(harness.reconnectMcpServer("docs")).rejects.toThrow("No Claude Code session");
  const session = await harness.createSession({ cwd: "/project", model: MODEL });
  await harness.send(session.id, { text: "hi", images: [] }, { mode: "default", model: MODEL });
  await settle();
  await harness.reconnectMcpServer("docs");
  expect(sdk.last.reconnects).toEqual(["docs"]);
});
