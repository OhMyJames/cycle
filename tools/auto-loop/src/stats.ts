import type { LoopEvent } from "./store.ts";

export type Stats = {
  runs: number;
  delivered: number;
  /** Delivered with no person's help, out of the runs that were started. */
  autonomousCompletionRate: number;
  /** Runs where a person had to step in (a waiting permission, a block, a resume), out of the runs started. */
  interventionRate: number;
  /** Runs that needed at least one fix round, out of the runs that reached a check. */
  reworkRate: number;
  /** When each delivered run's pull request was opened: its review time is the time from here to its merge. */
  delivery: { run: string; at: string; prUrl: string }[];
};

const INTERVENTIONS = new Set(["permission_pending", "blocked", "resumed"]);

const rate = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);

/** The metrics of the initiative, from the event log (docs: tools/auto-loop/README.md). */
export const computeStats = (events: LoopEvent[]): Stats => {
  const byRun = new Map<string, LoopEvent[]>();
  for (const event of events) {
    const list = byRun.get(event.run) ?? [];
    list.push(event);
    byRun.set(event.run, list);
  }
  let delivered = 0;
  let autonomous = 0;
  let intervened = 0;
  let checked = 0;
  let reworked = 0;
  const delivery: Stats["delivery"] = [];
  for (const [run, list] of byRun) {
    if (!list.some((e) => e.kind === "claimed")) continue;
    const helped = list.some((e) => INTERVENTIONS.has(e.kind));
    const done = list.find((e) => e.kind === "delivered");
    if (helped) intervened++;
    if (done !== undefined) {
      delivered++;
      if (!helped) autonomous++;
      delivery.push({ run, at: done.ts, prUrl: String(done.prUrl ?? "") });
    }
    if (list.some((e) => e.kind === "verify")) {
      checked++;
      if (list.some((e) => e.kind === "round_failed")) reworked++;
    }
  }
  const runs = Array.from(byRun.values()).filter((l) => l.some((e) => e.kind === "claimed")).length;
  return {
    runs,
    delivered,
    autonomousCompletionRate: rate(autonomous, runs),
    interventionRate: rate(intervened, runs),
    reworkRate: rate(reworked, checked),
    delivery,
  };
};
