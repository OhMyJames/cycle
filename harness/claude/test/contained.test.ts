import { expect, test } from "bun:test";
import { ClaudeHarness, modeOptions, processSpec } from "../src/index.ts";
import { fakeSbx } from "./fake-sbx.ts";
import { FakeSdk, settle } from "./fake-sdk.ts";

const SANDBOX = { enabled: true, autoAllowBashIfSandboxed: true };

test("a session in a container leaves Claude Code's own command sandbox off, whatever the mode", () => {
  // On this machine `acceptEdits` and `auto` run commands in Claude Code's sandbox.
  expect(modeOptions("acceptEdits", false)).toEqual({
    permissionMode: "acceptEdits",
    sandbox: SANDBOX,
  });
  expect(modeOptions("auto", false)).toEqual({ permissionMode: "auto", sandbox: SANDBOX });
  // In a container the container is the wall, so a command asks first in `acceptEdits`.
  expect(modeOptions("acceptEdits", true)).toEqual({ permissionMode: "acceptEdits" });
  expect(modeOptions("auto", true)).toEqual({ permissionMode: "auto" });
  // The other modes never had one.
  for (const contained of [false, true]) {
    expect(modeOptions("plan", contained)).toEqual({ permissionMode: "plan" });
    expect(modeOptions("bypassPermissions", contained)).toEqual({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
  }
});

test("what a process is started with is the same for a mode in a container as for one that asks first", () => {
  expect(processSpec("acceptEdits", false)).toBe(JSON.stringify({ sandbox: SANDBOX }));
  expect(processSpec("auto", false)).toBe(JSON.stringify({ sandbox: SANDBOX }));
  expect(processSpec("acceptEdits", true)).toBe("{}");
  expect(processSpec("auto", true)).toBe("{}");
  expect(processSpec("plan", false)).toBe("{}");
  expect(processSpec("plan", true)).toBe("{}");
  expect(processSpec("bypassPermissions", false)).toBe(
    JSON.stringify({ allowDangerouslySkipPermissions: true }),
  );
  expect(processSpec("bypassPermissions", true)).toBe(
    JSON.stringify({ allowDangerouslySkipPermissions: true }),
  );
});

async function started(inContainer: boolean) {
  const sdk = new FakeSdk();
  const harness = new ClaudeHarness({
    sdk,
    env: { CLAUDE_CONFIG_DIR: "/home/me/.claude" },
    bin: "/opt/claude",
    sandboxes: fakeSbx().sandboxes,
    schedule: () => () => {},
    now: () => 1000,
    newId: () => "id1",
  });
  const model = "claude-sonnet-5-5";
  const session = await harness.createSession({
    cwd: "/Users/me/app",
    model,
    ...(inContainer ? { environment: "standard" } : {}),
  });
  const options = { mode: "default", model, ...(inContainer ? { environment: "standard" } : {}) };
  await harness.send(session.id, { text: "hello", images: [] }, options);
  // The turn is over, so a process that must start again can be ended now.
  sdk.last.say({ type: "result", subtype: "success", is_error: false });
  await settle();
  return { sdk, harness, session, query: sdk.last };
}

test("moving from asking first to accepting edits is in place in a container, and a new start on this machine", async () => {
  const container = await started(true);
  expect(container.session.sandboxCwd).not.toBeNull();
  await container.harness.configure(container.session.id, { mode: "acceptEdits" });
  expect(container.query.moves).toEqual(["mode acceptEdits"]);
  expect(container.query.closed).toBe(false);

  const here = await started(false);
  expect(here.session.sandboxCwd).toBeNull();
  await here.harness.configure(here.session.id, { mode: "acceptEdits" });
  expect(here.query.moves).toEqual([]);
  expect(here.query.closed).toBe(true);
});
