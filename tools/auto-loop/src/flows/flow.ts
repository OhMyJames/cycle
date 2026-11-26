// What a kind of run does, as against what every run shares (CYC-322).
//
// `Pipeline` holds what is the same for every run: the lock and the runs under way, the workers, the sessions, the
// events, the phase field, the network retries and the loop that drives a run from phase to phase. A `Flow` holds
// what one kind of run does differently: its phases, how it starts again, how it stops, when its worktree can go.
// An `Intake` is where new runs come from. A new kind is a new flow (and, when its work comes from somewhere else,
// a new intake), not another branch in the pipeline.

import type { CriteriaBook } from "../criteria.ts";
import type { Deps, StepResult } from "../pipeline.ts";
import type { Preflight } from "../preflight.ts";
import type { Verdict } from "../prompts.ts";
import type { ResearchState, RunRecord } from "../store.ts";
import type { Config, ExecResult, Issue, LoopPhase, SessionRole, TurnResult } from "../types.ts";

export type RunKind = RunRecord["kind"];
export type Phase = RunRecord["phase"];
export type Save = (patch: Partial<RunRecord>) => Promise<void>;
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
  research: ResearchState | null;
  /** The data of the `claimed` event. */
  claimed: EventData;
};

/** The parts of `Pipeline` a flow may use. `d` is read at each use: it carries the config of the step under way. */
export type FlowHost = {
  readonly d: Deps;
  need<T>(value: T | undefined): T;
  netExec(key: string, command: string, fn: () => Promise<ExecResult>): Promise<ExecResult>;
  turn(
    key: string,
    sessionId: string,
    prompt: string,
    context: { role: SessionRole; worktree: string; timeoutMs: number; readRoots?: string[] },
  ): Promise<TurnResult>;
  mustHaveEnded(who: string, result: TurnResult): void;
  snapshot(worktree: string): Promise<string>;
  judge(
    run: RunRecord,
    issue: Issue,
    worktree: string,
    before: string,
    prompt: string,
    save: Save,
  ): Promise<Verdict>;
  newQaSession(run: RunRecord, issue: Issue): Promise<string>;
  nextRound(run: RunRecord, findings: string, save: Save, to?: "dev" | "research"): Promise<void>;
  clear(run: RunRecord, issue: Issue): Promise<void>;
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
  /** Stops a run that cannot go on without a person, and says so. */
  block(args: BlockArgs): Promise<StepResult>;
  /** A run whose work item is in Done: whether its worktree can go now, or the event to note once instead. */
  whenDone(run: RunRecord): Promise<"remove" | "keep" | { note: string }>;
}

/** Where new runs come from. `Pipeline` asks its intakes in order and takes the first that has something. */
export interface Intake {
  /**
   * The next thing to take, skipping the keys in `held`: accepted (with its kind), rejected (with the reasons), or
   * nothing, with a line that says why for `--dry-run`.
   */
  want(
    held: ReadonlySet<string>,
  ): Promise<
    { take: Issue; accepted: Accepted } | { reject: Issue; reasons: string[] } | { idle: string }
  >;
  /** What is done with a work item the intake would not take. */
  reject(issue: Issue, reasons: string[]): Promise<void>;
}
