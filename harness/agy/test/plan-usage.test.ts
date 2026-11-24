// agy's plan usage from `agy -p "/usage" --output-format json` (CYC-298), as agy 1.5.16 answered it.
import { expect, test } from "bun:test";
import { PlanUsageReader, type PlanWindow, planWindowsOf, usesApiKey } from "../src/plan-usage.ts";

const USAGE = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  response: "…",
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
  },
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-weekly",
              window: "weekly",
              remaining_fraction: 0.9,
              reset_time: "2026-11-30T22:15:29Z",
            },
            {
              id: "gemini-5h",
              window: "5h",
              remaining_fraction: 0.75,
              reset_time: "2026-11-24T14:07:16Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            {
              id: "3p-weekly",
              window: "weekly",
              remaining_fraction: 1,
              reset_time: "2026-12-01T13:34:17Z",
            },
            {
              id: "3p-5h",
              window: "5h",
              remaining_fraction: 0,
              reset_time: "2026-11-24T18:34:17Z",
            },
          ],
        },
      ],
    },
  },
});

test("/usage's buckets become plan windows, the used share and the reset time", () => {
  expect(planWindowsOf(USAGE)).toEqual([
    {
      kind: "seven_day",
      utilization: 0.09999999999999998,
      resetsAt: Date.parse("2026-11-30T22:15:29Z"),
      status: "allowed",
    },
    {
      kind: "five_hour",
      utilization: 0.25,
      resetsAt: Date.parse("2026-11-24T14:07:16Z"),
      status: "allowed",
    },
    {
      kind: "seven_day_other",
      utilization: 0,
      resetsAt: Date.parse("2026-12-01T13:34:17Z"),
      status: "allowed",
    },
    {
      kind: "five_hour_other",
      utilization: 1,
      resetsAt: Date.parse("2026-11-24T18:34:17Z"),
      status: "rejected",
    },
  ]);
});

test("anything else is no plan usage", () => {
  expect(planWindowsOf("not json")).toEqual([]);
  expect(planWindowsOf(JSON.stringify({ status: "ERROR" }))).toEqual([]);
  expect(planWindowsOf(JSON.stringify({ status: "SUCCESS", command: { data: {} } }))).toEqual([]);
});

test("the reader polls at most every five minutes, tells only a change, and leaves an API-key login alone", async () => {
  let clock = 1_000_000;
  let runs = 0;
  const told: PlanWindow[][] = [];
  const reader = new PlanUsageReader({
    executable: "/x/agy",
    env: { HOME: "/h" },
    tell: (w) => told.push(w),
    run: async () => {
      runs++;
      return USAGE;
    },
    now: () => clock,
  });
  await reader.poll();
  await reader.poll();
  expect(runs).toBe(1);
  clock += 5 * 60_000;
  await reader.poll();
  expect(runs).toBe(2);
  // Unchanged: told once.
  expect(told).toHaveLength(1);

  expect(usesApiKey({ GEMINI_API_KEY: "k" })).toBe(true);
  let keyed = 0;
  await new PlanUsageReader({
    executable: "/x/agy",
    env: { HOME: "/h", GEMINI_API_KEY: "k" },
    tell: () => {},
    run: async () => {
      keyed++;
      return USAGE;
    },
  }).poll();
  expect(keyed).toBe(0);
});
