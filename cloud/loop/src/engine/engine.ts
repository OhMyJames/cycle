// What every run shares, whatever it does: the lock and the runs under way, the workers, the sessions, the events, the
// phase field, the network retries, and the loop that drives a run from phase to phase (CYC-318, CYC-479).
//
// A run is driven by its flow (flows/): the phases it goes through, how it starts again, how it stops. This file knows
// nothing of pull requests, CI or git: that is the dev flow's. Each step ends by writing where the run is, so a loop
// that is killed, or a work item a person put back, goes on from the same place.

import { AsyncLocalStorage } from "node:async_hooks";
import { type Tuning, tuningToConfig } from "../config-file.ts";
import { CriteriaBook } from "../criteria.ts";
import type { PlanFlow } from "../flows/plan.ts";
import { isNetworkError } from "../network.ts";
import type { At } from "../ports/forge.ts";
import { applyPatch, type RunPatch, type RunRecord } from "../store.ts";
import type { Config, ExecResult, Issue, LoopPhase, SessionRole, TurnResult } from "../types.ts";
import {
  Blocked,
  branchOf,
  type Deps,
  type Flow,
  type FlowHost,
  type Intake,
  NetworkWait,
  type Opening,
  type OwnRun,
  type RunKind,
  type StepResult,
} from "./flow.ts";
import { Reconciler, writeIntent } from "./reconcile.ts";

/** What the engine runs with beyond `Deps`: the flows and intakes, made with the host they may use. */
export type Wiring = {
  flows: Record<RunKind, Flow>;
  /** Where new work items come from: the `Todo` column. */
  todo: Intake;
  /** The planning node (CYC-322): asked after `Todo`, and only when it is on. */
  plan: PlanFlow;
};

export class Engine {
  readonly #deps: Deps;
  readonly #flows: Record<RunKind, Flow>;
  readonly #todo: Intake;
  readonly #plan: PlanFlow;
  /** The `tuning` in force for new steps: the last one that was read and valid. */
  #tuning: Tuning;
  #lastTuningProblem: string | null = null;
  /** The config one step runs with, fixed when it starts: a change to the file does not reach a step under way. */
  readonly #stepConfig = new AsyncLocalStorage<Config>();
  /** Keys of the runs some step is working on now. */
  readonly #active = new Set<string>();
  #lock: Promise<void> = Promise.resolve();
  readonly #reconcile = new Reconciler(() => this.#d);

  constructor(deps: Deps, wire: (host: FlowHost) => Wiring) {
    this.#deps = deps;
    this.#tuning = deps.tuning?.initial ?? {};
    const wiring = wire(this.#host());
    this.#flows = wiring.flows;
    this.#todo = wiring.todo;
    this.#plan = wiring.plan;
  }

  /** Where new runs come from, asked in order: `Todo` first (approved work), then the planning node when it is on. */
  #intakes(config: Config): Intake[] {
    return config.planning === null ? [this.#todo] : [this.#todo, this.#plan.intake()];
  }

  /** What a flow may use. `d` is a getter: the config is the one of the step that calls. */
  #host(): FlowHost {
    const self = this;
    return {
      get d() {
        return self.#d;
      },
      need: (value) => this.#need(value),
      net: (key, command, fn, failure) => this.#net(key, command, fn, failure),
      netExec: (key, command, fn) => this.#netExec(key, command, fn),
      turn: (key, sessionId, prompt, context) => this.#turn(key, sessionId, prompt, context),
      mustHaveEnded: (who, result) => this.#mustHaveEnded(who, result),
      snapshot: (worktree) => this.#snapshot(worktree),
      reconcile: this.#reconcile,
      clear: (run, issue) => this.#clear(run, issue),
      mirror: (key, issue, phase) => this.#mirror(key, issue, phase),
      clearPhase: (key, issue) => this.#clearKey(key, issue),
    };
  }

