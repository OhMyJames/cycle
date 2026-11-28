import { expect, test } from "bun:test";
import type { LoopProjectInfo } from "../src/api.ts";
import { type LoopView, matchLoopProject, up, viewProject } from "../src/react/loop-nav.ts";

const ticket: LoopView = { at: "ticket", projectKey: "CYC", identifier: "CYC-1" };
const board: LoopView = { at: "project", projectKey: "CYC", tab: "kanban" };
const timeline: LoopView = { at: "project", projectKey: "CYC", tab: "timeline" };

const projects: LoopProjectInfo[] = [
  { name: "Cycle", projectKey: "CYC", repo: { displayName: "OhMyJames/cycle", forge: "github" } },
  { name: "Docs", projectKey: "DOC", repo: { displayName: "team/docs", forge: "gitlab" } },
];

test("up closes a ticket to its board and goes no higher", () => {
  expect(up(ticket)).toEqual(board);
  expect(up(board)).toBeUndefined();
  expect(up(timeline)).toBeUndefined();
  expect(up({ at: "overview" })).toBeUndefined();
});

test("viewProject names the Project a view is in", () => {
  expect(viewProject(ticket)).toBe("CYC");
  expect(viewProject(board)).toBe("CYC");
  expect(viewProject(timeline)).toBe("CYC");
  expect(viewProject({ at: "overview" })).toBeUndefined();
});

test("matchLoopProject matches workspace repo displayName case-insensitively", () => {
  expect(matchLoopProject(projects, "ohmyjames/cycle")?.projectKey).toBe("CYC");
  expect(matchLoopProject(projects, "team/docs")?.projectKey).toBe("DOC");
  expect(matchLoopProject(projects, "other/repo")).toBeUndefined();
  expect(matchLoopProject(projects, null)).toBeUndefined();
  expect(matchLoopProject(projects, undefined)).toBeUndefined();
});
