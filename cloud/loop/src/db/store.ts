// `LoopStore` kept in `<stateDir>/loop.db` (CYC-475). The same methods as the file `RunStore`, plus what the tables
// make possible: `transaction`, and the intents, heartbeats, notices and actions the later work items use. Nothing in
// the pipeline calls those yet, and nothing here moves a running loop's data: `openStore` picks this only where a
// `loop.db` already exists.

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CriteriaBook } from "../criteria.ts";
import {
  type LoopEvent,
  type LoopStore,
  PLAN_ROUND_ID,
  type PlanIndex,
  PlanIndexSchema,
  type PlanMemory,
  PlanMemorySchema,
  type PlanRound,
  type PlanRoundInput,
  PlanRoundSchema,
  type RunRecord,
  RunRecordSchema,
  RunStore,
  writeAtomic,
} from "../store.ts";
import { DB_FILE, openDb } from "./db.ts";

type Json = Record<string, string | number | boolean>;

export type IntentStatus = "pending" | "done" | "stuck";
export interface Intent {
  id: number;
  runKey: string;
  kind: string;
  payload: unknown;
  dedupe: string;
  status: IntentStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Heartbeat {
  runKey: string;
  at: string;
  detail: string | null;
}
export interface Notice {
  id: number;
  runKey: string;
  kind: string;
  text: string;
  dedupe: string;
  createdAt: string;
}
export interface Action {
  id: number;
  ts: string;
  runKey: string;
  kind: string;
  data: unknown;
}

/** The record's fields that have a column of their own; `state` holds the rest. */
const COLUMN_FIELDS = [
  "key",
  "kind",
  "phase",
  "round",
  "issueId",
  "issueNumber",
  "title",
  "worktree",
  "blockedReason",
  "resumeFrom",
  "prUrl",
  "startedAt",
  "updatedAt",
];

/** The record's columns the queries look at; everything else is the `state` JSON. */
const runColumns = (r: RunRecord) => ({
  kind: r.kind,
  phase: r.phase,
  round: r.round,
  issue_id: r.issueId,
  issue_number: r.issueNumber,
  title: r.title,
  worktree: r.worktree,
  blocked_reason: r.blockedReason,
  resume_from: r.resumeFrom,
  pr_url: r.prUrl,
  started_at: r.startedAt,
  updated_at: r.updatedAt,
});

interface RunRow {
  key: string;
  kind: string;
  phase: string;
  round: number;
  issue_id: number;
  issue_number: number;
  title: string;
  worktree: string | null;
  blocked_reason: string | null;
  resume_from: string | null;
  pr_url: string | null;
  started_at: string;
  updated_at: string;
  state: string;
}

const toRecord = (row: RunRow): RunRecord =>
  RunRecordSchema.parse({
    ...JSON.parse(row.state),
    key: row.key,
    kind: row.kind,
    phase: row.phase,
    round: row.round,
    issueId: row.issue_id,
    issueNumber: row.issue_number,
    title: row.title,
    worktree: row.worktree,
    blockedReason: row.blocked_reason,
    resumeFrom: row.resume_from,
    prUrl: row.pr_url,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  });

const missing = (what: string): Error =>
  Object.assign(new Error(`ENOENT: ${what}`), { code: "ENOENT" });

/** The synchronous half: what a `transaction` callback gets. Every call is one statement or a few on one connection. */
export class StoreOps {
  readonly dir: string;
  readonly db: Database;
  readonly now: () => Date;

  constructor(dir: string, db: Database, now: () => Date) {
    this.dir = dir;
    this.db = db;
    this.now = now;
  }

  load(key: string): RunRecord | undefined {
    const row = this.db.query("SELECT * FROM runs WHERE key = ?").get(key) as RunRow | null;
    return row === null ? undefined : toRecord(row);
  }

  save(record: RunRecord): RunRecord {
    return this.put({ ...record, updatedAt: this.now().toISOString() });
  }

  /** Writes the record as it is, `updatedAt` too: `save` stamps it, an import must not. */
  put(next: RunRecord): RunRecord {
    const state: Record<string, unknown> = { ...next };
    for (const name of COLUMN_FIELDS) delete state[name];
    this.db
      .query(
        `INSERT INTO runs (key, kind, phase, round, issue_id, issue_number, title, worktree, blocked_reason,
           resume_from, pr_url, started_at, updated_at, state)
         VALUES ($key, $kind, $phase, $round, $issue_id, $issue_number, $title, $worktree, $blocked_reason,
           $resume_from, $pr_url, $started_at, $updated_at, $state)
         ON CONFLICT (key) DO UPDATE SET kind = excluded.kind, phase = excluded.phase, round = excluded.round,
           issue_id = excluded.issue_id, issue_number = excluded.issue_number, title = excluded.title,
           worktree = excluded.worktree, blocked_reason = excluded.blocked_reason,
           resume_from = excluded.resume_from, pr_url = excluded.pr_url, started_at = excluded.started_at,
           updated_at = excluded.updated_at, state = excluded.state`,
      )
      .run({ ...runColumns(next), key: next.key, state: JSON.stringify(state) });
    return next;
  }

