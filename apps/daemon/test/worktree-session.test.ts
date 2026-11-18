import { expect, test } from "bun:test";
import type { ExecResult, Settings } from "@cycle/protocol";
import { Git, JsonStore, type MetaFile, SessionHub, UsageLedger } from "../src/index.ts";
import type { UsageFile } from "../src/index.ts";
import { FakeHarness, manualSchedule } from "./fake-harness.ts";

const memory = () => ({ read: async () => null, write: async () => {} });

/** Where a worktree's own root is, wherever the daemon of the day made it. */
const WORKTREE_ROOT = /^(\/home\/worktrees\/repo\/[^/]+|\/repo\/\.agents\/worktree\/[^/]+)/;

async function setup(stored: MetaFile = { sessions: {} }) {
  const harness = new FakeHarness();
  const timers = manualSchedule();
  const settings: Settings = {
    model: null,
    effort: null,
    modes: {},
    worktree: false,
    projects: [],
  };
  harness.execResults = {
    "rev-parse --path-format=absolute --git-common-dir": { exitCode: 0, stdout: "/repo/.git\n" },
    "rev-parse --verify HEAD^{commit}": { exitCode: 0, stdout: "abc123\n" },
    "for-each-ref --format=%(refname) --sort=-committerdate refs/heads refs/remotes": {
      exitCode: 0,
      stdout: "refs/heads/main\nrefs/heads/feature\n",
    },
    "test -e /repo/.agents/worktree/feature-2": { exitCode: 1, stdout: "" },
  };
  // The fake answers for every folder alike: a worktree's folder is a checkout of its own.
  const git = new Git(async (argv, options): Promise<ExecResult> => {
    if (argv.slice(4).join(" ") === "rev-parse --show-toplevel") {
      const root = WORKTREE_ROOT.exec(options.cwd ?? "")?.[1] ?? "/repo";
      return { exitCode: 0, stdout: `${root}\n`, stderr: "" };
    }
    return harness.exec(argv, options);
  });
  const meta = await JsonStore.open<MetaFile>(memory(), stored, timers.schedule);
  const usageFile = await JsonStore.open<UsageFile>(memory(), { days: {} }, timers.schedule);
  const hub = new SessionHub({
    harness: harness.asAgents(),
    meta,
    settings: () => settings,
    usage: new UsageLedger(usageFile, () => 0),
    git,
    legacyWorktrees: "/home/worktrees",
    schedule: timers.schedule,
    now: () => 1000,
    log: () => {},
    viewers: () => 0,
    publish: { frame: () => {}, sessions: () => {}, removed: () => {}, usage: () => {} },
  });
  const removals = () => harness.calls.filter((call) => call.startsWith("git worktree remove"));
  return { harness, hub, meta, removals };
}

const worktreeAt = { cwd: "/repo", worktree: { branch: "feature" } };

test("a worktree session starts in the worktree's folder, inside the project's subfolder", async () => {
  const { hub, meta } = await setup();
  const info = await hub.create({ cwd: "/repo/packages/app", worktree: { branch: "feature" } });
  expect(info.cwd).toMatch(/\/feature-2\/packages\/app$/);
  expect(info.worktree).toMatchObject({ repo: "/repo", base: "abc123", branch: "feature-2" });
  expect(info.branch).toBe("feature-2");
  expect(meta.value.sessions[info.id]?.worktree).toEqual(info.worktree ?? undefined);
});

test("an agent that cannot start leaves no worktree: its folder is removed, its branch kept", async () => {
  const { harness, hub, removals } = await setup();
  harness.createSession = async () => {
    throw new Error("no agent");
  };
  await expect(hub.create(worktreeAt)).rejects.toThrow("no agent");
  const added = harness.calls.find((call) => call.startsWith("git worktree add"));
  const folder = added?.split(" ").at(-2);
  expect(removals()).toEqual([`git worktree remove --force ${folder}`]);
  expect(harness.calls.some((call) => call.startsWith("git branch"))).toBe(false);
});

test("deleting a session removes its worktree's folder when asked, and never its branch", async () => {
  const { harness, hub, removals } = await setup();
  const info = await hub.create(worktreeAt);
  await hub.remove(info.id, true);
  expect(removals()).toEqual([`git worktree remove --force ${info.cwd}`]);
  expect(harness.calls.some((call) => call.startsWith("git branch"))).toBe(false);
  const kept = await hub.create(worktreeAt);
  await hub.remove(kept.id, false);
  expect(removals()).toHaveLength(1);
});

test("a fork keeps its source's worktree, and its record says so", async () => {
  const { hub, meta } = await setup();
  const source = await hub.create(worktreeAt);
  const fork = await hub.fork(source.id, null);
  expect(fork.worktree).toEqual(source.worktree);
  expect(meta.value.sessions[fork.id]?.worktree).toEqual(source.worktree ?? undefined);
});

test("a worktree an older daemon recorded still shows on the session, with its branch", async () => {
  const folder = "/home/worktrees/repo/feat";
  const worktree = { repo: "/repo", base: "abc123", branch: "feat" };
  const { harness, hub } = await setup({ sessions: { old: { worktree } } });
  harness.stored = [harness.session("old", { cwd: `${folder}/sub`, branch: "other" })];
  const [info] = await hub.list(false);
  expect(info?.worktree).toMatchObject(worktree);
  expect(info?.branch).toBe("feat");
  expect(info?.cwd).toBe(`${folder}/sub`);
});

test("a worktree without a path or an origin is read as the owner's, at the root its folder shows", async () => {
  const worktree = { repo: "/repo", base: "abc123", branch: "feat" };
  const { harness, hub, removals } = await setup({ sessions: { old: { worktree } } });
  harness.stored = [harness.session("old", { cwd: "/home/worktrees/repo/feat/sub" })];
  const [info] = await hub.list(false);
  expect(info?.worktree).toEqual({
    ...worktree,
    path: "/home/worktrees/repo/feat",
    origin: "owner",
  });
  await hub.remove("old", true);
  expect(removals()).toEqual(["git worktree remove --force /home/worktrees/repo/feat"]);
});

test("a worktree with no path, outside the older place, is rooted at the session's folder", async () => {
  const worktree = { repo: "/repo", base: "abc123", branch: "feat" };
  const { harness, hub } = await setup({ sessions: { odd: { worktree } } });
  harness.stored = [harness.session("odd", { cwd: "/elsewhere/feat" })];
  const [info] = await hub.list(false);
  expect(info?.worktree).toMatchObject({ path: "/elsewhere/feat", origin: "owner" });
});

test("a stored path and origin are kept, and a new worktree stores both", async () => {
  const stored = {
    repo: "/repo",
    base: "b",
    branch: "x",
    path: "/repo/.agents/worktree/x",
    origin: "agent",
  } as const;
  const { harness, hub, meta } = await setup({ sessions: { kept: { worktree: stored } } });
  harness.stored = [harness.session("kept", { cwd: "/repo/.agents/worktree/x" })];
  const [info] = await hub.list(false);
  expect(info?.worktree).toEqual(stored);
  const made = await hub.create(worktreeAt);
  expect(made.worktree).toMatchObject({ origin: "owner" });
  expect(meta.value.sessions[made.id]?.worktree).toEqual({
    repo: "/repo",
    base: "abc123",
    branch: "feature-2",
    path: made.cwd,
    origin: "owner",
  });
});
