// One work item, from the `Todo` column to a pull request, and the way back out when it cannot be done (CYC-318).
//
// The order is: preflight, claim, Dev, the checks (run by this code), independent QA, deliver. Each step ends by
// writing where the run is, so a loop that is killed, or a work item a person put back, goes on from the same place.
//
// This file decides; it does not touch the world. The tracker, the daemon's sessions, git and the shell are the
// interfaces in types.ts.

import { AsyncLocalStorage } from "node:async_hooks";
import { type Tuning, tuningToConfig } from "./config-file.ts";
import { CriteriaBook, type Criterion } from "./criteria.ts";
import { deliverEnv, GIT_SAFE, verifyEnv } from "./env.ts";
import { summarizeFailure } from "./failure.ts";
import { withRepoLock } from "./git-lock.ts";
import { testLayers } from "./layers.ts";
import {
  enableAutoMerge,
  type PrState,
  postPrComment,
  readCiStatus,
  readPrMergeStatus,
  readPrState,
  renderPr,
  renderPrTitle,
  renderReviewComment,
  rerunFailedCi,
  validatePr,
  waitForCi,
} from "./pr.ts";
import { preflight, sendBackComment } from "./preflight.ts";
import {
  conflictBrief,
  continueBrief,
  devBrief,
  fixBrief,
  formatFindings,
  formatReviewFindings,
  handoffBrief,
  listsWhatWasChecked,
  parseProgress,
  parseReviewVerdict,
  parseVerdict,
  qaBrief,
  type ReviewVerdict,
  reviewBrief,
  type Verdict,
} from "./prompts.ts";
import { pickNext } from "./select.ts";
import type { RunRecord, RunStore } from "./store.ts";
import {
  type Clock,
  type Config,
  type Exec,
  type ExecResult,
  type Issue,
  type Logger,
  SessionLost,
  type SessionRole,
  type Sessions,
  type Tracker,
  type TurnResult,
} from "./types.ts";

export type StepResult =
  | { status: "idle" }
  | { status: "rejected"; key: string; reasons: string[] }
  | { status: "would-take"; key: string; criteria: number }
  | { status: "delivered"; key: string; prUrl: string; autoMerge: boolean }
  | { status: "blocked"; key: string; reason: string };

export type Deps = {
  config: Config;
  tracker: Tracker;
  sessions: Sessions;
  exec: Exec;
  store: RunStore;
  clock: Clock;
  log: Logger;
  /** The loop's own environment; only the allowlisted parts of it go to the commands it runs. */
  env: Record<string, string | undefined>;
  /** Waits between CI status polls. Defaults to `Bun.sleep`. */
  sleep?: (ms: number) => Promise<void>;
  /** True once the loop has been asked to stop: no new work item is taken, runs already under way go on. */
  stopped?: () => boolean;
  /**
   * The Project's `tuning` (CYC-441): what it is at start, and how to read it again. `step()` reads before it takes
   * anything; a read that throws keeps the last good value. Without it, `config` is used as it is.
   */
  tuning?: { initial: Tuning; reload: () => Promise<Tuning> };
};

/** A run cannot go on without a person. The message is what the person is told. */
class Blocked extends Error {}

const PR_STATE_READS = 3;

const branchOf = (number: number) => `auto/cyc-${number}`;

export class Pipeline {
  readonly #deps: Deps;
  /** The `tuning` in force for new steps: the last one that was read and valid. */
  #tuning: Tuning;
  #lastTuningProblem: string | null = null;
  /** The config one step runs with, fixed when it starts: a change to the file does not reach a step under way. */
  readonly #stepConfig = new AsyncLocalStorage<Config>();
  /** Keys of the runs some step is working on now. */
  readonly #active = new Set<string>();
  #lock: Promise<void> = Promise.resolve();

  constructor(deps: Deps) {
    this.#deps = deps;
    this.#tuning = deps.tuning?.initial ?? {};
  }

  /** The deps with the config of the step this code runs in. */
  get #d(): Deps {
    return { ...this.#deps, config: this.#stepConfig.getStore() ?? this.#configNow() };
  }

  #configNow(): Config {
    return { ...this.#deps.config, ...tuningToConfig(this.#tuning) };
  }

  /** Seconds to wait when idle, from the `tuning` in force; undefined when it does not say. */
  get intervalSeconds(): number | undefined {
    return this.#tuning.intervalSeconds;
  }