  all(): RunRecord[] {
    return (this.db.query("SELECT * FROM runs ORDER BY key").all() as RunRow[]).map(toRecord);
  }

  unfinished(): RunRecord[] {
    return (
      this.db.query("SELECT * FROM runs WHERE phase != 'done' ORDER BY key").all() as RunRow[]
    ).map(toRecord);
  }

  saveCriteria(key: string, book: CriteriaBook): void {
    this.db
      .query(
        `INSERT INTO criteria (run_key, items, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (run_key) DO UPDATE SET items = excluded.items, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(book.items), this.now().toISOString());
  }

  loadCriteria(key: string): CriteriaBook {
    const row = this.db.query("SELECT items FROM criteria WHERE run_key = ?").get(key) as {
      items: string;
    } | null;
    if (row === null) throw missing(`no criteria for ${key}`);
    return CriteriaBook.restore(JSON.parse(row.items));
  }

  appendProgress(key: string, round: number, text: string): void {
    this.db
      .query("INSERT INTO progress (run_key, round, ts, text) VALUES (?, ?, ?, ?)")
      .run(key, round, this.now().toISOString(), text.trim());
  }

  readProgress(key: string): string {
    const rows = this.db
      .query("SELECT round, ts, text FROM progress WHERE run_key = ? ORDER BY id")
      .all(key) as { round: number; ts: string; text: string }[];
    return rows.map((r) => `## Turn ${r.round} (${r.ts})\n\n${r.text}\n\n`).join("");
  }

  event(run: string, kind: string, data: Json = {}): void {
    this.db
      .query("INSERT INTO events (ts, run, kind, data) VALUES (?, ?, ?, ?)")
      .run(this.now().toISOString(), run, kind, JSON.stringify(data));
  }

  events(): LoopEvent[] {
    const rows = this.db.query("SELECT ts, run, kind, data FROM events ORDER BY id").all() as {
      ts: string;
      run: string;
      kind: string;
      data: string;
    }[];
    return rows.map((r) => ({ ts: r.ts, run: r.run, kind: r.kind, ...JSON.parse(r.data) }));
  }

  #planId(id: string): string {
    if (!PLAN_ROUND_ID.test(id)) throw new Error(`not a planning round id: ${id}`);
    return id;
  }

  planBodiesDir(id: string): string {
    return join(this.dir, "plans", this.#planId(id), "bodies");
  }

  #planFrom(id: string, row: { state: string }): PlanRound {
    const items = this.db
      .query("SELECT state FROM plan_items WHERE plan_id = ? ORDER BY position")
      .all(id) as { state: string }[];
    return PlanRoundSchema.parse({
      ...JSON.parse(row.state),
      id,
      queue: items.map((i) => JSON.parse(i.state)),
    });
  }

  loadPlan(id: string): PlanRound | undefined {
    const row = this.db.query("SELECT state FROM plans WHERE id = ?").get(this.#planId(id)) as {
      state: string;
    } | null;
    return row === null ? undefined : this.#planFrom(id, row);
  }

  /** Saves the round and makes its `bodies/` directory the first time. */
  savePlan(round: PlanRoundInput): PlanRound {
    this.#planId(round.id);
    const next = this.putPlan(
      PlanRoundSchema.parse({ ...round, updatedAt: this.now().toISOString() }),
    );
    mkdirSync(this.planBodiesDir(next.id), { recursive: true, mode: 0o700 });
    return next;
  }

  /** Writes the round as it is, `updatedAt` too (an import keeps the time it had). */
  putPlan(next: PlanRound): PlanRound {
    this.#planId(next.id);
    const { queue, ...rest } = next;
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO plans (id, phase, started_at, updated_at, state) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET phase = excluded.phase, started_at = excluded.started_at,
             updated_at = excluded.updated_at, state = excluded.state`,
        )
        .run(next.id, next.phase, next.startedAt, next.updatedAt, JSON.stringify(rest));
      this.db.query("DELETE FROM plan_items WHERE plan_id = ?").run(next.id);
      queue.forEach((item, position) => {
        this.db
          .query("INSERT INTO plan_items (plan_id, position, key, state) VALUES (?, ?, ?, ?)")
          .run(next.id, position, item.key, JSON.stringify(item));
      });
    })();
    return next;
  }

  plans(): PlanRound[] {
    const rows = this.db.query("SELECT id, state FROM plans ORDER BY id").all() as {
      id: string;
      state: string;
    }[];
    return rows.map((r) => this.#planFrom(r.id, r));
  }

  unfinishedPlans(): PlanRound[] {
    return this.plans().filter((r) => r.phase !== "finished" && r.phase !== "abandoned");
  }

  loadPlanIndex(): PlanIndex {
    const row = this.db.query("SELECT value FROM meta WHERE key = 'plan_index'").get() as {
      value: string;
    } | null;
    return PlanIndexSchema.parse(row === null ? {} : JSON.parse(row.value));
  }

  savePlanIndex(index: PlanIndex): void {
    this.db
      .query(
        `INSERT INTO meta (key, value) VALUES ('plan_index', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify(PlanIndexSchema.parse(index)));
  }

