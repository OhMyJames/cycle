import { expect, test } from "bun:test";
import type { HarnessEvent } from "@cycle/protocol";
import { ClaudeHarness, sandboxName } from "../src/index.ts";
import type { WireMessage } from "../src/wire.ts";
import { fakeSbx } from "./fake-sbx.ts";
import { FakeSdk, settle } from "./fake-sdk.ts";

// What stays true of a Claude Code process whose agent may enter a worktree, with the port or without.

const options = { mode: "default", model: "claude-sonnet-5-5" };
const prompt = (text: string) => ({ text, images: [] });
/** What Claude Code says as a turn begins: where it is now. */
const init = (cwd: string): WireMessage =>
  Object.assign({ type: "system", subtype: "init" }, { cwd });

function setup() {
  const sdk = new FakeSdk();
  let ids = 0;
  const harness = new ClaudeHarness({
    sdk,
    env: { CLAUDE_CONFIG_DIR: "/home/me/.claude" },
    schedule: () => () => {},
    now: () => 1000,
    newId: () => `id${++ids}`,
  });
  const events: HarnessEvent[] = [];
  harness.onEvent((event) => events.push(event));
  return { sdk, harness, events };
}

test("a harness given no port starts Claude Code with no hooks of its own", async () => {
  const { sdk, harness } = setup();
  const session = await harness.createSession({ cwd: "/project", model: options.model });
  await harness.send(session.id, prompt("hello"), options);
  await settle();
  expect(sdk.last.options).not.toHaveProperty("hooks");
  expect(sdk.last.options.disallowedTools).toBeUndefined();
});

test("where Claude Code says it is makes no item and begins no turn, whether a turn runs or not", async () => {
  const { sdk, harness, events } = setup();
  const session = await harness.createSession({ cwd: "/project", model: options.model });
  await harness.send(session.id, prompt("hello"), options);
  await settle();
  events.length = 0;
  sdk.last.say(init("/project/.agents/worktree/x"));
  await settle();
  // The one thing it makes is the session's change, which the daemon reads for its title alone.
  expect(events.filter((event) => event.type !== "session.changed")).toEqual([]);
  // Between turns too: an `init` is not the start of a turn of the agent's own.
  sdk.last.say({ type: "result", subtype: "success", is_error: false, duration_ms: 1 });
  await settle();
  events.length = 0;
  sdk.last.say(init("/project"));
  await settle();
  expect(events.filter((event) => event.type !== "session.changed")).toEqual([]);
});

test("a session in a sandbox is started with the built-in worktree tools turned off, and no hooks", async () => {
  const sbx = fakeSbx();
  const sdk = new FakeSdk();
  const harness = new ClaudeHarness({
    sdk,
    env: { CLAUDE_CONFIG_DIR: "/home/me/.claude" },
    bin: "/opt/claude",
    sandboxes: sbx.sandboxes,
    files: { move: async () => true },
    schedule: () => () => {},
    now: () => 1000,
    newId: () => "id1",
  });
  const session = await harness.createSession({
    cwd: "/Users/me/app",
    sandboxed: "standard",
    ...options,
  });
  const name = sandboxName("/Users/me/app", "standard");
  await harness.send(session.id, prompt("hello"), { ...options, sandbox: name });
  await settle();
  // Changed with the hooks: without it the built-in tool made its worktree in the mounted folder.
  expect(sdk.last.options.disallowedTools).toEqual(["EnterWorktree", "ExitWorktree"]);
  expect(sdk.last.options).not.toHaveProperty("hooks");
});
