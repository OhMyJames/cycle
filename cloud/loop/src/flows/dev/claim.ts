import { Blocked, branchOf, tail } from "../../engine/flow.ts";
import type { Issue } from "../../types.ts";
import { type DevRun, type FlowHost, type Save, where } from "./context.ts";
import { freeKb, install, recordInstall } from "./node-modules.ts";

export async function claim(h: FlowHost, run: DevRun, issue: Issue, save: Save): Promise<void> {
  const { config, sessions } = h.d;
  let worktree = run.worktree ?? "";
  // Only a worktree made in this call gets a real install; on resume `bun install` is a no-op.
  const fresh = run.devSessionId === null;
  if (fresh) {
    // The loop fetches itself: whether the daemon may is undecided (docs/protocol.md, "待定").
    // Fetching needs the remote's credentials; no session has run in the main checkout, so this is safe to give them.
    const fetched = await h.netExec(run.key, "git fetch", () =>
      h.d.workspace.fetchMain(where(h, config.repoRoot)),
    );
    if (fetched.code !== 0) throw new Blocked(`git fetch 失败：${tail(fetched.output)}`);
    const created = await sessions.create({
      role: "dev",
      agent: config.devAgent,
      ...(config.devModel ? { model: config.devModel } : {}),
      ...(config.devEffort ? { effort: config.devEffort } : {}),
      title: `[${run.key}] Dev`,
      cwd: config.repoRoot,
      worktree: { base: config.baseRef, name: branchOf(issue.number) },
    });
    await save({
      devSessionId: created.sessionId,
      worktree: created.cwd,
      localBranch: created.branch,
    });
    worktree = created.cwd;
    await h.d.store.event(run.key, "dev_session", { new: true });
  }
  // A worktree made now has no node_modules.
  worktree = h.need(worktree === "" ? undefined : worktree);
  const before = fresh ? await freeKb(h, worktree) : undefined;
  await install(h, worktree);
  if (fresh) await recordInstall(h, run.key, worktree, before);
  await save({ phase: "dev", dev: { nodeModulesReleased: false } });
}
