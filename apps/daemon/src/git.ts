import type { ExecOptions, ExecResult, GitFile, GitStatus, WorktreeInfo } from "@cycle/protocol";

/** How git is run: through the harness, on the machine the agent works on. */
export type Exec = (argv: string[], options: ExecOptions) => Promise<ExecResult>;

/** The tree of a repository with no commit yet, to diff a first commit against. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_FILES = 3000;
const MAX_PATCH = 1024 * 1024;
const MAX_COUNTED = 40;
/** Where a repository's worktrees are, relative to its main checkout. */
const WORKTREES = ".agents/worktree";
const GIT = ["git", "--no-optional-locks", "-c", "core.quotepath=false"];

export class GitError extends Error {}

/** Parses `git diff --numstat -z`: counts per path, with a rename's two paths. */
export function parseNumstat(
  out: string,
): Map<string, { additions: number; deletions: number; binary: boolean; oldPath: string | null }> {
  const result = new Map<
    string,
    { additions: number; deletions: number; binary: boolean; oldPath: string | null }
  >();
  const parts = out.split("\0");
  for (let index = 0; index < parts.length; index++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[index] ?? "");
    if (!match) continue;
    const [, added = "0", deleted = "0", path = ""] = match;
    const counts = {
      additions: added === "-" ? 0 : Number(added),
      deletions: deleted === "-" ? 0 : Number(deleted),
      binary: added === "-",
    };
    if (path) {
      result.set(path, { ...counts, oldPath: null });
    } else {
      // A rename leaves the path empty and gives the old and new names next.
      const oldPath = parts[index + 1] ?? "";
      const newPath = parts[index + 2] ?? "";
      index += 2;
      result.set(newPath, { ...counts, oldPath });
    }
  }
  return result;
}

/** Parses `git diff --name-status -z`: the kind of change per path. */
export function parseNameStatus(out: string): Map<string, GitFile["status"]> {
  const result = new Map<string, GitFile["status"]>();
  const parts = out.split("\0");
  for (let index = 0; index < parts.length; index++) {
    const code = parts[index] ?? "";
    if (!code) continue;
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      result.set(parts[index + 2] ?? "", letter === "R" ? "R" : "A");
      index += 2;
    } else {
      result.set(parts[index + 1] ?? "", letter === "A" ? "A" : letter === "D" ? "D" : "M");
      index += 1;
    }
  }
  return result;
}

export function parseBranches(out: string): { local: string[]; remote: string[] } {
  const local: string[] = [];
  const remote: string[] = [];
  for (const ref of out.split("\n")) {
    if (ref.startsWith("refs/heads/")) local.push(ref.slice("refs/heads/".length));
    else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD")) {
      remote.push(ref.slice("refs/remotes/".length));
    }
  }
  return { local, remote };
}

/** A branch name as a folder name. */
export function branchSlug(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";
}

