// (CYC-475: `db/store.ts` keeps the same in `<stateDir>/loop.db`, and is used where that file exists; `LoopStore` is
// what both implement.)
//
// What the loop remembers between turns, restarts and crashes: one directory per work item under the state directory,
// and one event log. Nothing here is inside a worktree, so a session cannot edit it (CYC-318).
//
//   <stateDir>/runs/CYC-318/run.json       where the run is
//   <stateDir>/runs/CYC-318/criteria.json  the acceptance criteria and their evidence
//   <stateDir>/runs/CYC-318/progress.md    what Dev said it did and means to do next
//   <stateDir>/events.jsonl                one line per thing that happened, for the metrics
//
// The planning node (CYC-322) keeps its rounds apart from the work item runs:
//
//   <stateDir>/plans/<id>/run.json         one round: candidates, triage, the shaping queue and its write-back
//   <stateDir>/plans/<id>/bodies/          the bodies the round's sessions read
//   <stateDir>/plans/memory.json           per work item: last category, body hash, latest comment, stopped
//   <stateDir>/plans/index.json            the open round, the last look at the Backlog and what it saw

import type { Dirent } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CriteriaBook } from "./criteria.ts";

export const PHASES = [
  "claimed",
  "dev",
  "verify",
  "qa",
  "delivering",
  "ci",
  "review",
  "research",
  "research_qa",
  "publishing",
  "blocked",
  "done",
] as const;

/** One follow-up draft being published: its issue once made, and whether it is linked to the research work item. */
const PublishedFollowupSchema = z.object({
  title: z.string(),
  issueId: z.number().int().nullable(),
  /** The new issue's number, for its key in the closing comment. */
  number: z.number().int().nullable(),
  linked: z.boolean(),
});

/**
 * A research run (CYC-447): the questions, the last reply that passed the rules (what gets published), and how far
 * the publication got. Each step of the publication is written here as soon as it is done, so a restart neither
 * repeats nor skips one.
 */
const ResearchStateSchema = z.object({
  questions: z.array(z.string()),
  output: z
    .object({
      summary: z.string(),
      report: z.string(),
      followups: z.array(
        z.object({ type: z.enum(["Feature", "Bug"]), title: z.string(), body: z.string() }),
      ),
    })
    .nullable(),
  docId: z.number().int().nullable(),
  docLinked: z.boolean(),
  conclusionDone: z.boolean(),
  /** One entry per draft, in order, from the moment the output is saved. */
  followups: z.array(PublishedFollowupSchema),
  commented: z.boolean(),
});
export type ResearchState = z.infer<typeof ResearchStateSchema>;

