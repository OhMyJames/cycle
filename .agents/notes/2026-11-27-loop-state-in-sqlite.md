# Agent Note: Loop execution state lives in SQLite (`loop.db`), distinct from daemon JSONL session logs

Status: accepted
Date: 2026-11-27
Basis: Epic CYC-470 (`[CYC-470] Design` §2), tickets CYC-471, CYC-475, CYC-476, CYC-480; code in `cloud/loop/src/db/`.

## Problem

Earlier Loop versions stored runs, criteria, progress, planning rounds, and events across separate JSON and JSONL files under `stateDir`. Without multi-record transactions, writing a run transition and queuing a tracker write (`intents`) could tear halfway; querying live heartbeats, Notices, actions, and Task Graphs from both Work loop and the Supervisor across loose files was brittle and race-prone. Meanwhile, `docs/decisions/0002-storage-and-jsonl-session-log.md` chose JSONL for Cycle daemon session history, raising the question of whether Loop should stay on JSONL too.

## Decision

Store all Loop execution state in a single SQLite database `<stateDir>/loop.db` (mode `0600`, WAL mode, `busy_timeout=5000`, `foreign_keys=ON`):

- **Why SQLite here vs JSONL in `docs/decisions/0002`**: Daemon session logs are append-only event streams owned by one daemon per session (`0002`). Loop state is relational operational state shared concurrently by Work loop, Supervisor, Loop API, and `stats`: runs, transactional tracker outbox `intents`, `heartbeats`, `notices`, `actions`, `ci_state`, `plans`, and Level-2 `run_graphs`/`graph_nodes`. Atomic transactions across `runs` + `intents` + `events` are required to stop partial tracker writes from stranding work items.
- **Additive-only migrations**: `cloud/loop/src/db/schema.ts` allows only `CREATE TABLE`, `CREATE INDEX`, and `ALTER TABLE ... ADD COLUMN` (never `DROP` or `RENAME`). Before migrating, Loop writes a backup `loop.db.bak-<old version>`. A newer database stays readable after rolling back Work loop to an older version.
- **Verified startup import**: When `loop.db` does not exist yet and legacy files exist, startup acquires `loop.lock`, imports everything in one transaction into `loop.db.importing`, verifies exact `stats` and record parity, renames atomically to `loop.db`, and keeps old files as `*.imported-<date>`.

## Alternatives considered

- **Keep JSON/JSONL files and add SQLite only for new tables (intents, heartbeats)**: rejected; maintaining two storage engines makes atomic run+intent updates impossible and doubles query/recovery logic.
- **Stay purely on JSONL like `docs/decisions/0002`**: rejected; append-only logs do not give unique-keyed outbox deduplication (`intents.dedupe`), transactional state transitions, or indexed concurrent reads from the supervisor.

## Consequences

- Work loop, Supervisor, Loop API, and `stats` share one transactional, queryable store with safe rollback compatibility.
- Temporary prompt/body files (`writePlanBody`, PR body files) remain plain files regenerated from DB state.
- Legacy file-store code remains only as a fallback until old deployments have imported cleanly.

## Related

- [2026-11-27-loop-is-three-layers-and-a-person](2026-11-27-loop-is-three-layers-and-a-person.md)
- [2026-11-26-loop-work-item-and-task-graph-boundary](2026-11-26-loop-work-item-and-task-graph-boundary.md)
