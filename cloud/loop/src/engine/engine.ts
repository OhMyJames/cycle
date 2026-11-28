// What every run shares, whatever it does: the lock and the runs under way, the workers, the sessions, the events,
// the phase field, the network retries, and the loop that drives a run from phase to phase (CYC-318, CYC-479). It
// knows nothing of pull requests, CI or git: that is the flow's (flows/). Each step ends by writing where the run is.

import { AsyncLocalStorage } from "node:async_hooks";
import { type Tuning, tuningToConfig } from "../config-file.ts";
import { CriteriaBook } from "../criteria.ts";
import type { PlanFlow } from "../flows/plan.ts";
import type { PrFlow } from "../flows/pr/index.ts";
import { isNetworkError } from "../network.ts";
import type { At } from "../ports/forge.ts";
import { applyPatch, type RunRecord } from "../store.ts";
import type { Config, ExecResult, Issue, LoopPhase, SessionRole, TurnResult } from "../types.ts";
import { runCleanup } from "./cleanup.ts";
import { DaemonUpdateHold } from "./daemon-hold.ts";
import {
  Blocked,
  branchOf,
  type Deps,
  type Flow,
  type FlowHost,
  type Intake,
  mustHaveEnded,
  NetworkWait,
  type Opening,
  type OwnRun,
  type RunKind,
  type Save,
  type StepResult,
  saveWith,
} from "./flow.ts";
import { deadlineFor, recordHeartbeat, WORKER_BEAT_KEY } from "./heartbeat.ts";
import { stopIfMoved, waitingForBlockers } from "./person.ts";
import { Reconciler, writeIntent } from "./reconcile.ts";
import { putBackRun } from "./reread.ts";
import { waitStateOf, wake } from "./waiting.ts";

/** What the engine runs with beyond `Deps`: the flows and intakes, made with the host they may use. */
export type Wiring = {
  flows: Record<RunKind, Flow>;
  /** Where new work items come from: the `Todo` column. */
  todo: Intake;
  /** The planning node (CYC-322): asked after `Todo`, and only when it is on. */
  plan: PlanFlow;
  /** Pull requests a person opened (CYC-540): asked last, and only when the Project turned it on. */
  pr: PrFlow;
};

export class Engine {
  readonly #deps: Deps;
  readonly #flows: Record<RunKind, Flow>;
  readonly #todo: Intake;
  readonly #plan: PlanFlow;
  readonly #pr: PrFlow;
  /** The `tuning` in force for new steps: the last one that was read and valid. */
  #tuning: Tuning;
  #lastTuningProblem: string | null = null;
  /** The config one step runs with, fixed when it starts: a change to the file does not reach a step under way. */
  readonly #stepConfig = new AsyncLocalStorage<Config>();
  /** Keys of the runs some step is working on now. */
  readonly #active = new Set<string>();
  /** The wait on a daemon update, at most `daemonUpdateHoldMinutes` per version (CYC-561). */
  readonly #daemonHold = new DaemonUpdateHold();
  /** In-flight session id per run key, for supervisor `loop/run/cancel` (CYC-484). */
  readonly #activeSessions = new Map<string, string>();
  #lock: Promise<void> = Promise.resolve();
  #watching = false;
  readonly #reconcile = new Reconciler(() => this.#d);

