import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";

/** What is kept of a task the client was told of: the SDK's run of it, and whether it went missing from the list. */
export type LedgerEntry = { run: string | undefined; unknown: boolean };

/** A task as the SDK's background list names it. */
export type Listed = { task_id?: unknown; run_id?: string };

/**
 * The life of the tasks a client was told of, shared by the sub-agents and the other background tasks (CYCL-263): the
 * SDK's `task_*` messages and its background list, with the same rules for both.
 *
 * - A task Claude Code ran again has a later `run_id`: what is said of an earlier run is stale.
 * - The list is sent whole after each change; a task gone from it with no end is `unknown`, not finished.
 * - When the process goes, every task still told as running goes with it.
 *
 * What a task is, and how it is told, stays with its owner; this keeps only which are known and in which run.
 */
export class TaskLedger<E extends LedgerEntry> {
  readonly #entries = new Map<string, E>();
  /** The tasks whose presence in the background list is looked for: only those are lost when absent. */
  readonly #listed: (entry: E) => boolean;

  constructor(listed: (entry: E) => boolean = () => true) {
    this.#listed = listed;
  }

  get(id: string): E | undefined {
    return this.#entries.get(id);
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  set(id: string, entry: E): void {
    this.#entries.set(id, entry);
  }

  delete(id: string): void {
    this.#entries.delete(id);
  }

  /** Whether any known task, not lost, is `match` (any at all, with none). */
  some(match: (entry: E) => boolean = () => true): boolean {
    for (const entry of this.#entries.values()) if (!entry.unknown && match(entry)) return true;
    return false;
  }

  /** Said of an earlier run than the one known: Claude Code has run the task again since. */
  stale(id: string, run: string | undefined): boolean {
    const known = this.#entries.get(id)?.run;
    return !!known && !!run && run < known;
  }

  /** The known task `id`, when `run` is its run or does not say. Anything said of another run is not its. */
  ofRun(id: string, run: string | undefined): E | undefined {
    const known = this.#entries.get(id);
    if (known === undefined) return undefined;
    if (known.run && run && known.run !== run) return undefined;
    return known;
  }

  /**
   * The SDK's whole background list. Each task of it that `accepts` takes and that is not already told as running in
   * this run is `announce`d; each listed one known and absent is told `lost`, once.
   */
  reconcile<T extends Listed & { task_id: string }>(
    tasks: readonly Listed[],
    accepts: (task: Listed) => task is T,
    announce: (task: T) => SessionUpdate | undefined,
    lost: (id: string) => SessionUpdate,
  ): SessionUpdate[] {
    const updates: SessionUpdate[] = [];
    const live = new Set<string>();
    for (const task of tasks) {
      if (!accepts(task)) continue;
      live.add(task.task_id);
      if (this.stale(task.task_id, task.run_id)) continue;
      const known = this.#entries.get(task.task_id);
      if (
        known !== undefined &&
        this.#listed(known) &&
        !known.unknown &&
        (!task.run_id || known.run === task.run_id)
      )
        continue;
      const update = announce(task);
      if (update !== undefined) updates.push(update);
    }
    for (const [id, known] of this.#entries) {
      if (!this.#listed(known) || known.unknown || live.has(id)) continue;
      known.unknown = true;
      updates.push(lost(id));
    }
    return updates;
  }

  /** The process is gone: the tasks told as running end with it. Their ids, and none is known after. */
  endAll(): string[] {
    const ended = [...this.#entries.entries()]
      .filter(([, entry]) => !entry.unknown)
      .map(([id]) => id);
    this.#entries.clear();
    return ended;
  }
}
