import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CriteriaBook } from "../src/criteria.ts";
import { importLegacyState, needsImport } from "../src/db/import.ts";
import { openStore, SqliteStore } from "../src/db/store.ts";
import { computeStats, readStats } from "../src/stats.ts";
import { RunRecordSchema, RunStore } from "../src/store.ts";

const T0 = new Date("2026-11-25T10:00:00Z");
const now = () => new Date("2026-11-26T08:00:00Z");
const tmp = () => mkdtemp(join(tmpdir(), "al-import-"));

const run = (key: string, over: Record<string, unknown> = {}) =>
  RunRecordSchema.parse({
    key,
    issueId: 1,
    issueNumber: Number(key.split("-")[1]),
    title: `title of ${key}`,
    phase: "dev",
    round: 0,
    worktree: `/wt/${key}`,
    localBranch: `worktree-auto/${key}`,
    remoteBranch: `auto/${key}`,
    devSessionId: "d",
    qaSessionId: null,
    replacedSessions: [],
    blockedReason: null,
    resumeFrom: null,
    prUrl: null,
    findings: null,
    startedAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
    ...over,
  });

const PLAN_ID = "2026-11-25T09-00-00-000Z";

/** A state directory as an older loop left it: delivered, blocked, in progress and research runs, and a planning round. */
const sample = async (): Promise<string> => {
  const dir = await tmp();
  const store = new RunStore(dir, () => T0);
  const ev = (r: string, kind: string, data: Record<string, string | number | boolean> = {}) =>
    store.event(r, kind, data);

  await store.save(run("CYC-1", { phase: "done", prUrl: "https://x/pr/1" }));
  await ev("CYC-1", "claimed");
  await ev("CYC-1", "verify");
  await ev("CYC-1", "round_failed");
  await ev("CYC-1", "delivered", { autoMerge: true, prUrl: "https://x/pr/1" });
  await store.saveCriteria(
    "CYC-1",
    CriteriaBook.fromSpecs([{ text: "it works", verify: [["bun", "test"]] }]),
  );
  await store.appendProgress("CYC-1", 0, "done: a\nnext: b");
  await store.appendProgress("CYC-1", 1, "done: c\nnext: nothing");

  await store.save(
    run("CYC-2", { phase: "blocked", resumeFrom: "qa", blockedReason: "needs a person" }),
  );
  await ev("CYC-2", "claimed");
  await ev("CYC-2", "blocked");
  await ev("CYC-2", "permission_requested", { tool: "bash", command: "git mv", decision: "ask" });

  await store.save(run("CYC-3", { phase: "qa", round: 1, qaSessionId: "q" }));
  await ev("CYC-3", "claimed");
  await ev("CYC-3", "verify");
  await store.saveCriteria("CYC-3", CriteriaBook.fromSpecs([{ text: "x", verify: [["true"]] }]));
  await store.appendProgress("CYC-3", 0, "in flight");

  await store.save(
    run("CYC-4", {
      kind: "research",
      phase: "research",
      research: {
        questions: ["why?"],
        output: null,
        docId: null,
        docLinked: false,
        conclusionDone: false,
        followups: [],
        commented: false,
      },
    }),
  );
  await ev("CYC-4", "claimed", { runKind: "research" });
  await ev("CYC-4", "researched");

  // A run.json from before kind, ciRound, conflict, research and the rest were written.
  await store.save(run("CYC-5", { phase: "ci" }));
  const oldJson = JSON.parse(await readFile(join(dir, "runs", "CYC-5", "run.json"), "utf8"));
  for (const f of [
    "kind",
    "ciRound",
    "ciFailedSha",
    "nodeModulesReleased",
    "conflictRound",
    "conflict",
    "resolvedFiles",
    "reviewSessionId",
    "research",
    "fullFlowDocs",
    "cleanedAt",
    "cleanupNote",
  ])
    delete oldJson[f];
  await writeFile(join(dir, "runs", "CYC-5", "run.json"), JSON.stringify(oldJson));
  await ev("CYC-5", "claimed");

  await store.savePlan({
    id: PLAN_ID,
    startedAt: "2026-11-25T09:00:00.000Z",
    updatedAt: "",
    phase: "triage",
    worktree: null,
    triageSessionId: null,
    candidates: ["CYC-9"],
    triage: null,
    queue: [],
  });
  await ev(`plan-${PLAN_ID}`, "plan_started");
  await store.writePlanBody(PLAN_ID, "CYC-9", "body of nine");
  await store.savePlanMemory({
    "CYC-9": { category: "can", bodyHash: "h", lastCommentAt: null, stopped: false },
  });
  // The loop was killed in the middle of writing an event.
  await appendFile(join(dir, "events.jsonl"), '{"ts":"2026-11-25T10:00:00.000Z","run":"CYC-3","ki');
  return dir;
};

/** Every file under `dir`, with its content: to see that nothing was touched. */
const snapshot = async (dir: string, at = ""): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const e of await readdir(join(dir, at), { withFileTypes: true })) {
    const rel = join(at, e.name);
    if (e.isDirectory()) Object.assign(out, await snapshot(dir, rel));
    else out[rel] = await readFile(join(dir, rel), "utf8");
  }
  return out;
};

