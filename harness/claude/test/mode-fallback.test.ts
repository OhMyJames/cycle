import { expect, test } from "bun:test";
import type { HarnessEvent } from "@cycle/protocol";
import { ClaudeHarness } from "../src/index.ts";
import { FakeSdk, settle } from "./fake-sdk.ts";

const SONNET = "claude-sonnet-5-5";
const prompt = { text: "hello", images: [] };

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

/** A session in plan mode whose plan is asked, and the owner's answer to it. */
async function approvePlan(mode?: string) {
  const { sdk, harness, events } = setup();
  const session = await harness.createSession({ cwd: "/project", model: SONNET });
  await harness.send(session.id, prompt, { mode: "plan", model: SONNET });
  await settle();
  const plan = { type: "tool_use", id: "x", name: "ExitPlanMode", input: { plan: "# Do it" } };
  sdk.last.say({ type: "assistant", message: { content: [plan] } });
  await settle();
  events.length = 0;
  const answer = sdk.last.options.canUseTool?.(
    "ExitPlanMode",
    {},
    { signal: new AbortController().signal, toolUseID: "x" },
  );
  await settle();
  harness.respondApproval("x", { decision: "accept", ...(mode ? { mode } : {}) });
  return { answer: await answer, events, session };
}

test("a turn sent with no mode starts a process in the one that asks first", async () => {
  const { sdk, harness } = setup();
  const session = await harness.createSession({ cwd: "/project", model: SONNET });
  await harness.send(session.id, prompt, { model: SONNET });
  await settle();
  expect(sdk.last.options.permissionMode).toBe("default");
});

test("a plan approved with no mode, or one that cannot follow a plan, goes on asking first", async () => {
  for (const mode of [undefined, "plan", "bypassPermissions", "unheard-of"]) {
    const { answer, events, session } = await approvePlan(mode);
    expect(answer).toMatchObject({
      updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }],
    });
    expect(events.filter((event) => event.type === "mode.changed")).toEqual([
      { type: "mode.changed", sessionId: session.id, mode: "default" },
    ]);
  }
});

test("a plan approved into a mode that needs the command sandbox asks first until a new process", async () => {
  // The process planned with no sandbox, and only a start sets one: its spec is not acceptEdits'.
  const { answer, events, session } = await approvePlan("acceptEdits");
  expect(answer).toMatchObject({
    updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }],
  });
  // The session is in the owner's mode all the same, and the owner is told what waits.
  expect(events.filter((event) => event.type === "mode.changed")).toEqual([
    { type: "mode.changed", sessionId: session.id, mode: "acceptEdits" },
  ]);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "notice",
      level: "info",
      message: expect.stringContaining("asks before each step until this turn ends"),
    }),
  );
});

test("a plan approved into a mode that is offered, and that this process has, keeps it", async () => {
  for (const mode of ["default", "dontAsk"]) {
    const { answer, events, session } = await approvePlan(mode);
    expect(answer).toMatchObject({
      updatedPermissions: [{ type: "setMode", mode, destination: "session" }],
    });
    expect(events.filter((event) => event.type === "mode.changed")).toEqual([
      { type: "mode.changed", sessionId: session.id, mode },
    ]);
    expect(events.some((event) => event.type === "notice")).toBe(false);
  }
});
