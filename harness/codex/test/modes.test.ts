import { expect, test } from "bun:test";
import { CODEX_MODES, collaborationMode, modePolicy, modeReach } from "../src/index.ts";

test("codex offers the modes Cycle had, and its plan mode", () => {
  expect(CODEX_MODES.map((mode) => [mode.id, mode.replaces])).toEqual([
    ["readOnly", "readOnly"],
    ["auto", "auto"],
    ["plan", null],
    ["fullAccess", "fullAccess"],
  ]);
  expect(CODEX_MODES.filter((mode) => mode.isDefault).map((mode) => mode.id)).toEqual(["auto"]);
  expect(CODEX_MODES.filter((mode) => mode.dangerous).map((mode) => mode.id)).toEqual([
    "fullAccess",
  ]);
});

test("only full access goes without asking or a sandbox, and planning reads only", () => {
  for (const mode of ["readOnly", "plan", "unknown"]) {
    expect(modePolicy(mode)).toMatchObject({ approvalPolicy: "on-request", sandbox: "read-only" });
    expect(modeReach(mode)).toBe(0);
  }
  expect(modePolicy("auto")).toMatchObject({
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });
  expect(modePolicy("fullAccess")).toMatchObject({
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });
  expect(modeReach("fullAccess")).toBeGreaterThan(modeReach("auto"));
});

test("a thread is put in plan mode, and taken out of it, and otherwise left as it is", () => {
  const settings = { model: "gpt-5", effort: "high" };
  expect(collaborationMode("plan", undefined, settings)).toEqual({
    collaborationMode: {
      mode: "plan",
      settings: { model: "gpt-5", reasoning_effort: "high", developer_instructions: null },
    },
  });
  expect(collaborationMode("auto", "gpt-5", { model: "gpt-5" })).toEqual({
    collaborationMode: {
      mode: "default",
      settings: { model: "gpt-5", reasoning_effort: null, developer_instructions: null },
    },
  });
  expect(collaborationMode("auto", undefined, settings)).toEqual({});
  expect(() => collaborationMode("plan", undefined, {})).toThrow("Choose a model");
});

test("a thread leaves plan mode on the model it planned with when the turn names none", () => {
  expect(collaborationMode("auto", "gpt-5", {})).toMatchObject({
    collaborationMode: { mode: "default", settings: { model: "gpt-5" } },
  });
  // Never left planning while Cycle says otherwise.
  expect(() => collaborationMode("auto", "", {})).toThrow("out of plan mode");
});
