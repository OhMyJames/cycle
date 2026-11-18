import { expect, test } from "bun:test";
import { type ModeInfo, defineModes } from "@cycle/protocol";
import { draftHarness, draftModel, harnessesOf } from "../src/lib/draft.ts";
import { modeIcon, modeLabel, modeNamed, modesOf } from "../src/lib/modes.ts";

/** What the page does with the choices an agent offers today, pinned before one menu draws them (step 18). */

const modes: ModeInfo[] = [
  ...defineModes("claude", [
    { id: "bypassPermissions", name: "Bypass", description: "", dangerous: true },
    { id: "default", name: "Ask", description: "", replaces: "readOnly" },
    { id: "acceptEdits", name: "Edits", description: "", isDefault: true, replaces: "auto" },
    { id: "dontAsk", name: "Don't ask", description: "" },
  ]),
  ...defineModes("codex", [
    { id: "plan", name: "Plan", description: "", plan: true },
    { id: "full", name: "Full", description: "", dangerous: true },
    { id: "auto", name: "Auto", description: "", isDefault: true, replaces: "auto" },
  ]),
];

test("the modes that never ask come last and keep their order, in the agent's own list", () => {
  expect(modesOf(modes, "claude").map((mode) => mode.id)).toEqual([
    "default",
    "acceptEdits",
    "dontAsk",
    "bypassPermissions",
  ]);
  expect(modesOf(modes, "codex").map((mode) => mode.id)).toEqual(["plan", "auto", "full"]);
  expect(modesOf(modes, "nobody")).toEqual([]);
});

test("a stored mode is one of the agent's, an old one by what replaced it, else the agent's default", () => {
  expect(modeNamed(modes, "claude", "bypassPermissions")?.id).toBe("bypassPermissions");
  expect(modeNamed(modes, "claude", "legacy:readOnly")?.id).toBe("default");
  // A mode of another agent's is not read: the default is.
  expect(modeNamed(modes, "claude", "plan")?.id).toBe("acceptEdits");
  expect(modeNamed(modes, "codex", "gone")?.id).toBe("auto");
  expect(modeNamed(modes, "codex", undefined)?.id).toBe("auto");
});

test("a mode is marked as the default in a list of choices, never bare", () => {
  const [bypass, ask, edits] = modes;
  expect(modeLabel(edits as ModeInfo)).toBe("Edits (default)");
  expect(modeLabel(ask as ModeInfo)).toBe("Ask");
  expect(modeLabel(bypass as ModeInfo)).toBe("Bypass");
});

const icon = (patch: Partial<ModeInfo>) =>
  modeIcon({
    ...(defineModes("x", [{ id: "m", name: "M", description: "" }])[0] as ModeInfo),
    ...patch,
  });

test("a mode is drawn by how much it lets through: the one that never asks first of all", () => {
  expect(icon({ dangerous: true, plan: true, replaces: "readOnly", isDefault: true })).toBe(
    "warning",
  );
  expect(icon({ plan: true, replaces: "readOnly" })).toBe("lightbulb");
  expect(icon({ replaces: "readOnly", isDefault: true })).toBe("lock");
  expect(icon({ isDefault: true })).toBe("automation");
  expect(icon({ replaces: "auto" })).toBe("automation");
  expect(icon({})).toBe("sparkle");
  expect(icon({ replaces: "fullAccess" })).toBe("sparkle");
});

const models = [
  { id: "own-a", harness: "codex", isDefault: false, sandbox: false },
  { id: "own-b", harness: "codex", isDefault: true, sandbox: false },
  { id: "sonnet", harness: "claude", isDefault: false, sandbox: true },
  { id: "opus", harness: "claude", isDefault: false, sandbox: true },
];

test("the agent of a new session is its usual model's, else the one whose model is the default", () => {
  expect(draftHarness(models, "opus")).toBe("claude");
  expect(draftHarness(models, "gone")).toBe("codex");
  // Where no model is the default, it is codex all the same.
  expect(
    draftHarness(
      models.map((model) => ({ ...model, isDefault: false })),
      null,
    ),
  ).toBe("codex");
  // The default model's agent wins over the first one's.
  const claudeFirst = [...models.slice(2), ...models.slice(0, 2)];
  expect(draftHarness(claudeFirst, null)).toBe("codex");
  expect(harnessesOf(claudeFirst)).toEqual(["claude", "codex"]);
});

test("a model for an agent is the usual one if that is its own, else its default, else its first", () => {
  expect(draftModel(models, "codex", "own-a")).toBe("own-a");
  expect(draftModel(models, "codex", "opus")).toBe("own-b");
  expect(draftModel(models, "claude", null)).toBe("sonnet");
  expect(draftModel(models, "claude", "opus")).toBe("opus");
  expect(draftModel(models, "gone", "opus")).toBeNull();
});
