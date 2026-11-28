import { describe, expect, test } from "bun:test";
import type { LoopBoardColumn, LoopTicket } from "../src/api.ts";
import {
  type BacklogRow,
  backlogRows,
  filterRows,
  foldedByDefault,
  orderColumns,
  pageRows,
  parentProgress,
} from "../src/react/loop-board-layout.ts";

const tk = (identifier: string, extra: Partial<LoopTicket> = {}): LoopTicket => ({
  identifier,
  title: `title ${identifier}`,
  priority: null,
  column: "",
  ...extra,
});
const col = (id: number, stateType: string, tickets: LoopTicket[] = []): LoopBoardColumn => ({
  id,
  name: `c${id}`,
  stateType,
  tickets,
  more: false,
});
const child = (id: string, parent: string, extra: Partial<LoopTicket> = {}) =>
  tk(id, { parent: { identifier: parent, title: `title ${parent}` }, ...extra });
const ids = (rows: readonly BacklogRow[]): string[] =>
  rows.map((r) =>
    r.kind === "card"
      ? r.ticket.identifier
      : `[${r.key}:${r.children.map((c) => c.identifier).join(",")}]`,
  );

describe("columns", () => {
  const cols = [
    col(1, "backlog"),
    col(2, "unstarted"),
    col(3, "started"),
    col(4, "completed"),
    col(5, "started"),
    col(6, "unstarted"),
    col(7, "canceled"),
    col(8, "started"),
  ];
  test("orderColumns sorts by state and keeps server order within one", () => {
    expect(orderColumns(cols).map((c) => c.id)).toEqual([3, 5, 8, 2, 6, 1, 4, 7]);
  });
  test("foldedByDefault folds done, canceled and later unstarted columns", () => {
    expect([...foldedByDefault(cols)].sort()).toEqual([4, 6, 7]);
  });
});

describe("parentProgress", () => {
  test("counts completed as done and ignores canceled", () => {
    const p = parentProgress([
      col(1, "backlog", [child("a", "E")]),
      col(2, "started", [child("b", "E")]),
      col(3, "completed", [child("c", "E"), child("d", "F")]),
      col(4, "canceled", [child("e", "E"), child("f", "G")]),
    ]);
    expect(p.get("E")).toEqual({ done: 1, total: 3 });
    expect(p.get("F")).toEqual({ done: 1, total: 1 });
    expect(p.has("G")).toBe(false);
  });
});

describe("backlogRows", () => {
  test("pending first, Epic groups, parent-elsewhere groups, then the rest; each ticket once", () => {
    const backlog = [
      tk("loose-low", { priority: "low" }),
      tk("E1", { priority: "low" }),
      child("c1", "E1", { priority: "low" }),
      child("c2", "E1", { priority: "high" }),
      tk("E2", { priority: "urgent" }),
      child("c3", "E2"),
      child("x1", "T9"),
      child("p1", "E1", { pending: { reason: "r" }, priority: "low" }),
      tk("pend", { pending: { reason: "r" }, priority: "medium" }),
      tk("loose-high", { priority: "high" }),
    ];
    const rows = backlogRows(backlog, [
      col(1, "backlog", backlog),
      col(2, "unstarted", [tk("T9")]),
    ]);
    expect(ids(rows)).toEqual([
      "pend",
      "p1",
      "[E2:c3]",
      "[E1:c2,c1]",
      "[T9:x1]",
      "loose-high",
      "loose-low",
    ]);
    const elsewhere = rows.find((r) => r.kind === "group" && r.key === "T9");
    expect(elsewhere).toMatchObject({ elsewhere: true, head: { title: "title T9" } });
    const all = ids(rows)
      .join(",")
      .replace(/[[\]:]/g, ",")
      .split(",")
      .filter(Boolean);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(backlog.length + 1); // + the elsewhere head, which is not a Backlog ticket
  });
  test("a Backlog card with children elsewhere on the board is a group head with progress", () => {
    const backlog = [tk("E")];
    const rows = backlogRows(backlog, [
      col(1, "backlog", backlog),
      col(2, "completed", [child("d", "E")]),
      col(3, "started", [child("s", "E")]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "group",
      elsewhere: false,
      children: [],
      progress: { done: 1, total: 2 },
    });
  });
  test("sorting is stable among equal priorities", () => {
    const backlog = [tk("a"), tk("b"), tk("c", { priority: "high" }), tk("d")];
    expect(ids(backlogRows(backlog, [col(1, "backlog", backlog)]))).toEqual(["c", "a", "b", "d"]);
  });
});

describe("paging and filtering", () => {
  const backlog = [
    tk("E", { title: "alpha" }),
    child("c1", "E", { title: "beta" }),
    child("c2", "E", { title: "gamma" }),
    tk("z", { title: "delta" }),
  ];
  const rows = backlogRows(backlog, [col(1, "backlog", backlog)]);
  test("a group is one row", () => {
    expect(rows).toHaveLength(2);
    expect(pageRows(rows, 1)).toEqual({ shown: rows.slice(0, 1), hidden: 1 });
    expect(pageRows(rows, 20).hidden).toBe(0);
  });
  test("a matching head keeps every child", () => {
    expect(ids(filterRows(rows, (t) => t.title === "alpha"))).toEqual(["[E:c1,c2]"]);
  });
  test("a matching child keeps only the matching children", () => {
    expect(ids(filterRows(rows, (t) => t.title === "beta"))).toEqual(["[E:c1]"]);
  });
  test("a group nothing matches is dropped; cards filter one by one", () => {
    expect(ids(filterRows(rows, (t) => t.title === "delta"))).toEqual(["z"]);
  });
  test("a parent that is not in Backlog never matches for itself", () => {
    const b = [child("x", "T")];
    const r = backlogRows(b, [col(1, "backlog", b)]);
    expect(filterRows(r, (t) => t.identifier === "T")).toEqual([]);
  });
});