  #flowOf(run: RunRecord): Flow {
    return this.#flows[run.kind];
  }

  /** The phase field for a run: none once it has stopped. */
  #fieldOf(run: RunRecord): LoopPhase | null {
    if (run.phase === "blocked" || run.phase === "done") return null;
    return this.#flowOf(run).phases[run.phase]?.field ?? null;
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
    // What an earlier step could not write to the tracker, before anything new is taken.
    await this.#reconcile.flush(undefined, { capMs: this.#d.mirrorCapMs ?? 10_000 });

    const chosen = await this.#exclusive(() => this.#choose());
    if ("result" in chosen) return chosen.result;
    try {
      if ("own" in chosen) return await this.#goOwn(chosen.own);
      if (chosen.resume !== undefined) {
        return await this.#resume(chosen.resume.run, chosen.resume.issue, chosen.resume.byPerson);
      }
      return await this.#drive(chosen.run, chosen.issue, chosen.book, false);
    } finally {
      this.#active.delete(chosen.key);
    }
  }

  /** A run of its own: GitHub out of reach is a wait, as for any run; it stays where it was and goes on later. */
  async #goOwn(own: OwnRun): Promise<StepResult> {
    try {
      return await own.go();
    } catch (error) {
      if (error instanceof NetworkWait) {
        await this.#d.store.event(own.key, "network_down", { command: error.command });
        return { status: "network_wait", key: own.key, command: error.command };
      }
      // The tracker out of reach is a wait too; anything else ends the run, or every step would fail at the same place.
      if (error instanceof Error && isNetworkError(error.message)) {
        await this.#d.store.event(own.key, "network_down", { command: "tracker" });
        return { status: "network_wait", key: own.key, command: "tracker" };
      }
      if (own.fail === undefined) throw error;
      return own.fail(error);
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
    | { key: string; own: OwnRun }
  > {
    const { config, store } = this.#d;
    await this.#cleanup();

    const unfinished = await store.unfinished();
    for (const run of unfinished.sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
      if (this.#active.has(run.key)) continue;
      const flow = this.#flowOf(run);
      // A kind turned off with a run under way: the run waits in the state directory until it is on again. Still
      // held below, so its work item is not claimed afresh.
      if (!flow.enabled(config)) continue;
      const wanted = await flow.stillWanted(run);
      if (wanted === undefined) continue;
      this.#active.add(run.key);
      return { key: run.key, resume: { run, issue: wanted.issue, byPerson: wanted.byPerson } };
    }

    if (this.#d.stopped?.() === true) return { result: { status: "idle" } };
    const held = new Set([...this.#active, ...unfinished.map((r) => r.key)]);
    for (const intake of this.#intakes(config)) {
      const want = await intake.want(held);
      if ("idle" in want) continue;
      if ("begin" in want) {
        const own = want.begin;
        this.#active.add(own.key);
        try {
          await own.open();
        } catch (error) {
          this.#active.delete(own.key);
          throw error;
        }
        return { key: own.key, own };
      }
      if ("reject" in want) {
        await intake.reject(want.reject, want.reasons);
        return { result: { status: "rejected", key: want.reject.key, reasons: want.reasons } };
      }
      const kind = want.accepted.kind;
      return this.#open(want.take, this.#flows[kind].open(want.accepted));
    }
    return { result: { status: "idle" } };
  }

  /** Claims a new work item: its run record, its criteria, In Progress, and the `claimed` event. */
  async #open(
    issue: Issue,
    opening: Opening,
  ): Promise<{ key: string; run: RunRecord; issue: Issue; book: CriteriaBook }> {
    const { store } = this.#d;
    const book = CriteriaBook.fromSpecs(opening.specs);
    const run: RunRecord = {
      key: issue.key,
      ...opening.state,
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
      findings: null,
      cleanedAt: null,
      cleanupNote: null,
      startedAt: this.#d.clock.now().toISOString(),
      updatedAt: this.#d.clock.now().toISOString(),
    };
    this.#active.add(issue.key);
    try {
      store.transaction((tx) => {
        tx.saveCriteria(issue.key, book);
        tx.save(run);
        writeIntent(tx, {
          run: issue.key,
          issue,
          kind: "move",
          dedupe: `move:${issue.key}:claimed:${tx.countEvents(issue.key, "claimed") + 1}`,
          payload: { to: "inProgress", from: "todo" },
        });
        tx.event(issue.key, "claimed", opening.claimed);
      });
      await this.#reconcile.flush(issue.id, { capMs: this.#d.mirrorCapMs ?? 10_000 });
    } catch (error) {
      this.#active.delete(issue.key);
      throw error;
    }
    return { key: issue.key, run, issue, book };
  }

  /**
   * Before choosing, tidies the worktrees of runs that are over or stuck (CYC-379, CYC-449):
   * - a work item in Done whose PR is merged, or one in Canceled: the worktree and local branch are removed. Never
   *   forced; a worktree with uncommitted changes is left for a person, with one event;
   * - Done but the PR closed without merging: one `cleanup_skipped_unmerged` event, nothing removed;
   * - Blocked for longer than `blockedReminderDays`: one `blocked_stale` event, nothing removed.
   * A run another step is on is not touched. A failure here never stops the loop from taking work.
   */
  async #cleanup(): Promise<void> {
    const { config, store, log } = this.#d;
    if (config.planning !== null) {
      try {
        await this.#plan.cleanup(this.#active);
      } catch (error) {
        log(
          `cleanup of planning worktrees failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    for (const run of await store.all()) {
      if (run.cleanedAt !== null || run.worktree === null) continue;
      if (run.phase !== "done" && run.phase !== "blocked") continue;
      if (this.#active.has(run.key)) continue;
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
    const { config, tracker, store } = this.#d;
    const note = async (kind: string, data: Record<string, string | number | boolean> = {}) => {
      if (run.cleanupNote === kind) return;
      await store.event(run.key, kind, data);
      await store.save({ ...run, cleanupNote: kind });
    };
    // Only the work item's own worktree: `.../auto/cyc-<n>`.
    const own = `/${branchOf(run.issueNumber)}`;
    if (!worktree.replace(/\/+$/, "").endsWith(own)) return;

    const issue = await tracker.get(run.issueNumber);
    if (issue.columnId === config.columns.canceled)
      return this.#removeWorktree(run, worktree, note);

    if (run.phase === "blocked") {
      const days = config.blockedReminderDays;
      if (days <= 0) return;
      const since = Date.parse(run.updatedAt);
      const waited = Math.floor((this.#d.clock.now().getTime() - since) / 86_400_000);
      if (Number.isNaN(since) || waited < days) return;
      return note("blocked_stale", { days: waited });
    }

    if (issue.columnId !== config.columns.done) return;
    const done = await this.#flowOf(run).whenDone(run);
    if (done === "keep") return;
    if (done !== "remove") return note(done.note);
    return this.#removeWorktree(run, worktree, note);
  }

  /** The safe removal shared by Done and Canceled: no --force, dirty means an event for a person. */
  async #removeWorktree(
    run: RunRecord,
    worktree: string,
    note: (kind: string) => Promise<void>,
  ): Promise<void> {
    const { config, store, clock, workspace } = this.#d;
    const branches = [...new Set([run.localBranch, branchOf(run.issueNumber)])].filter(
      (b): b is string => b !== null,
    );
    const removal = await workspace.remove(this.#at(config.repoRoot), worktree, branches);
    if (removal === "failed") return note("cleanup_failed");
    if (removal === "dirty") return note("cleanup_skipped_dirty");
    await store.event(run.key, "cleaned");
    if (run.phase !== "done") {
      // Blocked, then Canceled: the run is not over. If a person puts the work item back, it starts again from the
      // claim with a new worktree and sessions, so nothing points at what was just removed and it is cleaned later.
      await store.save(
        applyPatch(run, {
          worktree: null,
          localBranch: null,
          devSessionId: null,
          qaSessionId: null,
          findings: null,
          resumeFrom: "claimed",
          cleanedAt: null,
          cleanupNote: null,
          ...this.#flowOf(run).afterRemoved?.(),
        }),
      );
      return;
    }
    await store.save({ ...run, cleanedAt: clock.now().toISOString(), cleanupNote: null });
  }

  /** `--dry-run`: pick and check, and say what would happen. Writes nothing anywhere. */
  async #dryRun(): Promise<StepResult> {
    for (const intake of this.#intakes(this.#d.config)) {
      const want = await intake.want(new Set());
      if ("idle" in want) {
        this.#d.log(want.idle);
        continue;
      }
      if ("begin" in want) return want.begin.would;
      if ("reject" in want)
        return { status: "rejected", key: want.reject.key, reasons: want.reasons };
      return this.#flows[want.accepted.kind].wouldTake(want.take, want.accepted);
    }
    return { status: "idle" };
  }

  async #resume(run: RunRecord, issue: Issue, byPerson: boolean): Promise<StepResult> {
    const { store } = this.#d;
    const book = await store.loadCriteria(run.key);
    let current = run;
    if (byPerson) {
      // A person has been at it: the budget of fix rounds starts again, from where it stopped. The flow resets its own.
      const putBack = await this.#flowOf(run).putBack({
        ...run,
        phase: run.resumeFrom ?? this.#flowOf(run).firstPhase,
        round: 0,
        blockedReason: null,
        resumeFrom: null,
        cleanupNote: null,
      });
      current = store.transaction((tx) => {
        const saved = tx.save(putBack);
        writeIntent(tx, {
          run: run.key,
          issue,
          kind: "move",
          dedupe: `move:${run.key}:resumed:${tx.countEvents(run.key, "resumed") + 1}`,
          payload: { to: "inProgress", from: "todo" },
        });
        tx.event(run.key, "resumed", { phase: saved.phase });
        return saved;
      });
      await this.#reconcile.flush(issue.id, { capMs: this.#d.mirrorCapMs ?? 10_000 });
    } else {
      await store.event(run.key, "recovered", { phase: run.phase });
    }
    // Some flows run their checks again before going on.
    const again = this.#flowOf(current).recheck(current, byPerson);
    if (again !== undefined) current = await store.save({ ...current, phase: again });
    return this.#drive(current, issue, book, byPerson);
  }

  /** Writes down the phase a work item should show (`null` clears), unless it is the one last written down. */
  #mirror(key: string, issue: Issue, phase: LoopPhase | null): void {
    const { store, clock } = this.#d;
    store.transaction((tx) => {
      const last = tx.lastIntent(key, "phase");
      if (last !== undefined && (last.payload as { phase: LoopPhase | null }).phase === phase)
        return;
      writeIntent(tx, {
        run: key,
        issue,
        kind: "phase",
        dedupe: `phase:${key}:${tx.countIntents(key, "phase") + 1}`,
        payload: { phase, at: clock.now().toISOString() },
      });
    });
    // In the background: the field only mirrors the run.
    void this.#reconcile.flush(issue.id);
  }

  /** Delivery or Blocked: clears the phase, waits a short while for it to land, and forgets the run. */
  async #clear(run: RunRecord, issue: Issue): Promise<void> {
    this.#flowOf(run).forget?.(run.key);
    await this.#clearKey(run.key, issue);
  }

  /** Clears the phase written under `key` and waits a short while for it to land. */
  async #clearKey(key: string, issue: Issue): Promise<void> {
    this.#mirror(key, issue, null);
    await this.#reconcile.flush(issue.id, { capMs: this.#d.mirrorCapMs ?? 10_000 });
  }

  async #drive(
    start: RunRecord,
    issue: Issue,
    book: CriteriaBook,
    byPerson: boolean,
  ): Promise<StepResult> {
    let run = start;
    const save = async (patch: RunPatch) => {
      run = await this.#d.store.save(applyPatch(run, patch));
    };
    const flow = this.#flowOf(start);
    try {
      let announce = byPerson;
      // A person put the run back: the flow's checks start from what they left, once.
      let rebase = byPerson;
      for (;;) {
        if (flow.beforePhase !== undefined && run.phase !== "blocked" && run.phase !== "done") {
          const settled = await flow.beforePhase({ run, issue, book, announce, save, rebase });
          rebase = false;
          if (settled !== undefined) {
            await this.#clear(run, issue);
            return settled;
          }
        }
        this.#mirror(run.key, issue, this.#fieldOf(run));
        if (run.phase === "blocked" || run.phase === "done") return { status: "idle" };
        const phase = flow.phases[run.phase];
        if (phase === undefined) throw new Error(`a ${flow.kind} run has no phase ${run.phase}`);
        const result = await phase.step({ run, issue, book, announce, save });
        if (result) return result;
        if (phase.announces === true) announce = false;
      }
    } catch (error) {
      if (error instanceof NetworkWait) {
        await this.#d.store.event(run.key, "network_down", {
          command: error.command,
          phase: run.phase,
        });
        return { status: "network_wait", key: run.key, command: error.command };
      }
      if (!(error instanceof Blocked)) throw error;
      await this.#clear(run, issue);
      const { resumeFrom, asked } = error;
      return flow.block({ run, issue, said: error.message, save, resumeFrom, asked });
    }
  }

  /**
   * One turn. When the daemon stopped in the middle of it (an update of Cycle), the same prompt is sent again in the
   * same session, up to `maxInterruptRetries` times; a resend takes no fix round and no review retry.
   */
  async #turn(
    key: string,
    sessionId: string,
    prompt: string,
    context: { role: SessionRole; worktree: string; timeoutMs: number; readRoots?: string[] },
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
    return this.#d.workspace.snapshot(this.#at(worktree));
  }

  /**
   * Runs a GitHub command; on a network error runs it again after a growing wait, up to `maxNetworkRetries` times.
   * Out of retries it throws `NetworkWait`. Any other failure is returned as it is, for the caller to block on.
   * `failure` gives the output of a failed result, or undefined when it succeeded.
   */
  async #net<T>(
    key: string,
    command: string,
    fn: () => Promise<T>,
    failure: (result: T) => string | undefined,
  ): Promise<T> {
    const { config, store } = this.#d;
    const sleep = this.#d.sleep ?? ((ms: number) => Bun.sleep(ms));
    let result = await fn();
    const down = (r: T) => {
      const f = failure(r);
      return f !== undefined && isNetworkError(f);
    };
    if (!down(result)) return result;
    const delays = config.networkRetryDelaysMs;
    for (let attempt = 1; attempt <= config.maxNetworkRetries; attempt++) {
      await sleep(delays[Math.min(attempt - 1, delays.length - 1)] ?? 0);
      result = await fn();
      const ok = !down(result);
      await store.event(key, "network_retry", { command, attempt, ok });
      if (ok) return result;
    }
    throw new NetworkWait(command);
  }

  /** `#net` for a command that returns an `ExecResult`. */
  #netExec(key: string, command: string, fn: () => Promise<ExecResult>): Promise<ExecResult> {
    return this.#net(key, command, fn, (r) =>
      r.timedOut
        ? "Connection timed out (the command timed out)"
        : r.code !== 0
          ? r.output
          : undefined,
    );
  }

  /** Where a port command runs, and for how long. */
  #at(cwd: string): At {
    return { cwd, timeoutMs: this.#d.config.commandTimeoutMs };
  }

  #need<T>(value: T | undefined): T {
    if (value === undefined) throw new Error("the run record is missing a value it should have");
    return value;
  }
}
