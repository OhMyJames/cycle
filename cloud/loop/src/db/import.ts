// Moves the file state (`runs/`, `events.jsonl`, `plans/`) into `loop.db` once, at start-up (CYC-476). The caller holds
// `loop.lock`, so no step is working on a run. The database is built apart as `loop.db.importing`, and used only when
// `stats` computed from it equals `stats` computed from the files, field by field (and the records read back equal
// the files'); then the old files are renamed, not deleted. Anything else: `loop.db.importing` is removed, the old
// files are not touched, and this throws, so the loop does not start.

import { cpSync, existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CriteriaBook } from "../criteria.ts";
import { computeStats, type Stats } from "../stats.ts";
import { type LoopEvent, RunStore } from "../store.ts";
import { DB_FILE } from "./db.ts";
import { SqliteStore } from "./store.ts";

export const IMPORTING_FILE = `${DB_FILE}.importing`;

export type ImportResult = {
  runs: number;
  events: number;
  plans: number;
  /** The names the old files were given, in the state directory. */
  kept: string[];
};

/** `loop.db` is not there, and there is state in files to bring over. */
export const needsImport = (stateDir: string): boolean =>
  !existsSync(join(stateDir, DB_FILE)) &&
  (existsSync(join(stateDir, "runs")) || existsSync(join(stateDir, "events.jsonl")));

