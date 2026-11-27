// What the dev flow's parts share: the host they run on, and the small helpers for talking to the ports.

import type { FlowHost, Save } from "../../engine/flow.ts";
import type { At } from "../../ports/forge.ts";
import type { DevState, RunCommon } from "../../store.ts";

export type { FlowHost, Save };

/** A dev run: the common part and the dev state. The flow's phases are only given these. */
export type DevRun = RunCommon & { kind: "dev"; dev: DevState };

export const asDev = (run: { kind: string; key: string }): DevRun => {
  if (run.kind !== "dev") throw new Error(`${run.key} is a ${run.kind} run, not a dev run`);
  return run as DevRun;
};

/** Where a port command runs, and for how long. */
export const where = (h: FlowHost, cwd: string): At => ({
  cwd,
  timeoutMs: h.d.config.commandTimeoutMs,
});

/** `net` for a port result: `ok`, or an `error` that says whether the network is to blame. */
export const netForge = <T extends { ok: boolean }>(
  h: FlowHost,
  key: string,
  command: string,
  fn: () => Promise<T>,
): Promise<T> =>
  h.net(key, command, fn, (r) =>
    r.ok ? undefined : String((r as { error?: unknown }).error ?? ""),
  );

/** `net` for a port result read as a status: a failed read says why. */
export const netRead = <T extends { ok: boolean }>(
  h: FlowHost,
  key: string,
  command: string,
  fn: () => Promise<T>,
): Promise<T> => netForge(h, key, command, fn);

/** What the dev flow holds in memory for the runs it is on. */
export type Dev = {
  readonly h: FlowHost;
  /** `node_modules_kept` events already written, by run, CI round and reason; a run's entries go when it ends. */
  readonly kept: Set<string>;
  /**
   * The commit each run's CI was seen green on by this process. `ci_state.greenSha` is not read for this: after a
   * restart the PR may have new commits or `ciChecks` may have changed, so the first review asks GitHub again.
   */
  readonly greenSeen: Map<string, string>;
};
