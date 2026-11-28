import type { Config } from "../types.ts";

/**
 * How long new work items are held back for a daemon update waiting to switch: per pending version, at most
 * `daemonUpdateHoldMinutes` from the first look at it (CYC-561). A newer version starts a new hold; none pending clears it.
 */
export class DaemonUpdateHold {
  #state: { version: string; since: number; announced: boolean; released: boolean } | null = null;

  /** Whether new work items are held back now. */
  holds(
    version: string | null | undefined,
    config: Config,
    d: { clock: { now(): Date }; log(line: string): void },
  ): boolean {
    const state = this.#state;
    if (version == null) {
      if (state?.announced) d.log("daemon update done: taking new work items again");
      this.#state = null;
      return false;
    }
    const now = d.clock.now().getTime();
    const minutes = config.daemonUpdateHoldMinutes;
    if (minutes <= 0) {
      if (state?.announced) d.log("daemon update done: taking new work items again");
      this.#state = { version, since: now, announced: false, released: true };
      return false;
    }
    let current = state;
    if (!current || current.version !== version || !current.announced) {
      current = {
        version,
        since: state?.version === version ? state.since : now,
        announced: true,
        released: false,
      };
      this.#state = current;
      d.log("daemon update waiting: not taking new work items until it has switched");
    }
    if (current.released) return false;
    const waited = now - current.since;
    if (waited < minutes * 60_000) return true;
    current.released = true;
    d.log(
      `daemon update waited ${Math.floor(waited / 60_000)} min: taking new work items; it switches when idle`,
    );
    return false;
  }
}
