import { expect, test } from "bun:test";
import { ClaudeHarness } from "../src/index.ts";
import { FakeSdk, settle } from "./fake-sdk.ts";

const MODEL = "claude-sonnet-5-5";

test("the helper agents a folder's session can start are what its process said, asked once and kept", async () => {
  const sdk = new FakeSdk();
  sdk.agents = [
    { name: "Explore", description: "Searches the code", model: "haiku" },
    { name: "reviewer", description: "Reads a diff" },
  ];
  const harness = new ClaudeHarness({ sdk, env: { CLAUDE_CONFIG_DIR: "/home/me/.claude" } });
  expect(harness.capabilities.subagents).toBe(true);

  // Nothing runs in the folder: a process is started to ask, and closed.
  expect(await harness.listSubagents("/project")).toEqual([
    { name: "Explore", description: "Searches the code", model: "haiku" },
    { name: "reviewer", description: "Reads a diff", model: null },
  ]);
  expect(sdk.queries).toHaveLength(1);
  expect(sdk.last.closed).toBe(true);

  // The files are as they were, so what was said is kept and nothing starts again.
  await harness.listSubagents("/project");
  expect(sdk.queries).toHaveLength(1);

  // A session's own process says the same as it starts.
  const session = await harness.createSession({ cwd: "/other", model: MODEL });
  await harness.send(session.id, { text: "hi", images: [] }, { mode: "default", model: MODEL });
  await settle();
  const before = sdk.queries.length;
  expect(await harness.listSubagents("/other")).toHaveLength(2);
  expect(sdk.queries).toHaveLength(before);
});
