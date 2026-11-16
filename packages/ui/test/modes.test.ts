import { expect, test } from "bun:test";
import type { ModeInfo } from "@cycle/protocol";
import { modeIcon, modeLabel, modeNamed, modesOf } from "../src/lib/modes.ts";

const mode = (id: string, harness: string, extra: Partial<ModeInfo> = {}): ModeInfo => ({
  id,
  harness,
  name: id,
  description: "",
  dangerous: false,
  plan: false,
  isDefault: false,
  replaces: null,
  ...extra,
});

const all = [
  mode("bypassPermissions", "claude", { dangerous: true, replaces: "fullAccess" }),
  mode("default", "claude", { replaces: "readOnly" }),
  mode("acceptEdits", "claude", { isDefault: true, replaces: "auto" }),
  mode("plan", "claude", { plan: true }),
  mode("auto", "claude"),
  mode("auto", "codex", { isDefault: true, replaces: "auto" }),
];

test("an agent's modes are its own, with the ones that never ask last", () => {
  expect(modesOf(all, "claude").map((each) => each.id)).toEqual([
    "default",
    "acceptEdits",
    "plan",
    "auto",
    "bypassPermissions",
  ]);
  expect(modesOf(all, "codex").map((each) => each.id)).toEqual(["auto"]);
});

test("a value names a mode of the agent's, an old one by what replaced it", () => {
  expect(modeNamed(all, "claude", "auto")?.id).toBe("auto");
  expect(modeNamed(all, "claude", "legacy:auto")?.id).toBe("acceptEdits");
  expect(modeNamed(all, "codex", "legacy:auto")?.id).toBe("auto");
  expect(modeNamed(all, "claude", "")?.id).toBe("acceptEdits");
  expect(modeNamed(all, "nobody", "auto")).toBeUndefined();
});

test("a mode is drawn by how much it lets through, and its default is marked", () => {
  expect(all.map(modeIcon)).toEqual([
    "warning",
    "lock",
    "automation",
    "lightbulb",
    "sparkle",
    "automation",
  ]);
  expect(modeLabel(all[2] as ModeInfo)).toBe("acceptEdits (default)");
  expect(modeLabel(all[3] as ModeInfo)).toBe("plan");
});