  async #reloadTuning(): Promise<void> {
    const source = this.#deps.tuning;
    if (source === undefined) return;
    try {
      this.#tuning = await source.reload();
      if (this.#lastTuningProblem !== null) this.#deps.log("tuning 恢复正常，按配置文件里的值");
      this.#lastTuningProblem = null;
    } catch (error) {
      const problem = error instanceof Error ? error.message : String(error);
      // One line per distinct problem, not one per idle poll.
      if (problem !== this.#lastTuningProblem)
        this.#deps.log(`tuning 读取失败，沿用上次的值：${problem}`);
      this.#lastTuningProblem = problem;
    }
  }

  /** Takes up one thing: a run to go on with, or else the next work item. Several steps may run at once. */
  async step(): Promise<StepResult> {
    await this.#reloadTuning();
    return this.#stepConfig.run(this.#configNow(), () => this.#step());
  }

  async #step(): Promise<StepResult> {
    if (this.#d.config.dryRun) return this.#dryRun();

    const chosen = await this.#exclusive(() => this.#choose());
    if ("result" in chosen) return chosen.result;
    try {
      if (chosen.resume !== undefined) {
        return await this.#resume(chosen.resume.run, chosen.resume.issue, chosen.resume.byPerson);
      }
      return await this.#drive(chosen.run, chosen.issue, chosen.book, false);
    } finally {
      this.#active.delete(chosen.key);
    }
  }

  /** Runs `fn` after every earlier call has finished, one at a time. A failure does not stop the later ones. */
  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#lock.then(fn);
    this.#lock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Cleanup, then the choice: a run to go on with, or else a new work item (claimed here). Only one runs at a time;
   * the chosen key is in `#active` before the lock is released, so no other step takes the same work item.
   */
  async #choose(): Promise<
    | { result: StepResult }
    | { key: string; resume: { run: RunRecord; issue: Issue; byPerson: boolean } }
    | { key: string; resume?: undefined; run: RunRecord; issue: Issue; book: CriteriaBook }
  > {
    const { config, tracker, store } = this.#d;
    await this.#cleanup();

    const unfinished = await store.unfinished();
    for (const run of unfinished.sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
      if (this.#active.has(run.key)) continue;
      const issue = await tracker.get(run.issueNumber);
      const putBack =
        issue.columnId === config.columns.todo && issue.labelIds.includes(config.autoLabelId);
      if (run.phase === "blocked" && !putBack) continue;
      // Not blocked and not done: the loop that was on it is gone (no step holds it).
      this.#active.add(run.key);
      return { key: run.key, resume: { run, issue, byPerson: run.phase === "blocked" } };
    }

    if (this.#d.stopped?.() === true) return { result: { status: "idle" } };
    const held = new Set([...this.#active, ...unfinished.map((r) => r.key)]);
    const issue = pickNext(
      (await tracker.listTodo()).filter((i) => !held.has(i.key)),
      config,
    );
    if (issue === undefined) return { result: { status: "idle" } };
    const pre = preflight(issue, config);
    if (!pre.ok) {
      await tracker.comment(issue, sendBackComment(pre.reasons));
      await tracker.move(issue, "blocked");
      await store.event(issue.key, "preflight_rejected", { reasons: pre.reasons.length });
      return { result: { status: "rejected", key: issue.key, reasons: pre.reasons } };
    }

    const book = CriteriaBook.fromSpecs(pre.specs);
    const run: RunRecord = {
      key: issue.key,
      issueId: issue.id,
      issueNumber: issue.number,
      title: issue.title,
      phase: "claimed",
      round: 0,
      ciRound: 0,
      ciFailedSha: null,
      conflictRound: 0,
      conflict: null,
      resolvedFiles: [],
      worktree: null,
      localBranch: null,
      remoteBranch: branchOf(issue.number),
      devSessionId: null,
      qaSessionId: null,
      reviewSessionId: null,
      replacedSessions: [],
      blockedReason: null,
      resumeFrom: null,
      prUrl: null,
      findings: null,
      cleanedAt: null,
      cleanupNote: null,
      startedAt: this.#d.clock.now().toISOString(),
      updatedAt: this.#d.clock.now().toISOString(),
    };
    this.#active.add(issue.key);
    try {
      await store.saveCriteria(issue.key, book);
      await store.save(run);
      await tracker.move(issue, "inProgress");
      await store.event(issue.key, "claimed", { criteria: pre.specs.length });
    } catch (error) {
      this.#active.delete(issue.key);
      throw error;
    }
    return { key: issue.key, run, issue, book };
  }

  /**
   * Before choosing, removes the worktree and local branch of every run whose work item is Done and whose PR is
   * merged. Anything else is left alone; a worktree with uncommitted changes is left for a person (CYC-379).
   * A failure here never stops the loop from taking work.
   */
  async #cleanup(): Promise<void> {
    const { store, log } = this.#d;
    for (const run of await store.all()) {
      if (run.phase !== "done" || run.cleanedAt !== null) continue;
      if (run.prUrl === null || run.worktree === null) continue;
      try {
        await this.#cleanupRun(run, run.worktree);
      } catch (error) {
        log(
          `cleanup of ${run.key} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  async #cleanupRun(run: RunRecord, worktree: string): Promise<void> {
    const { config, tracker, store, clock } = this.#d;
    const note = async (kind: string) => {
      if (run.cleanupNote === kind) return;
      await store.event(run.key, kind);
      await store.save({ ...run, cleanupNote: kind });
    };
    // Only the work item's own worktree: `.../auto/cyc-<n>`.
    const own = `/${branchOf(run.issueNumber)}`;
    if (!worktree.replace(/\/+$/, "").endsWith(own)) return;

    const issue = await tracker.get(run.issueNumber);
    if (issue.columnId !== config.columns.done) return;
    const read = await readPrState({
      prRef: run.prUrl ?? "",
      exec: this.#d.exec,
      cwd: config.repoRoot,
      env: this.#d.env,
      timeoutMs: config.commandTimeoutMs,
    });
    if (!read.ok || read.state !== "MERGED") return;

    const status = await this.#git(["status", "--porcelain"], worktree);
    if (status.code !== 0) return note("cleanup_failed");
    if (status.output.trim() !== "") return note("cleanup_skipped_dirty");

    // No --force: git itself refuses a worktree with changes in it.
    const removed = await this.#git(["worktree", "remove", worktree], config.repoRoot);
    if (removed.code !== 0) return note("cleanup_failed");
    for (const branch of new Set([run.localBranch, branchOf(run.issueNumber)])) {
      if (branch === null) continue;
      const exists = await this.#git(
        ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
        config.repoRoot,
      );
      if (exists.code !== 0) continue;
      const deleted = await this.#git(["branch", "-D", branch], config.repoRoot);
      if (deleted.code !== 0) return note("cleanup_failed");
    }
    await store.event(run.key, "cleaned");
    await store.save({ ...run, cleanedAt: clock.now().toISOString(), cleanupNote: null });
  }

  /** `--dry-run`: pick and check, and say what would happen. Writes nothing anywhere. */
  async #dryRun(): Promise<StepResult> {
    const { config, tracker } = this.#d;
    const todo = await tracker.listTodo();
    const issue = pickNext(todo, config);
    if (issue === undefined) {
      const labeled = todo.filter((i) => i.labelIds.includes(config.autoLabelId));
      const rightType = labeled.filter(
        (i) => i.typeId !== null && config.allowedTypeIds.includes(i.typeId),
      );
      const leaves = rightType.filter((i) => i.subtaskCount === 0);
      this.#d.log(
        `dry run: ${todo.length} in Todo, ${labeled.length} with auto, ${rightType.length} allowed type, ${leaves.length} leaf`,
      );
      return { status: "idle" };
    }
    const pre = preflight(issue, config);
    if (!pre.ok) return { status: "rejected", key: issue.key, reasons: pre.reasons };
    return { status: "would-take", key: issue.key, criteria: pre.specs.length };
  }

  async #resume(run: RunRecord, issue: Issue, byPerson: boolean): Promise<StepResult> {
    const { store, tracker } = this.#d;
    const book = await store.loadCriteria(run.key);
    let current = run;
    if (byPerson) {
      // A conflict turn that blocked before it was judged leaves the merge open, markers and all: back it out, or the
      // next checkpoint would commit them.
      const saved = run.conflict;
      if (saved?.state === "dev" && saved.preMergeSha !== undefined && run.worktree !== null) {
        const failed = await this.#rollbackMerge(run.worktree, saved.preMergeSha);
        if (failed !== "") throw new Error(`conflict rollback on resume failed: ${failed}`);
      }
      // A person has been at it: the budget of fix rounds starts again, from where it stopped.
      current = {
        ...run,
        phase: run.resumeFrom ?? "dev",
        round: 0,
        ciRound: 0,
        conflictRound: 0,
        conflict: null,
        resolvedFiles: [],
        blockedReason: null,
        resumeFrom: null,
      };
      current = await store.save(current);
      await tracker.move(issue, "inProgress");
      await store.event(run.key, "resumed", { phase: current.phase });
    } else {
      await store.event(run.key, "recovered", { phase: run.phase });
    }
    // What the checks said is held in memory only: going on from the review or the delivery, they are run again.
    // A human resume from `ci` or `review` also re-runs verify/QA/push in case they committed a fix locally; a crash
    // recovery in `ci` or `review` continues directly from there.
    if (
      current.phase === "qa" ||
      current.phase === "delivering" ||
      (byPerson && (current.phase === "ci" || current.phase === "review"))
    )
      current = await store.save({ ...current, phase: "verify" });
    return this.#drive(current, issue, book, byPerson);
  }

  async #drive(
    start: RunRecord,
    issue: Issue,
    book: CriteriaBook,
    byPerson: boolean,
  ): Promise<StepResult> {
    let run = start;
    const save = async (patch: Partial<RunRecord>) => {
      run = await this.#d.store.save({ ...run, ...patch });
    };
    try {
      let announce = byPerson;
      for (;;) {
        if (run.prUrl !== null && run.phase !== "blocked" && run.phase !== "done") {
          const settled = await this.#guardPr(run, issue, save);
          if (settled !== undefined) return settled;
        }
        switch (run.phase) {
          case "claimed": {
            await this.#claim(run, issue, save);
            break;
          }
          case "dev": {
            await this.#dev(run, issue, book, announce, save);
            announce = false;
            break;
          }
          case "verify": {
            await this.#verify(run, book, save);
            break;
          }
          case "qa": {
            await this.#qa(run, issue, book, save);
            break;
          }
          case "delivering": {
            await this.#deliver(run, issue, book, save);
            break;
          }
          case "ci": {
            await this.#ci(run, save);
            break;
          }
          case "review": {
            const done = await this.#review(run, issue, book, save);
            if (done !== undefined) {
              return {
                status: "delivered",
                key: run.key,
                prUrl: done.prUrl,
                autoMerge: done.autoMerge,
              };
            }
            break;
          }
          case "blocked":
          case "done":
            return { status: "idle" };
        }
      }
    } catch (error) {
      if (!(error instanceof Blocked)) throw error;
      return this.#block(run, issue, error.message, save);
    }
  }

  /** Reads the PR state, retrying a failed read; an unreadable state blocks, it never counts as open. */
  async #prState(run: RunRecord): Promise<{ prUrl: string; state: PrState }> {
    const { config } = this.#d;
    const prUrl = this.#need(run.prUrl ?? undefined);
    let lastError = "";
    for (let attempt = 0; attempt < PR_STATE_READS; attempt++) {
      const read = await readPrState({
        prRef: prUrl,
        exec: this.#d.exec,
        cwd: run.worktree ?? config.repoRoot,
        env: this.#d.env,
        timeoutMs: config.commandTimeoutMs,
      });
      if (read.ok) return { prUrl, state: read.state };
      lastError = read.error;
    }
    throw new Blocked(`读取 PR 状态失败：${tail(lastError)}`);
  }

  async #closedBlock(run: RunRecord, prUrl: string): Promise<never> {
    await this.#d.store.event(run.key, "pr_closed", { phase: run.phase });
    throw new Blocked(
      `PR 已被关闭（未合并），需人接手：${prUrl}。自动化不会再往该分支推送，也不会重开 PR。要继续，请先重新打开该 PR，再把工单放回 Todo。`,
    );
  }

  /**
   * Reads the pull request's state at the top of every step once it exists. Closed without merging stops the run (a
   * person takes over); merged counts as delivered.
   */
  async #guardPr(
    run: RunRecord,
    issue: Issue,
    save: (patch: Partial<RunRecord>) => Promise<void>,
  ): Promise<StepResult | undefined> {
    const { store, tracker } = this.#d;
    const { prUrl, state } = await this.#prState(run);
    if (state === "OPEN") return undefined;
    if (state === "CLOSED") return this.#closedBlock(run, prUrl);
    await tracker.comment(issue, `PR 已在自动化之外合并：${prUrl}。按已交付处理，不再重复开 PR。`);
    await tracker.move(issue, "inReview");
    await store.event(run.key, "delivered", { prUrl, rounds: run.round, autoMerge: false });
    await save({ phase: "done" });
    return { status: "delivered", key: run.key, prUrl, autoMerge: false };
  }

  /**
   * After auto-merge is enabled, waits for the pull request to actually merge. GitHub waits silently on a conflict, so a
   * conflicting, closed or never-merging PR blocks the run instead of being taken as delivered.
   */
  async #confirmMerged(run: RunRecord, prUrl: string, worktree: string): Promise<void> {
    const { config, store } = this.#d;
    const sleep = this.#d.sleep ?? ((ms: number) => Bun.sleep(ms));
    const polls = Math.max(
      1,
      Math.ceil(config.mergeTimeoutMs / Math.max(1, config.mergePollIntervalMs)),
    );
    let last = "仍在等待 GitHub 自动合并";
    for (let poll = 0; poll < polls; poll++) {
      if (poll > 0) await sleep(config.mergePollIntervalMs);
      const read = await readPrMergeStatus({
        prRef: prUrl,
        exec: this.#d.exec,
        cwd: worktree,
        env: this.#d.env,
        timeoutMs: config.commandTimeoutMs,
      });
      if (!read.ok) {
        last = `读取 PR 合并状态失败：${tail(read.error)}`;
        continue;
      }
      if (read.status === "merged") return;
      if (read.status === "closed") await this.#closedBlock(run, prUrl);
      if (read.status === "conflicting") {
        await this.#conflictBlock(run, prUrl, worktree, "已开启自动合并，但");
      }
      last = read.status === "mergeable" ? "PR 可合并但尚未合并" : "GitHub 尚未给出合并状态";
    }
    await store.event(run.key, "merge_timeout", { prUrl });
    throw new Blocked(
      `已开启自动合并，但 PR 在 ${Math.round(config.mergeTimeoutMs / 60_000)} 分钟内没有合并（${last}）：${prUrl}。`,
    );
  }

  /** Records `merge_conflict` and blocks: the PR conflicts with the base, so GitHub runs no CI and will not merge it. */
  async #conflictBlock(
    run: RunRecord,
    prUrl: string,
    worktree: string,
    lead: string,
  ): Promise<never> {
    const { config, store } = this.#d;
    const files = await this.#conflictFiles(worktree);
    await store.event(run.key, "merge_conflict", { prUrl, files: files.length });
    throw new Blocked(
      `${lead}PR 与 ${config.baseBranch} 冲突，GitHub 不会跑 CI 也不会合并它：${prUrl}。${
        files.length > 0 ? `冲突文件：${files.join("、")}。` : ""
      }需要把 ${config.baseBranch} 合并进该分支并解决冲突，推送后 CI 通过即会自动合并。`,
    );
  }

  /**
   * The PR conflicts with the base while CI is awaited: merge the base into the branch here, once. A clean merge goes on
   * through verify, QA, push and CI; a real conflict is handed to the Dev session, and judged from the repository after its turn. Out of attempts, it blocks as before.
   */
  async #handleConflict(
    run: RunRecord,
    prUrl: string,
    worktree: string,
    save: (patch: Partial<RunRecord>) => Promise<void>,
  ): Promise<void> {
    const { config } = this.#d;
    // A merge the loop started and a restart cut off is continued; it is not a second attempt.
    if (run.conflict === null && run.conflictRound >= config.maxConflictRounds) {
      const files = await this.#conflictFiles(worktree);
      await this.#d.store.event(run.key, "merge_conflict", { prUrl, files: files.length });
      throw new Blocked(
        `等待 CI 时发现 PR 与 ${config.baseBranch} 冲突，已自动处理过 ${run.conflictRound} 次，不再自动合并：${prUrl}。${
          files.length > 0 ? `冲突文件：${files.join("、")}。` : ""
        }需要人把 ${config.baseBranch} 合并进该分支并解决冲突。`,
      );
    }
    await this.#startMerge(run, worktree, save);
  }

  /**
   * Safe to run again at any point: after the count is saved, after a clean merge, or with a merge left open. A clean
   * merge goes on to verify. A real conflict is left in the worktree and handed to the Dev session (phase `dev`).
   * Returns the conflict, or undefined when the merge was clean.
   */
  async #startMerge(
    run: RunRecord,
    worktree: string,
    save: (patch: Partial<RunRecord>) => Promise<void>,
  ): Promise<{ files: string[]; preMergeSha: string } | undefined> {
    const { config, store } = this.#d;
    const open = await this.#git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], worktree);
    if (open.code !== 0) {
      const status = await this.#git(["status", "--porcelain"], worktree);
      if (status.code !== 0) throw new Blocked(`读取工作区状态失败：${tail(status.output)}`);
      if (status.output.trim() !== "")
        throw new Blocked(
          `PR 与 ${config.baseBranch} 冲突，但工作区有未提交的改动，不自动合并：\n${tail(status.output)}`,
        );
      const fetched = await withRepoLock(config.repoRoot, () =>
        this.#d.exec(["git", ...GIT_SAFE, "fetch", config.remote], {
          cwd: worktree,
          env: deliverEnv(this.#d.env),
          timeoutMs: config.commandTimeoutMs,
        }),
      );
      if (fetched.code !== 0) throw new Blocked(`合并前 git fetch 失败：${tail(fetched.output)}`);
    }
    // HEAD before the merge, saved with the count: a failed resolution goes back to it.
    let preMergeSha = run.conflict?.preMergeSha;
    if (preMergeSha === undefined) {
      const head = await this.#git(["rev-parse", "HEAD"], worktree);
      if (head.code !== 0) throw new Blocked(`读取 HEAD 提交失败：${tail(head.output)}`);
      preMergeSha = head.output.trim();
    }
    // The count is saved before the merge, so a kill in the middle cannot let the same attempt be taken twice.
    if (run.conflict === null)
      await save({
        conflictRound: run.conflictRound + 1,
        conflict: { state: "merging", preMergeSha },
      });
    const attempt = run.conflict === null ? run.conflictRound + 1 : run.conflictRound;
    let merged: ExecResult | undefined;
    if (open.code !== 0) {
      merged = await this.#git(["merge", "--no-edit", config.baseRef], worktree);
      if (merged.code === 0) {
        await store.event(run.key, "conflict_merge", { result: "clean", conflictRound: attempt });
        await save({ conflict: null, phase: "verify" });
        return undefined;
      }
    }
    // A merge that failed without starting leaves nothing to abort: say what git said.
    const started = await this.#git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], worktree);
    if (started.code !== 0) {
      await store.event(run.key, "conflict_merge", { result: "failed", conflictRound: attempt });
      await save({ conflict: null });
      throw new Blocked(
        `Loop 合并 ${config.baseRef} 失败，没有开始合并：${tail(merged?.output ?? "")}`,
      );
    }
    const files = await this.#unmergedFiles(worktree);
    if (files.length === 0) {
      const aborted = await this.#git(["merge", "--abort"], worktree);
      await store.event(run.key, "conflict_merge", {
        result: "conflict",
        conflictRound: attempt,
        files: 0,
      });
      await save({ conflict: null });
      if (aborted.code !== 0)
        throw new Blocked(`合并冲突后撤回合并失败，工作区留在合并中：${tail(aborted.output)}`);
      throw new Blocked(
        `Loop 合并 ${config.baseRef} 停在合并中，但没有读到冲突文件，已撤回合并：${tail(merged?.output ?? "")}`,
      );
    }
    await store.event(run.key, "conflict_merge", {
      result: "conflict",
      conflictRound: attempt,
      files: files.length,
    });
    await save({ conflict: { state: "dev", preMergeSha, files }, phase: "dev" });
    return { files, preMergeSha };
  }

  async #unmergedFiles(worktree: string): Promise<string[]> {
    const listed = await this.#git(["diff", "--name-only", "--diff-filter=U"], worktree);
    return listed.output
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
  }

  /** Titles of the commits on the base, not in the branch before the merge, that touch the conflicted files. */
  async #theirCommits(worktree: string, preMergeSha: string, files: string[]): Promise<string[]> {
    const log = await this.#git(
      ["log", "--format=%s", `${preMergeSha}..${this.#d.config.baseRef}`, "--", ...files],
      worktree,
    );
    return log.output
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
  }

  /**
   * After the conflict turn, decides from the repository whether the conflict is resolved: nothing unmerged, no
   * conflict markers in the files, the base in HEAD's history. An open merge is finished here with `commit --no-edit`.
   * Anything else rolls the worktree back to before the merge and blocks. Runs before the checkpoint, which would
   * otherwise commit the conflict markers.
   */
  async #judgeConflict(
    run: RunRecord,
    conflict: { files: string[]; preMergeSha: string },
    worktree: string,
    save: (patch: Partial<RunRecord>) => Promise<void>,
  ): Promise<void> {
    const { config, store } = this.#d;
    const open = async () =>
      (await this.#git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], worktree)).code === 0;
    const problems: string[] = [];
    // Anchored at the start of a line, with the files taken literally.
    const markers = await this.#git(
      [
        "--literal-pathspecs",
        "grep",
        "--no-index",
        "-l",
        "-E",
        "-e",
        `^(${"<".repeat(7)}|${">".repeat(7)})( |$)`,
        "--",
        ...conflict.files,
      ],
      worktree,
    );
    if (markers.code === 0)
      problems.push(
        `仍有冲突标记：${markers.output
          .split("\n")
          .filter((l) => l.trim() !== "")
          .join("、")}`,
      );
    else if (markers.code !== 1) problems.push(`检查冲突标记失败：${tail(markers.output)}`);
    // A file fixed but not staged still counts as unmerged: stage the files that are clean of markers.
    if (problems.length === 0 && (await open())) {
      await this.#git(["--literal-pathspecs", "add", "-A", "--", ...conflict.files], worktree);
      const unmerged = await this.#unmergedFiles(worktree);
      if (unmerged.length > 0) problems.push(`仍有未解决的文件：${unmerged.join("、")}`);
    }
    if (problems.length === 0 && (await open())) {
      const committed = await this.#git(["commit", "--no-edit"], worktree);
      if (committed.code !== 0) problems.push(`完成合并提交失败：${tail(committed.output)}`);
    }
    if (problems.length === 0) {
      const ancestor = await this.#git(
        ["merge-base", "--is-ancestor", config.baseRef, "HEAD"],
        worktree,
      );
      if (ancestor.code !== 0)
        problems.push(`${config.baseRef} 不在当前分支的历史里（合并被撤回或没有完成）`);
      const kept = await this.#git(
        ["merge-base", "--is-ancestor", conflict.preMergeSha, "HEAD"],
        worktree,
      );
      if (kept.code !== 0) problems.push("分支原来的提交不在当前历史里（被 rebase 或重置过）");
    }
    if (problems.length === 0) {
      await store.event(run.key, "conflict_resolved", { files: conflict.files.length });
      await save({
        conflict: null,
        resolvedFiles: [...new Set([...run.resolvedFiles, ...conflict.files])],
      });
      return;
    }
    const rollback = await this.#rollbackMerge(worktree, conflict.preMergeSha);
    await store.event(run.key, "conflict_unresolved", { files: conflict.files.length });
    await save({ conflict: null });
    throw new Blocked(
      `PR 与 ${config.baseBranch} 冲突，Dev 没有解决：${problems.join("；")}。冲突文件：${conflict.files.join("、")}。${
        rollback === "" ? "已撤回合并，工作区回到合并前。" : rollback
      }`,
    );
  }

  /** Back to before the merge: abort an open one, then reset to the commit it started from. "" when done. */
  async #rollbackMerge(worktree: string, preMergeSha: string): Promise<string> {
    const open = await this.#git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], worktree);
    if (open.code === 0) {
      const aborted = await this.#git(["merge", "--abort"], worktree);
      if (aborted.code !== 0) return `撤回合并失败，工作区留在合并中：${tail(aborted.output)}`;
    }
    const reset = await this.#git(["reset", "--hard", preMergeSha], worktree);
    return reset.code === 0 ? "" : `退回合并前的提交失败：${tail(reset.output)}`;
  }

  /**
   * The scene for a conflict turn. A merge still open, or already finished (the base is in HEAD), is left as it is: a
   * restart or a resend does not merge twice. Otherwise (the merge was aborted) it is made again. A merge that now
   * comes out clean needs no turn: undefined.
   */
  async #conflictScene(
    run: RunRecord,
    worktree: string,
    save: (patch: Partial<RunRecord>) => Promise<void>,
  ): Promise<{ files: string[]; preMergeSha: string } | undefined> {
    const { config } = this.#d;
    const saved = this.#need(run.conflict ?? undefined);
    const open = await this.#git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], worktree);
    const merged = await this.#git(
      ["merge-base", "--is-ancestor", config.baseRef, "HEAD"],
      worktree,
    );
    if (
      saved.preMergeSha !== undefined &&
      saved.files !== undefined &&
      (open.code === 0 || merged.code === 0)
    )
      return { files: saved.files, preMergeSha: saved.preMergeSha };
    return this.#startMerge(run, worktree, save);
  }

  /** Best effort: names the files a merge of the base into the PR head would conflict on. */
  async #conflictFiles(worktree: string): Promise<string[]> {
    const { config, exec, env } = this.#d;
    const opts = { cwd: worktree, env: deliverEnv(env), timeoutMs: config.commandTimeoutMs };
    await withRepoLock(config.repoRoot, () =>
      exec(["git", ...GIT_SAFE, "fetch", config.remote], opts),
    );
    const merged = await exec(
      [
        "git",
        ...GIT_SAFE,
        "merge-tree",
        "--write-tree",
        "--name-only",
        "--no-messages",
        "HEAD",
        config.baseRef,
      ],
      opts,
    );
    if (merged.code !== 1) return [];
    return merged.output
      .split("\n")
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l !== "");
  }

  /** Re-reads the state in the middle of a step, before acting on a PR that may have been closed meanwhile. */
  async #assertNotClosed(run: RunRecord): Promise<void> {
    const { prUrl, state } = await this.#prState(run);
    if (state === "CLOSED") await this.#closedBlock(run, prUrl);
  }

  async #block(
    run: RunRecord,
    issue: Issue,
    reason: string,
    save: (patch: Partial<RunRecord>) => Promise<void>,
  ): Promise<StepResult> {
    const { tracker, store } = this.#d;
    const from = run.phase === "blocked" || run.phase === "done" ? "dev" : run.phase;
    await save({ phase: "blocked", blockedReason: reason, resumeFrom: from });
    await tracker.comment(
      issue,
      `自动化在「${PHASE_NAMES[from]}」卡住了：${reason}\n\n现场已保留：Dev 会话「[${run.key}] Dev」可在 Cycle 桌面端打开接管。处理后把工单放回 Todo，自动化会在原会话里继续。`,
    );
    await tracker.move(issue, "blocked");
    await store.event(run.key, "blocked", { phase: from, round: run.round });
    return { status: "blocked", key: run.key, reason };
  }

  // ---- steps ----

  async #claim(
    run: RunRecord,
    issue: Issue,
    save: (patch: Partial<RunRecord>) => Promise<void>,
  ): Promise<void> {
    const { config, sessions } = this.#d;
    let worktree = run.worktree ?? "";
    if (run.devSessionId === null) {
      // The loop fetches itself: whether the daemon may is undecided (docs/protocol.md, "待定").
      // Fetching needs the remote's credentials; no session has run in the main checkout, so this is safe to give them.
      const fetched = await withRepoLock(config.repoRoot, () =>
        this.#d.exec(["git", ...GIT_SAFE, "fetch", config.remote], {
          cwd: config.repoRoot,
          env: deliverEnv(this.#d.env),
          timeoutMs: config.commandTimeoutMs,
        }),
      );
      if (fetched.code !== 0) throw new Blocked(`git fetch 失败：${tail(fetched.output)}`);
      const created = await sessions.create({
        role: "dev",
        agent: config.devAgent,
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
      await this.#d.store.event(run.key, "dev_session", { new: true });
    }
    // A worktree made now has no node_modules.
    worktree = this.#need(worktree === "" ? undefined : worktree);
    const installed = await this.#d.exec(["bun", "install"], {
      cwd: worktree,
      env: verifyEnv(this.#d.env),
      timeoutMs: config.commandTimeoutMs,
    });
    if (installed.code !== 0) throw new Blocked(`bun install 失败：${tail(installed.output)}`);
    await save({ phase: "dev" });
  }

  async #dev(
    run: RunRecord,
    issue: Issue,
    book: CriteriaBook,
    byPerson: boolean,
    save: (patch: Partial<RunRecord>) => Promise<void>,
  ): Promise<void> {
    const { config, store } = this.#d;
    const worktree = this.#need(run.worktree ?? undefined);
    const progress = await store.readProgress(run.key);
    // A conflict turn: the merge of the base is in the worktree (made again if it is not), and Dev is asked to finish it.
    let conflict: { files: string[]; preMergeSha: string } | undefined;
    if (run.conflict?.state === "dev") {
      const found = await this.#conflictScene(run, worktree, save);
      if (found === undefined) return;
      conflict = found;
    }
    const conflictPrompt =
      conflict === undefined
        ? undefined
        : conflictBrief(
            issue,
            config.baseRef,
            conflict.files,
            await this.#theirCommits(worktree, conflict.preMergeSha, conflict.files),
          );
    const prompt =
      conflictPrompt ??
      (run.findings !== null
        ? fixBrief(run.round, run.findings)
        : progress !== "" || byPerson
          ? continueBrief(issue, byPerson)
          : devBrief(issue, book.items));

    let sessionId = this.#need(run.devSessionId ?? undefined);
    let result: TurnResult;
    try {
      result = await this.#turn(run.key, sessionId, prompt, {
        role: "dev",
        worktree,
        timeoutMs: config.turnTimeoutMs,
      });
    } catch (error) {
      if (!(error instanceof SessionLost)) throw error;
      // It cannot be continued: a new one takes over from what is on disk, not from a replay of the log.
      const gitLog = await this.#git(["log", "--oneline", `${config.baseRef}..HEAD`], worktree);
      const created = await this.#d.sessions.create({
        role: "dev",
        agent: config.devAgent,
        title: `[${run.key}] Dev`,
        // The same name again is the worktree that is there: the daemon reuses it, and files the session under it.
        cwd: config.repoRoot,
        worktree: { base: config.baseRef, name: branchOf(issue.number) },
      });
      await save({
        devSessionId: created.sessionId,
        replacedSessions: [...run.replacedSessions, sessionId],
      });
      sessionId = created.sessionId;
      await store.event(run.key, "dev_session", { replaced: true });
      result = await this.#turn(
        run.key,
        sessionId,
        conflictPrompt ?? handoffBrief(issue, book.items, progress, gitLog.output, run.findings),
        { role: "dev", worktree, timeoutMs: config.turnTimeoutMs },
      );
    }
    await store.event(run.key, "dev_turn", { round: run.round, stop: result.stopReason });
    this.#mustHaveEnded("Dev", result);

    await store.appendProgress(
      run.key,
      run.round,
      parseProgress(result.text) ?? "(the turn ended with no progress block)",
    );
    // Decide first: the checkpoint below would commit conflict markers along with everything else.
    if (conflict !== undefined) await this.#judgeConflict(run, conflict, worktree, save);
    // What is on disk is the checkpoint. Work Dev left uncommitted is committed here, so it is not lost.
    const dirty = await this.#git(["status", "--porcelain"], worktree);
    if (dirty.output.trim() !== "") {
      await this.#git(["add", "-A"], worktree);
      await this.#git(["commit", "-m", `${run.key}: checkpoint (auto-loop)`], worktree);
    }
    await save({ phase: "verify", findings: null });
  }

  async #verify(
    run: RunRecord,
    book: CriteriaBook,
    save: (patch: Partial<RunRecord>) => Promise<void>,
  ): Promise<void> {
    const { config, store, clock } = this.#d;
    const worktree = this.#need(run.worktree ?? undefined);
    const changed = await this.#git(["diff", "--name-only", `${config.baseRef}...HEAD`], worktree);
    const files = changed.output.split("\n").filter((line) => line.trim() !== "");
    const failures: string[] = [];
    if (files.length === 0) failures.push("There is no change on the branch.");

    // The same command is run once, whichever criteria and layers name it.
    const results = new Map<string, ExecResult>();
    const exec: Exec = async (argv, options) => {
      const key = argv.join(" ");
      const known = results.get(key);
      if (known !== undefined) return known;
      let done = await this.#d.exec(argv, options);
      // A flaky command gets re-run in place; a timed-out one does not (it would stretch the round).
      for (
        let attempt = 1;
        attempt <= config.maxVerifyRetries && done.code !== 0 && !done.timedOut;
        attempt++
      ) {
        done = await this.#d.exec(argv, options);
        await store.event(run.key, "verify_retried", {
          round: run.round,
          command: key,
          attempt,
          passed: done.code === 0 && !done.timedOut,
        });
      }
      results.set(key, done);
      return done;
    };
    const env = verifyEnv(this.#d.env);
    const checks: { command: string; passed: boolean }[] = [];
    if (files.length > 0) {
      for (const argv of testLayers(files)) {
        const done = await exec(argv, { cwd: worktree, env, timeoutMs: config.commandTimeoutMs });
        const passed = done.code === 0 && !done.timedOut;
        checks.push({ command: argv.join(" "), passed });
        if (!passed) {
          failures.push(
            `\`${argv.join(" ")}\` ${done.timedOut ? "timed out" : `failed (exit ${done.code})`}:\n${summarizeFailure(done.output).trim()}`,
          );
          break;
        }
      }
    }

    book.reset();
    if (failures.length === 0) {
      for (const criterion of book.items) {
        const done = await book.verify(criterion.id, {
          exec,
          cwd: worktree,
          env,
          timeoutMs: config.commandTimeoutMs,
          now: () => clock.now(),
        });
        if (done.status !== "passed")
          failures.push(
            `Criterion ${done.id} (${done.text}) did not pass:\n${summarizeFailure(done.evidence ?? "").trim()}`,
          );
      }
    }
    await store.saveCriteria(run.key, book);
    this.#checks.set(run.key, checks);
    await store.event(run.key, "verify", {
      round: run.round,
      checks: checks.length,
      criteria: book.items.length,
      passed: book.items.filter((c) => c.status === "passed").length,
    });

    if (failures.length > 0) {
      await this.#nextRound(run, failures.join("\n\n"), save);
      return;
    }
    await save({ phase: "qa" });
  }

  async #qa(
    run: RunRecord,
    issue: Issue,
    book: CriteriaBook,
    save: (patch: Partial<RunRecord>) => Promise<void>,
  ): Promise<void> {
    const { config, store } = this.#d;
    const worktree = this.#need(run.worktree ?? undefined);
    if (run.qaSessionId === null) {
      const sessionId = await this.#newQaSession(run, issue);
      await save({ qaSessionId: sessionId });
      run = { ...run, qaSessionId: sessionId };
    }
    const before = await this.#snapshot(worktree);
    const diff = await this.#git(["diff", `${config.baseRef}...HEAD`], worktree);
    const checks = (this.#checks.get(run.key) ?? [])
      .map((c) => `- ${c.command}: ${c.passed ? "passed" : "failed"}`)
      .join("\n");
    const prompt = qaBrief(
      issue,
      book.items,
      diff.output,
      checks === "" ? "(none)" : checks,
      run.resolvedFiles,
    );

    const maxAttempts = Math.max(1, config.maxQaRetries + 1);
    let verdict: Verdict | undefined;
    let lastFailure = "";
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        // A retry is a new QA session from the same brief; the old one is not trusted.
        await store.event(run.key, "qa_retry", { round: run.round, attempt, reason: lastFailure });
        const created = await this.#newQaSession(run, issue);
        await save({ qaSessionId: created });
        run = { ...run, qaSessionId: created };
      }
      const turnOptions = { role: "qa" as const, worktree, timeoutMs: config.turnTimeoutMs };
      let result: TurnResult;
      try {
        result = await this.#turn(
          run.key,
          this.#need(run.qaSessionId ?? undefined),
          prompt,
          turnOptions,
        );
      } catch (error) {
        if (!(error instanceof SessionLost)) throw error;
        // QA keeps nothing worth carrying over: a new one starts from the same brief.
        const created = await this.#newQaSession(run, issue);
        await save({ qaSessionId: created });
        run = { ...run, qaSessionId: created };
        result = await this.#turn(run.key, created, prompt, turnOptions);
      }
      await store.event(run.key, "qa_turn", {
        round: run.round,
        attempt,
        stop: result.stopReason,
      });

      // Read-only, kept by a check and not by trust: the same commit and the same files as before.
      const after = await this.#snapshot(worktree);
      if (before !== after) throw new Blocked("QA 会话修改了工作区，自动化不信任这次审查结果。");

      if (result.timedOut) {
        lastFailure = "QA 会话单回合超时被取消。";
        continue;
      }
      if (result.stopReason !== "end_turn") {
        lastFailure = `QA 会话回合异常结束（${result.stopReason}）。`;
        continue;
      }
      const parsed = parseVerdict(result.text);
      if (parsed === undefined) {
        lastFailure = "QA 没有给出可以读取的审查结论。";
        continue;
      }
      if (!listsWhatWasChecked(result.text)) {
        lastFailure = "QA 没有写明它检查了什么，自动化不接受没有依据的通过。";
        continue;
      }
      verdict = parsed;
      break;
    }
    if (verdict === undefined)
      throw new Blocked(
        `QA 系统故障（不是代码问题）：共尝试 ${maxAttempts} 次仍没有可用的审查结论。最后一次：${lastFailure}`,
      );
    if (!verdict.pass) {
      await this.#nextRound(run, `Independent review found:\n${formatFindings(verdict)}`, save);
      return;
    }
    await save({ phase: "delivering" });
  }

  async #deliver(
    run: RunRecord,
    issue: Issue,
    book: CriteriaBook,
    save: (patch: Partial<RunRecord>) => Promise<void>,
  ): Promise<void> {
    const { config } = this.#d;
    const worktree = this.#need(run.worktree ?? undefined);
    const env = deliverEnv(this.#d.env);
    const timeoutMs = config.commandTimeoutMs;

    const pushed = await this.#d.exec(
      ["git", ...GIT_SAFE, "push", config.remote, `HEAD:refs/heads/${run.remoteBranch}`],
      { cwd: worktree, env, timeoutMs },
    );
    if (pushed.code !== 0) throw new Blocked(`git push 失败：${tail(pushed.output)}`);

    const commits = await this.#git(
      ["log", "--reverse", "--format=%s", `${config.baseRef}..HEAD`],
      worktree,
    );
    const summary = commits.output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.includes("checkpoint (auto-loop)"))
      .map((line) => `- ${line}`)
      .join("\n");
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const title = renderPrTitle(issue);
    const body = renderPr({
      issue,
      criteria: book.items,
      checks: this.#checks.get(run.key) ?? [],
      rounds: run.round,
      summary,
      sessions: { dev: run.devSessionId, qa: run.qaSessionId },
    });
    const prCheck = validatePr(issue.key, title, body);
    if (!prCheck.ok) throw new Blocked(prCheck.reason);
    const bodyPath = join(config.stateDir, "runs", run.key, "pr-body.md");
    await writeFile(bodyPath, body, { mode: 0o600 });

    let prUrl: string | undefined;
    if (run.prUrl !== null) {
      // Pushing a CI fix to the same branch: keep the existing pull request and refresh its description.
      const edited = await this.#d.exec(
        ["gh", "pr", "edit", run.prUrl, "--title", title, "--body-file", bodyPath],
        { cwd: worktree, env, timeoutMs },
      );
      if (edited.code !== 0) throw new Blocked(`gh pr edit 失败：${tail(edited.output)}`);
      prUrl = run.prUrl;
    } else {
      const created = await this.#d.exec(
        [
          "gh",
          "pr",
          "create",
          "--base",
          config.baseBranch,
          "--head",
          run.remoteBranch,
          "--title",
          title,
          "--body-file",
          bodyPath,
        ],
        { cwd: worktree, env, timeoutMs },
      );
      prUrl = findUrl(created.output);
      if (created.code !== 0 || prUrl === undefined) {
        // The pull request may already be there (a delivery that was cut off after it was made).
        const existing = await this.#d.exec(
          ["gh", "pr", "view", run.remoteBranch, "--json", "url", "--jq", ".url"],
          { cwd: worktree, env, timeoutMs },
        );
        prUrl = findUrl(existing.output);
        if (existing.code !== 0 || prUrl === undefined)
          throw new Blocked(`gh pr create 失败：${tail(created.output)}`);
        const edited = await this.#d.exec(
          ["gh", "pr", "edit", run.remoteBranch, "--title", title, "--body-file", bodyPath],
          { cwd: worktree, env, timeoutMs },
        );
        if (edited.code !== 0) throw new Blocked(`gh pr edit 失败：${tail(edited.output)}`);
      }
    }
    await save({ phase: "ci", prUrl });
  }

  async #ci(run: RunRecord, save: (patch: Partial<RunRecord>) => Promise<void>): Promise<void> {
    const { config, store, clock } = this.#d;
    const worktree = this.#need(run.worktree ?? undefined);
    const prUrl = this.#need(run.prUrl ?? undefined);
    const head = await this.#git(["rev-parse", "HEAD"], worktree);
    if (head.code !== 0) throw new Blocked(`读取 HEAD 提交失败：${tail(head.output)}`);
    const headSha = head.output.trim();

    // No new commit since the red run: a push starts no CI, so rerun the failed jobs and wait for that result.
    let staleFailedUrls: Set<string> | undefined;
    if (run.ciRound > 0 && run.ciFailedSha === headSha) {
      const read = await readCiStatus({
        prRef: prUrl,
        requiredChecks: config.ciChecks,
        expectedHeadSha: headSha,
        exec: this.#d.exec,
        cwd: worktree,
        env: this.#d.env,
        timeoutMs: config.commandTimeoutMs,
      });
      if (!read.ok) throw new Blocked(`读取 CI 状态失败：${tail(read.error)}`);
      if (read.status.state === "failed") {
        const rerun = await rerunFailedCi({
          failed: read.status.failed,
          ciRound: run.ciRound,
          maxCiRetries: config.maxCiRetries,
          exec: this.#d.exec,
          cwd: worktree,
          env: this.#d.env,
          timeoutMs: config.commandTimeoutMs,
        });
        if (!rerun.ok) throw new Blocked(`重新运行 CI 失败：${tail(rerun.error)}`);
        await store.event(run.key, "ci_rerun", { ciRound: run.ciRound, runs: rerun.runIds.length });
        staleFailedUrls = new Set(
          read.status.failed.flatMap((c) => (c.detailsUrl === null ? [] : [c.detailsUrl])),
        );
      }
    }

    const result = await waitForCi({
      staleFailedUrls,
      prRef: prUrl,
      requiredChecks: config.ciChecks,
      expectedHeadSha: headSha,
      exec: this.#d.exec,
      cwd: worktree,
      env: this.#d.env,
      commandTimeoutMs: config.commandTimeoutMs,
      pollIntervalMs: config.ciPollIntervalMs,
      timeoutMs: config.ciTimeoutMs,
      clock,
      sleep: this.#d.sleep ?? ((ms) => Bun.sleep(ms)),
    });

    await this.#assertNotClosed(run);
    if (result.outcome === "error") {
      throw new Blocked(`读取 CI 状态失败：${tail(result.error)}`);
    }
    if (result.outcome === "conflict") {
      await this.#handleConflict(run, prUrl, worktree, save);
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
      await store.event(run.key, "ci_timeout", { ciRound: run.ciRound });
      throw new Blocked(`等待 CI 结果超时（${detail}）。`);
    }
    if (result.outcome === "failed") {
      const failedList = result.status.failed.map((c) => c.name);
      await store.event(run.key, "ci_failed", {
        ciRound: run.ciRound,
        failed: failedList.length,
      });
      await store.event(run.key, "round_failed", { round: run.round });
      if (run.ciRound >= config.maxCiRetries) {
        throw new Blocked(
          `CI 连续失败（已重试 ${run.ciRound} 次达到上限），失败项：${failedList.join("、")}。\n${tail(result.logs, 1500)}`,
        );
      }
      const findings = `CI checks failed on PR ${prUrl} (failed: ${failedList.join(", ")}). Fix the failures below, run \`bun run check\`, and commit; the loop will verify, run QA, and push to the same branch.\n\n${result.logs}`;
      await save({
        phase: "dev",
        round: run.round + 1,
        ciRound: run.ciRound + 1,
        ciFailedSha: headSha,
        findings,
      });
      return;
    }

    this.#ciGreenSha.set(run.key, headSha);
    await store.event(run.key, "ci_passed", { ciRound: run.ciRound });
    await save({ phase: "review", prUrl });
  }

  async #review(
    run: RunRecord,
    issue: Issue,
    book: CriteriaBook,
    save: (patch: Partial<RunRecord>) => Promise<void>,
  ): Promise<{ prUrl: string; autoMerge: boolean } | undefined> {
    const { config, store, tracker } = this.#d;
    const worktree = this.#need(run.worktree ?? undefined);
    const prUrl = this.#need(run.prUrl ?? undefined);
    const head = await this.#git(["rev-parse", "HEAD"], worktree);
    const headSha = head.code === 0 ? head.output.trim() : "";

    // Confirm CI is green for this exact HEAD (re-checks via GitHub after a crash recovery).
    let ciGreen = headSha !== "" && this.#ciGreenSha.get(run.key) === headSha;
    let ciNotGreenReason: string | null = null;
    if (!ciGreen) {
      if (headSha === "") {
        ciNotGreenReason = `读取 HEAD 提交失败：${tail(head.output)}`;
      } else {
        const read = await readCiStatus({
          prRef: prUrl,
          requiredChecks: config.ciChecks,
          expectedHeadSha: headSha,
          exec: this.#d.exec,
          cwd: worktree,
          env: this.#d.env,
          timeoutMs: config.commandTimeoutMs,
        });
        if (read.ok && read.status.state === "passed") {
          ciGreen = true;
          this.#ciGreenSha.set(run.key, headSha);
        } else {
          ciNotGreenReason = read.ok
            ? `CI 状态未全绿（当前为 ${read.status.state}）。`
            : `读取 CI 状态失败：${tail(read.error)}`;
        }
      }
    }

    const diff = await this.#git(["diff", `${config.baseRef}...HEAD`], worktree);
    const maxAttempts = Math.max(1, config.maxReviewRetries + 1);
    let reviewSessionId = run.reviewSessionId;
    let verdict: ReviewVerdict | undefined;
    let lastFailure: string | null = null;
    let attempts = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      attempts = attempt + 1;
      let worktreeModified = false;
      try {
        const created = await this.#d.sessions.create({
          role: "review",
          agent: config.reviewAgent,
          title: `[${run.key}] Review`,
          cwd: config.repoRoot,
          worktree: { base: config.baseRef, name: branchOf(issue.number) },
        });
        reviewSessionId = created.sessionId;
        await save({ reviewSessionId });

        const before = await this.#snapshot(worktree);
        const retryNote =
          attempt > 0 && lastFailure !== null
            ? `Previous review attempt #${attempt} failed (${lastFailure}). Make sure to include a "What I checked" list and end with a valid <review> JSON block choosing "merge", "reject", or "escalate".`
            : undefined;
        const prompt = reviewBrief(
          issue,
          prUrl,
          book.items,
          diff.output,
          config.ciChecks,
          retryNote,
        );
        const result = await this.#turn(run.key, reviewSessionId, prompt, {
          role: "review",
          worktree,
          timeoutMs: config.turnTimeoutMs,
        });
        await store.event(run.key, "review_turn", {
          round: run.round,
          attempt,
          stop: result.stopReason,
        });

        const after = await this.#snapshot(worktree);
        if (before !== after) {
          lastFailure = "评审会话修改了工作区，自动化不信任这次评审结果。";
          worktreeModified = true;
        } else if (result.timedOut) {
          lastFailure = "评审会话单回合超时被取消。";
        } else if (result.stopReason !== "end_turn") {
          lastFailure = `评审会话异常结束（${result.stopReason}）。`;
        } else {
          const parsed = parseReviewVerdict(result.text);
          if (parsed === undefined) {
            lastFailure = "评审会话未给出可解析的结构化结论。";
          } else if (parsed.decision === "merge" && !listsWhatWasChecked(result.text)) {
            lastFailure = "评审结论为合并（merge）但未列出检查内容，不接受无依据的通过。";
          } else {
            verdict = parsed;
            lastFailure = null;
            break;
          }
        }
      } catch (error) {
        lastFailure = `评审会话执行失败：${error instanceof Error ? error.message : String(error)}`;
      }
      if (worktreeModified) break;
      if (attempt + 1 < maxAttempts) {
        await store.event(run.key, "review_retry", { round: run.round, attempt: attempt + 1 });
      }
    }

    await this.#assertNotClosed(run);

    const writeAndPostComment = async (body: string) => {
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const commentPath = join(config.stateDir, "runs", run.key, "review-comment.md");
      await writeFile(commentPath, body, { mode: 0o600 });
      return postPrComment({
        prRef: prUrl,
        bodyPath: commentPath,
        exec: this.#d.exec,
        cwd: worktree,
        env: this.#d.env,
        timeoutMs: config.commandTimeoutMs,
      });
    };

    // No valid conclusion even after retries (or read-only violation): review system failure, not a code issue.
    if (verdict === undefined) {
      const reason = lastFailure ?? "评审会话未给出有效结论。";
      const commented = await writeAndPostComment(
        renderReviewComment({
          issueKey: run.key,
          ciChecks: config.ciChecks,
          ciGreen,
          sessionId: reviewSessionId,
          systemError: { reason, attempts },
        }),
      );
      await store.event(run.key, "review_decided", { decision: "system_error", attempts });
      const commentErrorLine = !commented.ok
        ? `\n写入 PR 评审评论失败：${tail(commented.error)}`
        : "";
      await tracker.comment(
        issue,
        `已开 PR：${prUrl}\n独立评审经 ${attempts} 次尝试仍未得到有效结论，已升级给人处理。注意：这是评审系统故障，不是代码问题。\n原因：${reason}${commentErrorLine}`,
      );
      await tracker.move(issue, "inReview");
      await store.event(run.key, "review_done", {
        decision: "system_error",
        autoMerge: false,
        attempts,
      });
      await store.event(run.key, "delivered", { prUrl, rounds: run.round, autoMerge: false });
      await save({ phase: "done", prUrl });
      return { prUrl, autoMerge: false };
    }

    // Reject: blocker or major issues -> send back to Dev with review feedback (or escalate if fix round limit hit).
    if (verdict.decision === "reject") {
      const limitReached = run.round >= config.maxFixRounds;
      const commented = await writeAndPostComment(
        renderReviewComment({
          issueKey: run.key,
          ciChecks: config.ciChecks,
          ciGreen,
          sessionId: reviewSessionId,
          verdict,
          rejectLimitReached: limitReached,
        }),
      );
      await store.event(run.key, "review_decided", { decision: "reject" });
      await store.event(run.key, "round_failed", { round: run.round });
      const formatted = formatReviewFindings(verdict);

      if (limitReached) {
        const commentErrorLine = !commented.ok
          ? `\n写入 PR 评审评论失败：${tail(commented.error)}`
          : "";
        await tracker.comment(
          issue,
          `已开 PR：${prUrl}\n独立评审拒绝（reject），且已达修复轮数上限（${run.round} 轮），未开启自动合并，升级给人处理：\n${tail(formatted, 1500)}${commentErrorLine}`,
        );
        await tracker.move(issue, "inReview");
        await store.event(run.key, "review_done", { decision: "reject_limit", autoMerge: false });
        await store.event(run.key, "delivered", { prUrl, rounds: run.round, autoMerge: false });
        await save({ phase: "done", prUrl });
        return { prUrl, autoMerge: false };
      }

      this.#ciGreenSha.delete(run.key);
      await store.event(run.key, "review_done", { decision: "reject", autoMerge: false });
      const findings = `PR review rejected ${prUrl} (decision: reject). Fix the blocker/major issues below, run \`bun run check\`, and commit; the loop will verify, run QA, push to the same branch, wait for CI, and re-review.\n\n${formatted}`;
      await save({ phase: "dev", round: run.round + 1, findings });
      return undefined;
    }

    // Merge: enable squash auto-merge only when CI is green and the PR review comment succeeded.
    if (verdict.decision === "merge") {
      const commented = await writeAndPostComment(
        renderReviewComment({
          issueKey: run.key,
          ciChecks: config.ciChecks,
          ciGreen,
          sessionId: reviewSessionId,
          verdict,
        }),
      );
      await store.event(run.key, "review_decided", { decision: "merge" });
      if (ciGreen && commented.ok) {
        const merged = await enableAutoMerge({
          prRef: prUrl,
          exec: this.#d.exec,
          cwd: worktree,
          env: this.#d.env,
          timeoutMs: config.commandTimeoutMs,
        });
        if (merged.ok) {
          await this.#confirmMerged(run, prUrl, worktree);
          await tracker.comment(
            issue,
            `已开 PR：${prUrl}\nCI（${config.ciChecks.join(" / ")}）全部通过，独立评审结论为合并（merge：${verdict.summary}），已开启 GitHub 自动合并（squash）。`,
          );
          await store.event(run.key, "review_done", { decision: "merge", autoMerge: true });
          await store.event(run.key, "delivered", { prUrl, rounds: run.round, autoMerge: true });
          await save({ phase: "done", prUrl });
          return { prUrl, autoMerge: true };
        }
        await tracker.comment(
          issue,
          `已开 PR：${prUrl}\nCI（${config.ciChecks.join(" / ")}）全部通过且独立评审通过，但开启 GitHub 自动合并失败（这是系统/GitHub 操作故障，不是代码问题），需要人工处理：\n${tail(merged.error)}`,
        );
        await tracker.move(issue, "inReview");
        await store.event(run.key, "review_done", { decision: "merge", autoMerge: false });
        await store.event(run.key, "delivered", { prUrl, rounds: run.round, autoMerge: false });
        await save({ phase: "done", prUrl });
        return { prUrl, autoMerge: false };
      }

      const reasonLines: string[] = [];
      if (!ciGreen && ciNotGreenReason !== null) reasonLines.push(ciNotGreenReason);
      if (!commented.ok) reasonLines.push(`写入 PR 评审评论失败：${tail(commented.error)}`);
      await tracker.comment(
        issue,
        `已开 PR：${prUrl}\n独立评审结论为合并，但未满足自动合并前置条件，未开启自动合并，需要人工处理：\n${reasonLines.join("\n")}`,
      );
      await tracker.move(issue, "inReview");
      await store.event(run.key, "review_done", { decision: "system_error", autoMerge: false });
      await store.event(run.key, "delivered", { prUrl, rounds: run.round, autoMerge: false });
      await save({ phase: "done", prUrl });
      return { prUrl, autoMerge: false };
    }

    // Escalate: needs human judgment -> post PR comment, do not enable auto-merge, move to In Review.
    const commented = await writeAndPostComment(
      renderReviewComment({
        issueKey: run.key,
        ciChecks: config.ciChecks,
        ciGreen,
        sessionId: reviewSessionId,
        verdict,
      }),
    );
    await store.event(run.key, "review_decided", { decision: "escalate" });
    const reasonLines: string[] = [verdict.summary];
    for (const reason of verdict.reasons) reasonLines.push(`- ${reason}`);
    for (const finding of verdict.findings) {
      reasonLines.push(`- [${finding.severity}] ${finding.where}: ${finding.problem}`);
    }
    if (!commented.ok) {
      reasonLines.push(`写入 PR 评审评论失败：${tail(commented.error)}`);
    }
    await tracker.comment(
      issue,
      `已开 PR：${prUrl}\nCI（${config.ciChecks.join(" / ")}）已跑完，独立评审结论为升级给人（escalate），未开启自动合并：\n${reasonLines.join("\n")}`,
    );
    await tracker.move(issue, "inReview");
    await store.event(run.key, "review_done", { decision: "escalate", autoMerge: false });
    await store.event(run.key, "delivered", { prUrl, rounds: run.round, autoMerge: false });
    await save({ phase: "done", prUrl });
    return { prUrl, autoMerge: false };
  }

  // ---- helpers ----

  /** What the last verification ran, kept for the QA brief and the pull request. */
  readonly #checks = new Map<string, { command: string; passed: boolean }[]>();
  /** The HEAD commit SHA whose required CI checks passed in this process. */
  readonly #ciGreenSha = new Map<string, string>();

  async #nextRound(
    run: RunRecord,
    findings: string,
    save: (patch: Partial<RunRecord>) => Promise<void>,
  ): Promise<void> {
    await this.#d.store.event(run.key, "round_failed", { round: run.round });
    if (run.round >= this.#d.config.maxFixRounds) {
      throw new Blocked(
        `修复了 ${run.round} 轮仍未通过。最后一次的问题：\n${tail(findings, 1500)}`,
      );
    }
    await save({ phase: "dev", round: run.round + 1, findings });
  }

  async #newQaSession(run: RunRecord, issue: Issue): Promise<string> {
    const { config } = this.#d;
    const created = await this.#d.sessions.create({
      role: "qa",
      agent: config.qaAgent,
      title: `[${run.key}] QA`,
      // The same name again is the worktree that is there: the daemon reuses it, and files the session under it.
      cwd: config.repoRoot,
      worktree: { base: config.baseRef, name: branchOf(issue.number) },
    });
    return created.sessionId;
  }

  /**
   * One turn. When the daemon stopped in the middle of it (an update of Cycle), the same prompt is sent again in the
   * same session, up to `maxInterruptRetries` times; a resend takes no fix round and no review retry.
   */
  async #turn(
    key: string,
    sessionId: string,
    prompt: string,
    context: { role: SessionRole; worktree: string; timeoutMs: number },
  ): Promise<TurnResult> {
    const { config, store } = this.#d;
    for (let resend = 0; ; resend++) {
      const result = await this.#d.sessions.turn(sessionId, prompt, { ...context, run: key });
      if (result.interrupted !== true || result.timedOut) return result;
      if (resend >= config.maxInterruptRetries)
        throw new Blocked(
          `${context.role} 会话的回合被 daemon 反复中断（已重发 ${resend} 次仍被中断）。`,
        );
      await store.event(key, "turn_resent", { role: context.role, resend: resend + 1 });
    }
  }

  #mustHaveEnded(who: string, result: TurnResult): void {
    if (result.timedOut) throw new Blocked(`${who} 会话单回合超时被取消。`);
    if (result.stopReason !== "end_turn")
      throw new Blocked(`${who} 会话回合异常结束（${result.stopReason}）。`);
  }

  /** The commit and the changed files: two snapshots equal means nothing was written in between. */
  async #snapshot(worktree: string): Promise<string> {
    const head = await this.#git(["rev-parse", "HEAD"], worktree);
    const status = await this.#git(["status", "--porcelain"], worktree);
    return `${head.output.trim()}\n${status.output}`;
  }

  async #git(args: string[], cwd: string): Promise<ExecResult> {
    return this.#d.exec(["git", ...GIT_SAFE, ...args], {
      cwd,
      env: verifyEnv(this.#d.env),
      timeoutMs: this.#d.config.commandTimeoutMs,
    });
  }

  #need<T>(value: T | undefined): T {
    if (value === undefined) throw new Error("the run record is missing a value it should have");
    return value;
  }
}

const PHASE_NAMES: Record<string, string> = {
  claimed: "领单",
  dev: "开发",
  verify: "验证",
  qa: "独立审查",
  delivering: "交付",
  ci: "CI 检查",
  review: "PR 评审",
};

const tail = (text: string, max = 800): string =>
  text.length <= max ? text.trim() : `…${text.slice(text.length - max).trim()}`;

const findUrl = (text: string): string | undefined =>
  text
    .split("\n")
    .reverse()
    .find((line) => /^https:\/\/\S+$/.test(line.trim()))
    ?.trim();

export type { Criterion };
