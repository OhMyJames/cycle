import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SqliteStore } from "../src/db/store.ts";
import { runCommand } from "../src/runner.ts";
import { computeStats } from "../src/stats.ts";
import { LoopUpdater } from "../src/supervisor/updater.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "loop-updater-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const git = async (cwd: string, args: string[]) => {
  const out = await runCommand(["git", ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1" },
    timeoutMs: 15_000,
  });
  if (out.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${out.output}`);
  return out.output.trim();
};

const setupRepos = async () => {
  const upstream = join(dir, "upstream.git");
  const work = join(dir, "work");
  const runtimeDir = join(dir, "loop-runtime");
  const stateDir = join(dir, "state");
  await mkdir(work, { recursive: true });
  await git(dir, ["init", "--bare", upstream]);
  await git(work, ["init", "-b", "main"]);
  await git(work, ["config", "user.name", "Test"]);
  await git(work, ["config", "user.email", "test@example.com"]);
  await git(work, ["remote", "add", "origin", upstream]);

  await mkdir(join(work, "cloud/loop/src/supervisor"), { recursive: true });
  await mkdir(join(work, "packages/protocol"), { recursive: true });
  await writeFile(
    join(work, "cloud/loop/package.json"),
    JSON.stringify({ name: "@cycle/loop", dependencies: { "@cycle/protocol": "workspace:*" } }),
  );
  await writeFile(
    join(work, "packages/protocol/package.json"),
    JSON.stringify({ name: "@cycle/protocol" }),
  );
  await writeFile(join(work, "cloud/loop/src/cli.ts"), "// v1\n");
  await writeFile(join(work, "cloud/loop/src/supervisor/main.ts"), "// sup v1\n");
  await writeFile(join(work, "README.md"), "# init\n");
  await git(work, ["add", "-A"]);
  await git(work, ["commit", "-m", "v1"]);
  await git(work, ["push", "-u", "origin", "main"]);
  const v1 = await git(work, ["rev-parse", "HEAD"]);

  const commitFile = async (rel: string, content: string, msg: string) => {
    await writeFile(join(work, rel), content);
    await git(work, ["add", rel]);
    await git(work, ["commit", "-m", msg]);
    await git(work, ["push", "origin", "main"]);
    return git(work, ["rev-parse", "HEAD"]);
  };

  const store = SqliteStore.open(stateDir, () => new Date("2026-11-27T12:00:00.000Z"));
  return { upstream, work, runtimeDir, store, v1, commitFile };
};

test("skips unrelated changes; updates cloud/loop changes through install -> selfCheck -> drain -> flip -> self_updated (CYC-485)", async () => {
  const { upstream, runtimeDir, store, v1, commitFile } = await setupRepos();
  const steps: string[] = [];
  const startedDirs: string[] = [];

  const updater = new LoopUpdater({
    runtimeDir,
    repoUrl: upstream,
    projects: [{ projectKey: "CYC", store }],
    exec: runCommand,
    env: process.env,
    installDeps: async () => {
      steps.push("install");
      return { ok: true };
    },
    selfCheck: async () => {
      steps.push("selfCheck");
      return { ok: true };
    },
    drainStop: async () => {
      steps.push("drain");
      return { drained: true };
    },
    startWorkLoop: (d) => {
      steps.push("start");
      startedDirs.push(d);
    },
    stopWorkLoop: () => {
      steps.push("stop");
    },
    awaitHeartbeat: async () => {
      steps.push("heartbeat");
      return true;
    },
  });

  expect(await updater.ensureInitialized()).toBe(v1);
  // Initial checkout installs dependencies before pointing `current` at v1.
  expect(steps).toEqual(["install"]);
  steps.length = 0;

  // 1. Change unrelated file -> skipped, no install/drain/restart.
  const vUnrelated = await commitFile("README.md", "# updated\n", "docs only");
  expect(await updater.checkOnce()).toEqual({ status: "skipped_unrelated", sha: vUnrelated });
  expect(steps).toEqual([]);
  expect(updater.currentSha).toBe(v1);

  // 2. Change cloud/loop/ -> full update flow and self_updated event.
  const v2 = await commitFile("cloud/loop/src/cli.ts", "// v2\n", "loop change");
  const updated = await updater.checkOnce();
  expect(updated).toEqual({ status: "updated", from: v1, to: v2, supervisorChanged: false });
  expect(steps).toEqual(["install", "selfCheck", "drain", "start", "heartbeat"]);
  expect(updater.currentSha).toBe(v2);
  expect(basename(updater.previousPath ?? "")).toBe(v1);
  expect(basename(startedDirs[0] ?? "")).toBe(v2);

  const stats = computeStats(await store.events());
  expect(stats.selfUpdates).toBe(1);
});

test("self-check failure does not switch; missing heartbeat rolls back to previous and blacklists sha; drain timeout aborts (CYC-485)", async () => {
  const { upstream, runtimeDir, store, v1, commitFile } = await setupRepos();
  let checkOk = false;
  let drainOk = true;
  let heartbeatOk = true;
  const started: string[] = [];

  const updater = new LoopUpdater({
    runtimeDir,
    repoUrl: upstream,
    projects: [{ projectKey: "CYC", store }],
    exec: runCommand,
    env: process.env,
    installDeps: async () => ({ ok: true }),
    selfCheck: async () => (checkOk ? { ok: true } : { ok: false, error: "test failed" }),
    drainStop: async () => ({ drained: drainOk }),
    startWorkLoop: (d) => {
      started.push(basename(d));
    },
    stopWorkLoop: () => {},
    awaitHeartbeat: async () => heartbeatOk,
  });
  await updater.ensureInitialized();

  // 1. Self-check failure -> stays on v1 and does not retry same sha.
  const vBadCheck = await commitFile("cloud/loop/src/cli.ts", "// bad check\n", "bad check");
  expect(await updater.checkOnce()).toMatchObject({
    status: "self_check_failed",
    sha: vBadCheck,
    step: "check",
  });
  expect(updater.currentSha).toBe(v1);
  expect(started).toEqual([]);
  expect(await updater.checkOnce()).toEqual({ status: "noop", sha: vBadCheck });

  // 2. Drain timeout -> aborts without flipping current.
  checkOk = true;
  drainOk = false;
  const vDrain = await commitFile("cloud/loop/src/cli.ts", "// drain timeout\n", "drain timeout");
  expect(await updater.checkOnce()).toEqual({ status: "drain_timeout", sha: vDrain });
  expect(updater.currentSha).toBe(v1);
  expect(started).toEqual([]);

  // 3. No heartbeat after switch -> rolls back to v1, writes Notice, records self_update_rolled_back, and blacklists sha.
  drainOk = true;
  heartbeatOk = false;
  const vNoBeat = await commitFile("cloud/loop/src/cli.ts", "// no beat\n", "no beat");
  expect(await updater.checkOnce()).toEqual({ status: "rolled_back", sha: vNoBeat, to: v1 });
  expect(updater.currentSha).toBe(v1);
  expect(started).toEqual([vNoBeat, v1]);
  expect(store.notices().some((n) => n.kind === "supervisor" && n.text.includes("回滚"))).toBe(
    true,
  );
  expect((await store.events()).some((e) => e.kind === "self_update_rolled_back")).toBe(true);
  // Same bad sha is never tried again.
  expect(await updater.checkOnce()).toEqual({ status: "noop", sha: vNoBeat });
});

test("changes under cloud/loop/src/supervisor/ post a Notice and never switch the supervisor itself (CYC-485)", async () => {
  const { upstream, runtimeDir, store, v1, commitFile } = await setupRepos();
  const updater = new LoopUpdater({
    runtimeDir,
    repoUrl: upstream,
    projects: [{ projectKey: "CYC", store }],
    exec: runCommand,
    env: process.env,
    installDeps: async () => ({ ok: true }),
    selfCheck: async () => ({ ok: true }),
    drainStop: async () => ({ drained: true }),
    startWorkLoop: () => {},
    stopWorkLoop: () => {},
    awaitHeartbeat: async () => true,
  });
  await updater.ensureInitialized();

  const vSup = await commitFile(
    "cloud/loop/src/supervisor/main.ts",
    "// supervisor v2\n",
    "supervisor change",
  );
  const res = await updater.checkOnce();
  expect(res).toEqual({ status: "updated", from: v1, to: vSup, supervisorChanged: true });
  expect(
    store.notices().some((n) => n.kind === "supervisor" && n.text.includes("守护者有新版本")),
  ).toBe(true);
});
