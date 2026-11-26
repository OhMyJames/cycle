// What a kind of run does, as against what every run shares (CYC-322).
//
// `Engine` holds what is the same for every run: the lock and the runs under way, the workers, the sessions, the
// events, the phase field, the network retries and the loop that drives a run from phase to phase. A `Flow` holds
// what one kind of run does differently: its phases, how it starts again, how it stops, when its worktree can go.
// An `Intake` is where new runs come from. A new kind is a new flow (and, when its work comes from somewhere else,
// a new intake), not another branch in the pipeline.
//
// A `Flow` is one work item's run: a `RunRecord`, phases the pipeline drives, Blocked when it cannot go on. A run that
// is not one work item's (the planning round, CYC-322) is an `OwnRun` its intake hands over: the pipeline holds its
// key and calls it, and the run keeps its own record and drives itself (flows/plan.ts).

import type { Tuning } from "../config-file.ts";
import type { CriteriaBook } from "../criteria.ts";
import type { Forge } from "../ports/forge.ts";
import type { Tracker } from "../ports/tracker.ts";
import type { Workspace } from "../ports/workspace.ts";
import type { Preflight } from "../preflight.ts";
import type { DevState, LoopStore, ResearchState, RunPatch, RunRecord } from "../store.ts";
import type {
  Clock,
  Config,
  Exec,
  ExecResult,
  Issue,
  Logger,
  LoopPhase,
  SessionRole,
  Sessions,
  TurnResult,
} from "../types.ts";
import type { Reconciler } from "./reconcile.ts";

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
export class NetworkWait extends Error {
  constructor(readonly command: string) {
    super(`network down: ${command}`);
  }
}

export type RunKind = RunRecord["kind"];
export type Phase = RunRecord["phase"];
export type Save = (patch: RunPatch) => Promise<void>;
export type EventData = Record<string, string | number | boolean>;

/**
 * A run cannot go on without a person. The message is what the person is told. `resumeFrom` is where to go on once
 * they put it back, when that is not the phase it stopped in.
 */
export class Blocked extends Error {
  constructor(
    message: string,
    readonly resumeFrom?: Phase,
  ) {
    super(message);
  }
}

export const branchOf = (number: number) => `auto/cyc-${number}`;

export const tail = (text: string, max = 800): string =>
  text.length <= max ? text.trim() : `…${text.slice(text.length - max).trim()}`;

/** The phases as a person reads them, in the comment that says where a run stopped. */
export const PHASE_NAMES: Record<string, string> = {
  claimed: "领单",
  dev: "开发",
  verify: "验证",
  qa: "独立审查",
  delivering: "交付",
  ci: "CI 检查",
  review: "PR 评审",
  research: "调研",
  research_qa: "调研 QA",
  publishing: "发布",
};

/** What a phase is handed: the run as it is now, and how to move it on. */
export type PhaseContext = {
  run: RunRecord;
  issue: Issue;
  book: CriteriaBook;
  /** True for the first session turn after a person put the work item back. */
  announce: boolean;
  save: Save;
};

export type PhaseDef = {
  /** What the work item's phase field shows while the run is in this phase. */
  field: LoopPhase;
  /** One go at the phase: it saves the next phase and returns nothing, or it ends the step with a result. */
  step: (ctx: PhaseContext) => Promise<StepResult | undefined> | Promise<void>;
  /** A session turn that tells a put-back run so: done once, then later turns in the same step do not. */
  announces?: true;
};

/** A ticket preflight that passed: which kind of run it is for, and what that kind needs to start. */
export type Accepted = Extract<Preflight, { ok: true }>;

/** What a new run of a kind starts with, besides what every run starts with. */
export type Opening = {
  /** The criteria the run is checked against; empty for a kind that has none. */
  specs: Parameters<typeof CriteriaBook.fromSpecs>[0];
  /** The kind's own state at the start: for a 大档 dev run, the documents and versions it starts on (CYC-328). */
  state: { kind: "dev"; dev: DevState } | { kind: "research"; research: ResearchState };
  /** The data of the `claimed` event. */
  claimed: EventData;
};

/** The parts of `Engine` a flow may use. `d` is read at each use: it carries the config of the step under way. */
export type FlowHost = {
  readonly d: Deps;
  need<T>(value: T | undefined): T;
  /** Runs a GitHub command, again after a growing wait on a network error; out of retries it throws `NetworkWait`. */
  net<T>(
    key: string,
    command: string,
    fn: () => Promise<T>,
    failure: (result: T) => string | undefined,
  ): Promise<T>;
  netExec(key: string, command: string, fn: () => Promise<ExecResult>): Promise<ExecResult>;
  turn(
    key: string,
    sessionId: string,
    prompt: string,
    context: { role: SessionRole; worktree: string; timeoutMs: number; readRoots?: string[] },
  ): Promise<TurnResult>;
  mustHaveEnded(who: string, result: TurnResult): void;
  snapshot(worktree: string): Promise<string>;
  /** Does what is written down for the tracker (CYC-480). */
  readonly reconcile: Reconciler;
  clear(run: RunRecord, issue: Issue): Promise<void>;
  /**
   * The phase field of a work item a run that is not its own is on (a planning round shaping it): written in the
   * background as for any run, by the work item's key; `clearPhase` clears it and waits a short while for it to land.
   */
  mirror(key: string, issue: Issue, phase: LoopPhase | null): void;
  clearPhase(key: string, issue: Issue): Promise<void>;
};

