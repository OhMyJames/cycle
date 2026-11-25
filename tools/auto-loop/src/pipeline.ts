// One work item, from the `Todo` column to a pull request, and the way back out when it cannot be done (CYC-318).
//
// The order is: preflight, claim, Dev, the checks (run by this code), independent QA, deliver. Each step ends by
// writing where the run is, so a loop that is killed, or a work item a person put back, goes on from the same place.
//
// This file decides; it does not touch the world. The tracker, the daemon's sessions, git and the shell are the
// interfaces in types.ts.

import { CriteriaBook, type Criterion } from "./criteria.ts";
import { deliverEnv, GIT_SAFE, verifyEnv } from "./env.ts";
import { testLayers } from "./layers.ts";
import { renderPr } from "./pr.ts";
import { preflight, sendBackComment } from "./preflight.ts";
import {
  continueBrief,
  devBrief,
  fixBrief,
  formatFindings,
  handoffBrief,
  parseProgress,
  parseVerdict,
  qaBrief,
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
  type Sessions,
  type Tracker,
  type TurnResult,
} from "./types.ts";

export type StepResult =
  | { status: "idle" }
  | { status: "rejected"; key: string; reasons: string[] }
  | { status: "would-take"; key: string; criteria: number }
  | { status: "delivered"; key: string; prUrl: string }
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
};

/** A run cannot go on without a person. The message is what the person is told. */
class Blocked extends Error {}

const branchOf = (number: number) => `auto/cyc-${number}`;

export class Pipeline {
  readonly #d: Deps;

  constructor(deps: Deps) {
    this.#d = deps;
  }

  /** Takes up one thing: a run to go on with, or else the next work item. */
  async step(): Promise<StepResult> {
    const { config, tracker, store } = this.#d;
    if (config.dryRun) return this.#dryRun();

    for (const run of (await store.unfinished()).sort((a, b) =>
      a.startedAt.localeCompare(b.startedAt),
    )) {
      const issue = await tracker.get(run.issueNumber);
      const putBack =
        issue.columnId === config.columns.todo && issue.labelIds.includes(config.autoLabelId);
      if (run.phase === "blocked") {
        if (!putBack) continue;
        return this.#resume(run, issue, true);
      }
      // Not blocked and not done: the loop that was on it is gone (this one holds the lock).
      return this.#resume(run, issue, false);
    }

    const issue = pickNext(await tracker.listTodo(), config);
    if (issue === undefined) return { status: "idle" };
    const pre = preflight(issue, config);
    if (!pre.ok) {
      await tracker.comment(issue, sendBackComment(pre.reasons));
      await tracker.move(issue, "blocked");
      await store.event(issue.key, "preflight_rejected", { reasons: pre.reasons.length });
      return { status: "rejected", key: issue.key, reasons: pre.reasons };
    }

    const book = CriteriaBook.fromSpecs(pre.specs);
    const run: RunRecord = {
      key: issue.key,
      issueId: issue.id,
      issueNumber: issue.number,
      title: issue.title,
      phase: "claimed",
      round: 0,
      worktree: null,
      localBranch: null,
      remoteBranch: branchOf(issue.number),
      devSessionId: null,
      qaSessionId: null,
      replacedSessions: [],
      blockedReason: null,
      resumeFrom: null,
      prUrl: null,
      findings: null,
      startedAt: this.#d.clock.now().toISOString(),
      updatedAt: this.#d.clock.now().toISOString(),
    };
    await store.saveCriteria(issue.key, book);
    await store.save(run);
    await tracker.move(issue, "inProgress");
    await store.event(issue.key, "claimed", { criteria: pre.specs.length });
    return this.#drive(run, issue, book, false);
  }

