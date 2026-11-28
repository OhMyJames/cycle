import { expect, test } from "bun:test";
import { readOnlyMode } from "../src/ports/sessions.ts";
import { operatorBrief, parseOperatorReply } from "../src/prompts/index.ts";
import { computeStats } from "../src/stats.ts";

test("the operator role is read-only like research (CYC-486)", () => {
  expect(readOnlyMode("operator", "claude")).toBe(readOnlyMode("research", "claude") ?? "");
  expect(readOnlyMode("operator", "claude")).toBe("default");
});

test("stats counts operator_woken events as operatorWakes", () => {
  const ev = (kind: string) => ({ ts: "2026-01-01T00:00:00Z", run: "CYC-1", kind });
  expect(computeStats([]).operatorWakes).toBe(0);
  expect(
    computeStats([ev("operator_woken"), ev("operator_woken"), ev("operator_inspected")])
      .operatorWakes,
  ).toBe(2);
});

test("the reply parser takes the last diagnosis and flags any action", () => {
  expect(parseOperatorReply("x <diagnosis>old</diagnosis> <diagnosis> new </diagnosis>")).toEqual({
    diagnosis: "new",
    actionIgnored: false,
  });
  expect(parseOperatorReply('<diagnosis>d</diagnosis><action type="retry">CYC-1</action>')).toEqual(
    {
      diagnosis: "d",
      actionIgnored: true,
    },
  );
  expect(parseOperatorReply("<diagnosis> </diagnosis>").diagnosis).toBeNull();
  expect(parseOperatorReply("no blocks")).toEqual({ diagnosis: null, actionIgnored: false });
});

test("the briefs name the wake reason; an inspection carries the stats summary", () => {
  const bounds = {
    exportDir: "/state/operator-export",
    readRoots: ["/repo", "/state/operator-export"],
  };
  const stuck = operatorBrief({ reason: "stuck", key: "CYC-9", detail: "no heartbeat" }, bounds);
  expect(stuck).toContain("CYC-9");
  expect(stuck).toContain("/state/operator-export");
  const inspect = operatorBrief(
    { reason: "inspect", sinceMinutes: 60, stats: computeStats([]) },
    bounds,
  );
  expect(inspect).toContain("scheduled inspection");
  expect(inspect).toContain("rework rate");
  expect(operatorBrief({ reason: "blocked", keys: ["CYC-1", "CYC-2", "CYC-3"] }, bounds)).toContain(
    "CYC-1, CYC-2, CYC-3",
  );
});
