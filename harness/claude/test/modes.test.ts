import { expect, test } from "bun:test";
import type { HarnessEvent } from "@cycle/protocol";
import { ClaudeHarness } from "../src/index.ts";
import type { WireMessage } from "../src/wire.ts";
import { FakeSdk, settle } from "./fake-sdk.ts";

const SONNET = "claude-sonnet-5-5";
const result: WireMessage = { type: "result", subtype: "success", is_error: false };

async function begun(mode = "default") {
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
  const session = await harness.createSession({ cwd: "/project", model: SONNET });
  const options = { mode, model: SONNET };
  await harness.send(session.id, { text: "hello", images: [] }, options);
  await settle();
  return { sdk, harness, events, session, options, query: sdk.last };
}

/** Asks to leave plan mode with a plan, and answers it as the owner did. */
async function approvePlan(mode: string) {
  const all = await begun("plan");
  const plan = { type: "tool_use", id: "x", name: "ExitPlanMode", input: { plan: "# Do it" } };
  all.query.say({ type: "assistant", message: { content: [plan] } });
  await settle();
  all.events.length = 0;
  const answer = all.query.options.canUseTool?.(
    "ExitPlanMode",
    {},
    { signal: new AbortController().signal, toolUseID: "x" },
  );
  await settle();
  const asked = all.events.find((event) => event.type === "approval.requested");
  all.harness.respondApproval("x", { decision: "accept", mode });
  return { ...all, asked, answer: await answer };
}

test("Claude Code offers its six modes, and a session is always started in one by name", async () => {
  const { harness, query } = await begun();
  expect(harness.listModes().map((mode) => mode.id)).toEqual([
    "default",
    "acceptEdits",
    "plan",
    "auto",
    "dontAsk",
    "bypassPermissions",
  ]);
  expect(query.options.permissionMode).toBe("default");
  expect(query.options.onElicitation).toBeFunction();
});

test("a mode, model or effort the owner changes moves the process in place, mid-turn too", async () => {
  const { sdk, harness, session, query } = await begun();
  await harness.configure(session.id, { mode: "plan", model: "claude-opus-5-5", effort: "low" });
  expect(query.moves).toEqual(["model claude-opus-5-5", "effort low", "mode plan"]);
  // Claude Code saying the mode it was moved to is not the model's own move.
  query.say({ type: "system", subtype: "status", permissionMode: "plan" });
  query.say(result);
  await settle();
  expect(sdk.queries).toHaveLength(2);

  // The next turn asks for what the process already is: nothing moves, nothing starts.
  const options = { mode: "plan", model: "claude-opus-5-5", effort: "low" };
  await harness.send(session.id, { text: "more", images: [] }, options);
  expect(sdk.queries).toHaveLength(2);
  expect(query.moves).toHaveLength(3);
});

test("back to the model's own effort is its default effort, in place", async () => {
  const { harness, session, query } = await begun();
  await harness.configure(session.id, { effort: "low" });
  await harness.configure(session.id, { effort: null });
  expect(query.moves).toEqual(["effort low", "effort high"]);
});

test("a mode only a new process can give waits for the turn, and its model moves meanwhile", async () => {
  const { sdk, harness, session, options, query } = await begun();
  await harness.configure(session.id, { mode: "bypassPermissions", model: "claude-opus-5-5" });
  expect(query.moves).toEqual(["model claude-opus-5-5"]);
  expect(query.closed).toBe(false);
  query.say(result);
  await settle();
  await harness.configure(session.id, { mode: "bypassPermissions" });
  expect(query.closed).toBe(true);
  await harness.send(session.id, { text: "go", images: [] }, { ...options, mode: "acceptEdits" });
  expect(sdk.last.options).toMatchObject({ permissionMode: "acceptEdits", resume: session.id });
});

test("a process that will not move is ended, and the turn runs in a new one", async () => {
  const { sdk, harness, session, query } = await begun();
  query.say(result);
  await settle();
  query.refuseMoves = true;
  const { turnId } = await harness.send(
    session.id,
    { text: "again", images: [] },
    { mode: "default", model: "claude-opus-5-5" },
  );
  expect(query.closed).toBe(true);
  expect(sdk.queries).toHaveLength(3);
  expect(sdk.last.options).toMatchObject({ model: "claude-opus-5-5", resume: session.id });
  await settle();
  expect(sdk.last.prompts.map((prompt) => prompt.uuid)).toEqual([turnId]);
});

test("the model moving itself to another mode is told, once", async () => {
  const { events, session, query } = await begun();
  events.length = 0;
  query.say({ type: "system", subtype: "status", permissionMode: "plan" });
  query.say({ type: "system", subtype: "status", permissionMode: "plan" });
  await settle();
  expect(events).toEqual([{ type: "mode.changed", sessionId: session.id, mode: "plan" }]);
});

test("leaving plan mode asks the owner with the plan, and goes on in a mode this process has", async () => {
  const { asked, answer, events, session } = await approvePlan("default");
  expect(asked).toMatchObject({ approval: { kind: "plan", plan: "# Do it", itemId: "x" } });
  expect(answer).toMatchObject({
    behavior: "allow",
    updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }],
  });
  expect(events.filter((event) => event.type === "mode.changed")).toEqual([
    { type: "mode.changed", sessionId: session.id, mode: "default" },
  ]);
});

test("a plan approved into a mode that needs Claude Code's sandbox asks first until a new process", async () => {
  const { answer, events, session, query } = await approvePlan("auto");
  // Planning ran with no sandbox: nothing runs unsandboxed and unasked in the rest of the turn.
  expect(answer).toMatchObject({
    updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }],
  });
  expect(events).toContainEqual({ type: "mode.changed", sessionId: session.id, mode: "auto" });
  expect(events).toContainEqual(expect.objectContaining({ type: "notice", level: "info" }));
  // Claude Code's word for the mode it is in now is no move of the model's own.
  events.length = 0;
  query.say({ type: "system", subtype: "status", permissionMode: "default" });
  await settle();
  expect(events).toEqual([]);
});
