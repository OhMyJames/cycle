import { Blocked, NetworkWait, tail } from "../../engine/flow.ts";
import { isNetworkError } from "../../network.ts";
import { waitForCi } from "../../pr.ts";
import { handleConflict } from "./conflict.ts";
import type { Dev } from "./context.ts";
import { type DevRun, type Save, where } from "./context.ts";
import { assertNotClosed } from "./guard.ts";
import { releaseNodeModules } from "./node-modules.ts";

export async function ci(x: Dev, run: DevRun, save: Save): Promise<void> {
  const h = x.h;
  const { config, store, clock } = h.d;
  const worktree = h.need(run.worktree ?? undefined);
  const prUrl = h.need(run.dev.prUrl ?? undefined);
  const head = await h.d.workspace.head(where(h, worktree));
  if (!head.ok) throw new Blocked(`读取 HEAD 提交失败：${tail(head.error)}`);
  const headSha = head.sha;

  // No new commit since the red run: a push starts no CI, so rerun the failed jobs and wait for that result.
  let staleFailedUrls: Set<string> | undefined;
  if (run.dev.ciRound > 0 && run.dev.ciFailedSha === headSha) {
    const read = await h.net(
      run.key,
      "gh pr view",
      () => h.d.forge.ciStatus(where(h, worktree), prUrl, headSha, config.ciChecks),
      (r) => (r.ok ? undefined : r.error),
    );
    if (!read.ok) throw new Blocked(`读取 CI 状态失败：${tail(read.error)}`);
    if (read.status.state === "failed") {
      // Not retried in place (a retry could rerun twice): on a network error the run waits, and the next step
      // reads the CI status again before it reruns anything.
      const rerun = await h.d.forge.rerunFailed(where(h, worktree), read.status.failed, {
        ciRound: run.dev.ciRound,
        maxCiRetries: config.maxCiRetries,
      });
      if (!rerun.ok && isNetworkError(rerun.error)) throw new NetworkWait("gh run rerun");
      if (!rerun.ok) throw new Blocked(`重新运行 CI 失败：${tail(rerun.error)}`);
      await store.event(run.key, "ci_rerun", {
        ciRound: run.dev.ciRound,
        runs: rerun.runIds.length,
      });
      staleFailedUrls = new Set(
        read.status.failed.flatMap((c) => (c.detailsUrl === null ? [] : [c.detailsUrl])),
      );
    }
  }

  await releaseNodeModules(x, run, worktree, save);

  // A network error is retried on the single poll read, so the CI timeout budget is not restarted by it.
  const result = await waitForCi({
    staleFailedUrls,
    prRef: prUrl,
    requiredChecks: config.ciChecks,
    expectedHeadSha: headSha,
    forge: h.d.forge,
    cwd: worktree,
    commandTimeoutMs: config.commandTimeoutMs,
    pollIntervalMs: config.ciPollIntervalMs,
    timeoutMs: config.ciTimeoutMs,
    clock,
    sleep: h.d.sleep ?? ((ms) => Bun.sleep(ms)),
    guardRead: (read) => h.net(run.key, "gh pr view", read, (r) => (r.ok ? undefined : r.error)),
  });

  await assertNotClosed(h, run);
  if (result.outcome === "error") {
    throw new Blocked(`读取 CI 状态失败：${tail(result.error)}`);
  }
  if (result.outcome === "conflict") {
    await handleConflict(h, run, prUrl, worktree, save);
    return;
  }
  if (result.outcome === "timeout") {
    const pendingNames =
      result.status?.pending.map((c) => c.name).join("、") || config.ciChecks.join("、");
    const failedNames = result.status?.failed.map((c) => c.name).join("、") ?? "";
    const detail =
      failedNames !== ""
        ? `未完成项：${pendingNames}；已失败项：${failedNames}`
        : `未完成项：${pendingNames}`;
    await store.event(run.key, "ci_timeout", { ciRound: run.dev.ciRound });
    throw new Blocked(`等待 CI 结果超时（${detail}）。`);
  }
  if (result.outcome === "failed") {
    const failedList = result.status.failed.map((c) => c.name);
    await store.event(run.key, "ci_failed", {
      ciRound: run.dev.ciRound,
      failed: failedList.length,
    });
    await store.event(run.key, "round_failed", { round: run.round });
    if (run.dev.ciRound >= config.maxCiRetries) {
      throw new Blocked(
        `CI 连续失败（已重试 ${run.dev.ciRound} 次达到上限），失败项：${failedList.join("、")}。\n${tail(result.logs, 1500)}`,
      );
    }
    const findings = `CI checks failed on PR ${prUrl} (failed: ${failedList.join(", ")}). Fix the failures below, run \`bun run check\`, and commit; the loop will verify, run QA, and push to the same branch.\n\n${result.logs}`;
    await save({
      phase: "dev",
      round: run.round + 1,
      findings,
      dev: { ciRound: run.dev.ciRound + 1, ciFailedSha: headSha },
    });
    return;
  }

  await h.d.store.saveCi(run.key, { greenSha: headSha });
  await store.event(run.key, "ci_passed", { ciRound: run.dev.ciRound });
  await save({ phase: "review", dev: { prUrl } });
}
