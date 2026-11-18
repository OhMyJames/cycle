import { expect, test } from "bun:test";
import { type Option, defineModes, defineOption, optionsFromLegacy } from "../src/index.ts";

const model = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  harness: "codex",
  name: id.toUpperCase(),
  description: `${id} model`,
  efforts: [],
  defaultEffort: null,
  isDefault: false,
  images: true,
  sandbox: false,
  provider: null,
  ...extra,
});

test("an option has what an agent did not say filled in, and what it said kept", () => {
  const option = defineOption({
    id: "tone",
    category: "tone",
    name: "Tone",
    values: [
      { id: "dry", name: "Dry" },
      { id: "warm", name: "Warm", default: true },
    ],
  });
  expect(option).toEqual({
    id: "tone",
    category: "tone",
    name: "Tone",
    description: "",
    values: [
      {
        id: "dry",
        name: "Dry",
        description: "",
        default: false,
        dangerous: false,
        plan: false,
        replaces: null,
        provider: null,
        under: [],
      },
      {
        id: "warm",
        name: "Warm",
        description: "",
        default: true,
        dangerous: false,
        plan: false,
        replaces: null,
        provider: null,
        under: [],
      },
    ],
  });
});

const declareMode = (dangerous: boolean) =>
  defineOption({
    id: "mode",
    category: "mode",
    name: "Mode",
    values: [
      { id: "ask", name: "Ask" },
      { id: "free", name: "Free", dangerous, default: true },
    ],
  });

test("a value that never asks is never the default, at any depth", () => {
  expect(declareMode(false).values[1]?.default).toBe(true);
  expect(() => declareMode(true)).toThrow(
    'Option mode makes "free" its default, which never asks.',
  );
  const inner = { id: "m", category: "mode", name: "M", description: "", values: [] } as Option;
  const nested = (value: Record<string, unknown>) =>
    defineOption({
      id: "model",
      category: "model",
      name: "Model",
      values: [
        {
          id: "a",
          name: "A",
          under: [{ ...inner, values: [{ id: "x", name: "X", ...value }] as never }],
        },
      ],
    });
  expect(nested({ default: true }).values[0]?.under[0]?.values[0]?.default).toBe(true);
  expect(() => nested({ default: true, dangerous: true })).toThrow("never asks");
});

const declareEffort = (defaults: boolean[]) =>
  defineOption({
    id: "effort",
    category: "effort",
    name: "Effort",
    values: defaults.map((flag, index) => ({ id: `v${index}`, name: "V", default: flag })),
  });

test("an option has at most one default", () => {
  expect(declareEffort([false, false]).values.some((value) => value.default)).toBe(false);
  expect(declareEffort([false, true]).values.filter((value) => value.default)).toHaveLength(1);
  expect(() => declareEffort([true, false, true])).toThrow(
    'Option effort has two defaults: "v0" and "v2".',
  );
});

test("a mode becomes a value of the mode option, and nothing of it is lost", () => {
  const modes = defineModes("claude", [
    { id: "default", name: "Ask first", description: "asks", replaces: "readOnly" },
    { id: "plan", name: "Plan", description: "plans", plan: true },
    { id: "edits", name: "Edits", description: "edits", isDefault: true, replaces: "auto" },
    {
      id: "free",
      name: "Free",
      description: "never asks",
      dangerous: true,
      replaces: "fullAccess",
    },
  ]);
  const [mode] = optionsFromLegacy("claude", modes, []);
  expect(mode).toMatchObject({ id: "mode", category: "mode" });
  expect(mode?.values.map((value) => value.id)).toEqual(["default", "plan", "edits", "free"]);
  expect(mode?.values.map((value) => value.default)).toEqual([false, false, true, false]);
  expect(mode?.values.map((value) => value.dangerous)).toEqual([false, false, false, true]);
  expect(mode?.values.map((value) => value.plan)).toEqual([false, true, false, false]);
  expect(mode?.values.map((value) => value.replaces)).toEqual([
    "readOnly",
    null,
    "auto",
    "fullAccess",
  ]);
  expect(mode?.values[1]).toMatchObject({ name: "Plan", description: "plans" });
});

test("a mode that never asks as the default of a list is refused, so no agent can declare one", () => {
  const modes = defineModes("x", [
    { id: "free", name: "Free", description: "", dangerous: true, isDefault: true },
  ]);
  expect(() => optionsFromLegacy("x", modes, [])).toThrow("never asks");
});

test("a model carries its efforts under it, the default one marked, and its provider", () => {
  const options = optionsFromLegacy(
    "codex",
    [],
    [
      model("big", {
        isDefault: true,
        efforts: [
          { id: "low", description: "fast" },
          { id: "high", description: "deep" },
        ],
        defaultEffort: "high",
      }),
      model("mine/x", { provider: { id: "mine", name: "Mine" } }),
      model("odd", { efforts: [{ id: "low", description: "" }], defaultEffort: "gone" }),
    ],
  );
  expect(options.map((option) => option.id)).toEqual(["model"]);
  const [big, mine, odd] = options[0]?.values ?? [];
  expect(big).toMatchObject({ id: "big", name: "BIG", description: "big model", default: true });
  expect(big?.under).toHaveLength(1);
  expect(big?.under[0]).toMatchObject({ id: "effort", category: "effort" });
  expect(
    big?.under[0]?.values.map((value) => [value.id, value.default, value.description]),
  ).toEqual([
    ["low", false, "fast"],
    ["high", true, "deep"],
  ]);
  // A model of the owner's provider says which, and has no effort to choose.
  expect(mine).toMatchObject({ provider: { id: "mine", name: "Mine" }, default: false, under: [] });
  // A default effort the model does not list marks none.
  expect(odd?.under[0]?.values.map((value) => value.default)).toEqual([false]);
});

test("only an agent's own modes and models are its options, and an empty list is no option", () => {
  const modes = [...defineModes("codex", [{ id: "a", name: "A", description: "" }])];
  const models = [model("m"), model("n", { harness: "claude" })];
  const [first, ...rest] = optionsFromLegacy("codex", modes, models);
  expect(first?.values.map((value) => value.id)).toEqual(["m"]);
  expect(rest.map((option) => option.id)).toEqual(["mode"]);
  expect(optionsFromLegacy("claude", modes, [])).toEqual([]);
});