test("importing a state directory with a run in progress keeps stats, renames the old files and resumes from loop.db", async () => {
  const dir = await sample();
  const before = await readStats(dir, now);
  expect(before.runs).toBe(4);
  expect(before.delivered).toBe(1);
  expect(before.researched).toBe(1);
  const oldRuns = (await new RunStore(dir, now).all()).sort((a, b) => a.key.localeCompare(b.key));
  expect(needsImport(dir)).toBe(true);

  const result = await importLegacyState(dir, now);
  expect(result.runs).toBe(5);
  // The half line at the end was dropped.
  expect(result.events).toBe(13);

  const names = (await readdir(dir)).sort();
  expect(names).toContain("loop.db");
  expect(names).not.toContain("loop.db.importing");
  expect(names).toEqual(
    expect.arrayContaining([
      "runs.imported-2026-11-26",
      "events.jsonl.imported-2026-11-26",
      "plans.imported-2026-11-26",
    ]),
  );
  expect(names).not.toContain("runs");
  expect(names).not.toContain("events.jsonl");
  expect(needsImport(dir)).toBe(false);

  // loop.db is read now, and says the same.
  expect(await readStats(dir, now)).toEqual(before);
  expect(computeStats(await openStore(dir, now).events())).toEqual(before);

  const store = openStore(dir, now);
  expect(store).toBeInstanceOf(SqliteStore);
  expect((await store.all()).map((r) => r.key)).toEqual(oldRuns.map((r) => r.key));
  expect(await store.all()).toEqual(oldRuns);
  const unfinished = await store.unfinished();
  expect(unfinished.map((r) => r.key)).toEqual(["CYC-2", "CYC-3", "CYC-4", "CYC-5"]);
  // The old run.json had no such fields: the defaults are what the files would give.
  expect(unfinished.find((r) => r.key === "CYC-5")).toMatchObject({
    kind: "dev",
    dev: { ciRound: 0, conflict: null },
  });
  expect((await store.loadCriteria("CYC-3")).items).toHaveLength(1);
  expect(await store.readProgress("CYC-3")).toContain("in flight");
  expect(await store.readProgress("CYC-1")).toBe(
    await readFile(join(dir, "runs.imported-2026-11-26", "CYC-1", "progress.md"), "utf8"),
  );
  expect((await store.loadPlanMemory())["CYC-9"]?.category).toBe("can");
  expect((await store.plans()).map((p) => p.id)).toEqual([PLAN_ID]);
  // A session still reads the round's bodies from plans/.
  expect(await readFile(join(store.planBodiesDir(PLAN_ID), "CYC-9.md"), "utf8")).toBe(
    "body of nine",
  );

  // It carries on: the run moves, and the loop writes to loop.db.
  const moved = await store.save({
    ...(unfinished[1] as (typeof unfinished)[number]),
    phase: "delivering",
  });
  expect((await store.load("CYC-3"))?.phase).toBe(moved.phase);
  await store.event("CYC-3", "delivered", { autoMerge: true, prUrl: "u" });
  expect((await readStats(dir, now)).delivered).toBe(2);
});

test("a run.json that cannot be read refuses the import: no loop.db, the old files untouched", async () => {
  const dir = await sample();
  await writeFile(join(dir, "runs", "CYC-3", "run.json"), '{"key":"CYC-3","phase":');
  const files = await snapshot(dir);
  await expect(importLegacyState(dir, now)).rejects.toThrow(/could not import/);
  expect(await snapshot(dir)).toEqual(files);
  expect(await readdir(dir)).not.toContain("loop.db");
  expect(await readdir(dir)).not.toContain("loop.db.importing");
});

test("a run.json that fails the schema, or a bad line in the middle of events.jsonl, refuses it too", async () => {
  const dir = await sample();
  await writeFile(join(dir, "runs", "CYC-2", "run.json"), JSON.stringify({ key: "CYC-2" }));
  const files = await snapshot(dir);
  await expect(importLegacyState(dir, now)).rejects.toThrow(/could not import/);
  expect(await snapshot(dir)).toEqual(files);

  const other = await sample();
  const text = await readFile(join(other, "events.jsonl"), "utf8");
  await writeFile(join(other, "events.jsonl"), `not json\n${text}`);
  const before = await snapshot(other);
  await expect(importLegacyState(other, now)).rejects.toThrow(/line 1/);
  expect(await snapshot(other)).toEqual(before);
  expect(await readdir(other)).not.toContain("loop.db.importing");
});

test("a loop.db that is already there is not imported over, and a leftover loop.db.importing is cleared", async () => {
  const dir = await sample();
  SqliteStore.open(dir, now).close();
  expect(needsImport(dir)).toBe(false);

  const fresh = await tmp();
  expect(needsImport(fresh)).toBe(false);

  const again = await sample();
  await writeFile(join(again, "loop.db.importing"), "junk");
  await importLegacyState(again, now);
  expect(await readdir(again)).toContain("loop.db");
  expect(await readdir(again)).not.toContain("loop.db.importing");
});

test("stats from files before and from loop.db after are the same when there are no runs, only events", async () => {
  const dir = await tmp();
  await mkdir(join(dir, "runs"));
  await importLegacyState(dir, now);
  expect(await readStats(dir, now)).toEqual(computeStats([]));
});
