// One work item, from the `Todo` column to a pull request, and the way back out when it cannot be done (CYC-318).
//
// The order is: preflight, claim, Dev, the checks (run by this code), independent QA, deliver. Each step ends by
// writing where the run is, so a loop that is killed, or a work item a person put back, goes on from the same place.
//
// What one kind of run does differently (its phases, how it goes on and how it stops) is its flow, in flows/; the
// dev flow's phases are the steps in this file, which share the PR guard, conflicts and CI with it. The planning node
// (CYC-322) is asked after `Todo`, only when it is on; a round is a run of its own that drives itself (flows/plan.ts).
//
// This file decides; it does not touch the world. The tracker, the daemon's sessions, git and the shell are the
// interfaces in types.ts.

import { AsyncLocalStorage } from "node:async_hooks";
import { type Tuning, tuningToConfig } from "./config-file.ts";
import { CriteriaBook, type Criterion } from "./criteria.ts";
import { verifyEnv } from "./env.ts";
import { summarizeFailure } from "./failure.ts";
import { devFlow } from "./flows/dev.ts";
import {
  Blocked,
  branchOf,
  type Flow,
  type FlowHost,
  type Intake,
  type Opening,
  type OwnRun,
  type RunKind,
  tail,
} from "./flows/flow.ts";
import { PlanFlow } from "./flows/plan.ts";
import { ResearchFlow } from "./flows/research/index.ts";
import { todoIntake } from "./flows/ticket.ts";
import {
  changedReason,
  DocsChanged,
  docChanges,
  NEEDS_SPEC,
  readFullFlowDocs,
  readFullFlowTexts,
} from "./full-flow.ts";
import { testLayers } from "./layers.ts";
import { isNetworkError } from "./network.ts";
import type { At, Forge, PrState } from "./ports/forge.ts";
import { gitWorkspace } from "./ports/git.ts";
import { githubForge } from "./ports/github.ts";
import type { Tracker } from "./ports/tracker.ts";
import type { Done, Workspace } from "./ports/workspace.ts";
import { renderPr, renderPrTitle, renderReviewComment, validatePr, waitForCi } from "./pr.ts";
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
} from "./prompts/index.ts";
import type { LoopStore, RunRecord } from "./store.ts";
import {
  type Clock,
  type Config,
  type Exec,
  type ExecResult,
  type Issue,
  type Logger,
  type LoopPhase,
  SessionLost,
  type SessionRole,
  type Sessions,
  type TurnResult,
} from "./types.ts";

export type StepResult =
  | { status: "idle" }
  | { status: "rejected"; key: string; reasons: string[] }
  | { status: "would-take"; key: string; criteria: number }
  | { status: "would-take"; key: string; kind: "research"; questions: number }
  | { status: "delivered"; key: string; prUrl: string; autoMerge: boolean }
  /** A research work item is published and Done (CYC-447): its report, and the follow-ups made in Backlog. */
  | { status: "researched"; key: string; docId: number; followups: string[] }
  | { status: "blocked"; key: string; reason: string }
  /** GitHub could not be reached after the retries: the run stays where it was and the loop waits (CYC-444). */
  | { status: "network_wait"; key: string; command: string }
  /** A planning round ended (CYC-322): how many work items it shaped, asked about, stopped on and left alone. */
  | {
      status: "planned";
      key: string;
      shaped: number;
      asked: number;
      stopped: number;
      abandoned: number;
    }
  /** A planning round stopped before shaping (triage could not be used): nothing was written. */
  | { status: "plan_stopped"; key: string; reason: string }
  | { status: "would-plan"; key: string };

export type Deps = {
  config: Config;
  tracker: Tracker;
  sessions: Sessions;
  exec: Exec;
  /** Pull requests, CI, merging and PR comments: every `gh` the loop runs (CYC-477). */
  forge: Forge;
  /** git, worktrees and dependency install: every `git` the loop runs (CYC-477). */
  workspace: Workspace;
  store: LoopStore;
  clock: Clock;
  log: Logger;
  /** The loop's own environment; only the allowlisted parts of it go to the commands it runs. */
  env: Record<string, string | undefined>;
  /** Waits between CI status polls. Defaults to `Bun.sleep`. */
  sleep?: (ms: number) => Promise<void>;
  /** True once the loop has been asked to stop: no new work item is taken, runs already under way go on. */
  stopped?: () => boolean;
  /** How long delivery and Blocked wait for the last phase write to land before going on. Defaults to 10 s. */
  mirrorCapMs?: number;
  /**
   * The Project's `tuning` (CYC-441): what it is at start, and how to read it again. `step()` reads before it takes
   * anything; a read that throws keeps the last good value. Without it, `config` is used as it is.
   */
  tuning?: { initial: Tuning; reload: () => Promise<Tuning> };
};

/** A GitHub command still fails with a network error after its retries: the run waits where it is, nothing is blocked. */
class NetworkWait extends Error {
  constructor(readonly command: string) {
    super(`network down: ${command}`);
  }
}

const PR_STATE_READS = 3;

/** What a caller gives: the ports are made from `exec` and `env` when it does not bring its own. */
export type DepsInput = Omit<Deps, "forge" | "workspace"> &
  Partial<Pick<Deps, "forge" | "workspace">>;