/** How a run that cannot go on is stopped. */
export type BlockArgs = {
  run: RunRecord;
  issue: Issue;
  said: string;
  save: Save;
  resumeFrom: Phase | undefined;
};

export interface Flow {
  readonly kind: RunKind;
  /** The phases this kind goes through. `blocked` and `done` are not phases of any flow: a run there has stopped. */
  readonly phases: Partial<Record<Phase, PhaseDef>>;
  /** Where a put-back run starts again when it does not say, and the phase a block outside any phase is put in. */
  readonly firstPhase: Phase;
  /** The independent QA session of this kind. */
  readonly qa: {
    role: SessionRole;
    title: (key: string) => string;
    /** What QA's verdict is about, in a system-fault message: not a fault of 代码, or of 调研内容. */
    subject: string;
    /** Folders outside the worktree QA may read; undefined when none. */
    readRoots: (config: Config) => string[] | undefined;
  };
  /** Whether runs of this kind are taken up now. A run of a kind that is off waits in the state directory. */
  enabled(config: Config): boolean;
  /** The kind's part of a new run, from the preflight that accepted it. */
  open(accepted: Accepted): Opening;
  /** `--dry-run`: what would be taken, said and returned. */
  wouldTake(issue: Issue, accepted: Accepted): StepResult;
  /**
   * On restart, a run no step holds: the work item to carry on with, and whether a person put it back; undefined
   * leaves it where it is.
   */
  stillWanted(run: RunRecord): Promise<{ issue: Issue; byPerson: boolean } | undefined>;
  /** On resume, a phase to go back to before going on (checks to run again), or undefined to go on where it is. */
  recheck(run: RunRecord, byPerson: boolean): Phase | undefined;
  /**
   * Before each phase of a run that is under way: a check particular to the kind. It may throw `Blocked`, or settle the
   * run by returning a result. `rebase` is true for the first check after a person put the run back.
   */
  beforePhase?(ctx: PhaseContext & { rebase: boolean }): Promise<StepResult | undefined>;
  /**
   * A person put a blocked run back: the kind's part of what starts again (the budgets of rounds, a merge left open).
   * Gets the run with the common part already reset, and returns it with its own part reset.
   */
  putBack(run: RunRecord): Promise<RunRecord>;
  /** The kind's part of a run whose worktree was removed while it was blocked: what no longer points at anything. */
  afterRemoved?(): RunPatch;
  /** A run ended or stopped: what the flow held in memory for it can go. */
  forget?(key: string): void;
  /** Stops a run that cannot go on without a person, and says so. */
  block(args: BlockArgs): Promise<StepResult>;
  /** A run whose work item is in Done: whether its worktree can go now, or the event to note once instead. */
  whenDone(run: RunRecord): Promise<"remove" | "keep" | { note: string }>;
}

/**
 * A run that is not one work item's (CYC-322: a planning round). It has no `RunRecord`, no phase field of its own and
 * no Blocked: it keeps its own record, drives itself to the end and decides itself what a stop means. `Pipeline` only
 * holds its key while a step is on it, as for any run.
 */
export type OwnRun = {
  /** What `#active` holds while a step is on it, and the `run` of its events. */
  key: string;
  /** Writes what says the run has started. Called while the choice is still locked, so no other step starts it too. */
  open: () => Promise<void>;
  /** Drives the run, after the choice. */
  go: () => Promise<StepResult>;
  /** An error from `go` that is not the network's: the run ends here, so the next one can begin. */
  fail?: (error: unknown) => Promise<StepResult>;
  /** `--dry-run`: what would be started, said instead of `open` and `go`. */
  would: StepResult;
};

/** Where new runs come from. `Pipeline` asks its intakes in order and takes the first that has something. */
export interface Intake {
  /**
   * The next thing to take, skipping the keys in `held`: accepted (with its kind), rejected (with the reasons), a
   * run of its own to start or go on with (`begin`), or nothing, with a line that says why for `--dry-run`.
   */
  want(
    held: ReadonlySet<string>,
  ): Promise<
    | { take: Issue; accepted: Accepted }
    | { reject: Issue; reasons: string[] }
    | { begin: OwnRun }
    | { idle: string }
  >;
  /** What is done with a work item the intake would not take. */
  reject(issue: Issue, reasons: string[]): Promise<void>;
}
