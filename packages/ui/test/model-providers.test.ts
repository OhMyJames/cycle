import { expect, test } from "bun:test";
import {
  mergeConfigSchema,
  optionsOf,
  runsByProvider,
  withEffortFor,
} from "../src/react/config-form.tsx";
import { sameAddress } from "../src/react/providers.tsx";

const own = { const: "gpt-5", title: "GPT-5", _meta: { "cycle/efforts": ["low", "high"] } };
const mine = (id: string, provider: { id: string; name: string }, efforts: string[]) => ({
  const: `${provider.id}/${id}`,
  title: id,
  description: provider.name,
  _meta: { "cycle/efforts": efforts, "cycle/provider": provider },
});
const router = { id: "router", name: "My router" };
const lab = { id: "lab", name: "Lab" };

test("a model of the owner's carries its provider; the agent's own does not", () => {
  const options = optionsOf({ oneOf: [own, mine("m1", router, ["high"])] }) ?? [];
  expect(options[0]?.provider).toBeUndefined();
  expect(options[1]?.provider).toEqual(router);
  // Its effort levels are read as for any other model.
  expect(options[1]?.efforts).toEqual(["high"]);
});

test("the menu is the agent's own first, then one run per provider in the order each is met", () => {
  const options =
    optionsOf({
      oneOf: [mine("a", lab, []), own, mine("b", router, []), mine("c", lab, [])],
    }) ?? [];
  const runs = runsByProvider(options);
  expect(runs.map((r) => [r.provider?.name, r.options.map((o) => o.label)])).toEqual([
    [undefined, ["GPT-5"]],
    ["Lab", ["a", "c"]],
    ["My router", ["b"]],
  ]);
});

test("with no model of the owner's the menu is one run, as it was; with only theirs there is no own run", () => {
  expect(runsByProvider(optionsOf({ oneOf: [own] }) ?? [])).toHaveLength(1);
  const only = runsByProvider(optionsOf({ oneOf: [mine("a", lab, [])] }) ?? []);
  expect(only.map((r) => r.provider?.id)).toEqual(["lab"]);
  expect(runsByProvider([])).toEqual([]);
});

test("a session's live model options keep their provider, and the effort for the chosen model is still put right", () => {
  const schema = {
    properties: {
      model: { type: "string", oneOf: [own] },
      effort: { type: "string", enum: ["low", "high"] },
    },
  };
  const merged = mergeConfigSchema(schema, [
    {
      configId: "model",
      name: "Model",
      options: [{ value: "router/m1", name: "m1", provider: router, efforts: ["high"] }],
    },
  ]);
  const options =
    optionsOf((merged.properties as Record<string, Parameters<typeof optionsOf>[0]>).model ?? {}) ??
    [];
  expect(options[0]?.provider).toEqual(router);
  expect(withEffortFor(merged, { model: "router/m1", effort: "low" })).toEqual({
    model: "router/m1",
    effort: "default",
  });
});

test("an address is the same address with a slash or spaces more", () => {
  expect(sameAddress("https://x.example/v1/", " https://x.example/v1 ")).toBe(true);
  expect(sameAddress(null, "")).toBe(true);
  expect(sameAddress("https://x.example/v1", "https://y.example/v1")).toBe(false);
});