/** `events.jsonl` without a last line that was cut off: a line with no newline after it. Any other bad line is an error. */
const readEvents = async (stateDir: string): Promise<LoopEvent[]> => {
  let text: string;
  try {
    text = await readFile(join(stateDir, "events.jsonl"), "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
  const lines = text.split("\n");
  lines.pop(); // what follows the last newline: empty, or a half line
  return lines
    .filter((line) => line !== "")
    .map((line, i) => {
      try {
        return JSON.parse(line) as LoopEvent;
      } catch {
        throw new Error(`events.jsonl line ${i + 1} is not JSON`);
      }
    });
};

const PROGRESS_TURN = /^## Turn (\d+) \(([^)\n]*)\)\n\n/gm;

/** `progress.md` as the turns `appendProgress` wrote: round, time and text each. */
const parseProgress = (text: string): { round: number; ts: string; text: string }[] => {
  const heads = [...text.matchAll(PROGRESS_TURN)];
  if (heads.length === 0 && text.trim() !== "") throw new Error("progress.md has no turn heading");
  return heads.map((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = heads[i + 1]?.index ?? text.length;
    return { round: Number(m[1]), ts: m[2] as string, text: text.slice(start, end).trim() };
  });
};

const dirs = (path: string): string[] => {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
};

const differing = (a: Stats, b: Stats): string[] =>
  (Object.keys(a) as (keyof Stats)[]).filter((k) => !isDeepStrictEqual(a[k], b[k]));

const same = (what: string, a: unknown, b: unknown): void => {
  if (!isDeepStrictEqual(a, b)) throw new Error(`${what} differs between the files and loop.db`);
};

const free = (stateDir: string, name: string, date: string): string => {
  let target = `${name}.imported-${date}`;
  for (let n = 2; existsSync(join(stateDir, target)); n++) target = `${name}.imported-${date}-${n}`;
  return target;
};

/** Imports and switches, or throws with the files as they were. */
export const importLegacyState = async (
  stateDir: string,
  now: () => Date,
): Promise<ImportResult> => {
  const importing = join(stateDir, IMPORTING_FILE);
  const clear = () => {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${importing}${suffix}`, { force: true });
  };
  clear(); // left by a start that died half way
  let store: SqliteStore | null = null;
  try {
    const files = new RunStore(stateDir, now);
    const events = await readEvents(stateDir);
    const before = computeStats(events);

    const runNames = dirs(join(stateDir, "runs"));
    const runs = (await Promise.all(runNames.map((name) => files.load(name)))).flatMap((r, i) => {
      if (r === undefined) return [];
      if (r.key !== runNames[i]) throw new Error(`runs/${runNames[i]}/run.json is for ${r.key}`);
      return [r];
    });
    const criteria = new Map<string, CriteriaBook>();
    const progress = new Map<string, string>();
    for (const r of runs) {
      try {
        criteria.set(r.key, await files.loadCriteria(r.key));
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
      }
      progress.set(r.key, await files.readProgress(r.key));
    }
    const plans = await files.plans();
    const planIndex = await files.loadPlanIndex();
    const planMemory = await files.loadPlanMemory();

    store = SqliteStore.openFile(stateDir, IMPORTING_FILE, now);
    store.transaction((tx) => {
      for (const r of runs) {
        tx.put(r);
        const book = criteria.get(r.key);
        if (book !== undefined) tx.saveCriteria(r.key, book);
        for (const turn of parseProgress(progress.get(r.key) ?? "")) {
          tx.db
            .query("INSERT INTO progress (run_key, round, ts, text) VALUES (?, ?, ?, ?)")
            .run(r.key, turn.round, turn.ts, turn.text);
        }
      }
      for (const e of events) {
        const { ts, run, kind, ...data } = e;
        tx.db
          .query("INSERT INTO events (ts, run, kind, data) VALUES (?, ?, ?, ?)")
          .run(ts, run, kind, JSON.stringify(data));
      }
      for (const round of plans) tx.putPlan(round);
      tx.savePlanIndex(planIndex);
      tx.savePlanMemory(planMemory);
    });

    const afterEvents = await store.events();
    const after = computeStats(afterEvents);
    const bad = differing(before, after);
    if (bad.length > 0) throw new Error(`stats differ in: ${bad.join(", ")}`);
    // The rest of the state, read back from the database, must also be what the files hold.
    same("the runs", runs, await store.all());
    for (const r of runs) {
      same(`progress of ${r.key}`, progress.get(r.key), await store.readProgress(r.key));
      if (criteria.has(r.key))
        same(
          `criteria of ${r.key}`,
          criteria.get(r.key)?.items,
          (await store.loadCriteria(r.key)).items,
        );
    }
    same("the planning rounds", plans, await store.plans());
    same("the planning index", planIndex, await store.loadPlanIndex());
    same("the planning memory", planMemory, await store.loadPlanMemory());
    store.close(); // checkpoints the WAL away, so the file alone is the database
    store = null;

    // Switch. The bodies of planning rounds stay files (a session reads them): they are copied to the new `plans/`.
    const date = now().toISOString().slice(0, 10);
    const kept: string[] = [];
    const moved: [string, string][] = [];
    const move = (from: string, to: string) => {
      renameSync(join(stateDir, from), join(stateDir, to));
      moved.push([from, to]);
    };
    try {
      for (const name of ["runs", "events.jsonl", "plans"]) {
        if (!existsSync(join(stateDir, name))) continue;
        const to = free(stateDir, name, date);
        move(name, to);
        kept.push(to);
        if (name === "plans") {
          for (const round of plans) {
            const bodies = join(stateDir, to, round.id, "bodies");
            if (existsSync(bodies))
              cpSync(bodies, join(stateDir, "plans", round.id, "bodies"), { recursive: true });
          }
        }
      }
      renameSync(importing, join(stateDir, DB_FILE));
    } catch (error) {
      // Only a `plans/` made here is removed: one that was never moved is the old one.
      if (moved.some(([from]) => from === "plans"))
        rmSync(join(stateDir, "plans"), { recursive: true, force: true });
      for (const [from, to] of moved.reverse())
        renameSync(join(stateDir, to), join(stateDir, from));
      throw error;
    }
    return { runs: runs.length, events: events.length, plans: plans.length, kept };
  } catch (error) {
    store?.close();
    clear();
    throw new Error(
      `could not import the old state into loop.db: ${error instanceof Error ? error.message : String(error)}. The files are as they were; fix the cause or move them away, then start again.`,
    );
  }
};
