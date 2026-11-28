// CYC-509: small items are sized in `graph_plan`: one node on the fast path, or 2–4 nodes from a read-only planner.

import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import {
  checkPlannerReply,
  packageOf,
  routeSmallItem,
  touchedPackages,
} from "../src/graph-plan.ts";
import type { Issue } from "../src/types.ts";
import { setupFullFlow } from "./full-flow-helpers.ts";
import { CHECKED, config, done, issue, PASS, REVIEW_MERGE, WT } from "./helpers.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const BUG = 25;
const criteria = (n: number): string =>
  Array.from({ length: n }, (_, i) => `${i + 1}. c${i + 1}。验证：\`bun run check\``).join("\n");
const body = (n: number, surface = "x"): string =>
  `## 背景与证据\nx\n\n## 范围\nx\n\n## 非目标\nx\n\n## 涉及面\n${surface}\n\n## 验收标准\n\n${criteria(n)}\n`;
const bugBody = (n: number, surface = "x"): string =>
  `## 现象\nx\n\n## 复现步骤\nx\n\n## 预期与实际\nx\n\n## 环境与版本\nx\n\n## 严重度\nx\n\n## 涉及面\n${surface}\n\n## 验收标准\n\n${criteria(n)}\n`;
const cfg = config();

const node = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Node ${id}`,
  goal: `Do ${id}`,
  dependsOn: [] as string[],
  filesHint: ["cloud/loop/src/graph.ts"],
  verify: ["bun test ./cloud/loop/test/graph.test.ts"],
  ...over,
});
const reply = (nodes: unknown[]): string =>
  `${CHECKED}\n\`\`\`json\n${JSON.stringify({ nodes })}\n\`\`\`\n`;
const GOOD = reply([node("n1"), node("n2", { dependsOn: ["n1"] })]);
const CYCLE = reply([node("n1", { dependsOn: ["n2"] }), node("n2", { dependsOn: ["n1"] })]);

test("packageOf groups by top-level package directory", () => {
  expect(packageOf("cloud/loop/src/a.ts")).toBe("cloud/loop");
  expect(packageOf("./apps/desktop/src/x.ts")).toBe("apps/desktop");
  expect(packageOf("packages/ui/")).toBe("packages/ui");
  expect(packageOf("harness/claude/src")).toBe("harness/claude");
  expect(packageOf("docs/protocol.md")).toBe("docs");
  expect(packageOf("../x")).toBeUndefined();
});

test("touchedPackages reads 涉及面 only, and treats a missing path list as no package", () => {
  expect(
    [
      ...touchedPackages(body(1, "`cloud/loop/src/a.ts`、`cloud/loop/test/b.ts`、`docs/x.md`")),
    ].sort(),
  ).toEqual(["cloud/loop", "docs"]);
  expect(touchedPackages(body(1, "只改一处逻辑，和/或文案")).size).toBe(0);
  expect(touchedPackages("## 范围\n`apps/desktop/a.ts`").size).toBe(0);
  expect([...touchedPackages(body(1, "- cloud/loop/src/a.ts 与 packages/ui/b.ts"))].sort()).toEqual(
    ["cloud/loop", "packages/ui"],
  );
});

test("routeSmallItem: simple bug and single-package feature take the fast path; the rest are planned", () => {
  const route = (description: string, typeId = 20) =>
    routeSmallItem(issue({ description, typeId }), cfg);
  expect(route(bugBody(3, "`cloud/loop/a.ts` `apps/desktop/b.ts`"), BUG).route).toBe("single");
  expect(route(body(3, "`cloud/loop/a.ts` `cloud/loop/b.ts`")).route).toBe("single");
  expect(route(body(2, "x")).route).toBe("single");
  expect(route(body(4, "`cloud/loop/a.ts`")).route).toBe("plan");
  expect(route(bugBody(4), BUG).route).toBe("plan");
  expect(route(body(2, "`cloud/loop/a.ts` `apps/desktop/b.ts`"))).toMatchObject({
    route: "plan",
    reason: "cross_package",
  });
});

