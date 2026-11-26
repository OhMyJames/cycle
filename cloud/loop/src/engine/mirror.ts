// The phase field on a work item: a best-effort mirror of the run record (it may be stale; the record is the truth).
// Writes for one run go through one queue, so they land in order; nothing waits for them except delivery and Blocked,
// and only for a short while.

import type { Tracker } from "../ports/tracker.ts";
import type { LoopStore } from "../store.ts";
import type { Clock, Issue, Logger, LoopPhase } from "../types.ts";

type Parts = {
  tracker: Tracker;
  store: LoopStore;
  clock: Clock;
  log: Logger;
  mirrorCapMs?: number;
};

export class PhaseMirror {
  readonly #queues = new Map<string, Promise<void>>();
  /** The phase last queued for each run, so the same one is not queued twice. */
  readonly #mirrored = new Map<string, LoopPhase | null>();
  /** The kinds of failure already reported for each run: one log line and one event per kind. */
  readonly #failed = new Map<string, Set<string>>();

  /** Queues the write of a phase (`null` clears) and goes on. A failed write is reported once and not retried. */
  write(d: Parts, key: string, issue: Issue, phase: LoopPhase | null): void {
    if (this.#mirrored.has(key) && this.#mirrored.get(key) === phase) return;
    this.#mirrored.set(key, phase);
    const at = d.clock.now();
    const job = (this.#queues.get(key) ?? Promise.resolve())
      .then(() => d.tracker.setLoopPhase(issue, phase, at))
      .catch(async (error) => {
        const kind = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "error";
        const seen = this.#failed.get(key) ?? new Set<string>();
        this.#failed.set(key, seen);
        if (seen.has(kind)) return;
        seen.add(kind);
        const reason = error instanceof Error ? error.message : String(error);
        d.log(`${key}: could not write the phase field (${kind}): ${reason}`);
        await d.store.event(key, "phase_field_failed", { failure: kind }).catch(() => {});
      })
      .finally(() => {
        if (this.#queues.get(key) === job) this.#queues.delete(key);
      });
    this.#queues.set(key, job);
  }

  /** Clears the phase written under `key`, waits a short while for it to land, and forgets it. */
  async clear(d: Parts, key: string, issue: Issue): Promise<void> {
    this.write(d, key, issue, null);
    const queue = this.#queues.get(key);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (queue !== undefined)
      await Promise.race([
        queue,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, d.mirrorCapMs ?? 10_000);
        }),
      ]);
    clearTimeout(timer);
    this.#mirrored.delete(key);
    this.#failed.delete(key);
  }
}
