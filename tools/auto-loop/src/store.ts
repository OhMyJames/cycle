// What the loop remembers between turns, restarts and crashes: one directory per work item under the state directory,
// and one event log. Nothing here is inside a worktree, so a session cannot edit it (CYC-318).
//
//   <stateDir>/runs/CYC-318/run.json       where the run is
//   <stateDir>/runs/CYC-318/criteria.json  the acceptance criteria and their evidence
//   <stateDir>/runs/CYC-318/progress.md    what Dev said it did and means to do next
//   <stateDir>/events.jsonl                one line per thing that happened, for the metrics

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
  "blocked",
  "done",
] as const;

export const RunRecordSchema = z.object({
  key: z.string(),
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
  /** Times the loop merged the base into the branch after a conflict found while waiting for CI. Counted apart from fix rounds. */
  conflictRound: z.number().int().min(0).default(0),
  /** Set from the moment a conflict merge is started until it ends clean or is aborted: a restart picks it up from here. */
  conflict: z
    .object({ state: z.literal("merging") })
    .nullable()
    .default(null),
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

export type LoopEvent = { ts: string; run: string; kind: string } & Record<
  string,
  string | number | boolean
>;

const writeAtomic = async (path: string, text: string): Promise<void> => {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, text, { mode: 0o600 });
  await rename(temp, path);
};

export class RunStore {
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
