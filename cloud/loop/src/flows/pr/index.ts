// Pull requests a person opened (CYC-540). An intake polls the open pull requests of the Project's repository, keeps
// the ones the loop may look at, and hands over one run (`OwnRun`) per pull request that has something to do: a new
// commit, or a wait that was woken or whose time has come. The run reads GitHub again before every action, waits for
// CI by registering a wait (and ends, so the worker is free), calls the review task, and merges only through the
// merge gate, pinned to the commit that was reviewed.

import {
  type FlowHost,
  type Intake,
  NetworkWait,
  type OwnRun,
  type StepResult,
} from "../../engine/flow.ts";
import { recordHeartbeat } from "../../engine/heartbeat.ts";
import { mayMerge } from "../../guard/merge-gate.ts";
import type { At, OpenPr } from "../../ports/forge.ts";
import type { LoopStore } from "../../store.ts";
import { commentOnce, type ReviewInput, reviewTask } from "../review/index.ts";

/** The store methods this flow uses, each in a transaction of its own. */
const db = (store: LoopStore) => ({
  dueWaits: () => store.transaction((tx) => tx.dueWaits()),
  waits: () => store.transaction((tx) => tx.waits()),
  findReviewTask: (repo: string, pr: number, sha: string) =>
    store.transaction((tx) => tx.findReviewTask(repo, pr, sha)),
  reviewTask: (repo: string, pr: number, sha: string, origin: string) =>
    store.transaction((tx) => tx.reviewTask(repo, pr, sha, origin)),
  signal: (dedupe: string, subject: string, source: string) =>
    store.transaction((tx) => tx.signal(dedupe, subject, source)),
  clearWaits: (owner: string) => store.transaction((tx) => tx.clearWaits(owner)),
  wait: (owner: string, subject: string, at: string) =>
    store.transaction((tx) => tx.wait(owner, subject, at)),
  prReview: (repo: string, pr: number) => store.transaction((tx) => tx.prReview(repo, pr)),
  countPrReview: (repo: string, pr: number, sha: string) =>
    store.transaction((tx) => tx.countPrReview(repo, pr, sha)),
  markPrCapped: (repo: string, pr: number) => store.transaction((tx) => tx.markPrCapped(repo, pr)),
});

const BRANCH_OF_LOOP = /^auto\/cyc-/;
const WRITE = new Set(["write", "maintain", "admin"]);

export const prKey = (repo: string, pr: number) => `pr:${repo}#${pr}`;
const prNumberOf = (key: string) => Number(key.slice(key.lastIndexOf("#") + 1));