export class Pipeline {
  readonly #deps: Deps;
  /** What each kind of run does differently (flows/). */
  readonly #flows: Record<RunKind, Flow>;
  /** Where new work items come from: the `Todo` column. */
  readonly #todo: Intake;
  /** The planning node (CYC-322): asked after `Todo`, and only when it is on. */
  readonly #plan: PlanFlow;
  /** The `tuning` in force for new steps: the last one that was read and valid. */
  #tuning: Tuning;
  #lastTuningProblem: string | null = null;
  /** `node_modules_kept` events already written, by run, CI round and reason; a run's entries go when it ends. */
  readonly #keptNoted = new Set<string>();
  /** The config one step runs with, fixed when it starts: a change to the file does not reach a step under way. */
  readonly #stepConfig = new AsyncLocalStorage<Config>();
  /** Keys of the runs some step is working on now. */
  readonly #active = new Set<string>();
  #lock: Promise<void> = Promise.resolve();
  /**
   * The phase fields are a best-effort mirror of the run record (it may be stale; the record is the truth). Writes for
   * one run go through one queue, so they land in order; nothing waits for them except delivery and Blocked, and only
   * for a short while.
   */
  readonly #queues = new Map<string, Promise<void>>();
  /** The phase last queued for each run, so the same one is not queued twice. */
  readonly #mirrored = new Map<string, LoopPhase | null>();
  /** The kinds of failure already reported for each run: one log line and one event per kind. */
  readonly #failed = new Map<string, Set<string>>();

