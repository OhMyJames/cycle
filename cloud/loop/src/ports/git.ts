// The workspace over `git` and `bun` (CYC-477). Arguments, environments and working directories are what the loop
// used before: `GIT_SAFE` on every git, `verifyEnv` for everything but the commands that talk to the remote.
import { deliverEnv, GIT_SAFE, verifyEnv } from "../env.ts";
import { withRepoLock } from "../git-lock.ts";
import type { Exec } from "../types.ts";
import type { At } from "./forge.ts";
import type { Workspace } from "./workspace.ts";

const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");

export const gitWorkspace = (deps: {
  exec: Exec;
  env: Record<string, string | undefined>;
  /** The main checkout, where worktrees are made and fetches are serialised. */
  repoRoot: string;
  remote: string;
}): Workspace => {
  const { exec, env, repoRoot, remote } = deps;
  const git = (at: At, args: string[]) =>
    exec(["git", ...GIT_SAFE, ...args], {
      cwd: at.cwd,
      env: verifyEnv(env),
      timeoutMs: at.timeoutMs,
    });
  const gitDeliver = (at: At, args: string[]) =>
    exec(["git", ...GIT_SAFE, ...args], {
      cwd: at.cwd,
      env: deliverEnv(env),
      timeoutMs: at.timeoutMs,
    });
  const done = (r: { code: number; output: string }) =>
    r.code === 0 ? ({ ok: true } as const) : ({ ok: false, error: r.output } as const);
  const mergeHead = async (at: At) =>
    (await git(at, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code === 0;
  const freeKb: Workspace["freeKb"] = async (at) => {
    try {
      const out = await exec(["df", "-kP", at.cwd], {
        cwd: at.cwd,
        env: verifyEnv(env),
        timeoutMs: 10_000,
      });
      if (out.code !== 0) return undefined;
      // POSIX format: the Capacity column ("12%") sits right after Available, so anchor on it; a device name or
      // mount point with spaces cannot shift it. The header must name the column.
      const rows = out.output.trim().split("\n");
      if (rows.length !== 2 || !/avail/i.test(rows[0] ?? "")) return undefined;
      const row = (rows[1] ?? "").trim().split(/\s+/);
      const cap = row.findIndex((t) => /^\d+%$/.test(t));
      const field = cap > 0 ? (row[cap - 1] ?? "") : "";
      const free = /^\d+$/.test(field) ? Number(field) : Number.NaN;
      return Number.isSafeInteger(free) ? free : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    fetchMain: (at) => withRepoLock(repoRoot, () => gitDeliver(at, ["fetch", remote])),
    push: (at, branch) => gitDeliver(at, ["push", remote, `HEAD:refs/heads/${branch}`]),
    async head(at) {
      const r = await git(at, ["rev-parse", "HEAD"]);
      return r.code === 0 ? { ok: true, sha: r.output.trim() } : { ok: false, error: r.output };
    },
    async diff(at, base) {
      return (await git(at, ["diff", `${base}...HEAD`])).output;
    },
    async changedFiles(at, base) {
      const r = await git(at, ["diff", "--name-only", `${base}...HEAD`]);
      return r.output.split("\n").filter((line) => line.trim() !== "");
    },
    async log(at, base) {
      return (await git(at, ["log", "--oneline", `${base}..HEAD`])).output;
    },
    async commitSubjects(at, base) {
      return (await git(at, ["log", "--reverse", "--no-merges", "--format=%s", `${base}..HEAD`]))
        .output;
    },
    async snapshot(at) {
      const head = await git(at, ["rev-parse", "HEAD"]);
      const status = await git(at, ["status", "--porcelain"]);
      return `${head.output.trim()}\n${status.output}`;
    },
    async status(at) {
      const r = await git(at, ["status", "--porcelain"]);
      return r.code === 0 ? { ok: true, porcelain: r.output } : { ok: false, error: r.output };
    },
    async checkpoint(at, message) {
      const dirty = await git(at, ["status", "--porcelain"]);
      if (dirty.output.trim() === "") return;
      await git(at, ["add", "-A"]);
      await git(at, ["commit", "-m", message]);
    },
    mergeInProgress: mergeHead,
    async mergeMain(at, base) {
      return done(await git(at, ["merge", "--no-edit", base]));
    },
    async abortMerge(at) {
      return done(await git(at, ["merge", "--abort"]));
    },
    async resetHard(at, sha) {
      return done(await git(at, ["reset", "--hard", sha]));
    },
    async isAncestor(at, ref) {
      return (await git(at, ["merge-base", "--is-ancestor", ref, "HEAD"])).code === 0;
    },
    async unmergedFiles(at) {
      return lines((await git(at, ["diff", "--name-only", "--diff-filter=U"])).output);
    },
    async theirCommits(at, preMergeSha, base, files) {
      return lines(
        (await git(at, ["log", "--format=%s", `${preMergeSha}..${base}`, "--", ...files])).output,
      );
    },
    async conflictMarkers(at, files) {
      // Anchored at the start of a line, with the files taken literally.
      const r = await git(at, [
        "--literal-pathspecs",
        "grep",
        "--no-index",
        "-l",
        "-E",
        "-e",
        `^(${"<".repeat(7)}|${">".repeat(7)})( |$)`,
        "--",
        ...files,
      ]);
      if (r.code === 0)
        return { kind: "found", files: r.output.split("\n").filter((l) => l.trim() !== "") };
      if (r.code === 1) return { kind: "clean" };
      return { kind: "error", output: r.output };
    },
    async stage(at, files) {
      await git(at, ["--literal-pathspecs", "add", "-A", "--", ...files]);
    },
    async commitMerge(at) {
      return done(await git(at, ["commit", "--no-edit"]));
    },
    async conflictProbe(at, base) {
      await withRepoLock(repoRoot, () => gitDeliver(at, ["fetch", remote]));
      const merged = await gitDeliver(at, [
        "merge-tree",
        "--write-tree",
        "--name-only",
        "--no-messages",
        "HEAD",
        base,
      ]);
      if (merged.code !== 1) return [];
      return lines(merged.output.split("\n").slice(1).join("\n"));
    },
    async install(at) {
      return done(
        await exec(["bun", "install"], {
          cwd: at.cwd,
          env: verifyEnv(env),
          timeoutMs: at.timeoutMs,
        }),
      );
    },
    async nodeModulesDirs(at) {
      const status = await git(at, ["status", "--porcelain"]);
      if (status.code !== 0) return { ok: false, reason: "status_failed" };
      if (status.output.trim() !== "") return { ok: false, reason: "dirty" };
      const listed = await git(at, [
        "ls-files",
        "-z",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
      ]);
      if (listed.code !== 0) return { ok: false, reason: "list_failed" };
      const dirs = listed.output
        .split("\0")
        .map((l) => l.trim().replace(/\/+$/, ""))
        .filter(
          (d) =>
            d !== "" &&
            !d.startsWith("/") &&
            !d.split("/").includes("..") &&
            d.split("/").at(-1) === "node_modules",
        );
      return { ok: true, dirs };
    },
    async releaseNodeModules(at, dirs) {
      return done(
        await exec(["rm", "-rf", "--", ...dirs], {
          cwd: at.cwd,
          env: verifyEnv(env),
          timeoutMs: at.timeoutMs,
        }),
      );
    },
    freeKb,
    async remove(at, worktree, branches) {
      const status = await git({ ...at, cwd: worktree }, ["status", "--porcelain"]);
      if (status.code !== 0) return "failed";
      if (status.output.trim() !== "") return "dirty";
      // No --force: git itself refuses a worktree with changes in it.
      const removed = await git(at, ["worktree", "remove", worktree]);
      if (removed.code !== 0) return "failed";
      for (const branch of branches) {
        const exists = await git(at, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
        if (exists.code !== 0) continue;
        const deleted = await git(at, ["branch", "-D", branch]);
        if (deleted.code !== 0) return "failed";
      }
      return "removed";
    },
    async configClean() {
      return { ok: true };
    },
  };
};
