import type { EventFrame, HarnessEvent, Session, Settings } from "@cycle/protocol";
import { Git, JsonStore, type MetaFile, SessionHub, UsageLedger } from "../src/index.ts";
import type { UsageFile } from "../src/index.ts";
import { FakeHarness, manualSchedule } from "./fake-harness.ts";
import { type World, answer, keyOf, ok } from "./held-git.ts";

const memory = () => ({ read: async () => null, write: async () => {} });

export interface EnterOptions {
  /** What the machine resolves a path to (`pwd -P`), by the path given. */
  real?: Record<string, string>;
  /** Hold each `worktree add`, or each resolution of paths, until the test lets it go. */
  hold?: "add" | "resolve";
  world?: World;
  /** What the daemon kept of sessions before the test began. */
  stored?: MetaFile;
}

/** The hub, with an agent that declares `worktree.enter`, over a machine that answers for one repository. */
export async function setup(options: EnterOptions = {}) {
  const harness = new FakeHarness("claude");
  harness.declaration = {
    ...harness.declaration,
    operations: [...harness.declaration.operations, "worktree.enter"],
  };
  const timers = manualSchedule();
  const frames: EventFrame[] = [];
  const told: Session[] = [];
  const runs: { key: string; cwd: string }[] = [];
  const existing = new Set<string>();
  const added = new Set<string>();
  const holds: { adds: (() => void)[]; resolves: (() => void)[] } = { adds: [], resolves: [] };
  const git = new Git(async (argv, execOptions) => {
    const key = keyOf(argv);
    const cwd = execOptions.cwd ?? "";
    runs.push({ key, cwd });
    if (argv[0] === "sh" && key.includes("pwd -P")) {
      if (options.hold === "resolve")
        await new Promise<void>((resolve) => holds.resolves.push(resolve));
      return ok(
        `${argv
          .slice(4)
          .map((path) => options.real?.[path] ?? "")
          .join("\n")}\n`,
      );
    }
    if (key.startsWith("worktree add")) {
      if (options.hold === "add") await new Promise<void>((resolve) => holds.adds.push(resolve));
      added.add(key);
      existing.add(key.split(" ").at(-2) ?? "");
    }
    return answer(key, cwd, { ...options.world, existing });
  });
  const settings: Settings = {
    model: null,
    effort: null,
    modes: {},
    worktree: false,
    projects: [],
  };
  const meta = await JsonStore.open<MetaFile>(
    memory(),
    options.stored ?? { sessions: {} },
    timers.schedule,
  );
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
      frame: (frame) => frames.push(frame),
      sessions: (list) => told.push(...list),
      removed: (ids) => gone.push(...ids),
      usage: () => {},
    },
  });
  /** What the session's thread says to its owner, as the notices it holds. */
  const notices = async (sessionId: string) => {
    const opened = await hub.open(sessionId, undefined);
    return "state" in opened ? opened.state.notices : [];
  };
  const removals = () => runs.filter((run) => run.key.startsWith("worktree remove"));
  return { harness, hub, meta, runs, told, gone, holds, added, notices, removals };
}

/** The folder a worktree of this name has: `cycle/x` is the folder `cycle-x`. */
export const folderOf = (name: string) => `/repo/.agents/worktree/cycle-${name}`;

/** An agent saying where it works now, as its harness does when Claude Code's `init` says so. */
export const where = (sessionId: string, workingDir: string): HarnessEvent => ({
  type: "session.changed",
  sessionId,
  patch: { workingDir },
});
