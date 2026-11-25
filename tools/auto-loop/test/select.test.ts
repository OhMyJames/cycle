import { expect, test } from "bun:test";
import { pickNext } from "../src/select.ts";
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
