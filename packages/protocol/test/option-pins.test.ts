import { expect, test } from "bun:test";
import {
  type ModeInfo,
  defineModes,
  legacyMode,
  resolveMode,
  sameModelFamily,
} from "../src/index.ts";

/** What the choices an agent offers do today, pinned before they become one list (step 18). */

test("a mode an agent names has what it did not say filled in, and what it said kept", () => {
  const [plain, said] = defineModes("claude", [
    { id: "default", name: "Ask first", description: "" },
    { id: "plan", name: "Plan", description: "x", plan: true, replaces: "readOnly" },
  ]);
  expect(plain).toEqual({
    id: "default",
    harness: "claude",
    name: "Ask first",
    description: "",
    dangerous: false,
    plan: false,
    isDefault: false,
    replaces: null,
  });
  expect(said).toMatchObject({ plan: true, replaces: "readOnly", dangerous: false });
});

const list: ModeInfo[] = defineModes("x", [
  { id: "ask", name: "Ask", description: "", replaces: "readOnly" },
  { id: "work", name: "Work", description: "", replaces: "auto", isDefault: true },
  { id: "free", name: "Free", description: "", replaces: "fullAccess", dangerous: true },
]);

test("a stored value is read as the agent's default unless it names a mode the agent has", () => {
  expect(resolveMode(list, "free")?.id).toBe("free");
  expect(resolveMode(list, legacyMode("fullAccess"))?.id).toBe("free");
  // A marked word nothing replaces, an unmarked old word and an unknown one all fall to the default,
  // never to the first mode and never to the one that never asks.
  expect(resolveMode(list, "legacy:plan")?.id).toBe("work");
  expect(resolveMode(list, "readOnly")?.id).toBe("work");
  expect(resolveMode(list, "")?.id).toBe("work");
  expect(resolveMode(list, null)?.id).toBe("work");
});

test("a list with no default reads as its first mode, and an empty one as none", () => {
  const none = list.map((mode) => ({ ...mode, isDefault: false }));
  expect(resolveMode(none, "gone")?.id).toBe("ask");
  expect(resolveMode([], "gone")).toBeUndefined();
});

test("a session may change models only inside its agent and its kind of provider", () => {
  const own = { harness: "codex", provider: null };
  const mine = { harness: "codex", provider: { id: "p", name: "P" } };
  const other = { harness: "claude", provider: null };
  expect(sameModelFamily(own, { ...own })).toBe(true);
  expect(sameModelFamily(mine, { harness: "codex", provider: { id: "q", name: "Q" } })).toBe(true);
  expect(sameModelFamily(own, mine)).toBe(false);
  expect(sameModelFamily(mine, own)).toBe(false);
  expect(sameModelFamily(own, other)).toBe(false);
});
