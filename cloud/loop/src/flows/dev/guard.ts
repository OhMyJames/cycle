import { Blocked, type StepResult, tail } from "../../engine/flow.ts";
import type { PrState } from "../../ports/forge.ts";
import type { Issue } from "../../types.ts";
import { tellTicket } from "../ticket.ts";
import { type DevRun, type FlowHost, type Save, where } from "./context.ts";

/** Reads the PR state, retrying a failed read; an unreadable state blocks, it never counts as open. */
const PR_STATE_READS = 3;

export async function prState(
  h: FlowHost,
  run: DevRun,
): Promise<{ prUrl: string; state: PrState }> {
  const { config } = h.d;
  const prUrl = h.need(run.dev.prUrl ?? undefined);
  let lastError = "";
  for (let attempt = 0; attempt < PR_STATE_READS; attempt++) {
    const read = await h.net(
      run.key,
      "gh pr view",
      () => h.d.forge.prState(where(h, run.worktree ?? config.repoRoot), prUrl),
      (r) => (r.ok ? undefined : r.error),
    );
    if (read.ok) return { prUrl, state: read.state };
    lastError = read.error;
  }
  throw new Blocked(`读取 PR 状态失败：${tail(lastError)}`);
}

export async function closedBlock(h: FlowHost, run: DevRun, prUrl: string): Promise<never> {
  await h.d.store.event(run.key, "pr_closed", { phase: run.phase });
  throw new Blocked(
    `PR 已被关闭（未合并），需人接手：${prUrl}。自动化不会再往该分支推送，也不会重开 PR。要继续，请先重新打开该 PR，再把工单放回 Todo。`,
  );
}

/**
 * Reads the pull request's state at the top of every step once it exists. Closed without merging stops the run (a
 * person takes over); merged counts as delivered.
 */
export async function guardPr(
  h: FlowHost,
  run: DevRun,
  issue: Issue,
  save: Save,
): Promise<StepResult | undefined> {
  const { prUrl, state } = await prState(h, run);
  if (state === "OPEN") return undefined;
  if (state === "CLOSED") return closedBlock(h, run, prUrl);
  await save({ phase: "done", dev: { reviewCommented: undefined } }, (tx) => {
    tellTicket(tx, run, issue, `merged-outside:${run.key}:${prUrl}`, {
      body: `PR 已在自动化之外合并：${prUrl}。按已交付处理，不再重复开 PR。`,
      to: "inReview",
    });
    tx.event(run.key, "delivered", { prUrl, rounds: run.round, autoMerge: false });
  });
  return { status: "delivered", key: run.key, prUrl, autoMerge: false };
}

/**
 * After auto-merge is enabled, waits for the pull request to actually merge. GitHub waits silently on a conflict, so a
 * conflicting, closed or never-merging PR blocks the run instead of being taken as delivered.
 */
export async function confirmMerged(
  h: FlowHost,
  run: DevRun,
  prUrl: string,
  worktree: string,
): Promise<"merged" | "conflict"> {
  const { config, store } = h.d;
  const sleep = h.d.sleep ?? ((ms: number) => Bun.sleep(ms));
  const polls = Math.max(
    1,
    Math.ceil(config.mergeTimeoutMs / Math.max(1, config.mergePollIntervalMs)),
  );
  let last = "仍在等待 GitHub 自动合并";
  for (let poll = 0; poll < polls; poll++) {
    if (poll > 0) await sleep(config.mergePollIntervalMs);
    const read = await h.net(
      run.key,
      "gh pr view",
      () => h.d.forge.prMergeStatus(where(h, worktree), prUrl),
      (r) => (r.ok ? undefined : r.error),
    );
    if (!read.ok) {
      last = `读取 PR 合并状态失败：${tail(read.error)}`;
      continue;
    }
    if (read.status === "merged") return "merged";
    if (read.status === "closed") await closedBlock(h, run, prUrl);
    if (read.status === "conflicting") return "conflict";
    last = read.status === "mergeable" ? "PR 可合并但尚未合并" : "GitHub 尚未给出合并状态";
  }
  await store.event(run.key, "merge_timeout", { prUrl });
  throw new Blocked(
    `已开启自动合并，但 PR 在 ${Math.round(config.mergeTimeoutMs / 60_000)} 分钟内没有合并（${last}）：${prUrl}。`,
  );
}

/** Re-reads the state in the middle of a step, before acting on a PR that may have been closed meanwhile. */
export async function assertNotClosed(h: FlowHost, run: DevRun): Promise<void> {
  const { prUrl, state } = await prState(h, run);
  if (state === "CLOSED") await closedBlock(h, run, prUrl);
}