  loadPlanMemory(): PlanMemory {
    const rows = this.db.query("SELECT key, state FROM plan_memory ORDER BY key").all() as {
      key: string;
      state: string;
    }[];
    return PlanMemorySchema.parse(
      Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.state)])),
    );
  }

  /** Replaces the whole memory, as the file does. */
  savePlanMemory(memory: PlanMemory): void {
    const checked = PlanMemorySchema.parse(memory);
    this.db.transaction(() => {
      this.db.query("DELETE FROM plan_memory").run();
      for (const [key, entry] of Object.entries(checked)) {
        this.db
          .query("INSERT INTO plan_memory (key, state) VALUES (?, ?)")
          .run(key, JSON.stringify(entry));
      }
    })();
  }

  /**
   * Something to do to the tracker, written with the change that calls for it. A `dedupe` already there is left as it
   * is: returns whether this call made the intent.
   */
  intent(runKey: string, kind: string, payload: unknown, dedupe: string): boolean {
    const at = this.now().toISOString();
    return (
      this.db
        .query(
          `INSERT OR IGNORE INTO intents (run_key, kind, payload, dedupe, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(runKey, kind, JSON.stringify(payload), dedupe, at, at).changes > 0
    );
  }

  /** The intents still to do, oldest first. */
  pendingIntents(): Intent[] {
    const rows = this.db
      .query("SELECT * FROM intents WHERE status = 'pending' ORDER BY id")
      .all() as {
      id: number;
      run_key: string;
      kind: string;
      payload: string;
      dedupe: string;
      status: IntentStatus;
      attempts: number;
      last_error: string | null;
      created_at: string;
      updated_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      runKey: r.run_key,
      kind: r.kind,
      payload: JSON.parse(r.payload),
      dedupe: r.dedupe,
      status: r.status,
      attempts: r.attempts,
      lastError: r.last_error,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /** One attempt at an intent ended: `done`, `stuck`, or `pending` to try again. Counts the attempt. */
  markIntent(id: number, status: IntentStatus, error: string | null = null): void {
    const changed = this.db
      .query(
        `UPDATE intents SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(status, error, this.now().toISOString(), id).changes;
    if (changed === 0) throw new Error(`no intent ${id}`);
  }

  /** The loop is alive on this run. */
  beat(runKey: string, detail: string | null = null): void {
    this.db
      .query(
        `INSERT INTO heartbeats (run_key, at, detail) VALUES (?, ?, ?)
         ON CONFLICT (run_key) DO UPDATE SET at = excluded.at, detail = excluded.detail`,
      )
      .run(runKey, this.now().toISOString(), detail);
  }

  heartbeats(): Heartbeat[] {
    const rows = this.db
      .query("SELECT run_key, at, detail FROM heartbeats ORDER BY run_key")
      .all() as { run_key: string; at: string; detail: string | null }[];
    return rows.map((r) => ({ runKey: r.run_key, at: r.at, detail: r.detail }));
  }

  /** Something to tell a person, once per `dedupe`: returns whether this call made it. */
  notice(runKey: string, kind: string, text: string, dedupe: string): boolean {
    return (
      this.db
        .query(
          `INSERT OR IGNORE INTO notices (run_key, kind, text, dedupe, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(runKey, kind, text, dedupe, this.now().toISOString()).changes > 0
    );
  }

  notices(): Notice[] {
    const rows = this.db.query("SELECT * FROM notices ORDER BY id").all() as {
      id: number;
      run_key: string;
      kind: string;
      text: string;
      dedupe: string;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      runKey: r.run_key,
      kind: r.kind,
      text: r.text,
      dedupe: r.dedupe,
      createdAt: r.created_at,
    }));
  }

  /** What the loop did to the outside, appended and never changed. */
  action(runKey: string, kind: string, data: unknown = {}): void {
    this.db
      .query("INSERT INTO actions (ts, run_key, kind, data) VALUES (?, ?, ?, ?)")
      .run(this.now().toISOString(), runKey, kind, JSON.stringify(data));
  }

  actions(runKey?: string): Action[] {
    const rows = (
      runKey === undefined
        ? this.db.query("SELECT * FROM actions ORDER BY id").all()
        : this.db.query("SELECT * FROM actions WHERE run_key = ? ORDER BY id").all(runKey)
    ) as { id: number; ts: string; run_key: string; kind: string; data: string }[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      runKey: r.run_key,
      kind: r.kind,
      data: JSON.parse(r.data),
    }));
  }
}

export class SqliteStore implements LoopStore {
  readonly #ops: StoreOps;

  private constructor(ops: StoreOps) {
    this.#ops = ops;
  }

  /** The database as a file under the name `file` (the import fills `loop.db.importing`, then renames it). */
  static openFile(dir: string, file: string, now: () => Date): SqliteStore {
    return new SqliteStore(new StoreOps(dir, openDb(dir, undefined, file), now));
  }

  static open(dir: string, now: () => Date): SqliteStore {
    return new SqliteStore(new StoreOps(dir, openDb(dir), now));
  }

  close(): void {
    this.#ops.db.close();
  }

  /**
   * Runs `fn` as one transaction: all of what it writes takes effect, or, if it throws, none of it. `fn` is
   * synchronous (a transaction held open across an await would block every other writer) and gets the store's
   * synchronous methods.
   */
  transaction<T>(fn: (tx: StoreOps) => T): T {
    return this.#ops.db.transaction(() => {
      const result = fn(this.#ops);
      if (result instanceof Promise) throw new Error("a transaction callback cannot be async");
      return result;
    })();
  }

  async load(key: string) {
    return this.#ops.load(key);
  }
  async save(record: RunRecord) {
    return this.#ops.save(record);
  }
  async all() {
    return this.#ops.all();
  }
  async unfinished() {
    return this.#ops.unfinished();
  }
  planBodiesDir(id: string): string {
    return this.#ops.planBodiesDir(id);
  }
  async loadPlan(id: string) {
    return this.#ops.loadPlan(id);
  }
  async savePlan(round: PlanRoundInput) {
    return this.#ops.savePlan(round);
  }
  async unfinishedPlans() {
    return this.#ops.unfinishedPlans();
  }
  /** The bodies are files: a session reads them, and it cannot read the database. */
  async writePlanBody(id: string, key: string, text: string): Promise<void> {
    if (!/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(key)) throw new Error(`not a work item key: ${key}`);
    const dir = this.planBodiesDir(id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeAtomic(join(dir, `${key}.md`), text);
  }
  async plans() {
    return this.#ops.plans();
  }
  async loadPlanIndex() {
    return this.#ops.loadPlanIndex();
  }
  async savePlanIndex(index: PlanIndex) {
    this.#ops.savePlanIndex(index);
  }
  async loadPlanMemory() {
    return this.#ops.loadPlanMemory();
  }
  async savePlanMemory(memory: PlanMemory) {
    this.#ops.savePlanMemory(memory);
  }
  async saveCriteria(key: string, book: CriteriaBook) {
    this.#ops.saveCriteria(key, book);
  }
  async loadCriteria(key: string) {
    return this.#ops.loadCriteria(key);
  }
  async appendProgress(key: string, round: number, text: string) {
    this.#ops.appendProgress(key, round, text);
  }
  async readProgress(key: string) {
    return this.#ops.readProgress(key);
  }
  async event(run: string, kind: string, data: Json = {}) {
    this.#ops.event(run, kind, data);
  }
  async events() {
    return this.#ops.events();
  }

  intent(runKey: string, kind: string, payload: unknown, dedupe: string) {
    return this.#ops.intent(runKey, kind, payload, dedupe);
  }
  pendingIntents() {
    return this.#ops.pendingIntents();
  }
  markIntent(id: number, status: IntentStatus, error: string | null = null) {
    this.#ops.markIntent(id, status, error);
  }
  beat(runKey: string, detail: string | null = null) {
    this.#ops.beat(runKey, detail);
  }
  heartbeats() {
    return this.#ops.heartbeats();
  }
  notice(runKey: string, kind: string, text: string, dedupe: string) {
    return this.#ops.notice(runKey, kind, text, dedupe);
  }
  notices() {
    return this.#ops.notices();
  }
  action(runKey: string, kind: string, data: unknown = {}) {
    this.#ops.action(runKey, kind, data);
  }
  actions(runKey?: string) {
    return this.#ops.actions(runKey);
  }
}

/** `<stateDir>/loop.db` there: the database. Not there: the files. Nothing here makes a `loop.db`. */
export const openStore = (stateDir: string, now: () => Date): LoopStore =>
  existsSync(join(stateDir, DB_FILE))
    ? SqliteStore.open(stateDir, now)
    : new RunStore(stateDir, now);
