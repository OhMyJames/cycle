import { expect, test } from "bun:test";
import type { EventFrame, ExecResult, HarnessEvent, Session, Settings } from "@cycle/protocol";
import { Git, JsonStore, type MetaFile, SessionHub, UsageLedger } from "../src/index.ts";
import type { UsageFile } from "../src/index.ts";
import { FakeHarness, manualSchedule } from "./fake-harness.ts";

// What stays true of a session's folder when its agent says where it is, as the harness does when
// Claude Code enters a worktree: the daemon reads none of it yet.

const memory = () => ({ read: async () => null, write: async () => {} });

/** Where a worktree's own root is. */
const WORKTREE_ROOT = /^(\/repo\/\.agents\/worktree\/[^/]+)/;

async function setup() {
  const harness = new FakeHarness();
  const timers = manualSchedule();
  const infos: Session[] = [];
  const frames: EventFrame[] = [];
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
  const git = new Git(async (argv, options): Promise<ExecResult> => {
    if (argv.slice(4).join(" ") === "rev-parse --show-toplevel") {
      const root = WORKTREE_ROOT.exec(options.cwd ?? "")?.[1] ?? "/repo";
      return { exitCode: 0, stdout: `${root}\n`, stderr: "" };
    }
    return harness.exec(argv, options);
  });
  const meta = await JsonStore.open<MetaFile>(memory(), { sessions: {} }, timers.schedule);
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
    publish: {
      frame: (frame) => frames.push(frame),
      sessions: (list) => infos.push(...list),
      removed: () => {},
      usage: () => {},
    },
  });
  return { harness, hub, meta, infos };
}

/** An agent saying where it works now, as its harness does when Claude Code's `init` says so. */
const at = (sessionId: string, workingDir: string): HarnessEvent => ({
  type: "session.changed",
  sessionId,
  patch: { workingDir },
});

test("an agent saying where it works leaves the session's worktree and folder as they are", async () => {
  const { harness, hub, meta, infos } = await setup();
  const info = await hub.create({ cwd: "/repo", worktree: { branch: "feature" } });
  const before = { cwd: info.cwd, worktree: info.worktree, meta: meta.value.sessions[info.id] };
  infos.length = 0;
  harness.emit(at(info.id, "/repo"));
  harness.emit(at(info.id, "/repo/.agents/worktree/elsewhere"));
  expect(hub.info(info.id)).toMatchObject({ cwd: before.cwd, worktree: before.worktree });
  expect(hub.info(info.id)).not.toHaveProperty("workingDir");
  expect(meta.value.sessions[info.id]).toEqual(before.meta);
  // What the page is told is the session as it was: only the patch's title is read.
  for (const told of infos) {
    expect(told).not.toHaveProperty("workingDir");
    expect(told).toMatchObject({ cwd: before.cwd, worktree: before.worktree });
  }
});

test("a session made in a worktree of a subfolder project works in the subfolder, below the worktree's root", async () => {
  const { hub } = await setup();
  const info = await hub.create({ cwd: "/repo/pkg", worktree: { branch: "feature" } });
  expect(info.worktree).toMatchObject({
    path: "/repo/.agents/worktree/feature-2",
    origin: "owner",
  });
  // `worktree.path` is the root: the folder a panel reads is `cwd`, not `path`.
  expect(info.cwd).toBe("/repo/.agents/worktree/feature-2/pkg");
});

test("a session running in a folder keeps that folder busy, and idle it does not", async () => {
  const { harness, hub } = await setup();
  const info = await hub.create({ cwd: "/project" });
  expect(hub.busyIn("/project")).toBe(false);
  harness.emit({ type: "turn.started", sessionId: info.id, turnId: "t1", startedAt: null });
  expect(hub.busyIn("/project")).toBe(true);
  expect(hub.busyIn("/project/.agents/worktree/x")).toBe(false);
});
