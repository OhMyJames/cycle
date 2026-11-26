import { afterEach, expect, test } from "bun:test";
import { PlanTracker } from "../src/plan-mcp.ts";
import { resolveLoopFields } from "../src/project.ts";
import { issue } from "./helpers.ts";

const names = ["开发", "验证", "QA", "等 CI", "评审", "等合并"];
const fields = (over: { options?: string[]; skipStarted?: boolean } = {}) => ({
  ok: true,
  data: [
    {
      id: 7,
      name: "Loop 阶段",
      fieldType: "select",
      options: (over.options ?? names).map((value, i) => ({ id: 100 + i, value })),
    },
    ...(over.skipStarted ? [] : [{ id: 8, name: "Loop 阶段开始于", fieldType: "datetime" }]),
  ],
});

test("field and option ids are resolved by name", () => {
  expect(resolveLoopFields(fields())).toEqual({
    phaseFieldId: 7,
    startedFieldId: 8,
    optionIds: { dev: 100, verify: 101, qa: 102, ci: 103, review: 104, merge: 105 },
  });
});

test("a missing field or option means do not write, without throwing", () => {
  expect(resolveLoopFields(fields({ skipStarted: true }))).toBeNull();
  expect(resolveLoopFields(fields({ options: names.slice(0, 5) }))).toBeNull();
  expect(resolveLoopFields({ ok: true, data: [] })).toBeNull();
  expect(resolveLoopFields("nonsense")).toBeNull();
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const tracker = () => {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    calls.push(JSON.parse(init.body).params.arguments);
    return new Response(
      JSON.stringify({ result: { content: [{ type: "text", text: '{"ok":true}' }] } }),
    );
  }) as unknown as typeof fetch;
  const t = new PlanTracker({ url: "http://x", key: "k", projectKey: "CYC" });
  return { t, calls };
};

test("setting a phase writes the option and the time; clearing writes an empty list and null", async () => {
  const { t, calls } = tracker();
  t.setLoopFields(resolveLoopFields(fields()));
  const at = new Date("2026-11-26T01:02:03Z");
  await t.setLoopPhase(issue(), "qa", at);
  await t.setLoopPhase(issue(), null, at);
  expect(calls.map((c) => c.arguments)).toEqual([
    { issueId: 1, fieldId: 7, optionIds: [102] },
    { issueId: 1, fieldId: 8, value: "2026-11-26T01:02:03.000Z" },
    { issueId: 1, fieldId: 7, optionIds: [] },
    { issueId: 1, fieldId: 8, value: null },
  ]);
});

test("without resolved fields nothing is written", async () => {
  const { t, calls } = tracker();
  await t.setLoopPhase(issue(), "dev", new Date());
  expect(calls).toEqual([]);
});

test("a field of the wrong type is not taken", () => {
  const bad = fields();
  (bad.data[1] as { fieldType: string }).fieldType = "text";
  expect(resolveLoopFields(bad)).toBeNull();
  expect(resolveLoopFields({ data: [{ ...bad.data[0], id: null }, bad.data[1]] })).toBeNull();
});

test("a field scoped to one issue type, or a name that matches twice, is not taken", () => {
  const scoped = fields();
  (scoped.data[1] as { issueTypeId?: number }).issueTypeId = 3;
  expect(resolveLoopFields(scoped)).toBeNull();
  const twice = fields();
  twice.data.push({ ...(twice.data[1] as object) } as never);
  expect(resolveLoopFields(twice)).toBeNull();
});

test("an aborted write does not go on to the second field", async () => {
  const { t, calls } = tracker();
  t.setLoopFields(resolveLoopFields(fields()));
  const abort = new AbortController();
  abort.abort();
  await expect(t.setLoopPhase(issue(), "qa", new Date(), abort.signal)).rejects.toThrow();
  expect(calls).toEqual([]);
});
