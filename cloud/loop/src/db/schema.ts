// The schema as an ordered list of migrations (CYC-475). A migration is one SQL statement and only adds: a table, a
// column or an index. Never DROP or RENAME: a database written by a newer loop must stay readable by an older one, and
// the data an older loop wrote must stay where the newer one looks for it. A change to a column is a new column.
// Append to the end; do not edit or reorder what is there.

import type { Database } from "bun:sqlite";
import { chmodSync, existsSync, rmSync } from "node:fs";

export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  // The columns every query looks at; the rest of the record is `state`, JSON checked by zod when read.
  `CREATE TABLE runs (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    phase TEXT NOT NULL,
    round INTEGER NOT NULL,
    issue_id INTEGER NOT NULL,
    issue_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    worktree TEXT,
    blocked_reason TEXT,
    resume_from TEXT,
    pr_url TEXT,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    state TEXT NOT NULL
  )`,
  `CREATE INDEX runs_phase ON runs (phase)`,
  `CREATE TABLE criteria (
    run_key TEXT PRIMARY KEY,
    items TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_key TEXT NOT NULL,
    round INTEGER NOT NULL,
    ts TEXT NOT NULL,
    text TEXT NOT NULL
  )`,
  `CREATE INDEX progress_run ON progress (run_key, id)`,
  // Append-only: nothing updates or deletes a row.
  `CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    run TEXT NOT NULL,
    kind TEXT NOT NULL,
    data TEXT NOT NULL
  )`,
  `CREATE INDEX events_run ON events (run, id)`,
  // What to do to the tracker, written in the same transaction as the change that calls for it.
  `CREATE TABLE intents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    dedupe TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'stuck')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX intents_status ON intents (status, id)`,
  `CREATE TABLE heartbeats (
    run_key TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    detail TEXT
  )`,
  `CREATE TABLE actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    run_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    data TEXT NOT NULL
  )`,
  `CREATE INDEX actions_run ON actions (run_key, id)`,
  `CREATE TABLE notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    dedupe TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE plans (
    id TEXT PRIMARY KEY,
    phase TEXT NOT NULL,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    state TEXT NOT NULL
  )`,
  `CREATE TABLE plan_items (
    plan_id TEXT NOT NULL REFERENCES plans (id),
    position INTEGER NOT NULL,
    key TEXT NOT NULL,
    state TEXT NOT NULL,
    PRIMARY KEY (plan_id, position)
  )`,
  `CREATE TABLE plan_memory (
    key TEXT PRIMARY KEY,
    state TEXT NOT NULL
  )`,
  // What `Pipeline` holds only in memory today: the commit CI was green on and the checks last seen.
  `CREATE TABLE ci_state (
    run_key TEXT PRIMARY KEY,
    green_sha TEXT,
    checks TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
];

/** The statements a migration may be made of. */
export const ALLOWED =
  /^\s*(CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)\b|ALTER\s+TABLE\s+\S+\s+ADD\s+COLUMN\b)/i;

export const schemaVersion = (db: Database): number => {
  const meta = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (meta === null) return 0;
  const row = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
    value: string;
  } | null;
  return row === null ? 0 : Number.parseInt(row.value, 10);
};

/**
 * Brings the database up to the list. Behind it, a copy is made first (`loop.db.bak-<old version>`) unless the database
 * is new. Each step and the version it reaches are one transaction. A database ahead of this code is left alone.
 */
export const migrate = (
  db: Database,
  path: string,
  migrations: readonly string[] = MIGRATIONS,
): void => {
  for (const sql of migrations) {
    if (!ALLOWED.test(sql)) throw new Error(`a migration may only add: ${sql.slice(0, 40)}`);
  }
  const from = schemaVersion(db);
  if (from >= migrations.length) return;
  if (from > 0) {
    const backup = `${path}.bak-${from}`;
    if (existsSync(backup)) rmSync(backup);
    db.run("VACUUM INTO ?", [backup]);
    chmodSync(backup, 0o600);
  }
  for (let i = from; i < migrations.length; i++) {
    db.transaction(() => {
      db.run(migrations[i] as string);
      db.run(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [String(i + 1)],
      );
    })();
  }
};