test("checkPlannerReply accepts a valid graph in topological order", async () => {
  const out = await checkPlannerReply(
    reply([node("b", { dependsOn: ["a"] }), node("a")]),
    "/nonexistent/wt",
  );
  expect(out.ok).toBe(true);
  if (out.ok) expect(out.specs.map((s) => s.id)).toEqual(["a", "b"]);
});

test("checkPlannerReply rejects cycles, bad counts, bad verify, escaping filesHint and non-JSON", async () => {
  const wt = "/nonexistent/wt";
  const why = async (text: string): Promise<string> => {
    const out = await checkPlannerReply(text, wt);
    expect(out.ok).toBe(false);
    return out.ok ? "" : out.reasons.join("\n");
  };
  expect(await why(CYCLE)).toContain("cycle");
  expect(await why(reply([node("n1")]))).toContain("1 node");
  expect(await why(reply(["1", "2", "3", "4", "5"].map((i) => node(`n${i}`))))).toContain(
    "exceeding",
  );
  expect(await why(reply([node("n1"), node("n2", { verify: ["rm -rf /"] })]))).toContain(
    "disallowed verify",
  );
  expect(await why(reply([node("n1"), node("n1")]))).toContain("Duplicate");
  expect(await why(reply([node("n1"), node("n2", { dependsOn: ["zz"] })]))).toContain(
    "unknown node",
  );
  expect(await why(reply([node("n1"), node("n2", { filesHint: ["/etc/passwd"] })]))).toContain(
    "absolute",
  );
  expect(await why(reply([node("n1"), node("n2", { filesHint: ["a/../../x"] })]))).toContain("..");
  expect(await why("no block here")).toContain("no fenced");
  expect(await why("```json\n{not json\n```")).toContain("not valid JSON");
});

