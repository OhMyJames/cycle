import type { ExecResult, Settings } from "@cycle/protocol";
import { Git, JsonStore, type MetaFile, SessionHub, UsageLedger } from "../src/index.ts";
import type { UsageFile } from "../src/index.ts";
import { FakeHarness, manualSchedule } from "./fake-harness.ts";

export const memory = () => ({ read: async () => null, write: async () => {} });

/** Where a worktree's own root is, wherever the daemon of the day made it. */
export const WORKTREE_ROOT = /^(\/home\/worktrees\/repo\/[^/]+|\/repo\/\.agents\/worktree\/[^/]+)/;

export async function setup(stored: MetaFile = { sessions: {} }) {
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
  const gone: string[] = [];
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
    publish: {
      frame: () => {},
      sessions: () => {},
      removed: (ids) => gone.push(...ids),
      usage: () => {},
    },
  });
  const removals = () => harness.calls.filter((call) => call.startsWith("git worktree remove"));
  return { harness, hub, meta, removals, gone };
}

export const worktreeAt = { cwd: "/repo", worktree: { branch: "feature" } };