export const RunRecordSchema = z.object({
  key: z.string(),
  /** What kind of work item. A record from before research runs is a dev run. */
  kind: z.enum(["dev", "research"]).default("dev"),
  issueId: z.number().int(),
  issueNumber: z.number().int(),
  title: z.string(),
  phase: z.enum(PHASES),
  /** Fix rounds used so far: Dev turns after the first. */
  round: z.number().int().min(0),
  /** CI retry rounds used so far after a red CI run sent the ticket back to Dev. */
  ciRound: z.number().int().min(0).default(0),
  /** The HEAD commit whose CI run last came back red; the same commit again means no new CI run unless the failed jobs are rerun. */
  ciFailedSha: z.string().nullable().default(null),
  /** CYC-450: the worktree's `node_modules` was deleted while waiting for CI or the merge; Dev installs it again. */
  nodeModulesReleased: z.boolean().default(false),
  /** Times the loop merged the base into the branch after a conflict found while waiting for CI. Counted apart from fix rounds. */
  conflictRound: z.number().int().min(0).default(0),
  /**
   * Set from the moment a conflict merge is started until it ends clean, is resolved or is rolled back: a restart picks
   * it up from here. `merging`: the merge is being made. `dev`: it stopped on a real conflict and the Dev session has
   * the turn; `files` are the conflicted paths and `preMergeSha` is HEAD before the merge, to go back to.
   */
  conflict: z
    .object({
      state: z.enum(["merging", "dev"]),
      preMergeSha: z.string().optional(),
      files: z.array(z.string()).optional(),
    })
    .nullable()
    .default(null),
  /** The files a Dev conflict turn resolved: QA is told to look at them. */
  resolvedFiles: z.array(z.string()).default([]),
  worktree: z.string().nullable(),
  /** The branch the daemon made: `worktree-auto/cyc-318`. */
  localBranch: z.string().nullable(),
  /** The branch the pull request comes from: `auto/cyc-318`. */
  remoteBranch: z.string(),
  devSessionId: z.string().nullable(),
  qaSessionId: z.string().nullable(),
  reviewSessionId: z.string().nullable().default(null),
  /** Sessions that could not be continued and were replaced, oldest first. */
  replacedSessions: z.array(z.string()),
  blockedReason: z.string().nullable(),
  /** The phase to go on from when a person puts a blocked work item back. */
  resumeFrom: z.enum(PHASES).nullable(),
  prUrl: z.string().nullable(),
  /** Research runs only; null for a dev run. */
  research: ResearchStateSchema.nullable().default(null),
  /** 大档 (CYC-328): the Intent / Spec / Design / Plan documents and the versions the run started on; empty for a small one. */
  fullFlowDocs: z
    .array(z.object({ id: z.number().int(), title: z.string(), version: z.number().int() }))
    .default([]),
  /** What QA and the checks said last, for the Dev turn that follows. */
  findings: z.string().nullable(),
  /** When the worktree and local branch were removed after Done and merged; null while they are still there. */
  cleanedAt: z.string().nullable().default(null),
  /** The last cleanup event written for this run, so a worktree left for a person is told once, not every round. */
  cleanupNote: z.string().nullable().default(null),
  startedAt: z.string(),
  updatedAt: z.string(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

/**
 * One planning round's id (CYC-322): its start time with `:` and `.` replaced, so it can name a directory, a worktree
 * and an event's `run` (as `plan-<id>`).
 */
export const planRoundId = (startedAt: Date): string =>
  startedAt.toISOString().replace(/[:.]/g, "-");
export const PLAN_ROUND_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

export const PLAN_PHASES = ["triage", "shaping", "finished", "abandoned"] as const;

/** A shaping reply that passed the checks and QA, as it is written back. */
const ShapedSchema = z.object({
  kind: z.enum(["rewrite", "split"]),
  /** Rewrite: the new title and body (empty for a split). */
  title: z.string(),
  description: z.string(),
  notes: z.string(),
  /** Split: the parts, the first replacing the work item (under a parent) or each a child of the Epic. */
  parts: z.array(
    z.object({ type: z.enum(["Feature", "Bug"]), title: z.string(), description: z.string() }),
  ),
  /** Split of a work item with no parent: what it becomes as an Epic. */
  epic: z.object({ title: z.string(), description: z.string() }).nullable(),
});
export type Shaped = z.infer<typeof ShapedSchema>;

/**
 * One work item in a round's shaping queue, and how far writing it back got. Each step is saved as soon as it is
 * done, so a restart neither repeats nor skips one. Before split `k` is created, `pendingCreate` says so: after a
 * restart the Backlog is searched for it (by parent and title) before creating it again.
 */
const ShapeItemSchema = z.object({
  key: z.string(),
  issueId: z.number().int(),
  number: z.number().int(),
  /** Hash of the title and body when shaping began: writing back checks a person has not changed them since. */
  hash: z.string(),
  /**
   * `asked`: shaping asked questions instead (a comment and 待回答). `abandoned`: a person changed the work item, it
   * left Backlog or was marked to skip, so nothing was written.
   */
  state: z.enum([
    "waiting",
    "shape",
    "shape_qa",
    "writing",
    "done",
    "stopped",
    "asked",
    "abandoned",
  ]),
  /** Shape turns after the first, as `round` for a dev run. */
  round: z.number().int().min(0),
  shapeSessionId: z.string().nullable(),
  qaSessionId: z.string().nullable(),
  /** Why it stopped, for the event and the memory; null unless `state` is `stopped`. */
  stoppedReason: z.string().nullable(),
  originalCommented: z.boolean(),
  rewritten: z.boolean(),
  /** Numbers of the issues split off so far, in order. */
  created: z.array(z.number().int()),
  pendingCreate: z.object({ index: z.number().int().min(0), title: z.string() }).nullable(),
  linked: z.boolean(),
  notesCommented: z.boolean(),
  labelled: z.boolean(),
  /** What the loop's checks or QA said last, for the next shaping turn; null for the first. */
  findings: z.string().nullable().default(null),
  /** The reply that passed the checks and QA: what is written back. Null until then. */
  output: ShapedSchema.nullable().default(null),
  /** Links of the `blocks` chain made so far, in order. */
  linkedCount: z.number().int().min(0).default(0),
  /** For `asked`: the questions, and how far asking got. */
  questions: z.array(z.string()).nullable().default(null),
  askCommented: z.boolean().default(false),
  askLabelled: z.boolean().default(false),
  /** For `stopped`: the comment that says why is posted. */
  stopCommented: z.boolean().default(false),
});
export type ShapeItem = z.infer<typeof ShapeItemSchema>;

/** A planning round (CYC-322): `<stateDir>/plans/<id>/run.json`. */
export const PlanRoundSchema = z.object({
  id: z.string().regex(PLAN_ROUND_ID),
  startedAt: z.string(),
  updatedAt: z.string(),
  phase: z.enum(PLAN_PHASES),
  /** The detached worktree the round's sessions read, or null before it is made and after it is removed. */
  worktree: z.string().nullable(),
  triageSessionId: z.string().nullable(),
  /** Keys of the Backlog work items the round looked at. */
  candidates: z.array(z.string()),
  /** What triage decided, once it passed the checks: a category and a priority per key, and what to shape, in order. */
  triage: z
    .object({
      categories: z.record(z.string(), z.string()),
      priorities: z.record(z.string(), z.enum(["urgent", "high", "medium", "low"])),
      order: z.array(z.string()),
      reasons: z.record(z.string(), z.string()).default({}),
      questions: z.record(z.string(), z.array(z.string())).default({}),
    })
    .nullable(),
  queue: z.array(ShapeItemSchema),
  /** Triage turns after the first. */
  triageRound: z.number().int().min(0).default(0),
  /** What the loop's checks said of triage's last reply, for its next turn; null for the first. */
  triageFindings: z.array(z.string()).nullable().default(null),
  /** Per candidate, the triage write-backs done (`priority`, `priorityComment`, `askComment`, `askLabel`). */
  triageDone: z.record(z.string(), z.array(z.string())).default({}),
  /** Why the round stopped before shaping (triage could not be used); null otherwise. */
  stoppedReason: z.string().nullable().default(null),
  /** When the round ended. */
  endedAt: z.string().nullable().default(null),
});
export type PlanRound = z.infer<typeof PlanRoundSchema>;
/** A round as it may be saved: the fields added after the first rounds may be left out, and take their defaults. */
export type PlanRoundInput = z.input<typeof PlanRoundSchema>;

/** What the planner remembers about a work item between rounds, to skip one that has not changed. */
const PlanMemoryEntrySchema = z.object({
  category: z.string().nullable(),
  bodyHash: z.string(),
  /** ISO time of the latest comment when it was last looked at; null when it had none. */
  lastCommentAt: z.string().nullable(),
  /** Shaping stopped on it; it is not tried again until its body or comments change. */
  stopped: z.boolean(),
});
export const PlanMemorySchema = z.record(z.string(), PlanMemoryEntrySchema);
export type PlanMemory = z.infer<typeof PlanMemorySchema>;

/** The Backlog as the planner last saw it (`takeSnapshot`): a signature per row, the latest comment of the watched ones. */
const BacklogSnapshotSchema = z.object({
  rows: z.record(z.string(), z.string()),
  comments: z.record(z.string(), z.string().nullable()),
});

/**
 * `plans/index.json`: what the planning intake needs on an idle step, so it reads no past round (CYC-322). One per
 * Project, shared by its workers.
 */
export const PlanIndexSchema = z.object({
  /** The round started and not ended, if any. */
  open: z.string().nullable().default(null),
  /** When the Backlog was last looked at for a change: at most once every `checkMinutes`. */
  lastCheckedAt: z.string().nullable().default(null),
  /** When the last round ended, or the last look found nothing to plan (which makes no round). */
  lastEndedAt: z.string().nullable().default(null),
  /** The Backlog then, taken after the round's own writes. */
  snapshot: BacklogSnapshotSchema.nullable().default(null),
  /** Worktrees of ended rounds that could not be removed then; `#cleanup` tries again. */
  leftovers: z.array(z.object({ id: z.string(), worktree: z.string() })).default([]),
});
export type PlanIndex = z.infer<typeof PlanIndexSchema>;

export type LoopEvent = { ts: string; run: string; kind: string } & Record<
  string,
  string | number | boolean
>;

export const writeAtomic = async (path: string, text: string): Promise<void> => {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, text, { mode: 0o600 });
  await rename(temp, path);
};

/** What the loop reads and writes of its state, whichever way it is kept: files (`RunStore`) or `loop.db` (`SqliteStore`). */
export interface LoopStore {
  load(key: string): Promise<RunRecord | undefined>;
  save(record: RunRecord): Promise<RunRecord>;
  all(): Promise<RunRecord[]>;
  unfinished(): Promise<RunRecord[]>;
  planBodiesDir(id: string): string;
  loadPlan(id: string): Promise<PlanRound | undefined>;
  savePlan(round: PlanRoundInput): Promise<PlanRound>;
  unfinishedPlans(): Promise<PlanRound[]>;
  writePlanBody(id: string, key: string, text: string): Promise<void>;
  plans(): Promise<PlanRound[]>;
  loadPlanIndex(): Promise<PlanIndex>;
  savePlanIndex(index: PlanIndex): Promise<void>;
  loadPlanMemory(): Promise<PlanMemory>;
  savePlanMemory(memory: PlanMemory): Promise<void>;
  saveCriteria(key: string, book: CriteriaBook): Promise<void>;
  loadCriteria(key: string): Promise<CriteriaBook>;
  appendProgress(key: string, round: number, text: string): Promise<void>;
  readProgress(key: string): Promise<string>;
  event(run: string, kind: string, data?: Record<string, string | number | boolean>): Promise<void>;
  events(): Promise<LoopEvent[]>;
}

export class RunStore implements LoopStore {
  readonly #dir: string;
  readonly #now: () => Date;

  constructor(dir: string, now: () => Date) {
    this.#dir = dir;
    this.#now = now;
  }

  #run(key: string): string {
    return join(this.#dir, "runs", key);
  }

  async load(key: string): Promise<RunRecord | undefined> {
    try {
      return RunRecordSchema.parse(
        JSON.parse(await readFile(join(this.#run(key), "run.json"), "utf8")),
      );
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(record: RunRecord): Promise<RunRecord> {
    const next = { ...record, updatedAt: this.#now().toISOString() };
    await mkdir(this.#run(record.key), { recursive: true, mode: 0o700 });
    await writeAtomic(
      join(this.#run(record.key), "run.json"),
      `${JSON.stringify(next, null, 2)}\n`,
    );
    return next;
  }

  async all(): Promise<RunRecord[]> {
    let names: string[];
    try {
      names = await readdir(join(this.#dir, "runs"));
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return [];
      throw error;
    }
    const records = await Promise.all(names.map((name) => this.load(name)));
    return records.filter((r): r is RunRecord => r !== undefined);
  }

  /** Runs that have not ended: the loop picks these up again after a restart. */
  async unfinished(): Promise<RunRecord[]> {
    return (await this.all()).filter((r) => r.phase !== "done");
  }

  #plan(id: string): string {
    if (!PLAN_ROUND_ID.test(id)) throw new Error(`not a planning round id: ${id}`);
    return join(this.#dir, "plans", id);
  }

  /** Where a round's work item bodies go; a read root of its sessions. */
  planBodiesDir(id: string): string {
    return join(this.#plan(id), "bodies");
  }

  async loadPlan(id: string): Promise<PlanRound | undefined> {
    try {
      return PlanRoundSchema.parse(
        JSON.parse(await readFile(join(this.#plan(id), "run.json"), "utf8")),
      );
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /** Saves the round, making its directory and `bodies/` the first time. */
  async savePlan(round: PlanRoundInput): Promise<PlanRound> {
    const dir = this.#plan(round.id);
    const next = PlanRoundSchema.parse({ ...round, updatedAt: this.#now().toISOString() });
    await mkdir(join(dir, "bodies"), { recursive: true, mode: 0o700 });
    await writeAtomic(join(dir, "run.json"), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  /** Rounds that have not ended, oldest first: picked up again after a restart. Apart from `unfinished()`. */
  async unfinishedPlans(): Promise<PlanRound[]> {
    return (await this.plans()).filter((r) => r.phase !== "finished" && r.phase !== "abandoned");
  }

  /** Writes one work item's body where the round's sessions read it: `bodies/<key>.md`. */
  async writePlanBody(id: string, key: string, text: string): Promise<void> {
    if (!/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(key)) throw new Error(`not a work item key: ${key}`);
    const dir = this.planBodiesDir(id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeAtomic(join(dir, `${key}.md`), text);
  }

  /** Every round, oldest first. */
  async plans(): Promise<PlanRound[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(join(this.#dir, "plans"), { withFileTypes: true });
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return [];
      throw error;
    }
    const ids = entries
      .filter((e) => e.isDirectory() && PLAN_ROUND_ID.test(e.name))
      .map((e) => e.name)
      .sort();
    const rounds = await Promise.all(ids.map((id) => this.loadPlan(id)));
    return rounds.filter((r): r is PlanRound => r !== undefined);
  }

  /** `plans/index.json`; empty when there is none yet. */
  async loadPlanIndex(): Promise<PlanIndex> {
    try {
      return PlanIndexSchema.parse(
        JSON.parse(await readFile(join(this.#dir, "plans", "index.json"), "utf8")),
      );
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return PlanIndexSchema.parse({});
      throw error;
    }
  }

  async savePlanIndex(index: PlanIndex): Promise<void> {
    await mkdir(join(this.#dir, "plans"), { recursive: true, mode: 0o700 });
    await writeAtomic(
      join(this.#dir, "plans", "index.json"),
      `${JSON.stringify(PlanIndexSchema.parse(index), null, 2)}\n`,
    );
  }

  /** `plans/memory.json`; empty when there is none yet. */
  async loadPlanMemory(): Promise<PlanMemory> {
    try {
      return PlanMemorySchema.parse(
        JSON.parse(await readFile(join(this.#dir, "plans", "memory.json"), "utf8")),
      );
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return {};
      throw error;
    }
  }

  async savePlanMemory(memory: PlanMemory): Promise<void> {
    await mkdir(join(this.#dir, "plans"), { recursive: true, mode: 0o700 });
    await writeAtomic(
      join(this.#dir, "plans", "memory.json"),
      `${JSON.stringify(PlanMemorySchema.parse(memory), null, 2)}\n`,
    );
  }

  async saveCriteria(key: string, book: CriteriaBook): Promise<void> {
    await mkdir(this.#run(key), { recursive: true, mode: 0o700 });
    await writeAtomic(
      join(this.#run(key), "criteria.json"),
      `${JSON.stringify(book.items, null, 2)}\n`,
    );
  }

  async loadCriteria(key: string): Promise<CriteriaBook> {
    return CriteriaBook.restore(
      JSON.parse(await readFile(join(this.#run(key), "criteria.json"), "utf8")),
    );
  }

  /** What Dev reports at the end of a turn is kept, newest last. */
  async appendProgress(key: string, round: number, text: string): Promise<void> {
    await mkdir(this.#run(key), { recursive: true, mode: 0o700 });
    await appendFile(
      join(this.#run(key), "progress.md"),
      `## Turn ${round} (${this.#now().toISOString()})\n\n${text.trim()}\n\n`,
      { mode: 0o600 },
    );
  }

  async readProgress(key: string): Promise<string> {
    try {
      return await readFile(join(this.#run(key), "progress.md"), "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return "";
      throw error;
    }
  }

  async event(
    run: string,
    kind: string,
    data: Record<string, string | number | boolean> = {},
  ): Promise<void> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const line: LoopEvent = { ts: this.#now().toISOString(), run, kind, ...data };
    await appendFile(join(this.#dir, "events.jsonl"), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  }

  async events(): Promise<LoopEvent[]> {
    let text: string;
    try {
      text = await readFile(join(this.#dir, "events.jsonl"), "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return [];
      throw error;
    }
    return text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as LoopEvent);
  }
}

/**
 * One loop at a time on this machine. A lock file holds the pid; one whose process is gone is taken over, which is
 * also how a loop that was killed is told apart from one still running.
 */
export const acquireLock = async (
  dir: string,
  isAlive: (pid: number) => boolean = defaultIsAlive,
  pid: number = process.pid,
): Promise<() => Promise<void>> => {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "loop.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, String(pid), { flag: "wx", mode: 0o600 });
      return async () => {
        const { rm } = await import("node:fs/promises");
        await rm(path, { force: true });
      };
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      const holder = Number.parseInt(await readFile(path, "utf8").catch(() => ""), 10);
      if (Number.isInteger(holder) && holder !== pid && isAlive(holder)) {
        throw new Error(`another loop is running here (pid ${holder})`);
      }
      const { rm } = await import("node:fs/promises");
      await rm(path, { force: true });
    }
  }
  throw new Error("could not take the lock");
};

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}
