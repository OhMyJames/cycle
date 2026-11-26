import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopRunsListResultSchema } from "@cycle/protocol";
import type { Config } from "../src/config.ts";
import { runsList, type StateDirOf } from "../src/runs.ts";
import { listen } from "../src/server.ts";

const dir = mkdtempSync(join(tmpdir(), "loop-runs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TOKEN = "ghp_SECRETTOKEN_RUNS_123";
const REPO_URL = "https://x-access-token:abc@github.com/clawdot/cycle.git";
const cycState = join(dir, "state-cyc");
const docState = join(dir, "state-doc");

const record = (state: string, key: string, phase: string, name = key) => {
  mkdirSync(join(state, "runs", name), { recursive: true });
  writeFileSync(
    join(state, "runs", name, "run.json"),
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
    },
    {
      name: "Docs",
      projectKey: "DOC",
      repo: { url: "git@gitlab.example.com:team/docs.git", forge: "gitlab" },
      token: "glpat-OTHER",
    },
  ],
};
const first = config.projects[0] as Config["projects"][number];
const only: Config = { projects: [first] };

const stateDirOf: StateDirOf = (key) =>
  key === "CYC" ? cycState : key === "DOC" ? docState : undefined;
const at =
  (state: string): StateDirOf =>
  () =>
    state;

beforeAll(() => {
  record(cycState, "CYC-2", "dev");
  record(cycState, "CYC-1", "done");
  record(cycState, "CYC-3", "blocked");
  mkdirSync(docState, { recursive: true });
});

describe("runs/list", () => {
  test("returns each Project's runs, and an empty list for one with none", async () => {
    const result = LoopRunsListResultSchema.parse(await runsList(config, stateDirOf));
    expect(result.projects.map((p) => p.projectKey)).toEqual(["CYC", "DOC"]);
    expect(result.projects[0]?.runs.map((r) => [r.key, r.state])).toEqual([
      ["CYC-1", "done"],
      ["CYC-2", "active"],
      ["CYC-3", "blocked"],
    ]);
    expect(result.projects[1]?.runs).toEqual([]);
  });

  test("a corrupt record, a copied directory and a stray file are skipped, valid runs stay", async () => {
    const state = join(dir, "state-mixed");
    mkdirSync(join(state, "runs", "BAD-1"), { recursive: true });
    writeFileSync(join(state, "runs", "BAD-1", "run.json"), "{not json");
    writeFileSync(join(state, "runs", "stray.txt"), "x");
    record(state, "OK-1", "dev");
    record(state, "OK-1", "dev", "COPY-1");
    symlinkSync(join(state, "runs", "OK-1"), join(state, "runs", "LINK-1"));
    const result = await runsList(only, at(state));
    expect(result.projects[0]?.runs.map((r) => r.key)).toEqual(["OK-1"]);
  });

  test("a state directory with no runs/ yet is an empty list", async () => {
    const result = await runsList(only, at(docState));
    expect(result.projects[0]?.runs).toEqual([]);
  });

  test("a missing or unknown state directory is an error, not an empty list", async () => {
    await expect(runsList(only, at(join(dir, "nowhere")))).rejects.toThrow("state_dir_missing");
    await expect(runsList(only, () => undefined)).rejects.toThrow("state_dir_unknown");
  });

  test("the serialized response holds no token, repository address or local path", async () => {
    const raw = JSON.stringify(await runsList(config, stateDirOf));
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

describe("over the socket", () => {
  const ask = (
    sock: string,
    method: string,
  ): Promise<{ result?: unknown; error?: { code: number } }> =>
    new Promise((resolve) => {
      const socket = connect(sock);
      socket.once("data", (d) => {
        socket.end();
        resolve(JSON.parse(d.toString()));
      });
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method })}\n`);
    });

  test("runs/list answers, and -32603 when a state directory is missing", async () => {
    const good = await listen(config, join(dir, "a.sock"), stateDirOf);
    const bad = await listen(config, join(dir, "b.sock"), () => undefined);
    try {
      const ok = await ask(join(dir, "a.sock"), "runs/list");
      expect(LoopRunsListResultSchema.parse(ok.result).projects).toHaveLength(2);
      const err = await ask(join(dir, "b.sock"), "runs/list");
      expect(err.error?.code).toBe(-32603);
      expect(JSON.stringify(err)).not.toContain(dir);
    } finally {
      good.close();
      bad.close();
    }
  });
});