  /** `--dry-run`: pick and check, and say what would happen. Writes nothing anywhere. */
  async #dryRun(): Promise<StepResult> {
    const { config, tracker } = this.#d;
    const todo = await tracker.listTodo();
    const issue = pickNext(todo, config);
    if (issue === undefined) {
      const labeled = todo.filter((i) => i.labelIds.includes(config.autoLabelId)).length;
      this.#d.log(`dry run: ${todo.length} in Todo, ${labeled} with the auto label`);
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
      // A person has been at it: the budget of fix rounds starts again, from where it stopped.
      current = {
        ...run,
        phase: run.resumeFrom ?? "dev",
        round: 0,
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
    if (current.phase === "qa" || current.phase === "delivering")
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
            const prUrl = await this.#deliver(run, issue, book);
            await save({ phase: "done", prUrl });
            return { status: "delivered", key: run.key, prUrl };
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
      const fetched = await this.#d.exec(["git", ...GIT_SAFE, "fetch", config.remote], {
        cwd: config.repoRoot,
        env: deliverEnv(this.#d.env),
        timeoutMs: config.commandTimeoutMs,
      });
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
    const prompt =
      run.findings !== null
        ? fixBrief(run.round, run.findings)
        : progress !== "" || byPerson
          ? continueBrief(issue, byPerson)
          : devBrief(issue, book.items);

    let sessionId = this.#need(run.devSessionId ?? undefined);
    let result: TurnResult;
    try {
      result = await this.#d.sessions.turn(sessionId, prompt, {
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
        cwd: worktree,
      });
      await save({
        devSessionId: created.sessionId,
        replacedSessions: [...run.replacedSessions, sessionId],
      });
      sessionId = created.sessionId;
      await store.event(run.key, "dev_session", { replaced: true });
      result = await this.#d.sessions.turn(
        sessionId,
        handoffBrief(issue, book.items, progress, gitLog.output),
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
      const done = await this.#d.exec(argv, options);
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
            `\`${argv.join(" ")}\` ${done.timedOut ? "timed out" : `failed (exit ${done.code})`}:\n${tail(done.output)}`,
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
            `Criterion ${done.id} (${done.text}) did not pass:\n${tail(done.evidence ?? "")}`,
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
      const created = await this.#d.sessions.create({
        role: "qa",
        agent: config.qaAgent,
        title: `[${run.key}] QA`,
        cwd: worktree,
      });
      await save({ qaSessionId: created.sessionId });
      run = { ...run, qaSessionId: created.sessionId };
    }
    const before = await this.#snapshot(worktree);
    const diff = await this.#git(["diff", `${config.baseRef}...HEAD`], worktree);
    const checks = (this.#checks.get(run.key) ?? [])
      .map((c) => `- ${c.command}: ${c.passed ? "passed" : "failed"}`)
      .join("\n");
    const prompt = qaBrief(issue, book.items, diff.output, checks === "" ? "(none)" : checks);

    let result: TurnResult;
    try {
      result = await this.#d.sessions.turn(this.#need(run.qaSessionId ?? undefined), prompt, {
        role: "qa",
        worktree,
        timeoutMs: config.turnTimeoutMs,
      });
    } catch (error) {
      if (!(error instanceof SessionLost)) throw error;
      // QA keeps nothing worth carrying over: a new one starts from the same brief.
      const created = await this.#d.sessions.create({
        role: "qa",
        agent: config.qaAgent,
        title: `[${run.key}] QA`,
        cwd: worktree,
      });
      await save({ qaSessionId: created.sessionId });
      result = await this.#d.sessions.turn(created.sessionId, prompt, {
        role: "qa",
        worktree,
        timeoutMs: config.turnTimeoutMs,
      });
    }
    await store.event(run.key, "qa_turn", { round: run.round, stop: result.stopReason });
    this.#mustHaveEnded("QA", result);

    // Read-only, kept by a check and not by trust: the same commit and the same files as before.
    const after = await this.#snapshot(worktree);
    if (before !== after) throw new Blocked("QA 会话修改了工作区，自动化不信任这次审查结果。");

    const verdict = parseVerdict(result.text);
    if (verdict === undefined) throw new Blocked("QA 没有给出可以读取的审查结论。");
    if (!verdict.pass) {
      await this.#nextRound(run, `Independent review found:\n${formatFindings(verdict)}`, save);
      return;
    }
    await save({ phase: "delivering" });
  }

  async #deliver(run: RunRecord, issue: Issue, book: CriteriaBook): Promise<string> {
    const { config, store, tracker } = this.#d;
    const worktree = this.#need(run.worktree ?? undefined);
    const env = deliverEnv(this.#d.env);
    const timeoutMs = config.commandTimeoutMs;

    const pushed = await this.#d.exec(
      ["git", ...GIT_SAFE, "push", config.remote, `HEAD:refs/heads/${run.remoteBranch}`],
      { cwd: worktree, env, timeoutMs },
    );
    if (pushed.code !== 0) throw new Blocked(`git push 失败：${tail(pushed.output)}`);

    const progress = await store.readProgress(run.key);
    const summary = lastDone(progress);
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const bodyPath = join(config.stateDir, "runs", run.key, "pr-body.md");
    await writeFile(
      bodyPath,
      renderPr({
        issue,
        criteria: book.items,
        checks: this.#checks.get(run.key) ?? [],
        rounds: run.round,
        summary,
        sessions: { dev: run.devSessionId, qa: run.qaSessionId },
      }),
      { mode: 0o600 },
    );
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
        `${run.key} ${run.title}`,
        "--body-file",
        bodyPath,
      ],
      { cwd: worktree, env, timeoutMs },
    );
    let prUrl = findUrl(created.output);
    if (created.code !== 0 || prUrl === undefined) {
      // The pull request may already be there (a delivery that was cut off after it was made).
      const existing = await this.#d.exec(
        ["gh", "pr", "view", run.remoteBranch, "--json", "url", "--jq", ".url"],
        { cwd: worktree, env, timeoutMs },
      );
      prUrl = findUrl(existing.output);
      if (existing.code !== 0 || prUrl === undefined)
        throw new Blocked(`gh pr create 失败：${tail(created.output)}`);
    }
    await tracker.comment(
      issue,
      `已开 PR：${prUrl}\n验收标准全部由自动化执行验证通过，独立 QA 审查通过（修复 ${run.round} 轮）。等待人工审阅合并。`,
    );
    await tracker.move(issue, "inReview");
    await store.event(run.key, "delivered", { prUrl, rounds: run.round });
    return prUrl;
  }

  // ---- helpers ----

  /** What the last verification ran, kept for the QA brief and the pull request. */
  readonly #checks = new Map<string, { command: string; passed: boolean }[]>();

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
};

const tail = (text: string, max = 800): string =>
  text.length <= max ? text.trim() : `…${text.slice(text.length - max).trim()}`;

const findUrl = (text: string): string | undefined =>
  text
    .split("\n")
    .reverse()
    .find((line) => /^https:\/\/\S+$/.test(line.trim()))
    ?.trim();

/** The "done" of the last progress entry: what the change is, in Dev's words. */
const lastDone = (progress: string): string => {
  const entries = progress.split(/^## Turn /m).filter((entry) => entry.trim() !== "");
  const dones = entries
    .map((entry) => /^done:\s*([\s\S]*?)(?:\nnext:|$)/m.exec(entry)?.[1]?.trim())
    .filter((done): done is string => done !== undefined && done !== "");
  return dones.join("\n\n");
};

export type { Criterion };
