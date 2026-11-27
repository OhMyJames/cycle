// Opens `<stateDir>/loop.db` (CYC-475): owner-only, WAL, a wait on a busy lock, foreign keys on.

import { Database } from "bun:sqlite";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS, migrate } from "./schema.ts";

export const DB_FILE = "loop.db";

export const dbPath = (stateDir: string): string => join(stateDir, DB_FILE);

/** Opens (and makes, if it is not there) the database and brings its schema up to date. */
export const openDb = (
  stateDir: string,
  migrations: readonly string[] = MIGRATIONS,
  file: string = DB_FILE,
): Database => {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, file);
  // Made owner-only before SQLite writes anything to it; the -wal and -shm files copy its mode.
  closeSync(openSync(path, "a", 0o600));
  chmodSync(path, 0o600);
  const db = new Database(path, { create: true, strict: true });
  try {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA foreign_keys = ON");
    migrate(db, path, migrations);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
};