/** The branch name of a base ref such as "origin/main". */
const baseBranchOf = (baseRef: string) => baseRef.replace(/^(?:refs\/remotes\/)?origin\//, "");

/**
 * The pull requests the loop may look at: same repository, into the configured base branch, not a draft, not the
 * loop's own branch.
 */
export const eligible = (prs: OpenPr[], baseBranch: string): OpenPr[] =>
  prs.filter(
    (p) =>
      !p.crossRepository &&
      !p.isDraft &&
      p.baseBranch === baseBranch &&
      !BRANCH_OF_LOOP.test(p.headBranch),
  );

export class PrFlow {
  readonly #host: FlowHost;
  #lastPoll = 0;
  #open = new Map<number, OpenPr>();
  /**
   * "<key>@<sha>" that ended without anything left to do until a new commit (no write access, cap, a conclusion).
   * Kept in memory only (a departure from Design's persisted state), and pruned at each poll to the heads of open
   * pull requests: after a restart such a pull request is looked at once more, which reads GitHub again and costs a
   * review only if its task is not done (the cap still holds, it is in `pr_reviews`).
   */
  readonly #settled = new Set<string>();

  constructor(host: FlowHost) {
    this.#host = host;
  }

  get #d() {
    return this.#host.d;
  }

  #at(): At {
    return { cwd: this.#d.config.repoRoot, timeoutMs: this.#d.config.commandTimeoutMs };
  }

  #slug(): string | null {
    const { config } = this.#d;
    return config.prReview === null ? null : config.repoSlug;
  }

  intake(): Intake {
    return {
      want: async (held) => {
        const slug = this.#slug();
        if (slug === null) return { idle: "pr review is off" };
        const { config, store, clock } = this.#d;
        const now = clock.now().getTime();
        if (this.#lastPoll === 0 || now - this.#lastPoll >= config.ciPollIntervalMs) {
          this.#lastPoll = now;
          await this.#poll(slug);
        }
        const due = new Set(
          db(store)
            .dueWaits()
            .map((w) => w.owner),
        );
        const waiting = new Set(
          db(store)
            .waits()
            .map((w) => w.owner),
        );
        for (const p of [...this.#open.values()].sort((a, b) => a.number - b.number)) {
          const key = prKey(slug, p.number);
          if (held.has(key)) continue;
          const task = db(store).findReviewTask(slug, p.number, p.headSha);
          const fresh =
            !waiting.has(key) &&
            !this.#settled.has(`${key}@${p.headSha}`) &&
            task?.status !== "done";
          if (due.has(key) || fresh) return { begin: this.#run(slug, key, p.number) };
        }
        return { idle: "no pull request of a person has anything to do" };
      },
      reject: async () => {},
    };
  }

  /** Reads the open pull requests, writes a signal per commit, and wakes the waits whose CI is no longer pending. */
  async #poll(slug: string): Promise<void> {
    const { store, config, log } = this.#d;
    const read = await this.#d.forge.openPrs(this.#at());
    if (!read.ok) {
      log(`pr review: cannot read the open pull requests: ${read.error}`);
      return;
    }
    const prs = eligible(read.prs, baseBranchOf(config.baseRef));
    this.#open = new Map(prs.map((p) => [p.number, p]));
    // A commit that is no longer the head of an open pull request cannot be asked about again.
    const heads = new Set(prs.map((p) => `${prKey(slug, p.number)}@${p.headSha}`));
    for (const m of this.#settled) if (!heads.has(m)) this.#settled.delete(m);
    if (config.dryRun) return;
    for (const p of prs) {
      db(store).signal(`pr:${slug}#${p.number}@${p.headSha}`, `pr:${slug}#${p.number}`, "poll");
    }
    for (const w of db(store).waits()) {
      if (!w.owner.startsWith(`pr:${slug}#`)) continue;
      const p = this.#open.get(prNumberOf(w.owner));
      const sha = w.subject.slice(w.subject.lastIndexOf("@") + 1);
      // The pull request is gone, or has a newer commit: what it waited for no longer matters.
      if (p === undefined || p.headSha !== sha) {
        db(store).clearWaits(w.owner);
        continue;
      }
      if (!w.subject.startsWith("ci:")) continue;
      const ci = await this.#d.forge.ciStatus(this.#at(), String(p.number), sha, config.ciChecks);
      // Only green wakes it at once; a failed commit is looked at again at its recheck time.
      if (ci.ok && ci.status.state === "passed")
        db(store).signal(`${w.subject}:settled:${w.createdAt}`, w.subject, "poll");
    }
  }

  #run(slug: string, key: string, number: number): OwnRun {
    const { store } = this.#d;
    return {
      key,
      open: async () => {
        await store.event(key, "pr_review_started", {});
      },
      go: () => this.#go(slug, key, number),
      fail: async (error) => {
        const reason = error instanceof Error ? error.message : String(error);
        await store.event(key, "pr_review_failed", { reason: reason.slice(0, 300) });
        // Looked at again after a pause, not at the next tick: one pull request that keeps failing must not starve the rest.
        this.#retryLater(key, this.#open.get(prNumberOf(key))?.headSha ?? "error", "failed");
        return { status: "pr_step", key, outcome: "failed" };
      },
      would: { status: "pr_step", key, outcome: "would-review" },
    };
  }

  async #go(slug: string, key: string, number: number): Promise<StepResult> {
    const h = this.#host;
    const { config, store, clock } = this.#d;
    const at = this.#at();
    const max = config.prReview?.maxReviewsPerPr ?? 5;
    const ref = String(number);
    const done = (outcome: string): StepResult => ({ status: "pr_step", key, outcome });
    const read = <T extends { ok: boolean }>(command: string, fn: () => Promise<T>) =>
      h.net(key, command, fn, (r) =>
        r.ok ? undefined : (r as unknown as { error: string }).error,
      );

    const head = await read("gh pr view", () => this.#d.forge.prHead(at, ref));
    if (!head.ok) throw new Error(`cannot read the pull request: ${head.error}`);
    if (head.state !== "OPEN") {
      db(store).clearWaits(key);
      this.#settled.add(`${key}@${head.sha}`);
      return done("closed");
    }
    const sha = head.sha;
    const info = this.#open.get(number);
    if (info === undefined) {
      this.#settled.add(`${key}@${sha}`);
      return done("gone");
    }
    const mark = `${key}@${sha}`;
    db(store).clearWaits(key);

    const perm = await read("gh api permission", () =>
      this.#d.forge.authorPermission(at, info.author),
    );
    if (!perm.ok || !WRITE.has(perm.permission)) {
      this.#settled.add(mark);
      await store.event(key, "pr_author_no_write", {});
      return done("no-write-access");
    }

    const input: ReviewInput = {
      repo: slug,
      pr: number,
      headSha: sha,
      prRef: ref,
      key,
      origin: "pr",
      branch: info.headBranch,
      context: { kind: "pr", title: info.title, body: info.body },
    };
    const existing = db(store).findReviewTask(slug, number, sha);
    const reviewed = existing?.status === "done";

    if (!reviewed) {
      const counted = db(store).prReview(slug, number);
      if (counted.reviews >= max) {
        this.#settled.add(mark);
        if (!counted.capped) {
          db(store).reviewTask(slug, number, sha, "pr");
          const said = await commentOnce(
            h,
            input,
            config.repoRoot,
            "cap",
            `已审阅 ${counted.reviews} 次，达到上限（${max}），之后的提交不再自动审阅。`,
          );
          if (said.ok) db(store).markPrCapped(slug, number);
        }
        await store.event(key, "pr_review_capped", { reviews: counted.reviews });
        return done("capped");
      }
      const ci = await read("gh pr view", () =>
        this.#d.forge.ciStatus(at, ref, sha, config.ciChecks),
      );
      if (!ci.ok) return this.#retryLater(key, sha, "ci-unreadable");
      if (ci.status.state === "pending") {
        const subject = `ci:${slug}@${sha}`;
        db(store).wait(
          key,
          subject,
          new Date(clock.now().getTime() + config.ciPollIntervalMs).toISOString(),
        );
        recordHeartbeat(store, key, { phase: "pr_waiting_ci", waitingOn: "ci", deadline: null });
        await store.event(key, "pr_waiting_ci", { sha });
        return done("waiting-ci");
      }
      if (ci.status.state === "failed") return this.#ciFailed(key, slug, sha);
    }

    const result = await reviewTask(h, input);
    if (result.kind === "busy") return this.#retryLater(key, sha, "busy");
    if (result.kind === "ci_not_green") {
      if (result.state === "pending") {
        db(store).wait(
          key,
          `ci:${slug}@${sha}`,
          new Date(clock.now().getTime() + config.ciPollIntervalMs).toISOString(),
        );
        return done("waiting-ci");
      }
      return this.#ciFailed(key, slug, sha);
    }
    if (result.kind === "unavailable") return this.#retryLater(key, sha, "unavailable");
    // The conclusion is kept, but a comment that did not get onto the pull request comes first: no merge on a
    // review nobody could read. The task is done, so the next look only retries the comment.
    // A failure of the review system is not a review of the commit: it neither counts toward the cap nor settles it.
    if (result.conclusion.decision === "system_error") {
      await store.event(key, "pr_review_done", { decision: "system_error" });
      return this.#retryLater(key, sha, "system-error");
    }
    if (!reviewed) db(store).countPrReview(slug, number, sha);
    if (!result.conclusion.commented) return this.#retryLater(key, sha, "comment-failed");
    const { decision } = result.conclusion;
    await store.event(key, "pr_review_done", { decision });
    if (decision !== "merge") {
      this.#settled.add(mark);
      return done(decision);
    }
    return this.#merge(key, number, info, input);
  }

  /** CI failed on this commit: not reviewed, but looked at again later, since a re-run on the same commit can pass. */
  #ciFailed(key: string, slug: string, sha: string): StepResult {
    const { store, clock, config } = this.#d;
    db(store).wait(
      key,
      `ci:${slug}@${sha}`,
      new Date(clock.now().getTime() + config.ciPollIntervalMs).toISOString(),
    );
    void store.event(key, "pr_ci_failed", { sha });
    return { status: "pr_step", key, outcome: "ci-failed" };
  }

  #retryLater(key: string, sha: string, why: string): StepResult {
    const { store, clock, config } = this.#d;
    db(store).wait(
      key,
      `retry:${key}@${sha}`,
      new Date(clock.now().getTime() + config.ciPollIntervalMs).toISOString(),
    );
    return { status: "pr_step", key, outcome: why };
  }

  /** Everything the gate needs is read now, from GitHub; the merge is pinned to the commit that was reviewed. */
  async #merge(key: string, number: number, info: OpenPr, input: ReviewInput): Promise<StepResult> {
    const h = this.#host;
    const { config, store } = this.#d;
    const at = this.#at();
    const ref = String(number);
    const sha = input.headSha;
    const done = (outcome: string): StepResult => ({ status: "pr_step", key, outcome });
    const read = <T extends { ok: boolean }>(command: string, fn: () => Promise<T>) =>
      h.net(key, command, fn, (r) =>
        r.ok ? undefined : (r as unknown as { error: string }).error,
      );

    try {
      const head = await read("gh pr view", () => this.#d.forge.prHead(at, ref));
      const perm = await read("gh api permission", () =>
        this.#d.forge.authorPermission(at, info.author),
      );
      const ci = await read("gh pr view", () =>
        this.#d.forge.ciStatus(at, ref, sha, config.ciChecks),
      );
      const paths = await read("gh pr diff", () => this.#d.forge.changedPaths(at, ref));
      const gate = mayMerge({
        verdict: "merge",
        reviewedSha: sha,
        headNow: head.ok ? head.sha : "",
        ciAtHead: ci.ok ? ci.status.state : "unreadable",
        changedPaths: paths.ok ? paths.paths : null,
        author: {
          permission: perm.ok ? perm.permission : "",
          crossRepository: info.crossRepository,
        },
      });
      if (!gate.ok) {
        await store.event(key, "pr_merge_refused", { reasons: gate.reasons.length });
        await commentOnce(
          h,
          input,
          config.repoRoot,
          "merge-refused",
          `评审结论为合并，但合并门禁没有放行，Loop 不合并：\n\n${gate.reasons.map((r) => `- ${r}`).join("\n")}`,
        );
        this.#settled.add(`${key}@${sha}`);
        return done("merge-refused");
      }
      const merged = await read("gh pr merge", () => this.#d.forge.mergeAt(at, ref, sha));
      if (!merged.ok) {
        await store.event(key, "pr_merge_failed", {});
        await commentOnce(
          h,
          input,
          config.repoRoot,
          "merge-failed",
          `评审结论为合并，但合并失败：${(merged as { error: string }).error.slice(0, 500)}\n\nLoop 不会重试，请人处理。`,
        );
        this.#settled.add(`${key}@${sha}`);
        return done("merge-failed");
      }
      db(store).clearWaits(key);
      await store.event(key, "pr_merged", { sha });
      return done("merged");
    } catch (error) {
      // GitHub out of reach: the conclusion is kept, and the merge is tried again later.
      if (error instanceof NetworkWait) this.#retryLater(key, sha, "network");
      throw error;
    }
  }
}
