import { expect, test } from "bun:test";
import { ClaudeHarness } from "../src/index.ts";
import { toPlanLimits } from "../src/translate.ts";
import { FakeSdk, settle } from "./fake-sdk.ts";

const MODEL = "claude-sonnet-5-5";
const RESET = "2026-11-17T09:00:00.000Z";

test("the plan's windows are percentages and times, and only the ones the page names", () => {
  expect(toPlanLimits(null)).toEqual([]);
  expect(toPlanLimits({ rate_limits_available: false, rate_limits: null })).toEqual([]);
  expect(
    toPlanLimits({
      rate_limits: {
        five_hour: { utilization: 41.6, resets_at: RESET },
        seven_day: { utilization: 100, resets_at: null },
        seven_day_oauth_apps: { utilization: 5, resets_at: RESET },
        seven_day_opus: null,
        seven_day_sonnet: { utilization: null, resets_at: RESET },
      },
    }),
  ).toEqual([
    {
      id: "five_hour",
      name: "5-hour limit",
      usedPercent: 42,
      windowMinutes: 300,
      resetsAt: Date.parse(RESET),
      status: "ok",
      overage: false,
    },
    {
      id: "seven_day",
      name: "Weekly limit",
      usedPercent: 100,
      windowMinutes: 10080,
      resetsAt: null,
      status: "exceeded",
      overage: false,
    },
  ]);
});

test("the account shows the plan's windows once a process runs, and a window heard of keeps its status", async () => {
  const sdk = new FakeSdk();
  const harness = new ClaudeHarness({ sdk, env: { CLAUDE_CONFIG_DIR: "/home/me/.claude" } });
  const session = await harness.createSession({ cwd: "/project", model: MODEL });
  await harness.send(session.id, { text: "hi", images: [] }, { mode: "default", model: MODEL });
  await settle();
  expect((await harness.readAccount()).limits).toEqual([]);

  sdk.usage = {
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 82, resets_at: RESET } },
  };
  expect((await harness.readAccount()).limits).toMatchObject([
    { id: "five_hour", usedPercent: 82, status: "ok" },
  ]);

  // A `rate_limit_event` for the same window says it is near: the next read keeps that.
  sdk.last.say({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed_warning",
      rateLimitType: "five_hour",
      utilization: 0.8,
      resetsAt: Date.parse(RESET) / 1000,
    },
  });
  await settle();
  expect((await harness.readAccount()).limits).toMatchObject([
    { id: "five_hour", usedPercent: 82, status: "warning" },
  ]);
});
