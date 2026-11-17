import { expect, test } from "bun:test";
import type { HarnessEvent } from "@cycle/protocol";
import { ClaudeHarness } from "../src/index.ts";
import { type ClaudeConfig, emptyConfig } from "../src/config.ts";
import { FakeSdk, settle } from "./fake-sdk.ts";

const MODEL = "claude-sonnet-5-5";
const send = { mode: "default", model: MODEL };

function setup(run?: Partial<ClaudeConfig["run"]>) {
  const sdk = new FakeSdk();
  const config: ClaudeConfig = { ...emptyConfig(), run: { ...emptyConfig().run, ...run } };
  let ids = 0;
  const harness = new ClaudeHarness({
    sdk,
    env: { CLAUDE_CONFIG_DIR: "/home/me/.claude" },
    schedule: () => () => {},
    now: () => 1000,
    newId: () => `id${++ids}`,
    config: {
      book: { read: () => config, write: async () => {} },
      dir: "/cycle/claude",
      writeSettings: async () => "/cycle/claude/settings.json",
      cli: { run: async () => ({ code: 0, stdout: "[]", stderr: "" }) },
    },
  });
  const events: HarnessEvent[] = [];
  harness.onEvent((event) => events.push(event));
  return { sdk, harness, events };
}

async function begun(run?: Partial<ClaudeConfig["run"]>) {
  const all = setup(run);
  const session = await all.harness.createSession({ cwd: "/project", model: MODEL });
  await all.harness.send(session.id, { text: "hello", images: [] }, send);
  await settle();
  return { ...all, session, query: all.sdk.last };
}

const notices = (events: HarnessEvent[]) =>
  events.flatMap((event) => (event.type === "notice" ? [event.message] : []));

test("a request made again many times is said once a turn, and again in the next", async () => {
  const { harness, session, events, query } = await begun();
  const retry = { type: "system", subtype: "api_retry", error_status: 529, max_retries: 10 };
  query.say({ ...retry, attempt: 1 });
  query.say({ ...retry, attempt: 2 });
  await settle();
  expect(notices(events)).toEqual([
    "A request to the model failed (error 529). Claude Code is trying again: attempt 1 of 10.",
  ]);
  query.say({ type: "result", subtype: "success", is_error: false });
  await settle();
  await harness.send(session.id, { text: "again", images: [] }, send);
  query.say({ ...retry, attempt: 1 });
  await settle();
  expect(notices(events)).toHaveLength(2);
});

test("a refusal is said, with the model it was tried on instead when there is one", async () => {
  const { events, query } = await begun();
  query.say({
    type: "system",
    subtype: "model_refusal_fallback",
    direction: "retry",
    original_model: "opus",
    fallback_model: "sonnet",
  });
  query.say({ type: "system", subtype: "model_refusal_fallback", direction: "revert" });
  query.say({ type: "system", subtype: "model_refusal_no_fallback", content: "It declined." });
  await settle();
  expect(notices(events)).toEqual([
    "opus refused, so the turn was tried on sonnet.",
    "It declined.",
  ]);
});

test("a turn that stopped at a limit fails with the limit named", async () => {
  const { events, query } = await begun();
  query.say({ type: "result", subtype: "error_max_budget_usd", is_error: true });
  await settle();
  const done = events.find((event) => event.type === "turn.completed");
  expect(done).toMatchObject({ status: "failed" });
  expect(done && "error" in done ? done.error : "").toContain("most it may spend");
});

test("what the owner set for a process is what it starts with, and nothing when unset", async () => {
  const set = await begun({ fallbackModel: "a,b", maxTurns: 7, maxBudgetUsd: 1.5 });
  expect(set.query.options).toMatchObject({ fallbackModel: "a,b", maxTurns: 7, maxBudgetUsd: 1.5 });
  const none = await begun();
  for (const key of ["fallbackModel", "maxTurns", "maxBudgetUsd"]) {
    expect(none.query.options).not.toHaveProperty(key);
  }
});
