import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopRunsListResultSchema } from "@cycle/protocol";
import type { Config } from "../src/config.ts";
import { runsList } from "../src/runs.ts";

const dir = mkdtempSync(join(tmpdir(), "loop-runs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TOKEN = "ghp_SECRETTOKEN_RUNS_123";
const REPO_URL = "https://x-access-token:abc@github.com/clawdot/cycle.git";
const cycState = join(dir, "state-cyc");
const docState = join(dir, "state-doc");

const record = (key: string, phase: string, extra: Record<string, unknown> = {}) => {
  mkdirSync(join(cycState, "runs", key), { recursive: true });
  writeFileSync(
    join(cycState, "runs", key, "run.json"),
    JSON.stringify({
      key,
      issueId: 1,
      issueNumber: 1,
      title: "t",
      phase,
      round: 0,
      worktree: join(dir, "worktrees", key),
      localBranch: `worktree-auto/${key}`,
      remoteBranch: `auto/${key}`,
      devSessionId: null,
      qaSessionId: null,
      replacedSessions: [],
      blockedReason: null,
      resumeFrom: null,
      prUrl: "https://github.com/clawdot/cycle/pull/9",
      findings: null,
      startedAt: "2026-11-26T01:00:00.000Z",
      updatedAt: "2026-11-26T02:00:00.000Z",
      ...extra,
    }),
  );
};

const config: Config = {
  projects: [
    {
      name: "Cycle",
      projectKey: "CYC",
      repo: { url: REPO_URL, forge: "github" },
      token: TOKEN,
      stateDir: cycState,
    },
    {
      name: "Docs",
      projectKey: "DOC",
      repo: { url: "git@gitlab.example.com:team/docs.git", forge: "gitlab" },
      token: "glpat-OTHER",
      stateDir: docState,
    },
  ],
};

describe("runs/list", () => {
  test("returns each Project's runs, and an empty list for one with none", async () => {
    record("CYC-2", "dev");
    record("CYC-1", "done");
    record("CYC-3", "blocked", { blockedReason: "x" });
    const result = LoopRunsListResultSchema.parse(await runsList(config));
    expect(result.projects.map((p) => p.projectKey)).toEqual(["CYC", "DOC"]);
    expect(result.projects[0]?.runs.map((r) => [r.key, r.state])).toEqual([
      ["CYC-1", "done"],
      ["CYC-2", "active"],
      ["CYC-3", "blocked"],
    ]);
    expect(result.projects[1]?.runs).toEqual([]);
  });

  test("a corrupt record and a stray file do not hide a valid run, and the list says so", async () => {
    const state = join(dir, "state-mixed");
    mkdirSync(join(state, "runs", "BAD-1"), { recursive: true });
    writeFileSync(join(state, "runs", "BAD-1", "run.json"), "{not json");
    writeFileSync(join(state, "runs", "stray.txt"), "x");
    mkdirSync(join(state, "runs", "OK-1"), { recursive: true });
    const good = join(cycState, "runs", "CYC-1", "run.json");
    writeFileSync(
      join(state, "runs", "OK-1", "run.json"),
      readFileSync(good, "utf8").replace("CYC-1", "OK-1"),
    );
    const first = config.projects[0];
    if (first === undefined) throw new Error("no project");
    const result = await runsList({ projects: [{ ...first, stateDir: state }] });
    expect(result.projects[0]?.runs.map((r) => r.key)).toEqual(["OK-1"]);
    expect(result.projects[0]?.unavailable).toBe(true);
  });

  test("a Project with no stateDir gets an empty list", async () => {
    const first = config.projects[0];
    if (first === undefined) throw new Error("no project");
    const result = await runsList({ projects: [{ ...first, stateDir: undefined }] });
    expect(result.projects[0]?.runs).toEqual([]);
  });

  test("the serialized response holds no token, repository address or local path", async () => {
    const raw = JSON.stringify(await runsList(config));
    expect(raw).toContain("CYC-2");
    for (const secret of [
      TOKEN,
      "glpat-OTHER",
      "x-access-token",
      "github.com",
      "gitlab",
      dir,
      "worktree",
      "pull/9",
    ])
      expect(raw).not.toContain(secret);
  });
});
