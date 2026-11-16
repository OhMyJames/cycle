import { expect, test } from "bun:test";
import { type ModeInfo, formFields, legacyMode, resolveMode } from "../src/index.ts";

const mode = (id: string, extra: Partial<ModeInfo> = {}): ModeInfo => ({
  id,
  harness: "claude",
  name: id,
  description: "",
  dangerous: false,
  plan: false,
  isDefault: false,
  replaces: null,
  ...extra,
});

const modes = [
  mode("default", { replaces: "readOnly" }),
  mode("acceptEdits", { replaces: "auto", isDefault: true }),
  mode("auto"),
  mode("bypassPermissions", { replaces: "fullAccess", dangerous: true }),
];

test("a mode is an agent's own id, or an old one read by what replaces it", () => {
  expect(resolveMode(modes, "auto")?.id).toBe("auto");
  expect(resolveMode(modes, legacyMode("auto"))?.id).toBe("acceptEdits");
  expect(resolveMode(modes, legacyMode("readOnly"))?.id).toBe("default");
  expect(resolveMode(modes, legacyMode("fullAccess"))?.id).toBe("bypassPermissions");
  // What the agent does not offer, or nothing, is its default.
  expect(resolveMode(modes, "gone")?.id).toBe("acceptEdits");
  expect(resolveMode(modes, undefined)?.id).toBe("acceptEdits");
  expect(resolveMode([], "auto")).toBeUndefined();
  // Only the three old words are marked.
  expect(legacyMode("plan")).toBe("plan");
  expect(legacyMode("legacy:auto")).toBe("legacy:auto");
});

test("a form of simple fields is drawn as fields, and any other is not", () => {
  expect(
    formFields({
      properties: { n: { type: "integer", title: "N" }, c: { type: "string", enum: ["a"] } },
      required: ["c"],
    }),
  ).toEqual([
    { name: "n", title: "N", description: "", type: "integer", options: null, required: false },
    { name: "c", title: "c", description: "", type: "string", options: ["a"], required: true },
  ]);
  expect(formFields({ properties: { list: { type: "array" } } })).toBeNull();
  expect(formFields(null)).toEqual([]);
});
