import { expect, test } from "bun:test";
import { toIssue } from "../src/plan-mcp.ts";
import { pickNext } from "../src/select.ts";
import { parseAllowedTypeIds } from "../src/types.ts";
import { config, issue } from "./helpers.ts";

const cfg = config();

test("takes only a work item that is in Todo and carries auto", () => {
  const items = [
    issue({ number: 1, labelIds: [] }),
    issue({ number: 2, columnId: 23 }),
    issue({ number: 3, columnId: 35 }),
    issue({ number: 4 }),
  ];
  expect(pickNext(items, cfg)?.number).toBe(4);
});

test("takes nothing when nothing is both", () => {
  expect(pickNext([issue({ labelIds: [5] }), issue({ columnId: 24 })], cfg)).toBeUndefined();
  expect(pickNext([], cfg)).toBeUndefined();
});

test("takes only Feature and Bug leaf issues; ignores Epic, Design, other types, and parents", () => {
  const nonEligible = [
    issue({ number: 1, priority: "urgent", typeId: 17 }), // Epic
    issue({ number: 2, priority: "urgent", typeId: 19 }), // Design
    issue({ number: 3, priority: "urgent", typeId: 18 }), // Product Requirement / other
    issue({ number: 4, priority: "urgent", typeId: 21 }), // Tech Governance
    issue({ number: 5, priority: "urgent", typeId: null }), // unset type
    issue({ number: 6, priority: "urgent", typeId: 20, subtaskCount: 2 }), // Feature with subtasks
    issue({ number: 7, priority: "urgent", typeId: 25, subtaskCount: 1 }), // Bug with subtasks
    issue({ number: 12, priority: "urgent", typeId: 20, subtaskCount: null }), // unknown subtask info (fails closed)
    issue({ number: 8, priority: "urgent", columnId: 36, typeId: 20 }), // Paused
    issue({ number: 9, priority: "urgent", columnId: 21, typeId: 20 }), // Backlog
  ];
  expect(pickNext(nonEligible, cfg)).toBeUndefined();

  const featureLeaf = issue({ number: 10, priority: "medium", typeId: 20, subtaskCount: 0 });
  const bugLeaf = issue({ number: 11, priority: "low", typeId: 25, subtaskCount: 0 });
  expect(pickNext([...nonEligible, featureLeaf], cfg)?.number).toBe(10);
  expect(pickNext([...nonEligible, bugLeaf], cfg)?.number).toBe(11);
  expect(pickNext([...nonEligible, bugLeaf, featureLeaf], cfg)?.number).toBe(10);
});

test("allowed type ids come from config, not hardcoded ids", () => {
  const customCfg = config({ allowedTypeIds: [101, 102] });
  const items = [
    issue({ number: 1, priority: "urgent", typeId: 20 }),
    issue({ number: 2, priority: "urgent", typeId: 25 }),
    issue({ number: 3, priority: "low", typeId: 102 }),
  ];
  expect(pickNext(items, customCfg)?.number).toBe(3);
  expect(pickNext(items.slice(0, 2), customCfg)).toBeUndefined();
});

test("highest priority first, then oldest, then lowest number", () => {
  const items = [
    issue({ number: 1, priority: "low" }),
    issue({ number: 2, priority: "high", createdAt: "2026-11-25T02:00:00.000Z" }),
    issue({ number: 3, priority: "high", createdAt: "2026-11-25T01:00:00.000Z" }),
    issue({ number: 4, priority: null }),
  ];
  expect(pickNext(items, cfg)?.number).toBe(3);
  expect(
    pickNext(
      items.filter((i) => i.number !== 3),
      cfg,
    )?.number,
  ).toBe(2);
  expect(
    pickNext([issue({ number: 9, priority: null }), issue({ number: 8, priority: "low" })], cfg)
      ?.number,
  ).toBe(8);
});

test("toIssue parses typeId and active subtaskCount from tracker payloads", () => {
  const leaf = toIssue(
    {
      id: 676,
      sequenceNumber: 330,
      title: "leaf",
      description: "",
      priority: "high",
      createdAt: "2026-11-25T00:00:00.000Z",
      columnId: 22,
      labelIds: [11],
      typeId: 20,
      subtasks: [],
    },
    "CYC",
  );
  expect(leaf.typeId).toBe(20);
  expect(leaf.subtaskCount).toBe(0);

  const parent = toIssue(
    {
      id: 660,
      sequenceNumber: 315,
      title: "parent",
      columnId: 22,
      labelIds: [11],
      type: { id: 17 },
      subtasks: [
        { id: 1, columnId: 24, typeId: 20, archived: false },
        { id: 2, columnId: 21, typeId: 20, archived: true },
        { id: 3, columnId: 22, typeId: 20, archived: false },
      ],
    },
    "CYC",
  );
  expect(parent.typeId).toBe(17);
  expect(parent.subtaskCount).toBe(2);

  // Missing subtask info fails closed (subtaskCount: null) so pickNext refuses it.
  const noSubtaskFields = toIssue(
    { id: 700, sequenceNumber: 400, columnId: 22, labelIds: [11], typeId: 20 },
    "CYC",
  );
  expect(noSubtaskFields.typeId).toBe(20);
  expect(noSubtaskFields.subtaskCount).toBeNull();
  expect(pickNext([noSubtaskFields], cfg)).toBeUndefined();

  const untyped = toIssue({ id: 701, sequenceNumber: 401, columnId: 22, subtasks: [] }, "CYC");
  expect(untyped.typeId).toBeNull();
  expect(untyped.subtaskCount).toBe(0);
});

test("parseAllowedTypeIds parses valid comma-separated ids and rejects invalid values", () => {
  expect(parseAllowedTypeIds("20, 25")).toEqual([20, 25]);
  expect(parseAllowedTypeIds("101")).toEqual([101]);
  expect(() => parseAllowedTypeIds("")).toThrow();
  expect(() => parseAllowedTypeIds("20,abc")).toThrow();
  expect(() => parseAllowedTypeIds("0")).toThrow();
  expect(() => parseAllowedTypeIds("-5")).toThrow();
});
