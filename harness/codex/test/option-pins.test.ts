import { expect, test } from "bun:test";
import { resolveMode } from "@cycle/protocol";
import { CodexHarness } from "../src/index.ts";
import { CODEX_MODES, toModel } from "../src/translate.ts";
import type { WireModel } from "../src/wire.ts";

/** What codex gives of a session's choices today, pinned before they become one list (step 18). */

const wire = (patch: Partial<WireModel> = {}): WireModel => ({
  id: "m1",
  model: "gpt-5.5",
  displayName: "GPT-5.5",
  description: "The big one",
  hidden: false,
  supportedReasoningEfforts: [
    { reasoningEffort: "low", description: "Fast" },
    { reasoningEffort: "medium", description: "Balanced" },
    { reasoningEffort: "high", description: "Deep" },
  ],
  defaultReasoningEffort: "medium",
  isDefault: true,
  ...patch,
});

test("the modes keep their order, one is the default and it is not the one that never asks", () => {
  expect(CODEX_MODES.map((mode) => mode.id)).toEqual(["readOnly", "auto", "plan", "fullAccess"]);
  expect(CODEX_MODES.filter((mode) => mode.isDefault).map((mode) => mode.id)).toEqual(["auto"]);
  expect(CODEX_MODES.filter((mode) => mode.dangerous && mode.isDefault)).toEqual([]);
  expect(CODEX_MODES.filter((mode) => mode.plan).map((mode) => mode.id)).toEqual(["plan"]);
  expect(new CodexHarness({ bin: "/nonexistent/codex" }).listModes()).toEqual([...CODEX_MODES]);
});

const read = (value: string | undefined) => resolveMode(CODEX_MODES, value)?.id;

test("a stored mode is read by id, an old one by what replaces it, anything else as the default", () => {
  expect(read("fullAccess")).toBe("fullAccess");
  expect(read("legacy:readOnly")).toBe("readOnly");
  expect(read("legacy:auto")).toBe("auto");
  expect(read("legacy:fullAccess")).toBe("fullAccess");
  // Claude Code's words are not codex's.
  expect(read("acceptEdits")).toBe("auto");
  expect(read("bypassPermissions")).toBe("auto");
  expect(read(undefined)).toBe("auto");
});

test("a model keeps the efforts codex lists, in its order, and the one codex says it runs at", () => {
  expect(toModel(wire())).toEqual({
    id: "gpt-5.5",
    harness: "codex",
    name: "GPT-5.5",
    description: "The big one",
    efforts: [
      { id: "low", description: "Fast" },
      { id: "medium", description: "Balanced" },
      { id: "high", description: "Deep" },
    ],
    defaultEffort: "medium",
    isDefault: true,
    images: true,
    sandbox: false,
    provider: null,
  });
  const bare = toModel(
    wire({
      model: "gpt-x",
      displayName: "",
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
      isDefault: false,
      inputModalities: ["text"],
    }),
  );
  // With no display name it is named by its model, with no effort to choose it has none, and it
  // takes no image unless it says it reads them.
  expect(bare).toMatchObject({
    id: "gpt-x",
    name: "gpt-x",
    efforts: [],
    defaultEffort: null,
    isDefault: false,
    images: false,
  });
  expect(toModel(wire({ inputModalities: ["text", "image"] })).images).toBe(true);
});
