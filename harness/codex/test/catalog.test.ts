import { expect, test } from "bun:test";
import { modelCatalog } from "../src/index.ts";

interface Entry {
  slug: string;
  context_window: number;
  max_context_window: number;
  model_messages: { instructions_template: string };
}

function entries(text: string | null): Entry[] {
  if (text === null) throw new Error("no catalog");
  return (JSON.parse(text) as { models: Entry[] }).models;
}

test("each model may read as far as its own window, past codex's cap for one it does not know", () => {
  const [model] = entries(modelCatalog([{ slug: "mine/big", contextWindow: 1_000_000 }]));
  expect(model).toMatchObject({
    slug: "mine/big",
    context_window: 1_000_000,
    max_context_window: 1_000_000,
  });
  // Codex refuses an entry without instructions; these are its own.
  expect(model?.model_messages.instructions_template).toStartWith("You are a coding agent");
});

test("a model with no usable window is left to codex, and no models make no catalog", () => {
  const models = entries(
    modelCatalog([
      { slug: "mine/a", contextWindow: 64_000 },
      { slug: "mine/b", contextWindow: 0 },
      { slug: "mine/c", contextWindow: Number.NaN },
    ]),
  );
  expect(models.map(({ slug }) => slug)).toEqual(["mine/a"]);
  expect(modelCatalog([])).toBeNull();
  expect(modelCatalog([{ slug: "mine/b", contextWindow: 0 }])).toBeNull();
});