export function defaultBranchName(now: number): string {
  const iso = new Date(now).toISOString();
  return `cycle/${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
}

/** Reads and changes checkouts for sessions. Every command is one `git` run. */
export class Git {
  private readonly exec: Exec;
  /** The tail of each repository's worktree changes, by its git common dir. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(exec: Exec) {
    this.exec = exec;
  }

  private async run(cwd: string, args: string[], timeoutMs = 30_000): Promise<ExecResult> {
    return this.exec([...GIT, ...args], { cwd, timeoutMs });
  }

  private async out(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
    const result = await this.run(cwd, args, timeoutMs);
    if (result.exitCode !== 0) {
      throw new GitError(result.stderr.trim() || `git ${args[0]} failed (${result.exitCode})`);
    }
    return result.stdout;
  }

  /** The checkout's root, or null when the folder is in no repository. */
  async root(cwd: string): Promise<string | null> {
    try {
      const result = await this.run(cwd, ["rev-parse", "--show-toplevel"], 5_000);
      return result.exitCode === 0 ? result.stdout.trim() : null;
    } catch {
      return null;
    }
  }

  private async head(cwd: string): Promise<{ branch: string | null; commit: string | null }> {
    const [branch, commit] = await Promise.all([
      this.run(cwd, ["symbolic-ref", "--short", "-q", "HEAD"], 5_000),
      this.run(cwd, ["rev-parse", "-q", "--verify", "HEAD"], 5_000),
    ]);
    return {
      branch: branch.exitCode === 0 ? branch.stdout.trim() : null,
      commit: commit.exitCode === 0 ? commit.stdout.trim() : null,
    };
  }

  /**
   * What the checkout changed: against where `base` and HEAD parted when a
   * base is given, which is a worktree's whole work, else against HEAD.
   */
  async status(cwd: string, base?: string): Promise<GitStatus> {
    const root = await this.root(cwd);
    if (!root) return { repo: null, files: [], truncated: false };
    const head = await this.head(root);
    let from = head.commit ?? EMPTY_TREE;
    if (base && head.commit) {
      const merge = await this.run(root, ["merge-base", base, "HEAD"], 5_000);
      if (merge.exitCode === 0) from = merge.stdout.trim();
    }
    const diff = ["diff", "--no-ext-diff", "--no-textconv", "-M", "-z"];
    const [numstat, names, untracked] = await Promise.all([
      this.out(root, [...diff, "--numstat", from]),
      this.out(root, [...diff, "--name-status", from]),
      this.out(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    const counts = parseNumstat(numstat);
    const files: GitFile[] = [];
    for (const [path, status] of parseNameStatus(names)) {
      const count = counts.get(path);
      files.push({
        path,
        oldPath: count?.oldPath ?? null,
        status,
        additions: count?.additions ?? 0,
        deletions: count?.deletions ?? 0,
        binary: count?.binary ?? false,
      });
    }
    const fresh = untracked.split("\0").filter(Boolean);
    // A new file's lines are counted too, for the first few: each costs a run.
    const counted = await Promise.all(
      fresh.slice(0, MAX_COUNTED).map((path) =>
        this.run(root, ["diff", "--no-index", "--numstat", "-z", "--", "/dev/null", path]).then(
          (result) => /^(-|\d+)\t/.exec(result.stdout)?.[1],
          () => undefined,
        ),
      ),
    );
    fresh.forEach((path, index) => {
      const added = counted[index];
      files.push({
        path,
        oldPath: null,
        status: "U",
        additions: added && added !== "-" ? Number(added) : 0,
        deletions: 0,
        binary: added === "-",
      });
    });
    files.sort((a, b) => a.path.localeCompare(b.path));
    return {
      repo: { root, branch: head.branch, head: head.commit, from },
      files: files.slice(0, MAX_FILES),
      truncated: files.length > MAX_FILES,
    };
  }

  async diff(
    cwd: string,
    from: string,
    path: string,
    status: GitFile["status"],
  ): Promise<{ patch: string; truncated: boolean }> {
    const root = (await this.root(cwd)) ?? cwd;
    const args =
      status === "U"
        ? ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", path]
        : ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", from, "--", path];
    // Comparing against no index exits 1 when the files differ, which they do.
    const result = await this.run(root, args);
    if (result.exitCode > 1) throw new GitError(result.stderr.trim() || "git diff failed");
    const patch = result.stdout;
    return patch.length > MAX_PATCH
      ? { patch: patch.slice(0, MAX_PATCH), truncated: true }
      : { patch, truncated: false };
  }

  async branches(
    cwd: string,
  ): Promise<{ current: string | null; local: string[]; remote: string[] }> {
    const [refs, head] = await Promise.all([
      this.out(cwd, [
        "for-each-ref",
        "--format=%(refname)",
        "--sort=-committerdate",
        "refs/heads",
        "refs/remotes",
      ]),
      this.head(cwd),
    ]);
    return { current: head.branch, ...parseBranches(refs) };
  }

  async checkout(cwd: string, branch: string): Promise<void> {
    await this.out(cwd, ["switch", "--no-guess", branch], 120_000);
  }

  /** Commits everything the checkout changed, and answers with the new commit. */
  async commit(cwd: string, message: string): Promise<string> {
    await this.out(cwd, ["add", "-A"], 120_000);
    await this.out(cwd, ["commit", "-m", message], 120_000);
    return (await this.out(cwd, ["rev-parse", "--short", "HEAD"])).trim();
  }

  /** The repository's git common dir, which every checkout and worktree of it shares. */
  private async commonDir(cwd: string): Promise<string | null> {
    try {
      const result = await this.run(
        cwd,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        5_000,
      );
      return result.exitCode === 0 ? result.stdout.trim() || null : null;
    } catch {
      return null;
    }
  }

  /** Whether the folder is in a bare repository, which has no checkout to put a worktree in. */
  private async isBare(cwd: string): Promise<boolean> {
    try {
      const result = await this.run(cwd, ["rev-parse", "--is-bare-repository"], 5_000);
      return result.exitCode === 0 && result.stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  /** Runs `work` after the repository's earlier worktree changes, and lets the next one follow it. */
  private locked<T>(common: string, work: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(common) ?? Promise.resolve()).then(work);
    const tail = run.then(
      () => {},
      () => {},
    );
    this.locks.set(common, tail);
    void tail.then(() => {
      if (this.locks.get(common) === tail) this.locks.delete(common);
    });
    return run;
  }

  /**
   * Makes a worktree of `cwd`'s repository at `<main checkout>/.agents/worktree/<name>`, on a new
   * branch from `base` (HEAD when not given). The main checkout is the repository's own, even when
   * `cwd` is in another worktree of it. Answers with the folder a session should start in: the
   * same place inside the worktree as `cwd` was.
   */
  async addWorktree(options: {
    cwd: string;
    branch: string;
    base?: string;
  }): Promise<{ cwd: string; worktree: Omit<WorktreeInfo, "origin"> }> {
    const root = await this.root(options.cwd);
    if (!root) {
      throw new GitError(
        (await this.isBare(options.cwd))
          ? "A worktree needs a git checkout."
          : "A worktree needs a git repository.",
      );
    }
    // An ordinary repository's common dir is `<main checkout>/.git`. A submodule's or a
    // `--separate-git-dir` one's is elsewhere, and so is the answer of a git older than 2.31 (it
    // does not know `--path-format`): the folder's own root is the checkout then.
    const common = await this.commonDir(root);
    const main = common?.endsWith("/.git") ? common.slice(0, -"/.git".length) : root;
    return this.locked(common ?? root, async () => {
      const baseRef = options.base ?? "HEAD";
      const base = (await this.out(root, ["rev-parse", "--verify", `${baseRef}^{commit}`])).trim();
      const taken = new Set((await this.branches(root)).local);
      let branch = options.branch;
      for (let suffix = 2; taken.has(branch); suffix++) branch = `${options.branch}-${suffix}`;
      const folder = `${main}/${WORKTREES}`;
      const slug = branchSlug(branch);
      let name = slug;
      for (let suffix = 2; await this.exists(main, `${folder}/${name}`); suffix++) {
        name = `${slug}-${suffix}`;
      }
      await this.ignoreItself(main, folder);
      const path = `${folder}/${name}`;
      try {
        await this.out(root, ["worktree", "add", "--no-track", "-b", branch, path, base], 120_000);
      } catch (error) {
        // Nothing was at the path before: whatever the failed add left registered goes.
        await this.run(root, ["worktree", "remove", "--force", path]).catch(() => {});
        throw error;
      }
      const inside = options.cwd.startsWith(`${root}/`) ? options.cwd.slice(root.length) : "";
      return { cwd: `${path}${inside}`, worktree: { repo: main, base, branch, path } };
    });
  }

  /** Removes a worktree's folder. Its branch is kept, with whatever it committed. */
  async removeWorktree(repo: string, path: string): Promise<void> {
    const common = (await this.commonDir(repo)) ?? repo;
    await this.locked(common, async () => {
      const root = (await this.root(path)) ?? path;
      await this.out(repo, ["worktree", "remove", "--force", root], 120_000);
    });
  }

  /** Whether a path exists, asked of the machine the repository is on. */
  private async exists(cwd: string, path: string): Promise<boolean> {
    return (await this.exec(["test", "-e", path], { cwd, timeoutMs: 5_000 })).exitCode === 0;
  }

  /**
   * Makes the worktrees' folder, with a `.gitignore` of its own holding `*`, unless one is there: the
   * folder ignores itself and everything in it, and nothing outside it changes. It is a command on
   * the repository's machine, since the daemon reaches the project only through the harness.
   */
  private async ignoreItself(cwd: string, folder: string): Promise<void> {
    // A dangling symlink named `.gitignore` is a file there too: `printf >` would write through it.
    const script =
      'f="$1/.gitignore"; mkdir -p "$1" && { [ -e "$f" ] || [ -L "$f" ] || printf "*\\n" > "$f"; }';
    const result = await this.exec(["sh", "-c", script, "sh", folder], { cwd, timeoutMs: 5_000 });
    if (result.exitCode !== 0) {
      throw new GitError(result.stderr.trim() || "The worktrees' folder could not be made.");
    }
  }
}
