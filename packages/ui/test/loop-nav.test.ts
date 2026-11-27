import { expect, test } from "bun:test";
import { enter, type LoopView, up, viewProject } from "../src/react/loop-nav.ts";

const ticket: LoopView = { at: "ticket", projectKey: "CYC", identifier: "CYC-1" };
const board: LoopView = { at: "project", projectKey: "CYC", tab: "kanban" };

test("up closes a ticket to its board and goes no higher", () => {
  expect(up(ticket)).toEqual(board);
  expect(up(board)).toBeUndefined();
  expect(up({ at: "overview" })).toBeUndefined();
});

test("enter returns to where the Loop was left, else the overview", () => {
  expect(enter(ticket)).toEqual(ticket);
  expect(enter(board)).toEqual(board);
  expect(enter(undefined)).toEqual({ at: "overview", landing: true });
});

test("viewProject names the Project a view is in", () => {
  expect(viewProject(ticket)).toBe("CYC");
  expect(viewProject({ at: "overview" })).toBeUndefined();
});
