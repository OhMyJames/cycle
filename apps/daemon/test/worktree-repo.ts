import type { SessionActivity } from "@cycle/protocol";
import { Git, parseWorktrees } from "../src/git.ts";
import { Worktrees } from "../src/worktrees.ts";
import type { WorktreeUser } from "../src/sessions.ts";
import { keyOf, missing, ok } from "./held-git.ts";

export const LEGACY = "/home/worktrees";
export const MAIN = "/repo";
export const MADE = `${MAIN}/.agents/worktree`;

/** A record of `git worktree list --porcelain`. */
export function record(
  path: string,
  options: { branch?: string; locked?: string | true; bare?: boolean } = {},
): string {
  const lines = [`worktree ${path}`];
  if (options.bare) lines.push("bare");
  else
    lines.push("HEAD abc1234", options.branch ? `branch refs/heads/${options.branch}` : "detached");
  if (options.locked) lines.push(options.locked === true ? "locked" : `locked ${options.locked}`);
  return `${lines.join("\n")}\n`;
}

export const listing = (...records: string[]) => records.join("\n");

/** A session that uses a worktree, as the hub tells it. */
export function user(id: string, patch: Partial<WorktreeUser> = {}): WorktreeUser {
  return {
    id,
    name: id,
    title: null,
    preview: "",
    activity: "idle" as SessionActivity,
    named: true,
    archived: false,
    base: "abc123",
    origin: "owner",
    ...patch,
  };
}

export interface RepoOptions {
  /** What `git worktree list --porcelain` prints, now. Changed by a test to change the answer. */
  porcelain: string;
  /** Worktrees whose folder is gone. */
  gone?: string[];
  /** Worktrees whose `.git` file is gone: git takes them for part of the checkout above. */
  broken?: string[];
  /** What `git status --porcelain` prints in a folder. */
  status?: Record<string, string>;
  /** The sessions that use a path, now. */
  users?: Record<string, WorktreeUser[]>;
  /** Called as each command is asked, to change the repository between one and the next. */
  onRun?: (key: string) => void;
}

/** A repository at `/repo` answering git, with each command it was asked kept. */
export function repo(options: RepoOptions) {
  const runs: { key: string; cwd: string }[] = [];
  const releases: (() => void)[] = [];
  let hold = false;
  /** A checkout's root: its own folder, unless its `.git` is gone and the checkout above is meant. */
  const toplevel = (cwd: string) => {
    const paths = parseWorktrees(options.porcelain).map((one) => one.path);
    if (paths.includes(cwd) && !options.broken?.includes(cwd)) return cwd;
    const above = paths.filter((path) => cwd.startsWith(`${path}/`) || path === cwd);
    return above.filter((path) => path !== cwd).toSorted((a, b) => b.length - a.length)[0] ?? cwd;
  };
  const exec = async (argv: string[], execOptions: { cwd?: string }) => {
    const key = keyOf(argv);
    const cwd = execOptions.cwd ?? "";
    runs.push({ key, cwd });
    options.onRun?.(key);
    if (key === "worktree list --porcelain") return ok(options.porcelain);
    if (key === "status --porcelain") {
      return options.gone?.includes(cwd) ? missing : ok(options.status?.[cwd] ?? "");
    }
    if (key.startsWith("test -e ")) return options.gone?.includes(key.slice(8)) ? missing : ok("");
    if (key === "rev-parse --path-format=absolute --git-common-dir") return ok(`${MAIN}/.git\n`);
    if (key === "rev-parse --show-toplevel") {
      return options.gone?.includes(cwd) ? missing : ok(`${toplevel(cwd)}\n`);
    }
    if (key.startsWith("worktree remove") && hold) {
      await new Promise<void>((resolve) => releases.push(resolve));
    }
    return ok("");
  };
  const git = new Git(exec);
  const worktrees = new Worktrees({
    git,
    users: (path) => options.users?.[path] ?? [],
    legacyWorktrees: LEGACY,
  });
  return {
    worktrees,
    runs,
    releases,
    options,
    holdRemovals: () => {
      hold = true;
    },
    removals: () => runs.filter((run) => run.key.startsWith("worktree remove")),
  };
}
