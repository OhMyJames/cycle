import { Blocked, tail } from "../../engine/flow.ts";
import type { Dev } from "./context.ts";
import { type DevRun, type FlowHost, type Save, where } from "./context.ts";

/** Installs again when `node_modules` was released; an install that fails is Blocked. */
export async function restoreNodeModules(
  h: FlowHost,
  run: DevRun,
  worktree: string,
  save: Save,
): Promise<void> {
  if (!run.dev.nodeModulesReleased) return;
  await install(h, worktree);
  await save({ dev: { nodeModulesReleased: false } });
  await h.d.store.event(run.key, "node_modules_restored");
}

export async function install(h: FlowHost, worktree: string): Promise<void> {
  const installed = await h.d.workspace.install(where(h, worktree));
  if (!installed.ok) throw new Blocked(`bun install 失败：${tail(installed.error)}`);
}

/** `node_modules_kept`, once per run, CI round and reason: a wait that is entered again does not repeat it. */
export async function noteKept(x: Dev, run: DevRun, reason: string): Promise<void> {
  const h = x.h;
  const id = `${run.key}:${run.dev.ciRound}:${reason}`;
  if (x.kept.has(id)) return;
  x.kept.add(id);
  await h.d.store.event(run.key, "node_modules_kept", { reason, ciRound: run.dev.ciRound });
}

/**
 * CYC-450: while the run only waits for CI or the merge, the worktree's `node_modules` is not needed, so it is
 * deleted (when `releaseNodeModules` is on). Only git-ignored directories named `node_modules` go, and only when
 * the worktree has no uncommitted change. A failure to delete is not a failure of the run.
 */
export async function releaseNodeModules(
  x: Dev,
  run: DevRun,
  worktree: string,
  save: Save,
): Promise<void> {
  const h = x.h;
  const { config, store, workspace } = h.d;
  if (!config.releaseNodeModules || run.dev.nodeModulesReleased) return;
  const found = await workspace.nodeModulesDirs(where(h, worktree));
  if (!found.ok) {
    await noteKept(x, run, found.reason);
    return;
  }
  const dirs = found.dirs;
  if (dirs.length === 0) return;
  // Marked first: if rm stops halfway or the loop dies, the next Dev or verify installs again.
  await save({ dev: { nodeModulesReleased: true } });
  const removed = await workspace.releaseNodeModules(where(h, worktree), dirs);
  if (!removed.ok) {
    await store.event(run.key, "node_modules_release_failed", { reason: "rm_failed" });
    return;
  }
  await store.event(run.key, "node_modules_released", { dirs: dirs.length });
}

/** Free space of the volume holding `dir`, in 1 KiB blocks (`df -k`); undefined when it cannot be read. */
export async function freeKb(h: FlowHost, dir: string): Promise<number | undefined> {
  return h.d.workspace.freeKb(where(h, dir));
}

/** CYC-448: the volume's free-space drop across `bun install`. Numbers only; a failure never blocks the run. */
export async function recordInstall(
  h: FlowHost,
  run: string,
  dir: string,
  before: number | undefined,
): Promise<void> {
  try {
    const after = before === undefined ? undefined : await freeKb(h, dir);
    // A negative drop means something else freed space meanwhile: not a usable sample.
    if (before === undefined || after === undefined || before < after) {
      await h.d.store.event(run, "install_measured", { measured: false });
      return;
    }
    await h.d.store.event(run, "install_measured", {
      measured: true,
      freeKbBefore: before,
      freeKbAfter: after,
      usedKb: before - after,
    });
  } catch {
    // Measuring is advisory.
  }
}