  constructor(deps: Deps, wire: (host: FlowHost) => Wiring) {
    this.#deps = deps;
    this.#tuning = deps.tuning?.initial ?? {};
    const wiring = wire(this.#host());
    this.#flows = wiring.flows;
    this.#todo = wiring.todo;
    this.#plan = wiring.plan;
    this.#pr = wiring.pr;
  }

  /** Where new runs come from, asked in order: `Todo` first (approved work), then the planning node when it is on. */
  #intakes(config: Config): Intake[] {
    return [
      this.#todo,
      ...(config.planning === null ? [] : [this.#plan.intake()]),
      ...(config.prReview === null ? [] : [this.#pr.intake()]),
    ];
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
      mustHaveEnded,
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

  /** Cancels the active session turn of `key`, if one is currently running (CYC-484). */
  async cancelRun(key: string): Promise<boolean> {
    const sid = this.#activeSessions.get(key);
    return sid !== undefined && this.#deps.sessions.cancel !== undefined
      ? this.#deps.sessions.cancel(sid)
      : false;
  }

  /** Takes up one thing: a run to go on with, or else the next work item. Several steps may run at once. */
  async step(): Promise<StepResult> {
    await this.#reloadTuning();
    return this.#stepConfig.run(this.#configNow(), () => this.#step());
  }

  /** Lets each flow look at the runs waiting on the outside (CYC-550). One at a time; no lock, no session, no move. */
  async watch(): Promise<void> {
    if (this.#watching || this.#deps.config.dryRun) return;
    this.#watching = true;
    try {
      await this.#stepConfig.run(this.#configNow(), async () => {
        for (const flow of Object.values(this.#flows)) {
          try {
            await flow.watch?.();
          } catch (error) {
            this.#d.log(`watch failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      });
    } finally {
      this.#watching = false;
    }
  }

  async #step(): Promise<StepResult> {
    if (this.#d.config.dryRun) return this.#dryRun();
    // What an earlier step could not write to the tracker, before anything new is taken.
    await this.#reconcile.flush(undefined, { capMs: this.#d.mirrorCapMs ?? 10_000 });

    const chosen = await this.#exclusive(() => this.#choose());
    if ("result" in chosen) {
      recordHeartbeat(this.#d.store, WORKER_BEAT_KEY, {
        phase: "idle",
        waitingOn: "idle",
        deadline: null,
      });
      return chosen.result;
    }
    try {
      if ("own" in chosen) return await this.#goOwn(chosen.own);
      if (chosen.resume !== undefined) {
        return await this.#resume(
          chosen.resume.run,
          chosen.resume.issue,
          chosen.resume.byPerson,
          chosen.resume.woken,
        );
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
    | {
        key: string;
        resume: { run: RunRecord; issue: Issue; byPerson: boolean; woken: boolean };
      }
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
      // Waiting and not woken: left alone, the work item is not even read.
      const waiting = waitStateOf(store, run.key);
      if (waiting === "waiting") continue;
      const wanted = await flow.stillWanted(run);
      if (wanted === undefined) continue;
      if (wanted.byPerson && (await waitingForBlockers(this.#d, run, wanted.issue))) continue;
      if (waiting === "due") await wake(store, run.key, run.phase);
      this.#active.add(run.key);
      return {
        key: run.key,
        resume: { run, issue: wanted.issue, byPerson: wanted.byPerson, woken: waiting === "due" },
      };
    }

    if (this.#d.stopped?.() === true) return { result: { status: "idle" } };
    // The daemon has a new version waiting for it to be idle: nothing new is taken until it has switched (CYC-538).
    if (
      this.#daemonHold.holds(
        await this.#d.sessions.updatePending?.().catch(() => null),
        config,
        this.#d,
      )
    )
      return { result: { status: "idle" } };
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
      return this.#open(want.take, this.#flows[kind].open(want.accepted, want.take));
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
        if (opening.graph !== undefined) tx.saveGraph(opening.graph);
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

  async #cleanup(): Promise<void> {
    await runCleanup({
      deps: this.#d,
      flows: this.#flows,
      plan: this.#plan,
      active: this.#active,
    });
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

  async #resume(
    run: RunRecord,
    issue: Issue,
    byPerson: boolean,
    woken: boolean,
  ): Promise<StepResult> {
    const { store } = this.#d;
    let book = await store.loadCriteria(run.key);
    let current = run;
    if (byPerson) {
      const back = await putBackRun(this.#d, this.#flowOf(run), run, issue, book, () =>
        this.#reconcile.flush(issue.id, { capMs: this.#d.mirrorCapMs ?? 10_000 }),
      );
      if ("rejected" in back) return { status: "rejected", key: run.key, reasons: back.rejected };
      ({ run: current, book } = back);
    } else if (woken) {
      // Woken from a wait: not a recovery, nothing to check again; the phase reads what it waited for afresh.
      return this.#drive(current, issue, book, false);
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
    const save: Save = async (patch, also) => {
      run = await saveWith(this.#d.store, applyPatch(run, patch), also);
      if (also) await this.#reconcile.flush(issue.id, { capMs: this.#d.mirrorCapMs ?? 10_000 });
    };
    const flow = this.#flowOf(start);
    try {
      let announce = byPerson;
      // A person put the run back: the flow's checks start from what they left, once.
      let rebase = byPerson;
      for (;;) {
        if (await stopIfMoved(this.#d, flow, run, save)) {
          await this.#clear(run, issue);
          return { status: "idle" };
        }
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
        const wait = run.phase === "ci" ? "ci" : run.phase === "verify" ? "command" : "session";
        recordHeartbeat(this.#d.store, run.key, {
          phase: run.phase,
          waitingOn: wait,
          deadline: deadlineFor(wait, this.#d.clock.now(), this.#d.config),
        });
        const phase = flow.phases[run.phase];
        if (phase === undefined) throw new Error(`a ${flow.kind} run has no phase ${run.phase}`);
        const result = await phase.step({ run, issue, book, announce, save });
        if (result) return result;
        if (phase.announces === true) announce = false;
        // Asked to stop: this phase is over, the next is not begun.
        if (this.#d.stopped?.() === true) return { status: "idle" };
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
      this.#activeSessions.set(key, sessionId);
      recordHeartbeat(store, key, {
        phase: context.role,
        waitingOn: "session",
        deadline: deadlineFor("session", this.#d.clock.now(), config),
      });
      const result = await this.#d.sessions
        .turn(sessionId, prompt, { ...context, run: key })
        .finally(() => this.#activeSessions.delete(key));
      if (result.interrupted !== true || result.timedOut) return result;
      if (resend >= config.maxInterruptRetries)
        throw new Blocked(
          `${context.role} 会话的回合被 daemon 反复中断（已重发 ${resend} 次仍被中断）。`,
        );
      await store.event(key, "turn_resent", { role: context.role, resend: resend + 1 });
    }
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
