import type { ExecResult } from "@cycle/protocol";
import { Git, type Exec } from "../src/git.ts";

export const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
export const missing: ExecResult = { exitCode: 1, stdout: "", stderr: "" };

/** The words of a command after the four a git run starts with. */
export const keyOf = (argv: string[]) => (argv[0] === "git" ? argv.slice(4) : argv).join(" ");

/** What the folders are: a checkout's root and git common dir by folder, else the repository `/repo`. */
export interface World {
  roots?: Record<string, string>;
  commons?: Record<string, string>;
  branches?: string[];
  /** Paths that exist already, and the ones a worktree was added at. */
  existing?: Set<string>;
  /** Folders inside a bare repository: no checkout, so no toplevel. */
  bare?: Set<string>;
  /** A git older than 2.31, which does not know `--path-format`. */
  old?: boolean;
}

/** What one repository says to the commands a worktree is made with. */
export function answer(key: string, cwd: string, world: World = {}): ExecResult {
  const bare = world.bare?.has(cwd) ?? false;
  if (key === "rev-parse --is-bare-repository") return ok(`${bare}\n`);
  if (key === "rev-parse --show-toplevel") {
    return bare
      ? { exitCode: 128, stdout: "", stderr: "fatal: this operation must be run in a work tree\n" }
      : ok(`${world.roots?.[cwd] ?? "/repo"}\n`);
  }
  if (key === "rev-parse --path-format=absolute --git-common-dir") {
    if (world.old) return { exitCode: 129, stdout: "", stderr: "usage: git rev-parse\n" };
    return ok(`${world.commons?.[cwd] ?? "/repo/.git"}\n`);
  }
  if (key === "rev-parse --verify HEAD^{commit}") return ok("abc123\n");
  if (key.startsWith("for-each-ref")) {
    return ok((world.branches ?? ["main"]).map((name) => `refs/heads/${name}\n`).join(""));
  }
  if (key.startsWith("test -e ")) return world.existing?.has(key.slice(8)) ? ok("") : missing;
  return ok("");
}

/**
 * A git that answers for the world and holds each `worktree add` until the test lets it go, so
 * what runs one after the other can be told from what runs together.
 */
export function heldGit(world: World = {}) {
  const runs: { key: string; cwd: string }[] = [];
  const releases: (() => void)[] = [];
  const existing = world.existing ?? new Set<string>();
  const exec: Exec = async (argv, execOptions) => {
    const key = keyOf(argv);
    const cwd = execOptions.cwd ?? "";
    runs.push({ key, cwd });
    if (key.startsWith("worktree add")) {
      await new Promise<void>((resolve) => releases.push(resolve));
      existing.add(key.split(" ").at(-2) ?? "");
    }
    return answer(key, cwd, { ...world, existing });
  };
  const adds = () => runs.filter((run) => run.key.startsWith("worktree add")).map((r) => r.key);
  return { git: new Git(exec), runs, releases, adds };
}

/** Lets what is waiting on already-settled promises run, with no timer. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 50; turn++) await Promise.resolve();
}
