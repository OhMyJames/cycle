// One Project's loop, and a set of them side by side in one process (CYC-421). Each loop has its own step, its own
// failure handling and its own sleeping, so one that is stuck inside a step (or failing) never holds up another.

export type LoopSpec = {
  name: string;
  step: () => Promise<{ status: string }>;
  /** Stop after one step, and let an error escape. */
  once: boolean;
  intervalMs: number;
  log: (line: string) => void;
  stopped: () => boolean;
  sleep?: (ms: number) => Promise<void>;
};

export const runLoop = async (spec: LoopSpec): Promise<void> => {
  const sleep = spec.sleep ?? ((ms: number) => Bun.sleep(ms));
  do {
    let pause = false;
    try {
      const result = await spec.step();
      spec.log(`[${spec.name}] ${JSON.stringify(result)}`);
      pause = result.status === "idle";
    } catch (error) {
      if (spec.once) throw error;
      // A tracker or daemon hiccup must not end an unattended loop: log it, wait, try again.
      spec.log(
        `[${spec.name}] step failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      pause = true;
    }
    if (spec.once) break;
    if (pause && !spec.stopped()) await sleep(spec.intervalMs);
  } while (!spec.stopped());
};

/** Runs every loop at once. With `once`, the first error is reported after the others have finished. */
export const runLoops = async (specs: LoopSpec[]): Promise<void> => {
  const results = await Promise.allSettled(specs.map(runLoop));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed !== undefined) throw failed.reason;
};