  constructor(input: DepsInput) {
    const deps: Deps = {
      ...input,
      forge: input.forge ?? githubForge({ exec: input.exec, env: input.env }),
      workspace:
        input.workspace ??
        gitWorkspace({
          exec: input.exec,
          env: input.env,
          repoRoot: input.config.repoRoot,
          remote: input.config.remote,
        }),
    };
    this.#deps = deps;
    this.#tuning = deps.tuning?.initial ?? {};
    const host = this.#host();
    this.#flows = {
      dev: devFlow(host, {
        claim: ({ run, issue, save }) => this.#claim(run, issue, save),
        dev: ({ run, issue, book, announce, save }) => this.#dev(run, issue, book, announce, save),
        verify: ({ run, book, save }) => this.#verify(run, book, save),
        qa: ({ run, issue, book, save }) => this.#qa(run, issue, book, save),
        deliver: ({ run, issue, book, save }) => this.#deliver(run, issue, book, save),
        ci: ({ run, save }) => this.#ci(run, save),
        review: async ({ run, issue, book, save }) => {
          const done = await this.#review(run, issue, book, save);
          if (done === undefined) return undefined;
          await this.#clear(run, issue);
          return {
            status: "delivered",
            key: run.key,
            prUrl: done.prUrl,
            autoMerge: done.autoMerge,
          };
        },
      }),
      research: new ResearchFlow(host),
    };
    this.#todo = todoIntake(host);
    this.#plan = new PlanFlow(host);
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
      netExec: (key, command, fn) => this.#netExec(key, command, fn),
      turn: (key, sessionId, prompt, context) => this.#turn(key, sessionId, prompt, context),
      mustHaveEnded: (who, result) => this.#mustHaveEnded(who, result),
      snapshot: (worktree) => this.#snapshot(worktree),
      judge: (run, issue, worktree, before, prompt, save) =>
        this.#judge(run, issue, worktree, before, prompt, save),
      newQaSession: (run, issue) => this.#newQaSession(run, issue),
      nextRound: (run, findings, save, to) => this.#nextRound(run, findings, save, to),
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
      return this.#open(want.take, kind, this.#flows[kind].open(want.accepted));
    }
    return { result: { status: "idle" } };
  }

  /** Claims a new work item: its run record, its criteria, In Progress, and the `claimed` event. */
  async #open(
    issue: Issue,
    kind: RunKind,
    opening: Opening,
  ): Promise<{ key: string; run: RunRecord; issue: Issue; book: CriteriaBook }> {
    const { tracker, store } = this.#d;
    const book = CriteriaBook.fromSpecs(opening.specs);
    const run: RunRecord = {
      key: issue.key,
      kind,
      research: opening.research,
      issueId: issue.id,
      issueNumber: issue.number,
      title: issue.title,
      phase: "claimed",
      round: 0,
      ciRound: 0,
      ciFailedSha: null,
      nodeModulesReleased: false,
      fullFlowDocs: opening.fullFlowDocs ?? [],
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
      await store.event(issue.key, "claimed", opening.claimed);
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
      await store.save({
        ...run,
        worktree: null,
        localBranch: null,
        devSessionId: null,
        qaSessionId: null,
        reviewSessionId: null,
        prUrl: null,
        findings: null,
        resumeFrom: "claimed",
        cleanedAt: null,
        cleanupNote: null,
      });
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
        phase: run.resumeFrom ?? this.#flowOf(run).firstPhase,
        round: 0,
        ciRound: 0,
        conflictRound: 0,
        conflict: null,
        resolvedFiles: [],
        blockedReason: null,
        resumeFrom: null,
        cleanupNote: null,
      };
      current = await store.save(current);
      await tracker.move(issue, "inProgress");
      await store.event(run.key, "resumed", { phase: current.phase });
    } else {
      await store.event(run.key, "recovered", { phase: run.phase });
    }
    // Some flows run their checks again before going on (dev: what the checks said is held in memory only).
    const again = this.#flowOf(current).recheck(current, byPerson);
    if (again !== undefined) current = await store.save({ ...current, phase: again });
    return this.#drive(current, issue, book, byPerson);
  }

  /** Queues the write of a phase (`null` clears) and goes on. A failed write is reported once and not retried. */
  #mirror(key: string, issue: Issue, phase: LoopPhase | null): void {
    if (this.#mirrored.has(key) && this.#mirrored.get(key) === phase) return;
    this.#mirrored.set(key, phase);
    const at = this.#d.clock.now();
    const job = (this.#queues.get(key) ?? Promise.resolve())
      .then(() => this.#d.tracker.setLoopPhase(issue, phase, at))
      .catch(async (error) => {
        const kind = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "error";
        const seen = this.#failed.get(key) ?? new Set<string>();
        this.#failed.set(key, seen);
        if (seen.has(kind)) return;
        seen.add(kind);
        const reason = error instanceof Error ? error.message : String(error);
        this.#d.log(`${key}: could not write the phase field (${kind}): ${reason}`);
        await this.#d.store.event(key, "phase_field_failed", { failure: kind }).catch(() => {});
      })
      .finally(() => {
        if (this.#queues.get(key) === job) this.#queues.delete(key);
      });
    this.#queues.set(key, job);
  }

  /** Delivery or Blocked: clears the phase, waits a short while for it to land, and forgets the run. */
  async #clear(run: RunRecord, issue: Issue): Promise<void> {
    for (const id of this.#keptNoted) if (id.startsWith(`${run.key}:`)) this.#keptNoted.delete(id);
    await this.#clearKey(run.key, issue);
  }

  /** Clears the phase written under `key`, waits a short while for it to land, and forgets it. */
  async #clearKey(key: string, issue: Issue): Promise<void> {
    this.#mirror(key, issue, null);
    const queue = this.#queues.get(key);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (queue !== undefined)
      await Promise.race([
        queue,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.#d.mirrorCapMs ?? 10_000);
        }),
      ]);
    clearTimeout(timer);
    this.#mirrored.delete(key);
    this.#failed.delete(key);
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
    const flow = this.#flowOf(start);
    try {
      let announce = byPerson;
      // A person put a 大档 run back: the documents they confirmed are the new baseline, once.
      let rebase = byPerson;
      for (;;) {
        if (run.fullFlowDocs.length > 0 && run.phase !== "blocked" && run.phase !== "done") {
          await this.#checkDocs(run, issue, save, rebase);
          rebase = false;
        }
        if (run.prUrl !== null && run.phase !== "blocked" && run.phase !== "done") {
          const settled = await this.#guardPr(run, issue, save);
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
      return flow.block({ run, issue, said: error.message, save, resumeFrom: error.resumeFrom });
    }
  }

  /** 大档 (CYC-453): the named documents as the run recorded them; a change since blocks the run. */
  async #docTexts<N extends "Spec" | "Design" | "Plan">(
    run: RunRecord,
    issue: Issue,
    names: readonly N[],
  ): Promise<Record<Lowercase<N>, string> | undefined> {
    try {
      return await readFullFlowTexts(run.fullFlowDocs, this.#d.tracker, names, async () =>
        docChanges(run.fullFlowDocs, await this.#d.tracker.listIssueDocuments(issue)),
      );
    } catch (error) {
      if (error instanceof DocsChanged) throw new Blocked(changedReason(error.message));
      throw error;
    }
  }

  /**
   * 大档 (CYC-328): the four documents must still be as the run began. A change blocks, for a person to say whether
   * the plan changed or a document was touched by mistake. When a person has put the run back (`rebase`), what they
   * left, if all four are present and locked, becomes the new baseline.
   */
  async #checkDocs(
    run: RunRecord,
    issue: Issue,
    save: (patch: Partial<RunRecord>) => Promise<void>,
    rebase: boolean,
  ): Promise<void> {
    const linked = await this.#d.tracker.listIssueDocuments(issue);
    if (rebase) {
      const read = readFullFlowDocs(issue, linked);
      if (!read.ok) throw new Blocked(`${NEEDS_SPEC} ${read.reasons.join(" ")}`);
      const changes = docChanges(run.fullFlowDocs, linked);
      if (changes !== undefined) {
        await save({ fullFlowDocs: read.docs });
        await this.#d.store.event(run.key, "docs_rebaselined", { changes });
      }
      return;
    }
    const changes = docChanges(run.fullFlowDocs, linked);
    if (changes !== undefined) throw new Blocked(changedReason(changes));
  }

  /** Reads the PR state, retrying a failed read; an unreadable state blocks, it never counts as open. */
  async #prState(run: RunRecord): Promise<{ prUrl: string; state: PrState }> {
    const { config } = this.#d;
    const prUrl = this.#need(run.prUrl ?? undefined);
    let lastError = "";
    for (let attempt = 0; attempt < PR_STATE_READS; attempt++) {
      const read = await this.#net(
        run.key,
        "gh pr view",
        () => this.#d.forge.prState(this.#at(run.worktree ?? config.repoRoot), prUrl),
        (r) => (r.ok ? undefined : r.error),
      );
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
  async #confirmMerged(
    run: RunRecord,
    prUrl: string,
    worktree: string,
  ): Promise<"merged" | "conflict"> {
    const { config, store } = this.#d;
    const sleep = this.#d.sleep ?? ((ms: number) => Bun.sleep(ms));
    const polls = Math.max(
      1,
      Math.ceil(config.mergeTimeoutMs / Math.max(1, config.mergePollIntervalMs)),
    );
    let last = "仍在等待 GitHub 自动合并";
    for (let poll = 0; poll < polls; poll++) {
      if (poll > 0) await sleep(config.mergePollIntervalMs);
      const read = await this.#net(
        run.key,
        "gh pr view",
        () => this.#d.forge.prMergeStatus(this.#at(worktree), prUrl),
        (r) => (r.ok ? undefined : r.error),
      );
      if (!read.ok) {
        last = `读取 PR 合并状态失败：${tail(read.error)}`;
        continue;
      }
      if (read.status === "merged") return "merged";
      if (read.status === "closed") await this.#closedBlock(run, prUrl);
      if (read.status === "conflicting") return "conflict";
      last = read.status === "mergeable" ? "PR 可合并但尚未合并" : "GitHub 尚未给出合并状态";
    }
    await store.event(run.key, "merge_timeout", { prUrl });
    throw new Blocked(
      `已开启自动合并，但 PR 在 ${Math.round(config.mergeTimeoutMs / 60_000)} 分钟内没有合并（${last}）：${prUrl}。`,
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
    // Before anything else: pushing to a PR with auto-merge on does not turn it off (we have write access), so it would
    // merge on green CI without the new commits being reviewed again. Read it every time; an unreadable state blocks.
    const auto = await this.#d.forge.autoMergeOn(this.#at(worktree), prUrl);
    if (!auto.ok) throw new Blocked(`处理冲突前读取自动合并状态失败，不推送：${tail(auto.error)}`);
    if (auto.enabled) {
      const off = await this.#d.forge.autoMerge(this.#at(worktree), prUrl, false);
      if (!off.ok) throw new Blocked(`处理冲突前关闭自动合并失败，不推送：${tail(off.error)}`);
      await this.#d.store.event(run.key, "auto_merge_disabled", { prUrl });
    }
    // A merge the loop started and a restart cut off is continued; it is not a second attempt.
    if (run.conflict === null && run.conflictRound >= config.maxConflictRounds) {
      const files = await this.#conflictFiles(worktree);
      await this.#d.store.event(run.key, "merge_conflict", { prUrl, files: files.length });
      throw new Blocked(
        `发现 PR 与 ${config.baseBranch} 冲突，已自动处理过 ${run.conflictRound} 次，不再自动合并：${prUrl}。${
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
    const { config, store, workspace } = this.#d;
    const at = this.#at(worktree);
    const open = await workspace.mergeInProgress(at);
    if (!open) {
      const status = await workspace.status(at);
      if (!status.ok) throw new Blocked(`读取工作区状态失败：${tail(status.error)}`);
      if (status.porcelain.trim() !== "")
        throw new Blocked(
          `PR 与 ${config.baseBranch} 冲突，但工作区有未提交的改动，不自动合并：\n${tail(status.porcelain)}`,
        );
      const fetched = await this.#netExec(run.key, "git fetch", () => workspace.fetchMain(at));
      if (fetched.code !== 0) throw new Blocked(`合并前 git fetch 失败：${tail(fetched.output)}`);
    }
    // HEAD before the merge, saved with the count: a failed resolution goes back to it.
    let preMergeSha = run.conflict?.preMergeSha;
    if (preMergeSha === undefined) {
      const head = await workspace.head(at);
      if (!head.ok) throw new Blocked(`读取 HEAD 提交失败：${tail(head.error)}`);
      preMergeSha = head.sha;
    }
    // The count is saved before the merge, so a kill in the middle cannot let the same attempt be taken twice.
    if (run.conflict === null)
      await save({
        conflictRound: run.conflictRound + 1,
        conflict: { state: "merging", preMergeSha },
      });
    const attempt = run.conflict === null ? run.conflictRound + 1 : run.conflictRound;
    let merged: Done | undefined;
    if (!open) {
      merged = await workspace.mergeMain(at, config.baseRef);
      if (merged.ok) {
        await store.event(run.key, "conflict_merge", { result: "clean", conflictRound: attempt });
        await save({ conflict: null, phase: "verify" });
        return undefined;
      }
    }
    // A merge that failed without starting leaves nothing to abort: say what git said.
    const started = await workspace.mergeInProgress(at);
    if (!started) {
      await store.event(run.key, "conflict_merge", { result: "failed", conflictRound: attempt });
      await save({ conflict: null });
      throw new Blocked(
        `Loop 合并 ${config.baseRef} 失败，没有开始合并：${tail(mergeOutput(merged))}`,
      );
    }
    const files = await workspace.unmergedFiles(at);
    if (files.length === 0) {
      const aborted = await workspace.abortMerge(at);
      await store.event(run.key, "conflict_merge", {
        result: "conflict",
        conflictRound: attempt,
        files: 0,
      });
      await save({ conflict: null });
      if (!aborted.ok)
        throw new Blocked(`合并冲突后撤回合并失败，工作区留在合并中：${tail(aborted.error)}`);
      throw new Blocked(
        `Loop 合并 ${config.baseRef} 停在合并中，但没有读到冲突文件，已撤回合并：${tail(mergeOutput(merged))}`,
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

  /** Titles of the commits on the base, not in the branch before the merge, that touch the conflicted files. */
  async #theirCommits(worktree: string, preMergeSha: string, files: string[]): Promise<string[]> {
    return this.#d.workspace.theirCommits(
      this.#at(worktree),
      preMergeSha,
      this.#d.config.baseRef,
      files,
    );
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
    const { config, store, workspace } = this.#d;
    const at = this.#at(worktree);
    const open = () => workspace.mergeInProgress(at);
    const problems: string[] = [];
    const markers = await workspace.conflictMarkers(at, conflict.files);
    if (markers.kind === "found") problems.push(`仍有冲突标记：${markers.files.join("、")}`);
    else if (markers.kind === "error") problems.push(`检查冲突标记失败：${tail(markers.output)}`);
    // A file fixed but not staged still counts as unmerged: stage the files that are clean of markers.
    if (problems.length === 0 && (await open())) {
      await workspace.stage(at, conflict.files);
      const unmerged = await workspace.unmergedFiles(at);
      if (unmerged.length > 0) problems.push(`仍有未解决的文件：${unmerged.join("、")}`);
    }
    if (problems.length === 0 && (await open())) {
      const committed = await workspace.commitMerge(at);
      if (!committed.ok) problems.push(`完成合并提交失败：${tail(committed.error)}`);
    }
    if (problems.length === 0) {
      if (!(await workspace.isAncestor(at, config.baseRef)))
        problems.push(`${config.baseRef} 不在当前分支的历史里（合并被撤回或没有完成）`);
      if (!(await workspace.isAncestor(at, conflict.preMergeSha)))
        problems.push("分支原来的提交不在当前历史里（被 rebase 或重置过）");
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
    const { workspace } = this.#d;
    const at = this.#at(worktree);
    if (await workspace.mergeInProgress(at)) {
      const aborted = await workspace.abortMerge(at);
      if (!aborted.ok) return `撤回合并失败，工作区留在合并中：${tail(aborted.error)}`;
    }
    const reset = await workspace.resetHard(at, preMergeSha);
    return reset.ok ? "" : `退回合并前的提交失败：${tail(reset.error)}`;
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
    const { config, workspace } = this.#d;
    const saved = this.#need(run.conflict ?? undefined);
    const at = this.#at(worktree);
    const open = await workspace.mergeInProgress(at);
    const merged = await workspace.isAncestor(at, config.baseRef);
    if (saved.preMergeSha !== undefined && saved.files !== undefined && (open || merged))
      return { files: saved.files, preMergeSha: saved.preMergeSha };
    return this.#startMerge(run, worktree, save);
  }

  /** Best effort: names the files a merge of the base into the PR head would conflict on. */
  async #conflictFiles(worktree: string): Promise<string[]> {
    const { config, workspace } = this.#d;
    return workspace.conflictProbe(this.#at(worktree), config.baseRef);
  }

  /** Re-reads the state in the middle of a step, before acting on a PR that may have been closed meanwhile. */
  async #assertNotClosed(run: RunRecord): Promise<void> {
    const { prUrl, state } = await this.#prState(run);
    if (state === "CLOSED") await this.#closedBlock(run, prUrl);
  }

  // ---- steps ----

  async #claim(
    run: RunRecord,
    issue: Issue,
    save: (patch: Partial<RunRecord>) => Promise<void>,
  ): Promise<void> {
    const { config, sessions } = this.#d;
    let worktree = run.worktree ?? "";
    // Only a worktree made in this call gets a real install; on resume `bun install` is a no-op.
    const fresh = run.devSessionId === null;
    if (fresh) {
      // The loop fetches itself: whether the daemon may is undecided (docs/protocol.md, "待定").
      // Fetching needs the remote's credentials; no session has run in the main checkout, so this is safe to give them.
      const fetched = await this.#netExec(run.key, "git fetch", () =>
        this.#d.workspace.fetchMain(this.#at(config.repoRoot)),
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
      await this.#d.store.event(run.key, "dev_session", { new: true });
    }
    // A worktree made now has no node_modules.
    worktree = this.#need(worktree === "" ? undefined : worktree);
    const before = fresh ? await this.#freeKb(worktree) : undefined;
    await this.#install(worktree);
    if (fresh) await this.#recordInstall(run.key, worktree, before);
    await save({ phase: "dev", nodeModulesReleased: false });
  }

  /** Installs again when `node_modules` was released; an install that fails is Blocked. */
  async #restoreNodeModules(
    run: RunRecord,
    worktree: string,
    save: (patch: Partial<RunRecord>) => Promise<void>,
  ): Promise<void> {
    if (!run.nodeModulesReleased) return;
    await this.#install(worktree);
    await save({ nodeModulesReleased: false });
    await this.#d.store.event(run.key, "node_modules_restored");
  }

  async #install(worktree: string): Promise<void> {
    const installed = await this.#d.workspace.install(this.#at(worktree));
    if (!installed.ok) throw new Blocked(`bun install 失败：${tail(installed.error)}`);
  }

  /** `node_modules_kept`, once per run, CI round and reason: a wait that is entered again does not repeat it. */
  async #noteKept(run: RunRecord, reason: string): Promise<void> {
    const id = `${run.key}:${run.ciRound}:${reason}`;
    if (this.#keptNoted.has(id)) return;
    this.#keptNoted.add(id);
    await this.#d.store.event(run.key, "node_modules_kept", { reason, ciRound: run.ciRound });
  }

  /**
   * CYC-450: while the run only waits for CI or the merge, the worktree's `node_modules` is not needed, so it is
   * deleted (when `releaseNodeModules` is on). Only git-ignored directories named `node_modules` go, and only when
   * the worktree has no uncommitted change. A failure to delete is not a failure of the run.
   */
  async #releaseNodeModules(
    run: RunRecord,
    worktree: string,
    save: (patch: Partial<RunRecord>) => Promise<void>,
  ): Promise<void> {
    const { config, store, workspace } = this.#d;
    if (!config.releaseNodeModules || run.nodeModulesReleased) return;
    const found = await workspace.nodeModulesDirs(this.#at(worktree));
    if (!found.ok) {
      await this.#noteKept(run, found.reason);
      return;
    }
    const dirs = found.dirs;
    if (dirs.length === 0) return;
    // Marked first: if rm stops halfway or the loop dies, the next Dev or verify installs again.
    await save({ nodeModulesReleased: true });
    const removed = await workspace.releaseNodeModules(this.#at(worktree), dirs);
    if (!removed.ok) {
      await store.event(run.key, "node_modules_release_failed", { reason: "rm_failed" });
      return;
    }
    await store.event(run.key, "node_modules_released", { dirs: dirs.length });
  }

  /** Free space of the volume holding `dir`, in 1 KiB blocks (`df -k`); undefined when it cannot be read. */
  async #freeKb(dir: string): Promise<number | undefined> {
    return this.#d.workspace.freeKb(this.#at(dir));
  }

  /** CYC-448: the volume's free-space drop across `bun install`. Numbers only; a failure never blocks the run. */
  async #recordInstall(run: string, dir: string, before: number | undefined): Promise<void> {
    try {
      const after = before === undefined ? undefined : await this.#freeKb(dir);
      // A negative drop means something else freed space meanwhile: not a usable sample.
      if (before === undefined || after === undefined || before < after) {
        await this.#d.store.event(run, "install_measured", { measured: false });
        return;
      }
      await this.#d.store.event(run, "install_measured", {
        measured: true,
        freeKbBefore: before,
        freeKbAfter: after,
        usedKb: before - after,
      });
    } catch {
      // Measuring is advisory.
    }
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
    // Released while waiting for CI or the merge: installed again before the session starts.
    // Not in the middle of a conflict merge: an install could fail on a conflicted manifest or rewrite bun.lock.
    // The restore in #verify installs once the merge is resolved.
    if (run.conflict?.state !== "dev") await this.#restoreNodeModules(run, worktree, save);
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
          ) +
          (run.nodeModulesReleased
            ? "\n\nDependencies are not installed in this worktree (node_modules was removed while waiting for CI). Resolve package.json and bun.lock first if they are conflicted, then run `bun install` before `bun run check`.\n"
            : "");
    const prompt =
      conflictPrompt ??
      (run.findings !== null
        ? fixBrief(run.round, run.findings)
        : progress !== "" || byPerson
          ? continueBrief(issue, byPerson)
          : devBrief(issue, book.items, await this.#docTexts(run, issue, ["Design", "Plan"])));

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
      const gitLog = await this.#d.workspace.log(this.#at(worktree), config.baseRef);
      const created = await this.#d.sessions.create({
        role: "dev",
        agent: config.devAgent,
        ...(config.devModel ? { model: config.devModel } : {}),
        ...(config.devEffort ? { effort: config.devEffort } : {}),
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
        conflictPrompt ??
          handoffBrief(
            issue,
            book.items,
            progress,
            gitLog,
            run.findings,
            await this.#docTexts(run, issue, ["Design", "Plan"]),
          ),
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
    await this.#d.workspace.checkpoint(this.#at(worktree), `${run.key}: checkpoint (auto-loop)`);
    await save({ phase: "verify", findings: null });
  }

  async #verify(
    run: RunRecord,
    book: CriteriaBook,
    save: (patch: Partial<RunRecord>) => Promise<void>,
  ): Promise<void> {
    const { config, store, clock } = this.#d;
    const worktree = this.#need(run.worktree ?? undefined);
    // Every way into verify (after Dev, a clean conflict merge, a resume) passes here.
    await this.#restoreNodeModules(run, worktree, save);
    const files = await this.#d.workspace.changedFiles(this.#at(worktree), config.baseRef);
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
    const { config } = this.#d;
    const worktree = this.#need(run.worktree ?? undefined);
    if (run.qaSessionId === null) {
      const sessionId = await this.#newQaSession(run, issue);
      await save({ qaSessionId: sessionId });
      run = { ...run, qaSessionId: sessionId };
    }
    const before = await this.#snapshot(worktree);
    const diff = await this.#d.workspace.diff(this.#at(worktree), config.baseRef);
    const checks = (this.#checks.get(run.key) ?? [])
      .map((c) => `- ${c.command}: ${c.passed ? "passed" : "failed"}`)
      .join("\n");
    const prompt = qaBrief(
      issue,
      book.items,
      diff,
      checks === "" ? "(none)" : checks,
      run.resolvedFiles,
      await this.#docTexts(run, issue, ["Spec", "Design", "Plan"]),
    );
    const verdict = await this.#judge(run, issue, worktree, before, prompt, save);
    if (!verdict.pass) {
      await this.#nextRound(run, `Independent review found:\n${formatFindings(verdict)}`, save);
      return;
    }
    await save({ phase: "delivering" });
  }

  /**
   * The QA turn of a dev or a research run: a verdict that says what was checked, from a session that changed nothing.
   * An unusable answer is tried again in a fresh session, up to `maxQaRetries` times; then it blocks as a fault of QA.
   * `before` is the worktree as it was before the brief was made.
   */
  async #judge(
    start: RunRecord,
    issue: Issue,
    worktree: string,
    before: string,
    prompt: string,
    save: (patch: Partial<RunRecord>) => Promise<void>,
  ): Promise<Verdict> {
    const { config, store } = this.#d;
    let run = start;
    const qa = this.#flowOf(run).qa;
    const maxAttempts = Math.max(1, config.maxQaRetries + 1);
    const readRoots = qa.readRoots(config);
    const turnOptions = {
      role: qa.role,
      worktree,
      timeoutMs: config.turnTimeoutMs,
      ...(readRoots !== undefined ? { readRoots } : {}),
    };
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
        `QA 系统故障（不是${qa.subject}问题）：共尝试 ${maxAttempts} 次仍没有可用的审查结论。最后一次：${lastFailure}`,
      );
    return verdict;
  }

  async #deliver(
    run: RunRecord,
    issue: Issue,
    book: CriteriaBook,
    save: (patch: Partial<RunRecord>) => Promise<void>,
  ): Promise<void> {
    const { config } = this.#d;
    const worktree = this.#need(run.worktree ?? undefined);
    const at = this.#at(worktree);

    const pushed = await this.#netExec(run.key, "git push", () =>
      this.#d.workspace.push(at, run.remoteBranch),
    );
    if (pushed.code !== 0) throw new Blocked(`git push 失败：${tail(pushed.output)}`);

    const commits = await this.#d.workspace.commitSubjects(at, config.baseRef);
    const summary = commits
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
      documents: run.fullFlowDocs,
      docsBase: config.docsBase,
    });
    const prCheck = validatePr(issue.key, title, body);
    if (!prCheck.ok) throw new Blocked(prCheck.reason);
    const bodyPath = join(config.stateDir, "runs", run.key, "pr-body.md");
    await writeFile(bodyPath, body, { mode: 0o600 });

    const { forge } = this.#d;
    let prUrl: string | undefined;
    if (run.prUrl !== null) {
      // Pushing a CI fix to the same branch: keep the existing pull request and refresh its description.
      const prUrlNow = run.prUrl;
      const edited = await this.#netForge(run.key, "gh pr edit", () =>
        forge.editPr(at, prUrlNow, { title, bodyPath }),
      );
      if (!edited.ok) throw new Blocked(`gh pr edit 失败：${tail(edited.error)}`);
      prUrl = run.prUrl;
    } else {
      const created = await this.#netForge(run.key, "gh pr create", () =>
        forge.createPr(at, {
          base: config.baseBranch,
          head: run.remoteBranch,
          title,
          bodyPath,
        }),
      );
      if (created.ok) {
        prUrl = created.url;
      } else {
        // The pull request may already be there (a delivery that was cut off after it was made).
        const existing = await this.#netForge(run.key, "gh pr view", () =>
          forge.prFor(at, run.remoteBranch),
        );
        if (!existing.ok) throw new Blocked(`gh pr create 失败：${tail(created.error)}`);
        prUrl = existing.url;
        const edited = await this.#netForge(run.key, "gh pr edit", () =>
          forge.editPr(at, run.remoteBranch, { title, bodyPath }),
        );
        if (!edited.ok) throw new Blocked(`gh pr edit 失败：${tail(edited.error)}`);
      }
    }
    await save({ phase: "ci", prUrl });
  }

  async #ci(run: RunRecord, save: (patch: Partial<RunRecord>) => Promise<void>): Promise<void> {
    const { config, store, clock } = this.#d;
    const worktree = this.#need(run.worktree ?? undefined);
    const prUrl = this.#need(run.prUrl ?? undefined);
    const head = await this.#d.workspace.head(this.#at(worktree));
    if (!head.ok) throw new Blocked(`读取 HEAD 提交失败：${tail(head.error)}`);
    const headSha = head.sha;

    // No new commit since the red run: a push starts no CI, so rerun the failed jobs and wait for that result.
    let staleFailedUrls: Set<string> | undefined;
    if (run.ciRound > 0 && run.ciFailedSha === headSha) {
      const read = await this.#net(
        run.key,
        "gh pr view",
        () => this.#d.forge.ciStatus(this.#at(worktree), prUrl, headSha, config.ciChecks),
        (r) => (r.ok ? undefined : r.error),
      );
      if (!read.ok) throw new Blocked(`读取 CI 状态失败：${tail(read.error)}`);
      if (read.status.state === "failed") {
        // Not retried in place (a retry could rerun twice): on a network error the run waits, and the next step
        // reads the CI status again before it reruns anything.
        const rerun = await this.#d.forge.rerunFailed(this.#at(worktree), read.status.failed, {
          ciRound: run.ciRound,
          maxCiRetries: config.maxCiRetries,
        });
        if (!rerun.ok && isNetworkError(rerun.error)) throw new NetworkWait("gh run rerun");
        if (!rerun.ok) throw new Blocked(`重新运行 CI 失败：${tail(rerun.error)}`);
        await store.event(run.key, "ci_rerun", { ciRound: run.ciRound, runs: rerun.runIds.length });
        staleFailedUrls = new Set(
          read.status.failed.flatMap((c) => (c.detailsUrl === null ? [] : [c.detailsUrl])),
        );
      }
    }

    await this.#releaseNodeModules(run, worktree, save);

    // A network error is retried on the single poll read, so the CI timeout budget is not restarted by it.
    const result = await waitForCi({
      staleFailedUrls,
      prRef: prUrl,
      requiredChecks: config.ciChecks,
      expectedHeadSha: headSha,
      forge: this.#d.forge,
      cwd: worktree,
      commandTimeoutMs: config.commandTimeoutMs,
      pollIntervalMs: config.ciPollIntervalMs,
      timeoutMs: config.ciTimeoutMs,
      clock,
      sleep: this.#d.sleep ?? ((ms) => Bun.sleep(ms)),
      guardRead: (read) =>
        this.#net(run.key, "gh pr view", read, (r) => (r.ok ? undefined : r.error)),
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
    const head = await this.#d.workspace.head(this.#at(worktree));
    const headSha = head.ok ? head.sha : "";

    // Confirm CI is green for this exact HEAD (re-checks via GitHub after a crash recovery).
    let ciGreen = headSha !== "" && this.#ciGreenSha.get(run.key) === headSha;
    let ciNotGreenReason: string | null = null;
    if (!ciGreen) {
      if (headSha === "") {
        ciNotGreenReason = `读取 HEAD 提交失败：${tail(head.ok ? "" : head.error)}`;
      } else {
        const read = await this.#net(
          run.key,
          "gh pr view",
          () => this.#d.forge.ciStatus(this.#at(worktree), prUrl, headSha, config.ciChecks),
          (r) => (r.ok ? undefined : r.error),
        );
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

    const diff = await this.#d.workspace.diff(this.#at(worktree), config.baseRef);
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
          ...(config.reviewModel ? { model: config.reviewModel } : {}),
          ...(config.reviewEffort ? { effort: config.reviewEffort } : {}),
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
          diff,
          config.ciChecks,
          retryNote,
          run.resolvedFiles,
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
      return this.#net(
        run.key,
        "gh pr comment",
        () => this.#d.forge.comment(this.#at(worktree), prUrl, commentPath),
        (r) => (r.ok ? undefined : r.error),
      );
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
        const merged = await this.#net(
          run.key,
          "gh pr merge",
          () => this.#d.forge.autoMerge(this.#at(worktree), prUrl, true),
          (r) => (r.ok ? undefined : r.error),
        );
        if (merged.ok) {
          this.#mirror(run.key, issue, "merge");
          const outcome = await this.#confirmMerged(run, prUrl, worktree);
          if (outcome === "conflict") {
            // Not delivered: merge the base in (auto-merge is turned off first), then CI and review run again.
            await this.#handleConflict(run, prUrl, worktree, save);
            this.#ciGreenSha.delete(run.key);
            return undefined;
          }
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
    to: "dev" | "research" = "dev",
  ): Promise<void> {
    await this.#d.store.event(run.key, "round_failed", { round: run.round });
    if (run.round >= this.#d.config.maxFixRounds) {
      const message = `修复了 ${run.round} 轮仍未通过。最后一次的问题：\n${tail(findings, 1500)}`;
      // Research put back goes on in the research session with these findings; judging the same reply again would
      // only fail again.
      if (to === "research") {
        await save({ findings });
        throw new Blocked(message, "research");
      }
      throw new Blocked(message);
    }
    await save({ phase: to, round: run.round + 1, findings });
  }

  async #newQaSession(run: RunRecord, issue: Issue): Promise<string> {
    const { config } = this.#d;
    const qa = this.#flowOf(run).qa;
    const created = await this.#d.sessions.create({
      role: qa.role,
      agent: config.qaAgent,
      ...(config.qaModel ? { model: config.qaModel } : {}),
      ...(config.qaEffort ? { effort: config.qaEffort } : {}),
      title: qa.title(run.key),
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

  /** `#net` for a port result: `ok`, or an `error` that says whether the network is to blame. */
  #netForge<T extends { ok: boolean }>(
    key: string,
    command: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.#net(key, command, fn, (r) =>
      r.ok ? undefined : String((r as { error?: unknown }).error ?? ""),
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

/** The text of a failed merge, for the message that says what git said. */
const mergeOutput = (done: Done | undefined): string =>
  done !== undefined && !done.ok ? done.error : "";

export type { Criterion };