test("checkPlannerReply rejects a filesHint whose nearest existing parent is a symlink out of the worktree", async () => {
  const { mkdtemp, symlink, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const base = await mkdtemp(join(tmpdir(), "graph-plan-"));
  dirs.push(base);
  const wt = join(base, "wt");
  const outside = join(base, "outside");
  await mkdir(wt);
  await mkdir(outside);
  await mkdir(join(wt, "src"));
  await symlink(outside, join(wt, "link"));
  const bad = await checkPlannerReply(
    reply([node("n1"), node("n2", { filesHint: ["link/new.ts"] })]),
    wt,
  );
  expect(bad.ok).toBe(false);
  const good = await checkPlannerReply(
    reply([node("n1", { filesHint: ["src/new/x.ts"] }), node("n2")]),
    wt,
  );
  expect(good.ok).toBe(true);
});

const run = async (issueOver: Partial<Issue>, script: Parameters<typeof setupFullFlow>[2]) => {
  const s = await setupFullFlow([issue({ labelIds: [11], ...issueOver })], undefined, script);
  dirs.push(s.cfg.stateDir);
  const result = await s.pipeline.step();
  return { s, result };
};

test("simple Bug (AC <= 3) goes straight to one node: no graph_planner session", async () => {
  const { s, result } = await run(
    { description: bugBody(3, "`cloud/loop/a.ts` `apps/desktop/b.ts`"), typeId: BUG },
    { dev: [done()], qa: [done(PASS)], review: [done(REVIEW_MERGE)] },
  );
  expect(result.status).toBe("delivered");
  expect(s.sessions.titles.some((t) => t.role === "graph_planner")).toBe(false);
  expect(await s.store.loadGraph("CYC-1")).toBeUndefined();
  expect((await s.store.events()).some((e) => e.kind === "graph_plan_single")).toBe(true);
});

test("single-package Feature with AC <= 3 goes straight to one node", async () => {
  const { s, result } = await run(
    { description: body(3, "`cloud/loop/src/a.ts`、`cloud/loop/test/a.test.ts`") },
    { dev: [done()], qa: [done(PASS)], review: [done(REVIEW_MERGE)] },
  );
  expect(result.status).toBe("delivered");
  expect(s.sessions.titles.some((t) => t.role === "graph_planner")).toBe(false);
  expect(await s.store.loadGraph("CYC-1")).toBeUndefined();
});

test("AC > 3 runs the read-only planner and executes its nodes as source auto_planner", async () => {
  const { s, result } = await run(
    { description: body(5, "`cloud/loop/src/a.ts`") },
    {
      dev: [
        done("<progress>done: n1\nnext: n2</progress>"),
        done("<progress>done: n2\nnext: -</progress>"),
      ],
      qa: [done(PASS)],
      review: [done(REVIEW_MERGE)],
      graph_planner: [done(GOOD)],
    },
  );
  expect(result.status).toBe("delivered");
  expect(s.sessions.prompts.filter((p) => p.role === "graph_planner")).toHaveLength(1);
  expect(s.sessions.prompts.find((p) => p.role === "graph_planner")?.prompt).toContain("READ-ONLY");
  const graph = await s.store.loadGraph("CYC-1");
  expect(graph?.source).toBe("auto_planner");
  expect(graph?.nodes.map((n) => [n.id, n.status])).toEqual([
    ["n1", "passed"],
    ["n2", "passed"],
    ["qa-1", "passed"],
  ]);
  // The first node continues in the claim's Dev session; the second gets a fresh one.
  expect(s.sessions.titles.filter((t) => t.role === "dev")).toHaveLength(2);
});

test("a cross-package Feature with few criteria is planned too", async () => {
  const { s } = await run(
    { description: body(2, "`cloud/loop/src/a.ts` `apps/desktop/src/b.ts`") },
    {
      dev: [done(), done()],
      qa: [done(PASS)],
      review: [done(REVIEW_MERGE)],
      graph_planner: [done(GOOD)],
    },
  );
  expect((await s.store.loadGraph("CYC-1"))?.source).toBe("auto_planner");
});

test("an invalid reply is sent back in the same session and a corrected one is accepted on turn 3", async () => {
  const { s, result } = await run(
    { description: body(5) },
    {
      dev: [done(), done()],
      qa: [done(PASS)],
      review: [done(REVIEW_MERGE)],
      graph_planner: [done(CYCLE), done(reply([node("n1")])), done(GOOD)],
    },
  );
  expect(result.status).toBe("delivered");
  const planner = s.sessions.prompts.filter((p) => p.role === "graph_planner");
  expect(planner).toHaveLength(3);
  expect(new Set(planner.map((p) => p.sessionId)).size).toBe(1);
  expect(planner[1]?.prompt).toContain("cycle");
  expect(planner[2]?.prompt).toContain("1 node");
  expect(s.sessions.titles.filter((t) => t.role === "graph_planner")).toHaveLength(1);
  expect((await s.store.loadGraph("CYC-1"))?.source).toBe("auto_planner");
});

test("three invalid replies fall back to one node, record graph_plan_fallback, and never block", async () => {
  const { s, result } = await run(
    { description: body(5) },
    {
      dev: [done()],
      qa: [done(PASS)],
      review: [done(REVIEW_MERGE)],
      graph_planner: [
        done(reply([node("n1", { verify: ["rm -rf /"] }), node("n2")])),
        done(reply([node("n1", { filesHint: ["../x"] }), node("n2")])),
        done(CYCLE),
        done(GOOD), // a fourth turn must never be asked for
      ],
    },
  );
  expect(result.status).toBe("delivered");
  expect(s.sessions.prompts.filter((p) => p.role === "graph_planner")).toHaveLength(3);
  expect(s.sessions.script.graph_planner).toHaveLength(1);
  expect(await s.store.loadGraph("CYC-1")).toBeUndefined();
  const fallback = (await s.store.events()).filter((e) => e.kind === "graph_plan_fallback");
  expect(fallback).toHaveLength(1);
  expect(fallback[0]?.turns).toBe(3);
  expect(s.tracker.moves.some((m) => m.endsWith(":blocked"))).toBe(false);
  expect(s.sessions.titles.filter((t) => t.role === "dev")).toHaveLength(1);
  expect(WT).toBeTruthy();
});

test("a planner session that fails to start falls back instead of blocking", async () => {
  const { s, result } = await run(
    { description: body(5) },
    {
      dev: [done()],
      qa: [done(PASS)],
      review: [done(REVIEW_MERGE)],
      createError: { graph_planner: new Error("no agent") },
    },
  );
  expect(result.status).toBe("delivered");
  expect((await s.store.events()).some((e) => e.kind === "graph_plan_fallback")).toBe(true);
});
